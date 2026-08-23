import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendExternalMail } from "@/lib/mail-send";

/**
 * FraudRadar — the automated "this VIN doesn't match this car" alert to
 * a showroom's CEO. Fires from createVehicle() (intake) and
 * saveVinDecodedDetails() (re-decode of an existing car) whenever
 * vinMakeMismatch() (lib/vin-match.ts) trips.
 *
 * WHY sendExternalMail() DIRECTLY, NOT mail/actions.ts's sendMail()
 * ---------------------------------------------------------------
 * sendMail() is the human-composes-a-message path: it rate-limits,
 * checks externalMailPolicy() (a showroom's own "no external mail"
 * switch), and inserts a row into mail_messages under the SENDING
 * user's RLS session — none of which fits a system-generated security
 * alert with no logged-in "FraudRadar" profile to be that sender.
 *
 * Deliberately bypassing externalMailPolicy() is the correct call here,
 * not an oversight: a fraud alert that a showroom's own external-mail
 * toggle could silently swallow would defeat the point of having one.
 * This never touches mail_messages either, so it will not appear in the
 * tenant's internal Mail inbox UI — it is a pure outbound notification,
 * the same class of thing sendExternalMail() already serves for mail
 * leaving a tenant.
 *
 * RECIPIENT: a CEO's notification_email (their real external inbox —
 * migration 0007) when set, falling back to their felixmail.508.world
 * mail_address otherwise. notification_email is preferred because it is
 * guaranteed to reach an inbox someone actually reads; whether mail sent
 * TO a felixmail.508.world address round-trips through inbound routing
 * is unverified (see felix-mail memory), so it is a best-effort fallback
 * rather than the primary path.
 *
 * A SERVICE-ROLE LOOKUP, ON PURPOSE. The caller is inside an
 * authenticated request (a branch manager or the CEO running a decode),
 * but whether that actor's RLS session can read another profile's
 * notification_email is not something this function should depend on —
 * finding "who to alert about a security event" is the app's own job,
 * not the acting user's, so it runs as service_role via
 * createAdminClient(schemaName), scoped to the one tenant schema the
 * caller already resolved via getTenant().
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
    .select("notification_email, mail_address")
    .eq("role", "ceo");

  const recipients = ((ceos ?? []) as { notification_email: string | null; mail_address: string | null }[])
    .map((c) => c.notification_email || c.mail_address)
    .filter((e): e is string => Boolean(e));
  if (recipients.length === 0) return;

  const link = `https://${input.tenantSlug}-felix.508.world/${input.locale}/inventory/${input.vehicleId}`;
  const recordedVehicle = `${input.recordedMake} ${input.recordedModel}`.trim();
  const decodedVehicle = [input.decodedMake, input.decodedModel].filter(Boolean).join(" ");

  const result = await sendExternalMail({
    from: FRAUD_RADAR_FROM,
    fromName: FRAUD_RADAR_NAME,
    to: recipients,
    cc: [],
    subject: `Suspicious VIN detected — ${recordedVehicle}`,
    html: buildHtml({ ...input, link, recordedVehicle, decodedVehicle }),
    text: buildText({ ...input, link, recordedVehicle, decodedVehicle }),
    attachments: [],
  });

  // sendExternalMail() reports failure as a result, not a thrown
  // exception — a bare await here would let a "skipped" (mail channel
  // unconfigured) or "failed" (Resend rejected it) outcome disappear
  // with no trace, which defeats the point of a fraud alert existing.
  if (!result.ok) {
    console.error(`[vin-fraud-alert] send failed for vehicle ${input.vehicleId}: ${result.error}`);
  } else if (result.outcome !== "sent") {
    console.warn(`[vin-fraud-alert] send outcome "${result.outcome}" for vehicle ${input.vehicleId}`);
  } else {
    console.log(`[vin-fraud-alert] sent for vehicle ${input.vehicleId} to ${recipients.join(", ")}`);
  }
}

function buildHtml(args: {
  vin: string;
  recordedVehicle: string;
  decodedVehicle: string;
  link: string;
}): string {
  return `
<div dir="auto" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a2233;">
  <div style="border-left:4px solid #d33b3b;padding:4px 0 4px 14px;margin-bottom:18px;">
    <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#d33b3b;">
      FraudRadar Alert
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
