"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function createFinancingPartner(input: {
  bank_name: string;
  product_name: string;
  rate: string;
  term_months: string;
  min_down_payment: string;
  contract_file_url: string | null;
}) {
  const supabase = await createClient();
  const { error } = await supabase.from("financing_partners").insert({
    bank_name: input.bank_name,
    product_name: input.product_name,
    rate: input.rate ? parseFloat(input.rate) : null,
    term_months: input.term_months ? parseInt(input.term_months, 10) : null,
    min_down_payment: input.min_down_payment ? parseFloat(input.min_down_payment) : null,
    contract_file_url: input.contract_file_url,
    status: input.contract_file_url ? "active" : "pending_upload",
  });
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function attachContractFile(partnerId: string, url: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("financing_partners")
    .update({ contract_file_url: url, status: "active" })
    .eq("id", partnerId);
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateFinancingRequestStatus(requestId: string, status: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("financing_requests").update({ status }).eq("id", requestId);
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function upsertOverhead(branchId: string, monthlyOpex: number) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("overhead_config")
    .upsert({ branch_id: branchId, monthly_opex_amount: monthlyOpex, updated_at: new Date().toISOString() });
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}
