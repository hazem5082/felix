"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { WaterfallPreview } from "@/lib/supabase/types";

export async function updateChecklist(
  ticketId: string,
  checklist: Partial<{
    financial_check_passed: boolean;
    discount_validated: boolean;
    rate_revalidated: boolean;
  }>
) {
  const supabase = await createClient();
  const { error } = await supabase.from("deal_tickets").update(checklist).eq("id", ticketId);
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function approveTicket(ticketId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("deal_tickets").update({ status: "approved" }).eq("id", ticketId);
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function rejectTicket(ticketId: string, reason: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("deal_tickets")
    .update({ status: "rejected", rejection_reason: reason })
    .eq("id", ticketId);
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function executeSale(ticketId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("execute_vehicle_sale", { p_deal_ticket_id: ticketId });
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true, result: data };
}

export async function fetchWaterfallPreview(vehicleId: string, agreedPrice: number, discount: number) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("preview_vehicle_sale_waterfall", {
    p_vehicle_id: vehicleId,
    p_agreed_price: agreedPrice,
    p_discount: discount,
  });
  if (error) return null;
  return data as WaterfallPreview;
}
