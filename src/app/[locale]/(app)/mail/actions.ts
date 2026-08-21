"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authenticate } from "@/lib/auth";
import { consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import { checkAttachmentBudget, sniff, SNIFF_PREFIX_BYTES } from "@/lib/file-sniff";
import { deleteObject, readObjectBase64, readObjectPrefix } from "@/lib/r2";
import { isFelixMailAddress } from "@/lib/mail-address";
import { isMailSendConfigured, sendExternalMail } from "@/lib/mail-send";
import { MailComposeSchema, MarkMailReadSchema, parseInput } from "@/lib/validation";

/**
 * FELIX mail (0039). Internal recipients are written straight into the
 * caller's own RLS-scoped session — no admin client anywhere in this
 * file, because sender and every internal recipient are already rows
 * this session can see under RLS, and mail_messages_insert's WITH CHECK
 * (sender_profile_id = auth.uid()) is what actually authorizes the
 * write. External recipients go out through the 508.world Worker
 * (src/lib/mail-send.ts) — see migration 0039's file header for why
 * that split exists at all.
 *
 * The signature is appended ONCE, here, to the version that is both
 * sent and stored — so the sender's own copy shows exactly what an
 * external recipient received, and an internal recipient sees the same
 * signature an external one would have, for consistency rather than
 * necessity.
 */

const SIGNATURE_TEXT = "\n\n— mailed by FELIX by 508.world";
const SIGNATURE_HTML =
  '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e3e7ee;' +
  'font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#667085;">' +
  "mailed by FELIX by 508.world</div>";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;">${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div dir="auto" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a2233;">${body}</div>`;
}

/** "Re: Re: quote" -> "quote". Mirrors the 508.world Worker's threadKeyOf. */
function threadKeyOf(subject: string): string | null {
  let value = subject.trim();
  const prefix = /^\s*(re|aw|antw|fw|fwd|رد|إعادة توجيه)\s*(\[\d+\])?\s*:\s*/i;
  while (prefix.test(value)) value = value.replace(prefix, "");
  const key = value.toLowerCase().replace(/\s+/g, " ").trim();
  return key || null;
}

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

export type SendMailResponse =
  | { ok: true; id: string; sendOutcome: "sent" | "skipped" | "failed" | null }
  | { error: string; fieldErrors?: Record<string, string[]> };

export async function sendMail(input: unknown): Promise<SendMailResponse> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;
  const profile = auth.profile;

  if (!profile.mail_address) {
    // Should not happen post-0039 — every profile gets one at creation
    // or backfill — but a stale session cache is possible, and sending
    // FROM null would silently corrupt the row.
    return { error: "Your mail address is not set up yet. Try signing in again." };
  }

  const parsed = parseInput(MailComposeSchema, input);
  if (!parsed.ok) return parsed.error;
  const data = parsed.data;

  // Mail stays inside the showroom that sent it.
  //
  // The two internal id lists are already tenant-bound: they are resolved
  // below through the caller's own RLS-scoped `profiles`, which is this
  // tenant's schema and no other, and a count mismatch there rejects the
  // whole send. The free-text external lists are the gap that leaves — a
  // FELIX address typed by hand would be handed to Resend, delivered to
  // felixmail.508.world, and picked up by the inbound webhook as another
  // tenant's mail. That is a cross-showroom channel the per-tenant schema
  // split (0011) exists specifically to make impossible, so it is refused
  // here rather than relayed.
  //
  // Refused, not silently rerouted to the matching profile: the sender
  // may well mean a colleague whose address they typed instead of picked,
  // but they may equally mean a stranger at another showroom, and only
  // the first of those is something FELIX should quietly do for them.
  const crossTenant = [...data.to_external, ...data.cc_external].filter(isFelixMailAddress);
  if (crossTenant.length) {
    return {
      error: `FELIX addresses cannot be typed in as outside recipients (${crossTenant.join(", ")}). Pick colleagues from the To / Cc lists — you can only mail people in your own showroom.`,
    };
  }

  const throttle = await consume(`mail-send:${profile.id}`, LIMITS.mailSend);
  if (!throttle.allowed) return { error: retryMessage(throttle.retryAfter) };

  const supabase = await createClient();

  const internalIds = Array.from(new Set([...data.to_profile_ids, ...data.cc_profile_ids]));
  let internalProfiles: { id: string; full_name: string; mail_address: string | null }[] = [];
  if (internalIds.length) {
    const { data: rows, error } = await supabase
      .from("profiles")
      .select("id, full_name, mail_address")
      .in("id", internalIds);
    if (error) return { error: "Could not resolve recipients." };
    internalProfiles = (rows ?? []) as typeof internalProfiles;
    // RLS scopes this SELECT to the caller's own tenant already — a
    // count mismatch means an id from outside it, or one that no
    // longer exists, either way not a valid recipient.
    if (internalProfiles.length !== internalIds.length) {
      return { error: "One or more recipients could not be found." };
    }
  }

  const hasExternal = data.to_external.length + data.cc_external.length > 0;

  if (data.attachments.length) {
    const budget = checkAttachmentBudget(
      data.attachments.map((a) => a.size_bytes),
      { hasExternalRecipient: hasExternal }
    );
    if (!budget.ok) return { error: budget.reason };

    for (const att of data.attachments) {
      const prefix = await readObjectPrefix("mail", att.key, SNIFF_PREFIX_BYTES);
      const result = sniff(prefix, att.filename);
      if (!result.ok) {
        await deleteObject("mail", att.key).catch(() => {});
        return { error: `${att.filename}: ${result.reason}` };
      }
    }
  }

  const addressOf = (ids: string[]) =>
    internalProfiles
      .filter((p) => ids.includes(p.id))
      .map((p) => p.mail_address)
      .filter((a): a is string => Boolean(a));

  const toAddresses = [...addressOf(data.to_profile_ids), ...data.to_external];
  const ccAddresses = [...addressOf(data.cc_profile_ids), ...data.cc_external];

  const bodyHtml = textToHtml(data.body) + SIGNATURE_HTML;
  const bodyText = data.body + SIGNATURE_TEXT;

  let inReplyTo: string | null = null;
  if (data.reply_to_id) {
    const { data: parent } = await supabase
      .from("mail_messages")
      .select("message_id")
      .eq("id", data.reply_to_id)
      .maybeSingle();
    inReplyTo = (parent as { message_id: string | null } | null)?.message_id ?? null;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("mail_messages")
    .insert({
      sender_profile_id: profile.id,
      direction: hasExternal ? "outbound" : "internal",
      from_address: profile.mail_address,
      from_name: profile.full_name,
      to_addresses: toAddresses,
      cc_addresses: ccAddresses,
      subject: data.subject,
      body_text: bodyText,
      body_html: bodyHtml,
      snippet: snippetOf(data.body),
      thread_key: threadKeyOf(data.subject),
      in_reply_to: inReplyTo,
      send_status: hasExternal ? "skipped" : null,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    console.error("[mail] insert failed", insertError);
    return { error: "Could not send the message." };
  }

  const recipientRows = [
    ...data.to_profile_ids.map((id) => ({ message_id: inserted.id, profile_id: id, kind: "to" as const })),
    ...data.cc_profile_ids.map((id) => ({ message_id: inserted.id, profile_id: id, kind: "cc" as const })),
  ];
  if (recipientRows.length) {
    const { error } = await supabase.from("mail_recipients").insert(recipientRows);
    // The message itself is already stored and (for internal-only mail)
    // already "delivered" in every sense that matters; a fan-out row
    // failing here would only hide it from that one recipient's inbox,
    // not lose it, so this logs rather than aborts.
    if (error) console.error("[mail] recipient fan-out failed", { messageId: inserted.id, error });
  }

  if (data.attachments.length) {
    const { error } = await supabase.from("mail_attachments").insert(
      data.attachments.map((a) => ({
        message_id: inserted.id,
        filename: a.filename,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
        r2_key: a.key,
      }))
    );
    if (error) console.error("[mail] attachment rows failed", { messageId: inserted.id, error });
  }

  let sendOutcome: "sent" | "skipped" | "failed" | null = null;
  if (hasExternal) {
    if (!isMailSendConfigured()) {
      sendOutcome = "skipped";
      await supabase
        .from("mail_messages")
        .update({ send_status: "skipped", send_error: "Mail sending is not configured for this deployment." })
        .eq("id", inserted.id);
    } else {
      const attachmentsForSend = await Promise.all(
        data.attachments.map(async (a) => ({
          filename: a.filename,
          mimeType: a.mime_type,
          content: await readObjectBase64("mail", a.key),
        }))
      );
      const result = await sendExternalMail({
        from: profile.mail_address,
        fromName: profile.full_name,
        to: data.to_external,
        cc: data.cc_external,
        subject: data.subject,
        html: bodyHtml,
        text: bodyText,
        attachments: attachmentsForSend,
      });
      sendOutcome = result.ok ? result.outcome : "failed";
      await supabase
        .from("mail_messages")
        .update({
          send_status: sendOutcome,
          send_error:
            sendOutcome === "sent"
              ? null
              : result.ok
                ? "The mail provider could not deliver this message."
                : "Could not reach the mail service — try again shortly.",
        })
        .eq("id", inserted.id);
    }
  }

  revalidatePath("/[locale]/(app)/mail", "page");
  return { ok: true, id: inserted.id, sendOutcome };
}

export async function markMailRead(input: unknown): Promise<{ ok: true } | { error: string }> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = parseInput(MarkMailReadSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase
    .from("mail_recipients")
    .update({ is_read: parsed.data.is_read })
    .in("message_id", parsed.data.message_ids)
    .eq("profile_id", auth.profile.id);

  if (error) return { error: "Could not update read status." };
  revalidatePath("/[locale]/(app)/mail", "page");
  return { ok: true };
}
