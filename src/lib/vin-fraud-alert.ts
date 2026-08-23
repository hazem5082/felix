import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendExternalMail } from "@/lib/mail-send";

/**
 * FraudRadar — the automated "this VIN doesn't match this car" alert to
 * a showroom's CEO. Fires automatically from createVehicle() (intake)
 * and saveVinDecodedDetails() (re-decode of an existing car) whenever
 * vinMakeMismatch() (lib/vin-match.ts) trips — no button press required;
 * both call sites decode the VIN themselves server-side rather than
 * trusting whatever a client claims it decoded to.
 *
 * TWO DELIVERIES, ONE ALERT
 * -------------------------
 *   1. INTERNAL — a row in this tenant's own mail_messages/
 *      mail_recipients (migration 0042's is_system flag), so the alert
 *      shows up inside FELIX itself: a distinctly coloured, shield-
 *      iconed row in the CEO's inbox (mail-client.tsx), with a real
 *      clickable button to the vehicle — not just a plain-text link.
 *   2. EXTERNAL — sendExternalMail() to the CEO's real inbox, best-
 *      effort, so the alert reaches them even when they are not looking
 *      at FELIX at all.
 *
 * Losing #2 (mail channel unconfigured, Resend rejects it, the CEO has
 * no notification_email) must never take #1 down with it, and vice
 * versa — a CEO who never checks external mail should still see this
 * the next time they open FELIX. Each delivery is attempted and logged
 * independently.
 *
 * WHY THIS BYPASSES mail/actions.ts's sendMail() AND externalMailPolicy()
 * -------------------------------------------------------------------
 * sendMail() is the human-composes-a-message path: it rate-limits and
 * inserts under the SENDING user's own RLS session — neither fits a
 * system-generated alert with no logged-in "FraudRadar" profile to be
 * that sender. externalMailPolicy() (a showroom's own "no external
 * mail" switch) is deliberately not consulted either: a fraud alert that
 * toggle could silently swallow would defeat the point of having one.
 *
 * A SERVICE-ROLE LOOKUP AND WRITE, ON PURPOSE. The caller is inside an
 * authenticated request, but whether that actor's RLS session can read
 * another profile's notification_email — or write a message with no
 * sender at all — is not something this function should depend on.
 * createAdminClient(schemaName) is scoped to the one tenant the caller
 * already resolved via getTenant(); it is also the ONLY way an
 * is_system row can ever be created (0042's grant excludes that column
 * from the tenant role entirely, so no signed-in session could forge one
 * even if it tried).
 */

const FRAUD_RADAR_FROM = "FraudRadar@felixmail.508.world";
const FRAUD_RADAR_NAME = "FELIX FraudRadar";

export interface SuspiciousVinAlertInput {
  /** t_<slug> — from getTenant(), never taken from user input. */
  schemaName: string;
  /** <slug>-felix.508.world is this tenant's own host. */
  tenantSlug: string;
  vehicleId: string;
  vin: string;
  recordedMake: string;
  recordedModel: string;
  decodedMake: string;
  decodedModel: string | null;
  locale: string;
}

export async function sendSuspiciousVinAlert(input: SuspiciousVinAlertInput): Promise<void> {
  const admin = createAdminClient(input.schemaName);
  const { data: ceos } = await admin
    .from("profiles")
    .select("id, notification_email, mail_address")
    .eq("role", "ceo");

  const ceoRows = (ceos ?? []) as { id: string; notification_email: string | null; mail_address: string | null }[];
  if (ceoRows.length === 0) return;

  const link = `https://${input.tenantSlug}-felix.508.world/${input.locale}/inventory/${input.vehicleId}`;
  const recordedVehicle = `${input.recordedMake} ${input.recordedModel}`.trim();
  const decodedVehicle = [input.decodedMake, input.decodedModel].filter(Boolean).join(" ");
  const subject = `Suspicious VIN detected — ${recordedVehicle}`;
  const html = buildHtml({ vin: input.vin, recordedVehicle, decodedVehicle, link });
  const text = buildText({ vin: input.vin, recordedVehicle, decodedVehicle, link });
  const snippet = `FELIX detected a VIN that doesn't match this vehicle's recorded make.`;

  // ── 1. INTERNAL — the CEO's own FELIX Mail inbox ──────────────
  const internalTo = ceoRows.map((c) => c.mail_address).filter((a): a is string => Boolean(a));
  if (internalTo.length > 0) {
    const { data: message, error: insertError } = await admin
      .from("mail_messages")
      .insert({
        sender_profile_id: null,
        direction: "internal",
        from_address: FRAUD_RADAR_FROM,
        from_name: FRAUD_RADAR_NAME,
        to_addresses: internalTo,
        cc_addresses: [],
        subject,
        body_text: text,
        body_html: html,
        snippet,
        send_status: "sent",
        is_system: true,
      })
      .select("id")
      .single();

    if (insertError || !message) {
      console.error(`[vin-fraud-alert] internal insert failed for vehicle ${input.vehicleId}: ${insertError?.message}`);
    } else {
      const { error: fanOutError } = await admin
        .from("mail_recipients")
        .insert(ceoRows.map((c) => ({ message_id: message.id, profile_id: c.id, kind: "to" as const })));
      if (fanOutError) {
        console.error(`[vin-fraud-alert] recipient fan-out failed for vehicle ${input.vehicleId}: ${fanOutError.message}`);
      } else {
        console.log(`[vin-fraud-alert] internal message ${message.id} delivered to ${ceoRows.length} CEO(s)`);
      }
    }
  }

  // ── 2. EXTERNAL — best-effort, reaches an inbox even outside FELIX ──
  // notification_email ONLY — never fall back to mail_address here. That
  // address is already covered by the internal message above, and
  // mailing it a second time round-trips through Cloudflare Email
  // Routing -> the inbound webhook -> a SECOND, unstyled mail_messages
  // row (direction='inbound', is_system defaults false, since the
  // inbound path lives in the separate 508.world Worker repo and knows
  // nothing about this feature). Confirmed the hard way: testing this
  // against a CEO with no notification_email produced exactly that
  // duplicate every time.
  const externalTo = ceoRows.map((c) => c.notification_email).filter((e): e is string => Boolean(e));
  if (externalTo.length > 0) {
    const result = await sendExternalMail({
      from: FRAUD_RADAR_FROM,
      fromName: FRAUD_RADAR_NAME,
      to: externalTo,
      cc: [],
      subject,
      html,
      text,
      attachments: [],
    });

    if (!result.ok) {
      console.error(`[vin-fraud-alert] external send failed for vehicle ${input.vehicleId}: ${result.error}`);
    } else if (result.outcome !== "sent") {
      console.warn(`[vin-fraud-alert] external send outcome "${result.outcome}" for vehicle ${input.vehicleId}`);
    } else {
      console.log(`[vin-fraud-alert] external mail sent for vehicle ${input.vehicleId} to ${externalTo.join(", ")}`);
    }
  }
}

