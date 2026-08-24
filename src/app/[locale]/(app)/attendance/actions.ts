"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { createClient, getSessionTenant } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import { clientIp, consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import { localizeErrorMessage } from "@/lib/action-messages";
import { sendCode } from "@/lib/notify";
import {
  CODE_TTL_MINUTES,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE,
  MAX_CODE_ATTEMPTS,
  describeDevice,
  hashDeviceSecret,
  hashVerificationCode,
  newVerificationCode,
  timingSafeEqual,
} from "@/lib/device";
import { canPunch, stateAfter, type AttendanceEvent } from "@/lib/attendance";
import {
  ConfirmDeviceSchema,
  EnrolDeviceSchema,
  PunchSchema,
  parseInput,
} from "@/lib/validation";
import type { ActionError } from "@/lib/validation";
import type { TrustedDevice } from "@/lib/supabase/types";

/**
 * Attendance punching, and the device trust that gates it (0038).
 *
 * THE ONE THING THAT IS NOT ENFORCED HERE
 *
 * The geofence. Distance and verdict are computed by
 * `stamp_attendance_geofence()` inside Postgres on every insert, and
 * whatever this file sends for `distance_m` / `within_geofence` is
 * discarded before it is stored — so those two columns are deliberately
 * absent from every insert below. If they were set here, a Server
 * Action is still just an HTTP endpoint and the verdict would be
 * whatever the caller posted.
 *
 * WHAT IS ENFORCED HERE
 *
 * Device trust, because a policy cannot express "and the emailed code
 * was correct", and the punch state machine, because a policy cannot
 * express "you cannot arrive twice without leaving". Everything else —
 * who may punch for whom, which branch, no deletes — is RLS, and this
 * file treats that as the real boundary rather than the fallback.
 */

// ── Device plumbing ─────────────────────────────────────────

export type DeviceStatus =
  | { state: "trusted"; deviceId: string }
  /** Recognised nobody: a code has to be sent before this phone counts. */
  | { state: "unknown" }
  /** The phone was enrolled and has since been cut off. */
  | { state: "revoked" };

/**
 * Resolve a presented secret to a trusted device row.
 *
 * Reads through the ADMIN client on purpose. `trusted_devices` has no
 * INSERT grant for the tenant role at all (enrolment needs the code),
 * and the lookup is by hash — a value the caller already holds — so
 * nothing is revealed that they did not bring with them. The profile id
 * comes from the session, never from the request body, which is what
 * stops this being a device-enumeration oracle.
 */
async function resolveDevice(
  schema: string,
  profileId: string,
  deviceSecret: string
): Promise<DeviceStatus> {
  const admin = createAdminClient(schema);
  const hash = await hashDeviceSecret(deviceSecret);

  const { data } = await admin
    .from("trusted_devices")
    .select("id, status")
    .eq("profile_id", profileId)
    .eq("device_hash", hash)
    .maybeSingle();

  const row = data as Pick<TrustedDevice, "id" | "status"> | null;
  if (!row) return { state: "unknown" };
  if (row.status === "revoked") return { state: "revoked" };
  return { state: "trusted", deviceId: row.id };
}

/**
 * Mirror the secret into a cookie.
 *
 * The phone keeps it in localStorage too. Both, because either one
 * alone loses phones for reasons the employee cannot see: a privacy
 * sweep clears cookies, and iOS Safari evicts an origin's storage after
 * about a week of not being opened. Losing the binding means a code
 * email and an irritated salesperson, so it is worth two copies.
 *
 * Not httpOnly — the client component has to read it to send it back on
 * the next punch. That is not a downgrade: the same value is in
 * localStorage, which script can always read, so httpOnly would protect
 * nothing while breaking the flow.
 */
