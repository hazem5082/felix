"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate, authorize } from "@/lib/auth";
import { temporaryPassword } from "@/lib/passwords";
import {
  CreateStaffSchema,
  SetTargetSchema,
  UpdateAvatarSchema,
  UpdateStaffSchema,
  Uuid,
  parseInput,
} from "@/lib/validation";
import { isManagedUploadUrl } from "@/lib/r2";
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
  national_id: string;
  social_insurance_number: string;
  hire_date: string;
  monthly_wage: string;
  employment_type: string;
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

  const parsed = parseInput(SetTargetSchema, input);
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

  const parsed = parseInput(UpdateAvatarSchema, input);
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
