"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertBranch, authorize } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  AttendanceAdjustmentSchema,
  BranchGeofenceSchema,
  RevokeDeviceSchema,
  VoidAttendanceSchema,
  parseInput,
} from "@/lib/validation";
import type { ActionError } from "@/lib/validation";

/**
 * The supervisor half of attendance (migration 0038).
 *
 * Everything here is available to a branch manager over their own
 * branch, and to the CEO everywhere — which is `can_act_on_branch()`,
 * so the app calls `assertBranch()` and Postgres checks the identical
 * predicate again on the way in. Neither layer is the fallback; the
 * database is the boundary and this is the part that can produce a
 * readable error before the round trip.
 */

const MANAGER_ROLES = ["ceo", "branch_manager"] as const;

/**
 * Enter a punch on somebody's behalf.
 *
 * WHY THIS EXISTS AT ALL. A geofence with no exception path is a
 * geofence people work around: the phone is flat, or left at home, or
 * the salesperson genuinely spent the morning at the traffic authority
 * transferring a plate. Refusing to record those days does not make
 * them stop happening, it makes the attendance report wrong AND puts a
 * paper book back on the desk beside it.
 *
 * WHY IT CANNOT BE MISTAKEN FOR A REAL PUNCH. `source: 'adjustment'`
 * is stored on the row, the CHECK constraint makes `reason` mandatory
 * for it, and every surface that renders attendance — the day pill, the
 * report, the CSV — shows it as an adjustment. A manager can add a day;
 * a manager cannot make an added day look like a GPS one.
 *
 * No coordinates are sent, deliberately. The manager is at a desk, and
 * a punch stamped with the MANAGER'S location would be worse than no
 * location: it would look like evidence.
 */