// A full-bleed tinted wrapper, not just a coloured accent bar — "a
// different background than any other email" was explicit feedback:
// this has to read as visually distinct even inside a plain external
// inbox (Gmail/Outlook), which gives a sender no way to colour the
// LIST row itself, only the message body. The 🛡 glyph is deliberately
// the only "icon" — a Lucide component (used for the in-app inbox row)
// cannot be embedded in an email client, and a photographic or SVG
// graphic would read as marketing rather than a system notice.
function buildHtml(args: { vin: string; recordedVehicle: string; decodedVehicle: string; link: string }): string {
  return `
<div style="background:#fdf1f1;padding:24px;">
<div dir="auto" style="max-width:520px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a2233;background:#ffffff;border:1px solid #f3c6c6;border-radius:10px;padding:24px;">
  <div style="border-left:4px solid #d33b3b;padding:4px 0 4px 14px;margin-bottom:18px;">
    <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#d33b3b;">
      🛡 FraudRadar Alert
    </p>
    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#1a2233;">
      Suspicious VIN detected
    </p>
  </div>
  <p style="margin:0 0 14px;">
    FELIX's system detected a VIN that does not match the vehicle it is recorded against.
  </p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px;border-collapse:collapse;font-size:13px;">
    <tr>
      <td style="padding:6px 12px;border:1px solid #e3e7ee;background:#f7f8fa;color:#667085;width:40%;">VIN</td>
      <td style="padding:6px 12px;border:1px solid #e3e7ee;font-family:monospace;" dir="ltr">${escapeHtml(args.vin)}</td>
    </tr>
    <tr>
      <td style="padding:6px 12px;border:1px solid #e3e7ee;background:#f7f8fa;color:#667085;">Recorded as</td>
      <td style="padding:6px 12px;border:1px solid #e3e7ee;">${escapeHtml(args.recordedVehicle)}</td>
    </tr>
    <tr>
      <td style="padding:6px 12px;border:1px solid #e3e7ee;background:#f7f8fa;color:#667085;">VIN decodes to</td>
      <td style="padding:6px 12px;border:1px solid #e3e7ee;">${escapeHtml(args.decodedVehicle || "—")}</td>
    </tr>
  </table>
  <p style="margin:0 0 20px;">
    This can mean a data-entry mistake, a chassis plate swap, or an attempt to register one
    vehicle's paperwork against a different vehicle. Worth a look before this car is sold.
  </p>
  <a href="${args.link}"
     style="display:inline-block;background:#d33b3b;color:#ffffff;text-decoration:none;
            padding:12px 22px;border-radius:6px;font-weight:600;font-size:14px;">
    View this vehicle in FELIX
  </a>
  <div style="margin-top:28px;padding-top:12px;border-top:1px solid #e3e7ee;font-size:12px;color:#667085;">
    Sent automatically by FELIX FraudRadar — this mailbox does not accept replies.
  </div>
</div>
</div>`.trim();
}

function buildText(args: { vin: string; recordedVehicle: string; decodedVehicle: string; link: string }): string {
  return [
    "FraudRadar Alert — Suspicious VIN detected",
    "",
    "FELIX's system detected a VIN that does not match the vehicle it is recorded against.",
    "",
    `VIN: ${args.vin}`,
    `Recorded as: ${args.recordedVehicle}`,
    `VIN decodes to: ${args.decodedVehicle || "—"}`,
    "",
    "This can mean a data-entry mistake, a chassis plate swap, or an attempt to register one",
    "vehicle's paperwork against a different vehicle. Worth a look before this car is sold.",
    "",
    `View this vehicle: ${args.link}`,
    "",
    "Sent automatically by FELIX FraudRadar — this mailbox does not accept replies.",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
