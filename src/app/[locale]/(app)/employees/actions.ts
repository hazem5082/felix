"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate, authorize, getGrantedBranchIds } from "@/lib/auth";
import { temporaryPassword } from "@/lib/passwords";
import { acceptsBranchGrants } from "@/lib/branch-authority";
import {
  BranchGrantRevokeSchema,
  BranchGrantSchema,
  ChangeSignInEmailSchema,
  CreateStaffSchema,
  SetFeatureGrantSchema,
  SetTargetSchema,
  SetWorkModeSchema,
  UpdateAvatarSchema,
  UpdateStaffSchema,
  Uuid,
  parseInput,
} from "@/lib/validation";
import { canChangeSignInEmail } from "@/lib/hierarchy";
import { FEATURE_GRANTABLE, FEATURE_HIDEABLE } from "@/lib/features";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { ActionError } from "@/lib/validation";
import { isManagedUploadUrl } from "@/lib/r2";
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
  // Statutory employee data for the monthly NOSI filing (0018). All
  // optional — "" collapses to null in the schema.
  national_id: string;
  social_insurance_number: string;
  hire_date: string;
  monthly_wage: string;
  employment_type: string;
}): Promise<CreatedCredentials | { error: string; fieldErrors?: Record<string, string[]> }> {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(CreateStaffSchema, input);
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
  //
  // The returned token is the invitation's one-time secret (0052): the
  // ONLY proof GoTrue will accept that this signup is the person the CEO
  // invited. It rides straight into createUser's user_metadata below,
  // server-to-server, and is never displayed, logged or emailed — which
  // is what makes a public /auth/v1/signup with just the email address
  // useless to an attacker.
  const { data: inviteToken, error: inviteError } = await supabase.rpc("invite_staff", {
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

  if (typeof inviteToken !== "string" || inviteToken.length === 0) {
    return { error: "The invitation was created without its signup token. Revoke it and try again." };
  }

  const temp = temporaryPassword();
  const admin = createAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: staff.email.toLowerCase(),
    password: temp,
    email_confirm: true,
    user_metadata: { full_name: staff.full_name, invite_token: inviteToken },
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

  // Statutory fields ride a plain UPDATE through the CEO's own session:
  // handle_new_user() has already minted the profiles row (it fires
  // synchronously on the auth.users insert above), and RLS plus the
  // profiles_update_self policy scope the write to this showroom. The
  // invite RPC is deliberately not widened — these are HR fields, not
  // identity, and the account must not fail to exist over them. If this
  // update trips (it should not: columns are nullable and pre-validated),
  // the CEO still gets the one-time credentials and can fill the fields
  // in via Edit.
  const statutory = {
    national_id: staff.national_id,
    social_insurance_number: staff.social_insurance_number,
    hire_date: staff.hire_date,
    monthly_wage: staff.monthly_wage,
    employment_type: staff.employment_type,
  };
  if (Object.values(statutory).some((v) => v !== null)) {
    await supabase.from("profiles").update(statutory).eq("id", created.user.id);
  }

  revalidatePath("/[locale]/(app)/employees", "page");
  return { email: staff.email.toLowerCase(), temporary_password: temp };
}

export async function resetEmployeePassword(input: {
  profile_id: string;
}): Promise<CreatedCredentials | { error: string }> {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(Uuid, input.profile_id);
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
  national_id: string;
  social_insurance_number: string;
  hire_date: string;
  monthly_wage: string;
  employment_type: string;
}) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(UpdateStaffSchema, input);
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
      national_id: parsed.data.national_id,
      social_insurance_number: parsed.data.social_insurance_number,
      hire_date: parsed.data.hire_date,
      monthly_wage: parsed.data.monthly_wage,
      employment_type: parsed.data.employment_type,
    })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return toUserError(error);
  if (!data?.length) return { error: "No such employee in this showroom." };

  revalidatePath("/[locale]/(app)/employees", "page");
  return { ok: true };
}

/**
 * Upsert one monthly target. Manager-or-above app-side; the database
 * re-checks the branch scope (a manager can only target their own
 * staff) and pins set_by to the caller — RLS is the enforcement, this
 * guard just gives a readable refusal.
 */