async function rememberDeviceCookie(secret: string): Promise<void> {
  const jar = await cookies();
  jar.set(DEVICE_COOKIE, secret, {
    maxAge: DEVICE_COOKIE_MAX_AGE,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

// ── Punching ────────────────────────────────────────────────

export type PunchResult =
  | { ok: true; within_geofence: boolean | null; distance_m: number | null }
  /** This phone is not trusted yet — the UI must run the code flow. */
  | { ok: false; needsDevice: "unknown" | "revoked" }
  | ActionError;

export async function punch(input: {
  kind: string;
  branch_id: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  device_secret: string;
}): Promise<PunchResult> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(PunchSchema, input);
  if (!parsed.ok) return parsed.error;
  const p = parsed.data;

  // Remote staff owe no attendance, so a punch from one is a mistake
  // rather than an attack — but it must not silently create a record
  // that makes the report say something untrue about their week.
  if (auth.profile.work_mode === "remote") {
    return { error: "Your account is set to remote working, so you do not record attendance." };
  }

  const throttle = await consume(`punch:${auth.profile.id}`, LIMITS.punch);
  if (!throttle.allowed) {
    return {
      error: `${await localizeErrorMessage("Too many attendance actions.")} ${await retryMessage(throttle.retryAfter)}`,
    };
  }

  const claim = await getSessionTenant();
  if (!claim) return { error: "Your session has expired. Please sign in again." };

  const device = await resolveDevice(claim.schema, auth.profile.id, p.device_secret);
  if (device.state !== "trusted") return { ok: false, needsDevice: device.state };

  const supabase = await createClient();

  // The state machine. RLS cannot express "you cannot arrive twice
  // without leaving" — it is a fact about the rows already there, not
  // about the row being written — so it is checked here against what
  // the caller's OWN session can see, which is their own punches.
  const { data: recent } = await supabase
    .from("attendance_events")
    .select("*")
    .eq("profile_id", auth.profile.id)
    .order("occurred_at", { ascending: false })
    .limit(50);

  const state = stateAfter((recent as AttendanceEvent[] | null) ?? []);
  if (!canPunch(state, p.kind)) {
    return { error: PUNCH_CONFLICT[state] };
  }

  // NOTE the absence of distance_m and within_geofence. See the header.
  const { data, error } = await supabase
    .from("attendance_events")
    .insert({
      profile_id: auth.profile.id,
      branch_id: p.branch_id,
      kind: p.kind,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracy_m: p.accuracy_m ?? null,
      device_id: device.deviceId,
      source: "device",
      recorded_by: auth.profile.id,
    })
    .select("within_geofence, distance_m")
    .maybeSingle();

  if (error) return toUserError(error);

  // Best-effort, and deliberately not awaited into the failure path: a
  // punch that succeeded must not report failure because a bookkeeping
  // timestamp did not update.
  await createAdminClient(claim.schema)
    .from("trusted_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", device.deviceId);

  const row = (data as { within_geofence: boolean | null; distance_m: string | number | null } | null) ?? null;

  revalidatePath("/[locale]/(app)/attendance", "page");
  return {
    ok: true,
    within_geofence: row?.within_geofence ?? null,
    distance_m: row?.distance_m === null || row?.distance_m === undefined ? null : Number(row.distance_m),
  };
}

const PUNCH_CONFLICT: Record<string, string> = {
  out: "You are not clocked in. Record your arrival first.",
  in: "You are already clocked in.",
  on_break: "You are on a break. End the break before doing that.",
};

// ── Enrolling a new phone ───────────────────────────────────

export type EnrolResult =
  | { ok: true; sentTo: string }
  /** Nothing to verify: this phone is already trusted. */
  | { ok: true; alreadyTrusted: true }
  | ActionError;

/**
 * Step one: mint a code and email it.
 *
 * The address is `notification_email` on the profile, falling back to
 * the sign-in address. Never an address from the request — the whole
 * value of the second factor is that it goes somewhere the person
 * already controls, so letting the caller nominate a destination would
 * turn the check into a formality.
 */
export async function requestDeviceCode(input: {
  device_secret: string;
  user_agent?: string;
}): Promise<EnrolResult> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(EnrolDeviceSchema, input);
  if (!parsed.ok) return parsed.error;

  const [ip, byProfile] = await Promise.all([
    clientIp(),
    consume(`devicecode:${auth.profile.id}`, LIMITS.deviceCode),
  ]);
  const byIp = await consume(`devicecode:ip:${ip}`, LIMITS.deviceCode);
  if (!byProfile.allowed || !byIp.allowed) {
    const retry = Math.max(byProfile.retryAfter, byIp.retryAfter);
    return {
      error: `${await localizeErrorMessage("Too many verification codes requested.")} ${await retryMessage(retry)}`,
    };
  }

  const claim = await getSessionTenant();
  if (!claim) return { error: "Your session has expired. Please sign in again." };

  const existing = await resolveDevice(claim.schema, auth.profile.id, parsed.data.device_secret);
  if (existing.state === "trusted") {
    await rememberDeviceCookie(parsed.data.device_secret);
    return { ok: true, alreadyTrusted: true };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const to = auth.profile.notification_email ?? user?.email ?? "";
  if (!to) {
    return {
      error:
        "There is no email address on your account to send a code to. Ask your manager to add one, or to approve this phone for you.",
    };
  }

  const ua = parsed.data.user_agent ?? (await headers()).get("user-agent");
  const described = describeDevice(ua);
  const code = newVerificationCode();
  const admin = createAdminClient(claim.schema);
  const deviceHash = await hashDeviceSecret(parsed.data.device_secret);

  const { data: pending, error: insertError } = await admin
    .from("device_verifications")
    .insert({
      profile_id: auth.profile.id,
      device_hash: deviceHash,
      code_hash: await hashVerificationCode(auth.profile.id, code),
      label: described.label,
      platform: described.platform,
      expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (insertError) return toUserError(insertError);

  const sent = await sendCode({
    to,
    code,
    purpose: "device_enrolment",
    deviceLabel: described.label,
    expiresInMinutes: CODE_TTL_MINUTES,
    tenant: claim.slug,
    locale: "en",
  });

  if (!sent.ok) {
    // Do NOT leave a pending row behind for a code nobody received. The
    // person would then be told "check your email" and, later, "that
    // code is wrong", for a message that was never sent.
    if (pending) {
      await admin.from("device_verifications").delete().eq("id", (pending as { id: string }).id);
    }
    return {
      error:
        sent.error === "channel_unconfigured"
          ? "Email is not configured for this deployment, so a code cannot be sent. Ask your manager to approve this phone for you."
          : "The verification email could not be sent. Please try again, or ask your manager to approve this phone.",
    };
  }

  return { ok: true, sentTo: maskEmail(to) };
}

/**
 * Step two: redeem the code and enrol the phone.
 *
 * Every check is against the caller's OWN pending row, found by their
 * session's profile id and the hash of the secret their phone holds.
 * Nothing here trusts a body field to say who is enrolling.
 */
export async function confirmDeviceCode(input: {
  device_secret: string;
  code: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(ConfirmDeviceSchema, input);
  if (!parsed.ok) return parsed.error;

  const throttle = await consume(`deviceconfirm:${auth.profile.id}`, LIMITS.deviceConfirm);
  if (!throttle.allowed) {
    return {
      error: `${await localizeErrorMessage("Too many attempts.")} ${await retryMessage(throttle.retryAfter)}`,
    };
  }

  const claim = await getSessionTenant();
  if (!claim) return { error: "Your session has expired. Please sign in again." };

  const admin = createAdminClient(claim.schema);
  const deviceHash = await hashDeviceSecret(parsed.data.device_secret);

  const { data } = await admin
    .from("device_verifications")
    .select("id, code_hash, attempts, expires_at, consumed_at, label, platform")
    .eq("profile_id", auth.profile.id)
    .eq("device_hash", deviceHash)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as {
    id: string;
    code_hash: string;
    attempts: number;
    expires_at: string;
    label: string | null;
    platform: string | null;
  } | null;

  // One message for "no such request", "expired" and "too many tries".
  // Distinguishing them tells an attacker which of the three they hit,
  // and none of the three is actionable differently by a real employee.
  const STALE = {
    error: "That code is not valid any more. Request a new one.",
  };
  if (!row) return STALE;
  if (new Date(row.expires_at).getTime() < Date.now()) return STALE;
  if (row.attempts >= MAX_CODE_ATTEMPTS) return STALE;

  const presented = await hashVerificationCode(auth.profile.id, parsed.data.code);
  if (!timingSafeEqual(presented, row.code_hash)) {
    await admin
      .from("device_verifications")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    const left = MAX_CODE_ATTEMPTS - (row.attempts + 1);
    return {
      error:
        left > 0
          ? `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`
          : "That code is not correct, and this request is now closed. Request a new one.",
    };
  }

  // Burn the code BEFORE enrolling. If the insert below fails the code
  // is spent and a new one is needed, which is the safe direction to
  // fail — the alternative leaves a valid code alive after it has been
  // successfully presented once.
  await admin
    .from("device_verifications")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id);

  // Upsert on (profile_id, device_hash): the unique index means a phone
  // that was revoked and is being re-enrolled reuses its row and keeps
  // its history, rather than opening a second answer to "may this phone
  // punch?". Same reasoning as 0030's branch_grants.
  const { error } = await admin.from("trusted_devices").upsert(
    {
      profile_id: auth.profile.id,
      device_hash: deviceHash,
      label: row.label,
      platform: row.platform,
      status: "active",
      revoked_at: null,
      revoked_by: null,
      enrolled_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "profile_id,device_hash" }
  );

  if (error) return toUserError(error);

  await rememberDeviceCookie(parsed.data.device_secret);
  revalidatePath("/[locale]/(app)/attendance", "page");
  return { ok: true };
}

/** "ha***@gmail.com" — enough to recognise, not enough to harvest. */
function maskEmail(address: string): string {
  const [name, domain] = address.split("@");
  if (!domain) return "your email address";
  const head = name.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}
