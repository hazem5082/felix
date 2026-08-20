"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, FINANCE_ROLES, STAFF_ROLES } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import { RecordEtaInvoiceSchema, SubmitEtaInvoiceSchema, parseInput } from "@/lib/validation";
import {
  listEtaSubmissions,
  previewEtaSubmission,
  submitTicketToEta,
  type EtaPreview,
} from "@/lib/eta/service";
import { getEtaMode } from "@/lib/eta/env";
import type { EtaMode } from "@/lib/eta/types";
import type { EtaSubmission } from "@/lib/supabase/types";
import type { ActionError } from "@/lib/validation";

/**
 * Record the Egyptian Tax Authority's identifiers on a contract after
 * the showroom submits the invoice on the ETA portal by hand. Recording
 * slots only — no ETA API integration lives here.
 *
 * FINANCE_ROLES (ceo, accountant) mirrors the database gate exactly:
 * migration 0024's contracts_eta_update policy admits
 * is_accountant_or_above(), and the tenant role's UPDATE grant is
 * column-limited to the four eta_* fields, so even this action could
 * not touch serial, pdf_url or unlocked_at. No branch assertion — the
 * accountant operates org-wide (canActOnBranch), and tax filings are an
 * org-level duty.
 */
export async function recordEtaInvoice(input: {
  ticketId: string;
  eta_uuid: string;
  eta_long_id: string;
  eta_submission_status: string;
  eta_submitted_at: string;
}) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(RecordEtaInvoiceSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // The contract row must already exist — it is minted by the approval
  // trigger, and an e-invoice for an unapproved deal is a category
  // error. A targeted read distinguishes "no such contract" from the
  // silent zero-row update RLS would otherwise produce.
  const { data: contract } = await supabase
    .from("contracts")
    .select("id")
    .eq("deal_ticket_id", parsed.data.ticketId)
    .maybeSingle();
  if (!contract) return { error: "This deal has no contract yet — it must be approved first." };

  const { error } = await supabase
    .from("contracts")
    .update({
      eta_uuid: parsed.data.eta_uuid,
      eta_long_id: parsed.data.eta_long_id,
      eta_submission_status: parsed.data.eta_submission_status,
      eta_submitted_at: parsed.data.eta_submitted_at,
    })
    .eq("deal_ticket_id", parsed.data.ticketId);
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");
  return { ok: true };
}

/**
 * What the panel needs to render the submission history (migration
 * 0034).
 *
 * A read, so STAFF_ROLES rather than FINANCE_ROLES: 0034's select
 * policy lets a branch manager see their own branch's submissions, and
 * the panel shows the timeline to whoever the database will show it to.
 * Nothing here can change anything.
 */
export async function loadEtaSubmissions(input: {
  ticketId: string;
}): Promise<{ submissions: EtaSubmission[]; mode: EtaMode } | ActionError> {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(SubmitEtaInvoiceSchema, input);
  if (!parsed.ok) return parsed.error;

  const result = await listEtaSubmissions(parsed.data.ticketId);
  if (!Array.isArray(result)) return result;
  // The mode travels with the list so the panel can show the Sandbox
  // badge before anybody opens a dialog — a demo acceptance must never
  // be mistaken for a filing, and the badge is what says so.
  return { submissions: result, mode: getEtaMode() };
}

/**
 * Build the document and report what it would say — totals, VAT, buyer,
 * item code — plus every blocker and warning, WITHOUT sending anything.
 *
 * FINANCE_ROLES, not STAFF_ROLES, even though it mutates nothing: the
 * preview discloses the buyer's national ID and the exact tax position
 * of the sale, which is the accountant's business and not the sales
 * floor's.
 */
export async function previewEtaInvoice(input: {
  ticketId: string;
}): Promise<EtaPreview | ActionError> {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(SubmitEtaInvoiceSchema, input);
  if (!parsed.ok) return parsed.error;

  return previewEtaSubmission(parsed.data.ticketId);
}

/**
 * File the e-invoice with the Egyptian Tax Authority.
 *
 * FINANCE_ROLES (ceo, accountant) — the same gate as the manual
 * transcription above, and the same one 0034's insert/update policies
 * enforce in the database (is_accountant_or_above()). A branch manager
 * can READ the resulting trail for their branch and cannot file.
 *
 * No branch assertion, for the reason recordEtaInvoice gives: tax
 * filing is an org-level duty and the accountant operates org-wide.
 *
 * The action carries no data beyond the ticket id. Every figure on the
 * document is derived server-side from the ticket, the vehicle, the
 * contract and the buyer, so there is nothing here for a hand-crafted
 * request to falsify.
 */
export async function submitEtaInvoice(input: { ticketId: string }) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(SubmitEtaInvoiceSchema, input);
  if (!parsed.ok) return parsed.error;

  const result = await submitTicketToEta(parsed.data.ticketId, auth.profile.id);
  revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");
  return result;
}