export async function setEmployeeTarget(input: {
  profile_id: string;
  metric: string;
  target_value: number;
  period_month: string;
}) {
  const auth = await authorize(["ceo", "branch_manager"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(SetTargetSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("employee_targets").upsert(
    {
      profile_id: parsed.data.profile_id,
      metric: parsed.data.metric,
      target_value: parsed.data.target_value,
      period_month: parsed.data.period_month,
      set_by: auth.profile.id,
    },
    { onConflict: "profile_id,metric,period_month" }
  );

  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/employees/[profileId]", "page");
  return { ok: true };
}

/**
 * Set or clear a profile photo. Open to any signed-in member because
 * the profiles_update_self policy is the real gate: it admits exactly
 * the owner and the CEO, so a sales exec POSTing a colleague's id gets
 * zero rows updated, not a new photo.
 */
export async function updateEmployeeAvatar(input: {
  profile_id: string;
  avatar_url: string;
}) {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(UpdateAvatarSchema, input);
  if (!parsed.ok) return parsed.error;

  // A hand-typed URL must not stand in for an uploaded photo — the same
  // rule the bank-contract upload enforces.
  if (parsed.data.avatar_url && !isManagedUploadUrl(parsed.data.avatar_url, "avatars")) {
    return { error: "The photo must be uploaded through the app." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ avatar_url: parsed.data.avatar_url })
    .eq("id", parsed.data.profile_id)
    .select("id");

  if (error) return toUserError(error);
  if (!data?.length) return { error: "You can only change your own photo." };

  revalidatePath("/[locale]/(app)/employees/[profileId]", "page");
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

  const parsed = await parseInput(BranchGrantSchema, input);
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

  const parsed = await parseInput(BranchGrantRevokeSchema, input);
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

// ── Attendance administration (migration 0038) ──────────────

/**
 * On-site or remote.
 *
 * CEO only, and that is a decision rather than an oversight. Work mode
 * decides whether a person owes attendance AT ALL, so it is an
 * employment term and it sits with the other employment terms — a
 * branch manager cannot change a subordinate's wage, branch or role
 * today either. `guard_profile_privilege_columns()` (0038) enforces the
 * same rule inside Postgres, so this guard only supplies the readable
 * refusal.
 *
 * A manager who needs to excuse one DAY rather than one CONTRACT has
 * the adjustment path in attendance/manage-actions.ts.
 */
export async function setWorkMode(input: { profile_id: string; work_mode: string }) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(SetWorkModeSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ work_mode: parsed.data.work_mode })
    .eq("id", parsed.data.profile_id)
    .select("id");

  if (error) return toUserError(error);
  if (!data?.length) return { error: "No such employee in this showroom." };

  revalidatePath("/[locale]/(app)/employees", "page");
  revalidatePath("/[locale]/(app)/attendance", "page");
  return { ok: true };
}

/**
 * Change a SIGN-IN address — the credential itself, not the
 * notification contact that account/actions.ts edits.
 *
 * TWO PATHS, ONE ACTION, DIFFERENT PROOFS
 *
 *   Your own      — requires your CURRENT PASSWORD. An email address is
 *                   the account recovery channel, so changing it is a
 *                   credential change: a borrowed unlocked laptop must
 *                   not be enough to redirect somebody's password
 *                   resets to an attacker's inbox.
 *   Somebody
 *   else's        — requires SUPERVISION, per src/lib/hierarchy.ts: the
 *                   CEO over anyone, a branch manager over the sales and
 *                   marketing staff of a branch they may act on. No
 *                   password, because a supervisor does not know one and
 *                   must not need to — the point of the path is the
 *                   employee who has LOST access to their inbox.
 *
 * WHY THE TENANT FENCE IS NOT THE `authorize` LINE
 *
 * `auth.users` is outside every tenant schema, so this necessarily uses
 * the admin client, which bypasses RLS. What keeps it inside the
 * showroom is that the target profile is read through the CALLER'S OWN
 * SESSION first: `profiles_select` returns nothing for another
 * showroom's id, and nothing outside a branch manager's branch. The
 * admin key only ever touches an id that RLS has already vouched for —
 * the same construction resetEmployeePassword() has used since 0009.
 */
export async function changeSignInEmail(input: {
  profile_id: string;
  new_email: string;
  current_password?: string;
}): Promise<{ ok: true; email: string } | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(ChangeSignInEmailSchema, input);
  if (!parsed.ok) return parsed.error;
  const { profile_id, new_email, current_password } = parsed.data;

  const supabase = await createClient();

  // THE TENANT AND BRANCH FENCE. Read through the caller's session, so
  // an id from another showroom simply does not exist here.
  const { data: target } = await supabase
    .from("profiles")
    .select("id, role, branch_id, full_name")
    .eq("id", profile_id)
    .maybeSingle();

  const subject = target as
    | { id: string; role: Role; branch_id: string | null; full_name: string }
    | null;
  if (!subject) return { error: "No such employee in this showroom." };

  const verdict = canChangeSignInEmail(
    { id: auth.profile.id, role: auth.profile.role, branch_id: auth.profile.branch_id },
    subject,
    await getGrantedBranchIds()
  );

  if (!verdict.allowed) {
    return {
      error:
        verdict.reason === "other_branch"
          ? "That employee belongs to another branch."
          : "You do not have permission to change that person's sign-in email.",
    };
  }

  // Changing your own is a credential change; prove you are at the
  // keyboard. The only way to verify a password with GoTrue is to
  // attempt a sign-in, and it must happen on a throwaway client —
  // doing it on the request's own server client would overwrite this
  // request's session cookie mid-flight. Same shape as changePassword().
  if (verdict.reason === "self") {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) return { error: "Your session has expired. Please sign in again." };
    if (!current_password) {
      return {
        error: "Enter your current password to change your sign-in email.",
        fieldErrors: { current_password: ["Required"] },
      };
    }
    const verifier = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    const { error: signInError } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: current_password,
    });
    if (signInError) return { error: "Your current password is incorrect." };
  }

  const admin = createAdminClient();

  // email_confirm: true because this is an ADMINISTRATIVE change made by
  // somebody who has already been authorized above, not a self-service
  // one that needs proving. Leaving it false would send a confirmation
  // link to the NEW address — which is exactly the address the employee
  // has lost access to in the case this path exists to solve.
  const { error: updateError } = await admin.auth.admin.updateUserById(subject.id, {
    email: new_email,
    email_confirm: true,
  });

  if (updateError) {
    // GoTrue's uniqueness error names the conflict across the whole
    // deployment, which would tell this showroom that another one holds
    // the address. Collapsed, the way invite_staff() collapses its own.
    if (/already|exists|registered|duplicate/i.test(updateError.message)) {
      return { error: "That email address is already in use." };
    }
    return { error: `The sign-in email could not be changed: ${updateError.message}` };
  }

  revalidatePath("/[locale]/(app)/employees", "page");
  revalidatePath("/[locale]/(app)/account", "page");
  return { ok: true, email: new_email };
}

