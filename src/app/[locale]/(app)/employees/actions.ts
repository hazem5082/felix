"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorize } from "@/lib/auth";
import { temporaryPassword } from "@/lib/passwords";
import { acceptsBranchGrants } from "@/lib/branch-authority";
import {
  BranchGrantRevokeSchema,
  BranchGrantSchema,
  CreateStaffSchema,
  UpdateStaffSchema,
  Uuid,
  parseInput,
} from "@/lib/validation";
import type { Role } from "@/lib/supabase/types";
import { toUserError } from "@/lib/db-error";

// Staff management is CEO-only end to end. Every action here re-checks
// that server-side; the service-role client only ever acts on a target
// the CEO's OWN session has already proven it can see — which, under
// the tenant-isolation policies, is the proof the target belongs to
// this showroom. The admin key never touches an id RLS hasn't vouched
// for first.

export type CreatedCredentials = {
  email: string;
  /** Shown exactly once, never stored, never logged. */
  temporary_password: string;
};

export async function createEmployee(input: {
  email: string;
  full_name: string;
  role: string;
  branch_id: string | null;
  phone: string;
}): Promise<CreatedCredentials | { error: string; fieldErrors?: Record<string, string[]> }> {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateStaffSchema, input);
  if (!parsed.ok) return parsed.error;
  const staff = parsed.data;

  const supabase = await createClient();

  // Invitation first: handle_new_user() reads it to decide the new
  // account's role, branch and tenant.
  //
  // Called as an RPC rather than an INSERT because the table moved to the
  // `platform` schema in 0008, which no tenant role can write. The CEO
  // check that used to be RLS (0003's staff_invitations_ceo) now lives
  // inside platform.invite_staff(): it re-derives the caller's showroom
  // from auth.uid() and re-checks is_ceo() in that showroom's own schema.
  // So this stays database-enforced rather than resting on the
  // authorize(["ceo"]) above — whoever can write an invitation can mint a
  // CEO, and that decision must not be the app's alone.
  //
  // The branch pre-check that used to sit here is gone for the same
  // reason: invite_staff validates the branch inside the tenant schema,
  // where a foreign showroom's branch id simply does not exist.
  // invited_by is set from auth.uid() by the function, not passed.
  const { error: inviteError } = await supabase.rpc("invite_staff", {
    p_email: staff.email.toLowerCase(),
    p_full_name: staff.full_name,
    p_role: staff.role,
    p_branch_id: staff.branch_id,
  });

  if (inviteError) {
    // invite_staff collapses a unique violation into one message on
    // purpose: the pending-email index is global, so a raw conflict would
    // tell this showroom that another one has a pending invitation for
    // the address.
    if (/unavailable/i.test(inviteError.message)) {
      return { error: "That email address has already been invited or registered." };
    }
    if (/Unknown branch/i.test(inviteError.message)) {
      return { error: "Unknown branch." };
    }
    return { error: inviteError.message };
  }

  const temp = temporaryPassword();
  const admin = createAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: staff.email.toLowerCase(),
    password: temp,
    email_confirm: true,
    user_metadata: { full_name: staff.full_name },
  });

  if (createError || !created?.user) {
    // Leave no half-created state: an unaccepted invitation with no
    // account behind it would block this email forever.
    await supabase.rpc("revoke_invitation", { p_email: staff.email.toLowerCase() });
    const already = /already (been )?registered|already exists/i.test(createError?.message ?? "");
    return {
      error: already
        ? "An account with that email address already exists."
        : `The account could not be created: ${createError?.message ?? "unknown error"}`,
    };
  }

  revalidatePath("/[locale]/(app)/employees", "page");
  return { email: staff.email.toLowerCase(), temporary_password: temp };
}

export async function resetEmployeePassword(input: {
  profile_id: string;
}): Promise<CreatedCredentials | { error: string }> {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(Uuid, input.profile_id);
  if (!parsed.ok) return { error: "Invalid employee." };

  const supabase = await createClient();

  // Visibility through the CEO's own session is the tenant check: the
  // RESTRICTIVE isolation policy makes another showroom's profile
  // return zero rows, so the admin client below can never be pointed
  // across a tenant boundary.
  const { data: target } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("id", parsed.data)
    .maybeSingle();
  if (!target) return { error: "No such employee in this showroom." };

  const admin = createAdminClient();
  const { data: user, error: lookupError } = await admin.auth.admin.getUserById(parsed.data);
  if (lookupError || !user?.user?.email) {
    return { error: "That employee has no sign-in account." };
  }

  const temp = temporaryPassword();
  const { error: updateError } = await admin.auth.admin.updateUserById(parsed.data, {
    password: temp,
  });
  if (updateError) return { error: `Password reset failed: ${updateError.message}` };

  return { email: user.user.email, temporary_password: temp };
}

