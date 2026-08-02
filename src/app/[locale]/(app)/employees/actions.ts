"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorize } from "@/lib/auth";
import { temporaryPassword } from "@/lib/passwords";
import { CreateStaffSchema, UpdateStaffSchema, Uuid, parseInput } from "@/lib/validation";
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

  // The branch must be one of ours. RLS would let the invitation insert
  // name a foreign branch id (branches are checked by FK, not policy),
  // so resolve it through the CEO's own session first.
  if (staff.branch_id) {
    const { data: branch } = await supabase
      .from("branches")
      .select("id")
      .eq("id", staff.branch_id)
      .maybeSingle();
    if (!branch) return { error: "Unknown branch." };
  }

  // Invitation first: handle_new_user() reads it to decide the new
  // account's role, branch and tenant. Inserted through the CEO's own
  // session so tenant_id defaults to their showroom and the CEO-only
  // policy applies — the service role plays no part in deciding *what*
  // the new account becomes.
  const { error: inviteError } = await supabase.from("staff_invitations").insert({
    email: staff.email.toLowerCase(),
    full_name: staff.full_name,
    role: staff.role,
    branch_id: staff.branch_id,
    invited_by: auth.profile.id,
  });

  if (inviteError) {
    // The PK is the email address, globally. A conflict means this email
    // was already invited — possibly by another showroom, whose row is
    // invisible to us. Same message either way; do not leak which.
    if (inviteError.code === "23505") {
      return { error: "That email address has already been invited or registered." };
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
    await supabase.from("staff_invitations").delete().eq("email", staff.email.toLowerCase());
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
