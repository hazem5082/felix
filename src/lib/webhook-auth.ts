import "server-only";
import { timingSafeEqual } from "@/lib/device";

/**
 * Shared authentication for the Worker-to-Worker webhooks
 * (/api/provision, /api/mail/inbound).
 *
 * BOTH callers live in the 508.world router Worker, which this repo does
 * not deploy — so the signing side ships on its own schedule. The verify
 * therefore accepts two schemes during the transition and prefers the
 * strong one:
 *
 *   1. HMAC (preferred). Headers `x-felix-timestamp` + `x-felix-signature`,
 *      where signature = HMAC-SHA256(secret, "<timestamp>.<raw body>") in
 *      hex. This binds the exact bytes received, so nothing between the
 *      two Workers can reorder or mutate fields, and the timestamp window
 *      (±5 min) makes a captured request useless shortly after capture.
 *
 *   2. Legacy bearer. The pre-existing `Authorization: Bearer <secret>`
 *      compare, kept working so a router that has not learned to sign yet
 *      cannot silently break licence approvals or inbound mail. Every use
 *      is logged loudly; once both sides sign, delete this branch.
 *
 * All compares are constant-time (timingSafeEqual), including the legacy
 * one — the original routes compared with `!==`, which was documented as
 * acceptable but never actually necessary.
 *
 * On success the RAW body text is returned, because the HMAC branch must
 * read the stream to sign-verify it and Request bodies do not rewind.
 * Callers json.parse the returned string themselves.
 */

const REPLAY_WINDOW_SECONDS = 300;

type WebhookAuth =
  | { ok: true; body: string }
  | { ok: false; status: number; error: string };

async function hexHmac(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function authenticateWebhook(
  request: Request,
  secretEnvName: "PROVISION_SECRET" | "FELIX_MAIL_SECRET",
  route: string
): Promise<WebhookAuth> {
  const expected = process.env[secretEnvName];
  if (!expected) {
    console.error(`[${route}] ${secretEnvName} is not configured`);
    return { ok: false, status: 503, error: "Not configured" };
  }

  const presentedBearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const timestamp = request.headers.get("x-felix-timestamp") ?? "";
  const signature = request.headers.get("x-felix-signature") ?? "";

  // The body must be read exactly once, on every path that succeeds. Read
  // BEFORE scheme selection: a caller sending signature headers but failing
  // the timestamp check never gets this far anyway, and reading eagerly
  // keeps the control flow linear.
  let rawBody: string | null = null;

  // ── Scheme 1: HMAC over "<timestamp>.<body>" ────────────────────
  if (timestamp && signature) {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) {
      return { ok: false, status: 403, error: "Stale or invalid webhook timestamp" };
    }

    rawBody = await request.text();
    const expectedSig = await hexHmac(expected, `${timestamp}.${rawBody}`);

    if (!timingSafeEqual(signature.toLowerCase(), expectedSig)) {
      return { ok: false, status: 403, error: "Forbidden" };
    }

    return { ok: true, body: rawBody };
  }

  // ── Scheme 2: legacy bearer (transition only) ────────────────────
  if (presentedBearer) {
    if (!timingSafeEqual(presentedBearer, expected)) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    console.warn(
      `[${route}] authenticated via LEGACY bearer token — upgrade the 508.world router to HMAC signing (x-felix-timestamp/x-felix-signature)`
    );
    rawBody ??= await request.text();
    return { ok: true, body: rawBody };
  }

  return { ok: false, status: 403, error: "Forbidden" };
}
