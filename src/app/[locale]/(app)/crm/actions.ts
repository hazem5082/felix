"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, STAFF_ROLES } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  CreateDealTicketSchema,
  CreateLeadInterestSchema,
  CreateLeadSchema,
  LeadCommentSchema,
  UpdateLeadInterestSchema,
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

  if (error) return toUserError(error);
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

  if (error) return toUserError(error);
  revalidatePath("/[locale]/(app)/crm/[leadId]", "page");
  return { ok: true };
}

/**
 * Records that a buyer wants a car, and what they will pay for it.
 *
 * Deliberately NOT a deal ticket. A ticket locks the vehicle, opens a
 * financing request and flips the lead to 'ticket_created'; none of that
 * should happen because somebody said they liked a car on the forecourt.
 * This is the cheap, reversible, many-per-lead record that was missing
 * between "car_interest: looking for a sedan" and a signed contract.
 */
export async function addLeadInterest(input: {
  lead_id: string;
  vehicle_id: string;
  wanted_make: string;
  wanted_model: string;
  wanted_year: string;
  budget_amount: string;
  origin: "requested" | "suggested";
  note: string;
}) {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateLeadInterestSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // Same reasoning as addLeadComment: the insert policy mirrors the lead's
  // own visibility, but a readable failure beats a bare RLS rejection.
  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("id", parsed.data.lead_id)
    .maybeSingle();
  if (!lead) return { error: "Unknown lead." };

  // Confirm the car is one this actor can actually see. No branch
  // assertion, unlike createDealTicket: a manager noting that a customer
  // wants a car sitting at another branch is how a transfer starts, and
  // nothing is reserved or committed by saying so.
  if (parsed.data.vehicle_id) {
    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("id")
      .eq("id", parsed.data.vehicle_id)
      .maybeSingle();
    if (!vehicle) return { error: "That vehicle is not available to you." };
  }

  const { error } = await supabase.from("lead_vehicle_interests").insert({
    lead_id: parsed.data.lead_id,
    vehicle_id: parsed.data.vehicle_id,
    wanted_make: parsed.data.wanted_make,
    wanted_model: parsed.data.wanted_model,
    wanted_year: parsed.data.wanted_year,
    budget_amount: parsed.data.budget_amount,
    origin: parsed.data.origin,
    note: parsed.data.note,
    created_by: auth.profile.id,
  });

  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/crm/[leadId]", "page");
  if (parsed.data.vehicle_id) revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
  revalidatePath("/[locale]/(app)/ceo", "page");
  return { ok: true };
}

/**
 * Moves an interest along. 'declined' is what takes it out of the CEO's
 * demand report — a buyer who walked away has to be able to leave it,
 * or the report only ever grows and stops being read.
 */
export async function setLeadInterestStatus(input: { id: string; status: string }) {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(UpdateLeadInterestSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("lead_vehicle_interests")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.id)
    .select("id")
    .maybeSingle();

  if (error) return toUserError(error);
  // RLS returns zero rows rather than an error when the row belongs to
  // another salesperson's lead, and an update that changed nothing would
  // otherwise report success.
  if (!data) return { error: "That record is not available to you." };

  revalidatePath("/[locale]/(app)/crm/[leadId]", "page");
  revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
  revalidatePath("/[locale]/(app)/ceo", "page");
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

  if (error) return toUserError(error);

  const ticketId = (data as { id: string }).id;

  // An installments deal has to reach the bank. The schema modelled this
  // from the start — financing_requests exists, with RLS letting the
  // salesperson open one and the accountant move it through review —
  // but nothing ever inserted the row, so the Accountant Hub's
  // "Financing Requests" table could never show anything and the whole
  // bank-approval workflow was a dead end.
  //
  // Deliberately not fatal: the ticket is already created and is the
  // record that matters. A failure here is logged and the accountant
  // can still work from the ticket itself.
  if (parsed.data.financing_type === "installments" && parsed.data.financing_partner_id) {
    const { error: reqError } = await supabase.from("financing_requests").insert({
      deal_ticket_id: ticketId,
      financing_partner_id: parsed.data.financing_partner_id,
      status: "submitted",
    });
    if (reqError) {
      console.error("[crm] financing request not opened", reqError.message);
    }
  }

  if (parsed.data.lead_id) {
    await supabase.from("leads").update({ status: "ticket_created" }).eq("id", parsed.data.lead_id);
  }

  revalidatePath("/[locale]/(app)/deals", "page");
  revalidatePath("/[locale]/(app)/crm", "page");
  revalidatePath("/[locale]/(app)/accountant", "page");
  return { id: ticketId };
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
