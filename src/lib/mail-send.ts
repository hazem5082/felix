import "server-only";

/**
 * The FILEX -> 508.world Worker bridge for mail leaving the tenant.
 *
 * Mirrors src/lib/notify.ts exactly: same NOTIFY_URL/NOTIFY_SECRET pair,
 * same fail-loud shape, same short timeout. Internal FELIX-to-FELIX mail
 * never calls this — see mail_messages.direction in migration 0039 — so
 * every call here is either 'outbound' (a FELIX user mailing an address
 * outside their tenant) or exists so a future inbound reply path can
 * reuse the same signature.
 *
 * THE ENDPOINT THIS EXPECTS
 *
 *   POST {NOTIFY_URL}/api/mail/felix/send
 *   Authorization: Bearer {NOTIFY_SECRET}
 *   { from, from_name, to, cc, subject, html, text, attachments }
 *
 * Sends via Resend from <address>@felixmail.508.world and returns the
 * same tri-state outcome every other Worker mail route does
 * ('sent' | 'skipped' | 'failed') — never a bare boolean, because
 * "skipped" (no transport configured, or a suppressed recipient) and
 * "failed" (the provider rejected it) are different things for the
 * compose screen to say.
 */

export type SendMailOutcome = "sent" | "skipped" | "failed";

export interface OutboundAttachment {
  filename: string;
  /** base64, no data: prefix. */
  content: string;
  mimeType: string;
}

export interface OutboundMailMessage {
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: OutboundAttachment[];
}

export type SendMailResult =
  | { ok: true; outcome: SendMailOutcome }
  | { ok: false; error: "channel_unconfigured" | "send_failed" };

export function isMailSendConfigured(): boolean {
  return Boolean(process.env.NOTIFY_URL && process.env.NOTIFY_SECRET);
}

export async function sendExternalMail(message: OutboundMailMessage): Promise<SendMailResult> {
  const url = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (!url || !secret) return { ok: false, error: "channel_unconfigured" };

  try {
    // 15s, longer than notify.ts's 8s: this call can carry attachment
    // bytes as base64 and a slow upstream (Resend) is a real possibility
    // that a code-entry screen never has to account for.
    const res = await fetch(`${url}/api/mail/felix/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        from: message.from,
        from_name: message.fromName,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          mime_type: a.mimeType,
        })),
      }),
    });

    if (!res.ok) return { ok: false, error: "send_failed" };
    const body = (await res.json().catch(() => null)) as { outcome?: SendMailOutcome } | null;
    if (!body?.outcome) return { ok: false, error: "send_failed" };
    return { ok: true, outcome: body.outcome };
  } catch {
    return { ok: false, error: "send_failed" };
  }
}