export async function updateEmployee(input: {
  id: string;
  full_name: string;
  role: string;
  branch_id: string | null;
  phone: string;
}) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(UpdateStaffSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  if (parsed.data.branch_id) {
    const { data: branch } = await supabase
      .from("branches")
      .select("id")
      .eq("id", parsed.data.branch_id)
      .maybeSingle();
    if (!branch) return { error: "Unknown branch." };
  }

  // Straight through the CEO's session: RLS keeps it inside the tenant,
  // and the profile-privilege trigger owns the hard rules (only a CEO
  // may touch role/branch; the last CEO cannot be demoted). Database
  // errors here are those rules speaking — surface them verbatim.
  const { data, error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      role: parsed.data.role,
      branch_id: parsed.data.branch_id,
      phone: parsed.data.phone,
    })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return toUserError(error);
  if (!data?.length) return { error: "No such employee in this showroom." };

  revalidatePath("/[locale]/(app)/employees", "page");
  return { ok: true };
}

// ── Multi-branch authority (migration 0030) ─────────────────
//
// A grant EXTENDS an employee's reach to one more branch. Their home
// branch stays on profiles.branch_id, so an "area manager" is a
// branch_manager holding several grants and no new role exists.
//
// Both actions are CEO-only twice over: authorize(["ceo"]) here, and
// branch_grants' insert/update policies, which admit is_ceo() alone. The
// database check is the one that matters — delegating the power to
// delegate is how a branch manager would grant themselves the branch
// next door — and this one is what makes the refusal legible.

/** Shared prologue: the CEO's own session must be able to see the target. */
async function loadGrantTarget(profileId: string) {
  const supabase = await createClient();
  // Visibility through the CEO's session IS the tenant check, as in
  // resetEmployeePassword above: another showroom's profile returns zero
  // rows under the isolation policies.
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role, branch_id")
    .eq("id", profileId)
    .maybeSingle();
  return data as { id: string; full_name: string; role: Role; branch_id: string | null } | null;
}

export async function grantBranchAccess(input: {
  profile_id: string;
  branch_id: string;
  note: string;
}) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(BranchGrantSchema, input);
  if (!parsed.ok) return parsed.error;

  const target = await loadGrantTarget(parsed.data.profile_id);
  if (!target) return { error: "No such employee in this showroom." };

  // Refused at the point it is offered rather than quietly stored: a
  // grant to a CEO or an accountant says nothing they did not already
  // have org-wide, and an investor's scope is the vehicles they hold
  // equity in, not a branch.
  if (!acceptsBranchGrants(target.role)) {
    return { error: "Only branch managers and sales staff can be granted extra branches." };
  }

  if (target.branch_id === parsed.data.branch_id) {
    return { error: "That is already their home branch." };
  }

  const supabase = await createClient();
  const { data: branch } = await supabase
    .from("branches")
    .select("id")
    .eq("id", parsed.data.branch_id)
    .maybeSingle();
  if (!branch) return { error: "Unknown branch." };

  // UPSERT rather than INSERT: the unique index is on (profile_id,
  // branch_id) with no revoked_at in it, so re-granting a branch that was
  // taken away must reuse the row — and the row's whole history stays in
  // audit_log instead of splitting across two of them.
  //
  // granted_by is set from the session, never from the client: the RLS
  // WITH CHECK pins it to auth.uid() and would reject anything else.
  const { error } = await supabase.from("branch_grants").upsert(
    {
      profile_id: parsed.data.profile_id,
      branch_id: parsed.data.branch_id,
      note: parsed.data.note,
      granted_by: auth.profile.id,
      revoked_at: null,
    },
    { onConflict: "profile_id,branch_id" }
  );
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/employees", "page");
  return { ok: true };
}

export async function revokeBranchAccess(input: { profile_id: string; branch_id: string }) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(BranchGrantRevokeSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // Stamped, not deleted. §6f grants DELETE on nothing and assertion (j)
  // inside create_tenant_schema() proves it, but the better reason is
  // that an authority record is the last one that should vanish: the
  // revocation, its timestamp and its author are what audit_log keeps.
  const { data, error } = await supabase
    .from("branch_grants")
    .update({ revoked_at: new Date().toISOString(), granted_by: auth.profile.id })
    .eq("profile_id", parsed.data.profile_id)
    .eq("branch_id", parsed.data.branch_id)
    .is("revoked_at", null)
    .select("id");

  if (error) return toUserError(error);
  if (!data?.length) return { error: "That branch is not currently granted." };

  revalidatePath("/[locale]/(app)/employees", "page");
  return { ok: true };
}
