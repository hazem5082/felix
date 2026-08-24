/**
 * How a FELIX message's body is built, in one place.
 *
 * These four helpers lived inside the compose action (0039) and were
 * private to it, which was correct while exactly one thing sent mail.
 * The end-of-day report (0053) is the second, and it writes rows into
 * the same `mail_messages` table that the mail client reads — so if the
 * two disagreed about escaping, threading or the signature, the evening
 * report would render as a slightly different kind of message in the
 * inbox than everything else, for no reason a reader could name.
 *
 * No `server-only`, and deliberately: threadKeyOf's rule is the one the
 * 508.world Worker also implements, and a compose form that wants to
 * preview a thread should be able to ask the same question without a
 * round trip.
 */

export const SIGNATURE_TEXT = "\n\n— mailed by FELIX by 508.world";
export const SIGNATURE_HTML =
  '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e3e7ee;' +
  'font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#667085;">' +
  "mailed by FELIX by 508.world</div>";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Plain text to a paragraphed HTML body. `dir="auto"` rather than a
 * hard-coded direction: FELIX is deployed for Arabic and English
 * showrooms and a message can be either, whatever the sender's UI
 * language is.
 */
export function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;">${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div dir="auto" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a2233;">${body}</div>`;
}

/** "Re: Re: quote" -> "quote". Mirrors the 508.world Worker's threadKeyOf. */
export function threadKeyOf(subject: string): string | null {
  let value = subject.trim();
  const prefix = /^\s*(re|aw|antw|fw|fwd|رد|إعادة توجيه)\s*(\[\d+\])?\s*:\s*/i;
  while (prefix.test(value)) value = value.replace(prefix, "");
  const key = value.toLowerCase().replace(/\s+/g, " ").trim();
  return key || null;
}

/** The one-line preview the inbox list shows. */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}
