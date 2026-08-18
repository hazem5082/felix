import "server-only";
import { headers } from "next/headers";
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
  { limit, windowSeconds }: { limit: number; windowSeconds: number }
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
    // Fail OPEN. A rate limiter that takes the login page down with it when
    // the database hiccups is a worse outage than the abuse it prevents —
    // but it must be visible, so log loudly.
    console.error("[rate-limit] check failed, allowing request", { key, err });
    return { allowed: true, remaining: 0, retryAfter: 0 };
  }
}

/** Formats the retry delay for a user-facing message. */
export function retryMessage(retryAfter: number): string {
  const minutes = Math.ceil(retryAfter / 60);
  return minutes <= 1 ? "Please try again in a minute." : `Please try again in ${minutes} minutes.`;
}
