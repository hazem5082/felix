"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentTenantClaim } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate } from "@/lib/auth";
import { consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import { checkAttachmentBudget, sniff, SNIFF_PREFIX_BYTES } from "@/lib/file-sniff";
import { deleteObject, readObjectBase64, readObjectPrefix, statObjectSize } from "@/lib/r2";
import { isFelixMailAddress } from "@/lib/mail-address";
// The body helpers moved to lib/mail-body.ts when the end-of-day report
// (0053) became the second thing writing into mail_messages — see that
// module's header for why they must not be two copies.
import {
  SIGNATURE_HTML,
  SIGNATURE_TEXT,
  snippetOf,
  textToHtml,
  threadKeyOf,
} from "@/lib/mail-body";
import { externalMailPolicy } from "@/lib/mail-policy";
import { isMailSendConfigured, sendExternalMail, type SendMailOutcome } from "@/lib/mail-send";
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

  const parsed = await parseInput(MailComposeSchema, input);
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
  if (!throttle.allowed) return { error: await retryMessage(throttle.retryAfter) };

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

  // The Agentic portal's per-showroom switch for mail leaving FELIX.
  // Checked before anything is written, so a blocked send leaves no
  // half-message in Sent — unlike a delivery failure, which is a real
  // message that genuinely did not arrive and should be recorded as such.
  //
  // Only external recipients are gated. A message to colleagues never
  // reaches this branch, so a showroom switched off still has working
  // internal mail.
  const claim = await currentTenantClaim();
  if (hasExternal && claim) {
    const policy = await externalMailPolicy(claim.slug);
    if (!policy.allowed) {
      return {
        error:
          policy.message ??
          "Mailing addresses outside FELIX is switched off for this showroom. You can still mail colleagues. Contact 508.world if this is unexpected.",
      };
    }
  }

  if (data.attachments.length) {
    // OWNERSHIP BEFORE ANYTHING ELSE. A staged key is trusted for nothing
    // until its owner segment names the caller — the compose form is not
    // the only thing that can POST this action, and `mail/<uuid>_<name>`
    // keys are only as secret as the people who have seen them. Inbound
    // attachments (no owner segment) and anyone else's staged uploads are
    // refused here, which closes the one cross-tenant read the shared
    // bucket could otherwise leak.
    const ownedPrefix = `mail/${profile.id}/`;
    const foreign = data.attachments.filter((a) => !a.key.startsWith(ownedPrefix));
    if (foreign.length) {
      return { error: "One or more attachments were not uploaded by you. Re-attach them and try again." };
    }

    // TRUE SIZES. The budget was computed from client-supplied numbers;
    // HEAD each object and re-run against reality before a single byte
    // leaves for Resend. A missing object fails the send rather than
    // storing an attachment that 404s forever after.
    const realSizes: number[] = [];
    for (const att of data.attachments) {
      const size = await statObjectSize("mail", att.key);
      if (size === null) {
        return { error: `${att.filename}: the upload could not be found. Upload it again.` };
      }
      realSizes.push(size);
    }

    const budget = checkAttachmentBudget(realSizes, { hasExternalRecipient: hasExternal });
    if (!budget.ok) return { error: budget.reason };

    for (const att of data.attachments) {
      const prefix = await readObjectPrefix("mail", att.key, SNIFF_PREFIX_BYTES);
      const result = sniff(prefix, att.filename);
      if (!result.ok) {
        await deleteObject("mail", att.key).catch(() => {});
        return { error: `${att.filename}: ${result.reason}` };
      }
    }

    // The rows persist the VERIFIED sizes, never the claimed ones.
    data.attachments.forEach((att, i) => {
      att.size_bytes = realSizes[i];
    });
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

  let sendOutcome: SendMailOutcome | null = null;
  if (hasExternal) {
    // Delivery bookkeeping is written with the service-role client, not
    // the caller's.
    //
    // mail_messages is immutable to tenant roles on purpose (0039: no
    // update policy, and `grant select, insert` withholds the privilege
    // even if there were one) — a sent message is not something its
    // author gets to revise afterwards. But send_status/send_error are
    // not part of the message: they are what the server learned while
    // trying to hand it to Resend, and the sender neither wrote them nor
    // should be able to. Routing them through `supabase` meant every one
    // of these updates was refused and, because the result was never
    // checked, refused silently — so the row kept the "skipped" its
    // INSERT gave it and the UI said "Not delivered" no matter what had
    // actually happened.
    const bookkeeping = claim ? createAdminClient(claim.schema) : null;

    const record = async (status: SendMailOutcome, sendError: string | null) => {
      if (!bookkeeping) {
        console.error("[mail] no tenant schema for send status", { messageId: inserted.id });
        return;
      }
      const { error } = await bookkeeping
        .from("mail_messages")
        .update({ send_status: status, send_error: sendError })
        .eq("id", inserted.id);
      // Logged, not fatal. The message is stored and the send has
      // already either happened or not by this point, so losing the
      // status costs the sender an accurate badge, not the mail.
      if (error) console.error("[mail] send status update failed", { messageId: inserted.id, error });
    };

    if (!isMailSendConfigured()) {
      sendOutcome = "skipped";
      await record("skipped", "Mail sending is not configured for this deployment.");
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
      await record(
        sendOutcome,
        sendOutcome === "sent"
          ? null
          : result.ok
            ? "The mail provider could not deliver this message."
            : "Could not reach the mail service — try again shortly."
      );
    }
  }

  revalidatePath("/[locale]/(app)/mail", "page");
  return { ok: true, id: inserted.id, sendOutcome };
}

export async function markMailRead(input: unknown): Promise<{ ok: true } | { error: string }> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(MarkMailReadSchema, input);
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
