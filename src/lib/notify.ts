import "server-only";

/**
 * FELIX's outbound message channel — the 508.world router Worker.
 *
 * FELIX has never sent an email itself. `src/instrumentation.ts` relays
 * uncaught errors to the router Worker at `NOTIFY_URL`, and the Worker
 * owns the mail pipeline, the throttling and the sender identity. This
 * module is the second thing to use that channel: the six-digit codes
 * that let a new phone enrol for attendance.
 *
 * IT FAILS LOUD, AND THAT IS THE DIFFERENCE
 *
 * instrumentation.ts is deliberately fail-silent — an unreachable
 * reporting endpoint must never make an outage worse. The exact
 * opposite is required here. If the code cannot be sent, the person is
 * standing in the showroom looking at a screen that says "check your
 * email", and a silent failure means they wait for a message that is
 * never coming. Every failure path below returns an error the action
 * turns into visible text, and no pending verification row is left
 * behind for a code that was never delivered.
 *
 * THE ENDPOINT THIS EXPECTS
 *
 *   POST {NOTIFY_URL}/api/notify/code
 *   Authorization: Bearer {NOTIFY_SECRET}
 *   { to, code, purpose, device_label, expires_in_minutes, tenant, locale }
 *
 * It does not exist in the 508.world repo yet — that is the one piece
 * of this feature that lives outside FELIX. Until it does, `sendCode`
 * returns `channel_unconfigured` (no NOTIFY_URL) or the Worker's own
 * 404, and the punch screen tells the employee to ask their manager to
 * approve the device instead of pretending a mail was sent.
 */

export type NotifyResult = { ok: true } | { ok: false; error: NotifyError };

export type NotifyError =
  | "channel_unconfigured"
  | "no_address"
  | "send_failed";

export interface CodeMessage {
  /** The address the code goes to. Never taken from user input. */
  to: string;
  code: string;
  /** What the recipient is being asked to confirm. */
  purpose: "device_enrolment";
  deviceLabel: string;
  expiresInMinutes: number;
  /** Showroom slug, so the Worker can brand and rate-limit per tenant. */
  tenant: string;
  locale: string;
}

export function isNotifyConfigured(): boolean {
  return Boolean(process.env.NOTIFY_URL && process.env.NOTIFY_SECRET);
}

export async function sendCode(message: CodeMessage): Promise<NotifyResult> {
  const url = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (!url || !secret) return { ok: false, error: "channel_unconfigured" };
  if (!message.to || !message.to.includes("@")) return { ok: false, error: "no_address" };

  try {
    // A short timeout on purpose: this sits between a person tapping a
    // button and the screen changing. A Worker that is slow to answer
    // must surface as "try again", not as a spinner that never resolves.
    const res = await fetch(`${url}/api/notify/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        source: "felix-app",
        to: message.to,
        code: message.code,
        purpose: message.purpose,
        device_label: message.deviceLabel,
        expires_in_minutes: message.expiresInMinutes,
        tenant: message.tenant,
        locale: message.locale,
      }),
    });
    return res.ok ? { ok: true } : { ok: false, error: "send_failed" };
  } catch {
    // Network error, DNS failure, or the 8s timeout above.
    return { ok: false, error: "send_failed" };
  }
}
