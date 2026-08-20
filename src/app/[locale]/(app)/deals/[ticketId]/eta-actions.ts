"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, FINANCE_ROLES } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import { RecordEtaInvoiceSchema, parseInput } from "@/lib/validation";

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
