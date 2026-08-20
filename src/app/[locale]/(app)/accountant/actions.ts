"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, FINANCE_ROLES } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  CreateFinancingPartnerSchema,
  FinancingRequestStatusSchema,
  MarkPayoutPaidSchema,
  OverheadSchema,
  Uuid,
  parseInput,
} from "@/lib/validation";
import { isManagedUploadUrl } from "@/lib/r2";

const MANAGER_OR_FINANCE = [...FINANCE_ROLES, "branch_manager"] as const;

export async function createFinancingPartner(input: {
  bank_name: string;
  product_name: string;
  rate: string;
  term_months: string;
  min_down_payment: string;
  contract_file_url: string | null;
}) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateFinancingPartnerSchema, input);
  if (!parsed.ok) return parsed.error;

  // The whole point of the gate is that a partner cannot go active until a
  // real bank contract has been uploaded. Accepting any truthy string meant
  // "-" was enough to activate one, so require a URL we actually issued.
  const url = parsed.data.contract_file_url;
  if (url && !isManagedUploadUrl(url, "financing-contracts")) {
    return { error: "The contract file must be uploaded through this application." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("financing_partners").insert({
    bank_name: parsed.data.bank_name,
    product_name: parsed.data.product_name,
    rate: parsed.data.rate,
    term_months: parsed.data.term_months,
    min_down_payment: parsed.data.min_down_payment,
    contract_file_url: url,
    status: url ? "active" : "pending_upload",
    created_by: auth.profile.id,
  });
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/accountant", "page");
  return { ok: true };
}

export async function attachContractFile(partnerId: string, url: string) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(partnerId);
  if (!id.success) return { error: "Unknown financing partner." };

  if (!isManagedUploadUrl(url, "financing-contracts")) {
    return { error: "The contract file must be uploaded through this application." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("financing_partners")
    .update({ contract_file_url: url, status: "active" })
    .eq("id", id.data);
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/accountant", "page");
  return { ok: true };
}

export async function updateFinancingRequestStatus(requestId: string, status: string) {
  const auth = await authorize([...MANAGER_OR_FINANCE]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(FinancingRequestStatusSchema, { requestId, status });
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // A financing request belongs to a deal ticket, which belongs to a branch.
  // Without this a manager could record a bank decision on another branch's
  // deal, which that branch would then act on.
  const { data: request } = await supabase
    .from("financing_requests")
    .select("id, deal_tickets(branch_id)")
    .eq("id", parsed.data.requestId)
    .maybeSingle();

  const r = request as { id: string; deal_tickets?: { branch_id: string } } | null;
  if (!r) return { error: "Unknown financing request." };

  const branchError = await assertBranch(auth.profile, r.deal_tickets?.branch_id ?? null);
  if (branchError) return branchError;

  const { error } = await supabase
    .from("financing_requests")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.requestId);
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/accountant", "page");
  return { ok: true };
}

/**
 * Records that the showroom has paid the owner of a consigned car
 * (migration 0032).
 *
 * FINANCE_ROLES, matching the RLS exactly: consignment_payouts_update is
 * `is_accountant_or_above()`, which is CEO or accountant. No
 * assertBranch — paying the consignors is one desk's job for the whole
 * group, and the policy has no branch predicate to mirror. That is the
 * same shape as the ledger the accountant already reads org-wide.
 *
 * The amounts are deliberately not settable. They were computed inside
 * execute_vehicle_sale() from a price a manager approved; an accountant
 * marks a debt paid, they do not re-price it. There is no unpay, either:
 * the row has no DELETE policy and the tenant role holds no DELETE
 * privilege, and a payment recorded in error is corrected by a note on
 * the next one, not by erasure.
 */
export async function markPayoutPaid(input: {
  payout_id: string;
  settlement_method: "bank_transfer" | "cheque" | "instapay" | "cash";
  settlement_reference: string | null;
  note: string | null;
}) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(MarkPayoutPaidSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("consignment_payouts")
    .update({
      paid_at: new Date().toISOString(),
      settlement_method: parsed.data.settlement_method,
      settlement_reference: parsed.data.settlement_reference,
      note: parsed.data.note,
    })
    .eq("id", parsed.data.payout_id)
    // Marking an already-paid payout paid again would silently rewrite
    // the date and the reference on a settled debt, which is the one
    // edit this table must not lose.
    .is("paid_at", null)
    .select("id")
    .maybeSingle();

  if (error) return toUserError(error);
  // RLS returns zero rows rather than an error for a payout the caller
  // cannot see, and the `is null` filter above matches nothing for one
  // already settled. Both deserve a sentence rather than a false success.
  if (!data) return { error: "That payout is not available, or has already been settled." };

  revalidatePath("/[locale]/(app)/accountant", "page");
  return { ok: true };
}

export async function upsertOverhead(branchId: string, monthlyOpex: number) {
  // Overhead is applied retroactively to every unsold vehicle in the branch,
  // so it changes what every equity holder is paid. CEO only.
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(OverheadSchema, { branchId, monthlyOpex });
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("overhead_config").upsert({
    branch_id: parsed.data.branchId,
    monthly_opex_amount: parsed.data.monthlyOpex,
    updated_at: new Date().toISOString(),
  });
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/accountant", "page");
  return { ok: true };
}
