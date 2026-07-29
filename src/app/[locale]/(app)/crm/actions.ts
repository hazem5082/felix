"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { getProfile } from "@/lib/auth";

export async function createLead(input: {
  client_name: string;
  phone_number: string;
  car_interest: string;
  address: string;
  company_name: string;
  job_title: string;
  income: string;
  client_notes: string;
}) {
  const supabase = await createClient();
  const profile = await getProfile();
  if (!profile) return { error: "Not authenticated" };

  const { error } = await supabase.from("leads").insert({
    client_name: input.client_name,
    phone_number: input.phone_number,
    car_interest: input.car_interest || null,
    address: input.address || null,
    company_name: input.company_name || null,
    job_title: input.job_title || null,
    income: input.income ? parseFloat(input.income) : null,
    client_notes: input.client_notes || null,
    salesperson_id: profile.id,
    branch_id: profile.branch_id,
    source: "manual",
  });

  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function addLeadComment(input: {
  lead_id: string;
  body: string;
  contact_method: string;
}) {
  const supabase = await createClient();
  const profile = await getProfile();
  if (!profile) return { error: "Not authenticated" };

  const { error } = await supabase.from("lead_comments").insert({
    lead_id: input.lead_id,
    author_id: profile.id,
    body: input.body,
    contact_method: input.contact_method || null,
    contact_time: new Date().toISOString(),
  });

  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createDealTicket(input: {
  lead_id: string | null;
  vehicle_id: string;
  agreed_price: number;
  financing_type: "cash" | "installments";
  financing_partner_id: string | null;
  down_payment: number | null;
  discount_amount: number;
}) {
  const supabase = await createClient();
  const profile = await getProfile();
  if (!profile) return { error: "Not authenticated" };

  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("branch_id")
    .eq("id", input.vehicle_id)
    .single();

  const { data, error } = await supabase
    .from("deal_tickets")
    .insert({
      lead_id: input.lead_id,
      vehicle_id: input.vehicle_id,
      branch_id: (vehicle as { branch_id: string } | null)?.branch_id ?? profile.branch_id,
      salesperson_id: profile.id,
      agreed_price: input.agreed_price,
      financing_type: input.financing_type,
      financing_partner_id: input.financing_partner_id,
      down_payment: input.down_payment,
      discount_amount: input.discount_amount,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };
  if (input.lead_id) {
    await supabase.from("leads").update({ status: "ticket_created" }).eq("id", input.lead_id);
  }
  revalidatePath("/", "layout");
  return { id: (data as { id: string }).id };
}

export async function fetchActiveVehicles() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vehicles")
    .select("id, year, make, model, trim, purchase_price")
    .eq("status", "in_stock");
  return data ?? [];
}

export async function fetchActiveFinancingPartners() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("financing_partners")
    .select("id, bank_name, product_name, rate, term_months")
    .eq("status", "active");
  return data ?? [];
}
