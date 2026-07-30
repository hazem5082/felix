"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, STAFF_ROLES } from "@/lib/auth";
import {
  CreateDealTicketSchema,
  CreateLeadSchema,
  LeadCommentSchema,
  parseInput,
} from "@/lib/validation";

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
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateLeadSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("leads").insert({
    ...parsed.data,
    salesperson_id: auth.profile.id,
    branch_id: auth.profile.branch_id,
    source: "manual",
  });

  if (error) return { error: error.message };
  revalidatePath("/[locale]/(app)/crm", "page");
  return { ok: true };
}

export async function addLeadComment(input: {
  lead_id: string;
  body: string;
  contact_method: string;
}) {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(LeadCommentSchema, {
    ...input,
    contact_method: input.contact_method || null,
  });
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // Confirm the lead is actually visible to this actor before writing to it.
  // RLS on lead_comments only checked `is_staff()`, so without this a
  // salesperson could inject notes onto another branch's leads.
  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("id", parsed.data.lead_id)
    .maybeSingle();
  if (!lead) return { error: "Unknown lead." };

  const { error } = await supabase.from("lead_comments").insert({
    lead_id: parsed.data.lead_id,
    author_id: auth.profile.id,
    body: parsed.data.body,
    contact_method: parsed.data.contact_method,
    contact_time: new Date().toISOString(),
  });

  if (error) return { error: error.message };
  revalidatePath("/[locale]/(app)/crm/[leadId]", "page");
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
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateDealTicketSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("id, branch_id, status")
    .eq("id", parsed.data.vehicle_id)
    .maybeSingle();

  const v = vehicle as { id: string; branch_id: string; status: string } | null;

  // The original fell back to the caller's own branch when this lookup came
  // back empty, which quietly stamped another branch's vehicle as ours.
  if (!v) return { error: "That vehicle is not available to you." };

  const branchError = assertBranch(auth.profile, v.branch_id);
  if (branchError) return branchError;

  if (v.status !== "in_stock") {
    return { error: "That vehicle is no longer in stock." };
  }

  const { data, error } = await supabase
    .from("deal_tickets")
    .insert({
      lead_id: parsed.data.lead_id,
      vehicle_id: parsed.data.vehicle_id,
      branch_id: v.branch_id,
      salesperson_id: auth.profile.id,
      agreed_price: parsed.data.agreed_price,
      financing_type: parsed.data.financing_type,
      financing_partner_id: parsed.data.financing_partner_id,
      down_payment: parsed.data.down_payment,
      discount_amount: parsed.data.discount_amount,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  if (parsed.data.lead_id) {
    await supabase.from("leads").update({ status: "ticket_created" }).eq("id", parsed.data.lead_id);
  }

  revalidatePath("/[locale]/(app)/deals", "page");
  revalidatePath("/[locale]/(app)/crm", "page");
  return { id: (data as { id: string }).id };
}

export async function fetchActiveVehicles() {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return [];

  const supabase = await createClient();
  // RLS already scopes this to the caller's branch (plus org-wide roles).
  const { data } = await supabase
    .from("vehicles")
    .select("id, year, make, model, trim, purchase_price")
    .eq("status", "in_stock")
    .order("created_at", { ascending: false })
    .limit(500);
  return data ?? [];
}

export async function fetchActiveFinancingPartners() {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("financing_partners")
    .select("id, bank_name, product_name, rate, term_months")
    .eq("status", "active")
    .order("bank_name");
  return data ?? [];
}
