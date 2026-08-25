import "server-only";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { createAdminClient } from "@/lib/supabase/admin";

// There is no KV or Durable Object binding in this deployment, so the
// counter lives in Postgres (`consume_rate_limit` in migration 0003) and is
// driven through the service-role client — the callers are unauthenticated
// by definition, so they hold no session of their own.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export const LIMITS = {
  /** Password attempts per IP. Deliberately tight — this is the whole system. */
  login: { limit: 8, windowSeconds: 15 * 60 },
  /** Password attempts per email, so one account can't be ground down from many IPs. */
  loginByEmail: { limit: 10, windowSeconds: 15 * 60 },
  /** Public referral intake per IP. Generous for a real person, useless for a script. */
  publicLead: { limit: 5, windowSeconds: 10 * 60 },
  /** Presigned upload URLs per user. */
  upload: { limit: 60, windowSeconds: 10 * 60 },
  /**
   * Passwordless persona switches on the flagship demo, per IP. Roomy
   * enough that someone clicking through all six personas twice never
   * notices it, tight enough that the endpoint cannot be used to mint
   * sessions in bulk — each call costs a GoTrue generateLink + verifyOtp.
   */
  demoSwitch: { limit: 30, windowSeconds: 60 },
  /**
   * Attendance punches per profile. Generous for a real day (arrive,
   * two breaks, leave, plus retries when the GPS is slow) and useless
   * for a script trying to bury a bad day under noise.
   */
  punch: { limit: 40, windowSeconds: 60 * 60 },
  /**
   * Device-enrolment codes per profile. Each one sends a real email, so
   * this is the throttle that stops the endpoint being turned into a
   * mail cannon aimed at an employee's inbox.
   */
  deviceCode: { limit: 5, windowSeconds: 15 * 60 },
  /**
   * Attempts to redeem a code, per profile. Tight because a six-digit
   * code is only a million guesses — the per-row attempt counter in
   * device_verifications is the primary defence and this is the second,
   * covering someone who keeps requesting fresh rows to reset it.
   */
  deviceConfirm: { limit: 12, windowSeconds: 15 * 60 },
  /**
   * Messages sent per profile. Internal mail is a free DB write, but
   * every message with an external recipient spends a real Resend send
   * — this is the throttle that stops FELIX being used as a mail
   * cannon aimed at the outside world.
   */
  mailSend: { limit: 60, windowSeconds: 60 * 60 },
  /**
   * END DAY presses per profile (0053). Every one of them mails the
   * branch managers and the CEO, so this is the throttle that stops an
   * evening report becoming a way to fill your manager's inbox. Ten an
   * hour is roomy for the real case — finish a late task, press it
   * again — and useless for anything else.
   */
  endDay: { limit: 10, windowSeconds: 60 * 60 },
  /**
   * Cross-showroom stock searches per profile (0054). Every call fans
   * out one request per participating showroom, so this is both a cost
   * ceiling and the thing that stops one manager's account being used
   * to walk the whole network's floor make by make — the one abuse this
   * feature makes possible that nothing else in FELIX does.
   *
   * Roomy for the real job: a manager working through a list of
   * unfilled asks clicks a dozen of them and never sees it.
   */
  networkSearch: { limit: 60, windowSeconds: 10 * 60 },
  /**
   * Opening one of those results. Looser than the search that produced
   * it — a manager comparing four candidates for one buyer opens each
   * of them, and opens the good one twice — but bounded for the same
   * reason: this is the other endpoint that reads another showroom's
   * floor.
   */
  networkDetail: { limit: 200, windowSeconds: 10 * 60 },
} as const;

/**
 * Best-effort client address. On Cloudflare `cf-connecting-ip` is set by the
 * edge and cannot be spoofed by the client; the others are fallbacks for
 * local dev. Returns a stable placeholder rather than null so a missing
 * header degrades to one shared bucket instead of no limiting at all.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function consume(
  key: string,
  {
    limit,
    windowSeconds,
    failClosed = false,
  }: { limit: number; windowSeconds: number; failClosed?: boolean }
): Promise<RateLimitResult> {
  try {
    // Buckets and the function both live in `platform` since 0008/0011 —
    // throttling is deployment-wide, not per showroom, so a caller cannot
    // reset their limit by switching subdomains.
    const admin = createAdminClient("platform");
    const { data, error } = await admin.rpc("consume_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    const row = data as { allowed: boolean; remaining: number; retry_after: number };
    return { allowed: row.allowed, remaining: row.remaining, retryAfter: row.retry_after };
  } catch (err) {
    if (!failClosed) {
      // Fail OPEN. A rate limiter that takes its feature down with it when
      // the database hiccups is a worse outage than the abuse it prevents —
      // but it must be visible, so log loudly.
      console.error("[rate-limit] check failed, allowing request", { key, err });
      return { allowed: true, remaining: 0, retryAfter: 0 };
    }

    // Fail CLOSED. The login buckets pass this flag on purpose: during a
    // Postgres outage, "open" means password grinding with no throttle at
    // all, against the single most valuable credential set in the system.
    // Denying logins for the window is the safer failure — nobody can
    // sign in anyway while auth's own session store is unreachable.
    console.error("[rate-limit] check failed, REFUSING request (fail-closed bucket)", { key, err });
    return { allowed: false, remaining: 0, retryAfter: windowSeconds };
  }
}

/** Formats the retry delay for a user-facing message. */
export async function retryMessage(retryAfter: number): Promise<string> {
  const minutes = Math.ceil(retryAfter / 60);
  // One plural key instead of two branches: next-intl renders the =1 and
  // other cases in the request's locale, including the numeral.
  const t = await getTranslations("errors.actions");
  return t("retryInMinutes", { count: minutes });
}