/**
 * Grant or hide a navigation feature for one person (migration 0048).
 *
 * CEO-ONLY, and the database says so too: feature_grants_insert and
 * _update are both `is_ceo()`. A branch manager who could grant 'hr'
 * would be granting themselves — one hop later — every profile in the
 * company and the wage column on all of them.
 *
 * TWO REFUSALS BEFORE THE ROUND TRIP, both of which Postgres would also
 * make. They are here so the message names the problem instead of
 * arriving as a constraint violation:
 *
 *   1. Only FEATURE_GRANTABLE may be granted. That list mirrors
 *      feature_grants_grantable, and it is short because a grant is
 *      real authority: a feature whose policies do not consult
 *      has_feature() would hand somebody a tab onto an empty page.
 *   2. Nothing may be hidden that is not FEATURE_HIDEABLE — nobody gets
 *      locked out of their own account page or the help desk.
 *
 * REVOKING IS AN UPDATE, never a delete: the tenant role holds no
 * DELETE grant on the table (assertion (j) would refuse to provision a
 * showroom where it did), and "who handed this person payroll, and who
 * took it back" is exactly the question the row exists to answer.
 *
 * The unique index is partial (`where revoked_at is null`), so a
 * re-grant after a revoke opens a NEW row rather than reusing the old
 * one — which is why this upserts by hand: revoke whatever is live,
 * then insert. Doing it in that order means the index is never asked to
 * hold two live rows for the same pair, even for an instant.
 */
export async function setFeatureGrant(input: {
  profile_id: string;
  feature: string;
  mode: string;
  enabled: boolean;
  note: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(SetFeatureGrantSchema, input);
  if (!parsed.ok) return parsed.error;
  const g = parsed.data;

  if (g.mode === "grant" && !FEATURE_GRANTABLE.includes(g.feature)) {
    return {
      error:
        "That hub cannot be granted yet — its data permissions have not been wired for grants.",
    };
  }
  if (g.mode === "hide" && !FEATURE_HIDEABLE.includes(g.feature)) {
    return { error: "That tab cannot be hidden." };
  }

  const supabase = await createClient();

  // Whatever is live for this pair goes first, in both directions:
  // turning something on must also clear an opposing 'hide', or the
  // sidebar would grant and then immediately hide the same key.
  const { error: revokeError } = await supabase
    .from("feature_grants")
    .update({ revoked_at: new Date().toISOString(), revoked_by: auth.profile.id })
    .eq("profile_id", g.profile_id)
    .eq("feature", g.feature)
    .is("revoked_at", null);

  if (revokeError) return toUserError(revokeError);

  if (!g.enabled) {
    revalidatePath("/[locale]/(app)/employees/[profileId]", "page");
    return { ok: true };
  }

  const { error } = await supabase.from("feature_grants").insert({
    profile_id: g.profile_id,
    feature: g.feature,
    mode: g.mode,
    // Stamped from the authenticated session rather than pinned by a
    // policy predicate — 0046's header explains why `= auth.uid()` in a
    // WITH CHECK raises 42501 under the tenant role.
    granted_by: auth.profile.id,
    note: g.note,
  });

  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/employees/[profileId]", "page");
  revalidatePath("/[locale]/(app)", "layout");
  return { ok: true };
}
