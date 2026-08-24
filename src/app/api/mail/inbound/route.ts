import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { putObject } from "@/lib/r2";
import { sniff, SNIFF_PREFIX_BYTES, MAX_ATTACHMENT_BYTES } from "@/lib/file-sniff";
import { authenticateWebhook } from "@/lib/webhook-auth";

/**
 * The 508.world Worker -> FILEX bridge for mail arriving at
 * *@felixmail.508.world from the outside world.
 *
 * Mirrors POST /api/provision's shape exactly (bearer shared secret,
 * service-role client, no session involved) — this door has no user
 * behind it either, only the Worker holding FELIX_MAIL_SECRET. See
 * migration 0039's file header for why the directory lookup below has
 * to happen here rather than in the Worker: the Worker holds no
 * credentials for this Supabase project at all, by design.
 *
 * WHAT HAPPENS TO AN ADDRESS THAT DOES NOT EXIST
 *
 * 404. The Worker interprets that as "reject the SMTP transaction",
 * not "retry" — an unknown recipient is permanent, and Cloudflare
 * Email Routing would otherwise hammer this endpoint with the same
 * dead letter for days. Any OTHER non-2xx (a DB error, this route
 * throwing) is what the Worker treats as retry-worthy, because that
 * kind of failure is plausibly transient — see the Worker's own
 * handleInboundFelixMail() for the throw-to-retry mechanics.
 */

const AttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().max(200).optional(),
  /** base64, no data: prefix. Bounded at the raw-body level before any
   * decode is attempted — 25 MB of bytes is ~34 MB of base64. */
  content: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES * 1.37)),
});

const InboundSchema = z.object({
  to: z.string().trim().toLowerCase().email(),
  from: z.string().trim().max(320),
  from_name: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(500).optional(),
  text: z.string().max(1_000_000).optional(),
  html: z.string().max(2_000_000).optional(),
  message_id: z.string().trim().max(998).optional(),
  in_reply_to: z.string().trim().max(998).optional(),
  occurred_at: z.string().datetime().optional(),
  attachments: z.array(AttachmentSchema).max(50).default([]),
});

// Same clamp philosophy as the Agent Portal's mail.js — a stranger's
// HTML can run to megabytes, and this schema has no interest in storing
// all of it just to render a snippet and a reading pane.
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 512 * 1024;

function clampBytes(value: string | undefined, limit: number): string | null {
  if (!value) return null;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return value;
  return Buffer.from(value, "utf8").subarray(0, limit).toString("utf8") + "\n\n[truncated]";
}

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

export async function POST(request: Request) {
  // Shared-secret auth, HMAC-signed when the router has been upgraded
  // (see webhook-auth.ts). On success `body` holds the raw request text —
  // the HMAC branch consumes the stream verifying it.
  const verified = await authenticateWebhook(request, "FELIX_MAIL_SECRET", "mail/inbound");
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(verified.body);
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  const parsed = InboundSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid inbound mail payload" },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const platform = createAdminClient("platform");
  const { data: directoryRow } = await platform
    .from("mail_addresses")
    .select("tenant_schema, profile_id")
    .eq("address", body.to)
    .maybeSingle();

  if (!directoryRow) {
    // Permanent, not transient — see the file header. 404 tells the
    // Worker to reject the SMTP transaction rather than retry.
    return NextResponse.json({ error: "No such FELIX mail address" }, { status: 404 });
  }
  const { tenant_schema: schema, profile_id: profileId } = directoryRow as {
    tenant_schema: string;
    profile_id: string;
  };

  const tenant = createAdminClient(schema);

  const occurredAt = body.occurred_at ?? new Date().toISOString();
  const subject = body.subject || "(no subject)";
  const bodyText = clampBytes(body.text, MAX_TEXT_BYTES);
  const bodyHtml = clampBytes(body.html, MAX_HTML_BYTES);

  const { data: inserted, error: insertError } = await tenant
    .from("mail_messages")
    .insert({
      sender_profile_id: null,
      direction: "inbound",
      from_address: body.from,
      from_name: body.from_name || null,
      to_addresses: [body.to],
      cc_addresses: [],
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      snippet: snippetOf(bodyText || subject),
      thread_key: threadKeyOf(subject),
      message_id: body.message_id || null,
      in_reply_to: body.in_reply_to || null,
      occurred_at: occurredAt,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    // A duplicate message_id (0055's unique index) means the Worker is
    // retrying a delivery we already stored — Cloudflare Email Routing
    // retries on any non-2xx, so answering 500 here would loop forever.
    // Report success with the row we already have; mail is idempotent
    // per (tenant, inbound message_id).
    if (insertError?.code === "23505" && body.message_id) {
      const { data: existing } = await tenant
        .from("mail_messages")
        .select("id")
        .eq("message_id", body.message_id)
        .eq("direction", "inbound")
        .limit(1)
        .maybeSingle();
      if (existing) {
        console.warn("[mail/inbound] duplicate delivery ignored", { messageId: body.message_id });
        return NextResponse.json({ ok: true, id: (existing as { id: string }).id, duplicate: true });
      }
    }

    // Otherwise thrown rather than a clean 4xx: a DB hiccup is exactly the
    // kind of transient failure the Worker should retry, and Cloudflare
    // Email Routing's own retry/backoff is a better recovery path here
    // than anything this route could build itself.
    console.error("[mail/inbound] storing message failed", insertError);
    throw new Error(`Could not store inbound mail for ${body.to}: ${insertError?.message}`);
  }

  const { error: recipientError } = await tenant
    .from("mail_recipients")
    .insert({ message_id: inserted.id, profile_id: profileId, kind: "to", is_read: false });
  if (recipientError) {
    console.error("[mail/inbound] recipient fan-out failed", { messageId: inserted.id, error: recipientError });
  }

  // Attachments: sniffed and stored AFTER the message row exists, and
  // never fatal to the request — the message itself is safely stored
  // by this point, and one bad attachment must not be the reason the
  // whole email disappears. A part that fails the sniff is dropped
  // silently rather than stored as a lie about what it is.
  for (const att of body.attachments) {
    try {
      const bytes = Buffer.from(att.content, "base64");
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;

      const result = sniff(bytes.subarray(0, SNIFF_PREFIX_BYTES), att.filename);
      if (!result.ok) {
        console.warn("[mail/inbound] dropped attachment failing sniff", {
          messageId: inserted.id,
          filename: att.filename,
          reason: result.reason,
        });
        continue;
      }

      const { key } = await putObject("mail", att.filename, bytes, result.mimeType);
      const { error } = await tenant.from("mail_attachments").insert({
        message_id: inserted.id,
        filename: att.filename,
        mime_type: result.mimeType,
        size_bytes: bytes.length,
        r2_key: key,
      });
      if (error) console.error("[mail/inbound] attachment row failed", { messageId: inserted.id, error });
    } catch (err) {
      console.error("[mail/inbound] attachment processing failed", { messageId: inserted.id, err });
    }
  }

  return NextResponse.json({ ok: true, id: inserted.id });
}