export async function recordAdjustment(input: {
  profile_id: string;
  branch_id: string;
  kind: string;
  occurred_at: string;
  reason: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(AttendanceAdjustmentSchema, input);
  if (!parsed.ok) return parsed.error;
  const a = parsed.data;

  const branchError = await assertBranch(auth.profile, a.branch_id);
  if (branchError) return branchError;

  // A timestamp arriving as a local `datetime-local` string has no zone.
  // Rejecting rather than guessing: an adjustment filed three hours off
  // is a wrong record that looks right, which is the worst kind.
  const when = new Date(a.occurred_at);
  if (Number.isNaN(when.getTime())) {
    return { error: "That is not a valid date and time.", fieldErrors: { occurred_at: ["Invalid"] } };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("attendance_events").insert({
    profile_id: a.profile_id,
    branch_id: a.branch_id,
    kind: a.kind,
    occurred_at: when.toISOString(),
    source: "adjustment",
    recorded_by: auth.profile.id,
    reason: a.reason,
  });

  if (error) return toUserError(error);
  revalidatePath("/[locale]/(app)/attendance", "page");
  return { ok: true };
}

/**
 * Strike a punch that should not have happened.
 *
 * An UPDATE, never a DELETE: §6f of the schema grants DELETE on
 * nothing, assertion (j) proves it, and "what did this record say
 * before somebody corrected it" has to stay answerable. The tenant
 * role's UPDATE grant on this table is column-limited to exactly the
 * three fields below, so this action could not rewrite a timestamp
 * even if it tried to.
 */
export async function voidAttendanceEvent(input: {
  event_id: string;
  void_reason: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(VoidAttendanceSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // Read it through the caller's OWN session first. If RLS does not
  // show them the row, the update below would silently affect zero rows
  // and report success — which is how "it didn't work and said it did"
  // gets shipped.
  const { data: target } = await supabase
    .from("attendance_events")
    .select("id, branch_id, voided_at")
    .eq("id", parsed.data.event_id)
    .maybeSingle();

  const row = target as { id: string; branch_id: string; voided_at: string | null } | null;
  if (!row) return { error: "That attendance record could not be found." };
  if (row.voided_at) return { error: "That record has already been struck." };

  const branchError = await assertBranch(auth.profile, row.branch_id);
  if (branchError) return branchError;

  const { error } = await supabase
    .from("attendance_events")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: auth.profile.id,
      void_reason: parsed.data.void_reason,
    })
    .eq("id", row.id);

  if (error) return toUserError(error);
  revalidatePath("/[locale]/(app)/attendance", "page");
  return { ok: true };
}

/**
 * Place the showroom on the map.
 *
 * Runs through the caller's own session on purpose, not the admin
 * client: `branches_geofence_update` (0038) admits a manager over their
 * own branch, and the column-limited grant means this statement
 * physically cannot touch the branch's name, licence numbers or tax
 * registration. Using the service role here would throw all of that
 * away and rest the whole thing on the `authorize` line above.
 *
 * Clearing the pin (both coordinates null) is allowed and meaningful:
 * it returns the branch to "not assessed", which is what a showroom
 * that has moved and not yet been re-pinned should read as.
 */
export async function setBranchGeofence(input: {
  branch_id: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(BranchGeofenceSchema, input);
  if (!parsed.ok) return parsed.error;
  const g = parsed.data;

  // Half a pin is not a pin. Storing one would leave geofenceFromBranch()
  // returning null while the form showed a latitude, which reads as a
  // bug rather than as "unpinned".
  if ((g.latitude === null) !== (g.longitude === null)) {
    return { error: "Enter both a latitude and a longitude, or clear both." };
  }

  const branchError = await assertBranch(auth.profile, g.branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("branches")
    .update({
      latitude: g.latitude,
      longitude: g.longitude,
      geofence_radius_m: g.geofence_radius_m,
    })
    .eq("id", g.branch_id)
    .select("id");

  if (error) return toUserError(error);
  // RLS filters an UPDATE rather than raising, so zero rows is the
  // shape a refusal takes. Reporting success here would be a lie.
  if (!data || data.length === 0) {
    return { error: "You do not have permission to set the location for that branch." };
  }

  revalidatePath("/[locale]/(app)/attendance", "page");
  return { ok: true };
}

/**
 * Cut a phone off.
 *
 * Through the caller's own session, again deliberately: the tenant
 * role's column-limited UPDATE covers exactly status/revoked_at/
 * revoked_by, the policy admits the device's owner plus a manager over
 * their branch, and `record_audit()` therefore stamps the REAL actor on
 * the trail. Doing this with the service role would leave every
 * revocation attributed to nobody, and "who cut this phone off" is the
 * question the table exists to answer after the fact.
 *
 * Anyone may revoke their own device — that is the lost-phone path, and
 * it must not require finding a manager on a Sunday.
 */
export async function revokeTrustedDevice(input: {
  device_id: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorize(["ceo", "branch_manager", "accountant", "sales_exec", "marketing"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(RevokeDeviceSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trusted_devices")
    .update({
      status: "revoked",
      revoked_at: new Date().toISOString(),
      revoked_by: auth.profile.id,
    })
    .eq("id", parsed.data.device_id)
    .eq("status", "active")
    .select("id");

  if (error) return toUserError(error);
  if (!data || data.length === 0) {
    return { error: "That device could not be revoked. It may already have been." };
  }

  revalidatePath("/[locale]/(app)/attendance", "page");
  return { ok: true };
}

/**
 * The people a manager oversees, for the team board and the adjustment
 * form's picker.
 *
 * No explicit branch filter: `profiles_select` (0003 §10) already
 * confines a branch manager to their own branch plus unassigned
 * accounts, and the CEO to everyone. Adding a filter here would
 * duplicate the rule in a second place where it could drift — and
 * would silently narrow a CEO's list.
 */
export async function overseenProfiles(): Promise<
  { ok: true; profiles: { id: string; full_name: string; branch_id: string | null; work_mode: string }[] } | ActionError
> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, branch_id, work_mode, role")
    .neq("role", "investor")
    .order("full_name");

  if (error) return toUserError(error);

  return {
    ok: true,
    profiles: (data as { id: string; full_name: string; branch_id: string | null; work_mode: string }[]) ?? [],
  };
}
