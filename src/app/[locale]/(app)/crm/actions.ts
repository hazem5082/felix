"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, STAFF_ROLES } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import { findCustomerCandidates, linkLeadToCustomer } from "@/lib/customer-link";
import { decideCustomerLink } from "@/lib/customer-match";
import {
  CreateDealTicketSchema,
  CreateLeadInterestSchema,
  CreateLeadSchema,
  CustomerLookupSchema,
  LeadCommentSchema,
  UpdateLeadInterestSchema,
  UpdateLeadInterestStatusSchema,
  UpdateLeadSchema,
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
  client_note_points: string[];
  // Buyer identity (0020) — "" collapses to null in the schema, and a
  // non-empty national ID must be the 14 digits the DB CHECK demands.
  national_id: string;
  nationality: string;
}) {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateLeadSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .insert({
      ...parsed.data,
      salesperson_id: auth.profile.id,
      branch_id: auth.profile.branch_id,
      source: "manual",
    })
    .select("id")
    .single();

  if (error) return toUserError(error);

  // The identity behind the enquiry (0031). Runs after the insert and
  // never fails the action: the lead is the record that matters, and a
  // deployment still on 0030 has no customers table to write to. See
  // lib/customer-link.ts for why this is here and not in a trigger.
  await linkLeadToCustomer(supabase, (data as { id: string }).id, {
    full_name: parsed.data.client_name,
    phone_number: parsed.data.phone_number,
    national_id: parsed.data.national_id,
    address: parsed.data.address,
    nationality: parsed.data.nationality,
  });

  revalidatePath("/[locale]/(app)/crm", "page");
  return { ok: true };
}

/**
 * "Have we met this person before?", asked while the Add Lead dialog is
 * still open (migration 0031).
 *
 * NON-BLOCKING BY DESIGN. It returns a name to show above the form and
 * nothing else — it does not pre-fill fields, does not change what gets
 * saved, and cannot refuse a save. The link itself is decided again,
 * server-side, by createLead: this probe is a courtesy, and a courtesy
 * that could block the counter would be worse than no courtesy.
 *
 * Returns only `full_name`. Deliberately not the customer's other leads,
 * their tickets or what they paid — the dialog's job is to stop a
 * salesperson typing a duplicate, and everything beyond the name is on
 * the lead page afterwards, behind the reader's own RLS.
 */
export async function lookupCustomerForLead(input: {
  national_id: string;
  phone_number: string;
}): Promise<{ full_name: string } | null> {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return null;

  const parsed = parseInput(CustomerLookupSchema, input);
  if (!parsed.ok) return null;
  if (!parsed.data.national_id && !parsed.data.phone_number) return null;

  const supabase = await createClient();
  const candidates = await findCustomerCandidates(supabase, parsed.data);
  if (!candidates?.length) return null;

  // The same decision createLead will make, so the notice cannot promise
  // a link the save then declines to create.
  const plan = decideCustomerLink(parsed.data, candidates);
  if (plan.action !== "link") return null;

  const { data } = await supabase
    .from("customers")
    .select("full_name")
    .eq("id", plan.customerId)
    .maybeSingle();

  const customer = data as { full_name: string } | null;
  return customer ? { full_name: customer.full_name } : null;
}

/**
 * Corrects a client's details, and their note.
 *
 * Anyone who can see a lead can fix it. That is not a new privilege —
 * `leads_update` has permitted the owning salesperson, the branch's
 * manager and the CEO since 0001 — it is the first code path that ever
 * used it. Until now a phone number typed wrong at the counter stayed
 * wrong, because the only writer was the "Add Lead" dialog.
 *
 * The audit trigger on `leads` turns every one of these into a
 * before/after pair in `audit_log`, which is what the History panel on
 * the lead page reads. Editing and the record of who edited arrive
 * together on purpose: the second is what makes the first safe to hand
 * to everyone.
 *
 * No `assertBranch`. The branch check belongs on acts that move money or
 * stock; visibility is the right gate for correcting a contact detail,
 * and RLS already IS that gate — the update below simply matches no rows
 * for a lead the caller cannot see, which the empty-result check turns
 * into a sentence.
 */
export async function updateLead(input: {
  id: string;
  client_name: string;
  phone_number: string;
  car_interest: string;
  address: string;
  company_name: string;
  job_title: string;
  income: string;
  client_notes: string;
  client_note_points: string[];
  contact_time_preference: string;
  national_id: string;
  nationality: string;
}) {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(UpdateLeadSchema, input);
  if (!parsed.ok) return parsed.error;

  const { id, ...fields } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .update(fields)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return toUserError(error);
  // RLS returns zero rows rather than an error for a lead belonging to
  // another salesperson's pipeline, and an update that changed nothing
  // would otherwise report success.
  if (!data) return { error: "That client is not available to you." };

  // Re-run the link (0031). This is the write path that matters most:
  // the national ID is normally recorded HERE rather than at creation,
  // because it arrives when the person is actually buying — which makes
  // this edit the moment a lead first becomes matchable to somebody the
  // showroom already knows.
  //
  // customer_id is read in its own statement rather than folded into the
  // UPDATE's returning clause: naming a column that a pre-0031 database
  // does not have would turn every lead edit into an error, whereas a
  // separate select simply comes back empty and the link step no-ops.
  const { data: linkRow } = await supabase
    .from("leads")
    .select("customer_id")
    .eq("id", id)
    .maybeSingle();

  // Passed through so an edit that matches nobody new enriches the
  // identity already attached instead of minting a second one and
  // orphaning this person's history — see lib/customer-link.ts.
  await linkLeadToCustomer(
    supabase,
    id,
    {
      full_name: fields.client_name,
      phone_number: fields.phone_number,
      national_id: fields.national_id,
      address: fields.address,
      nationality: fields.nationality,
    },
    (linkRow as { customer_id: string | null } | null)?.customer_id ?? null
  );

  revalidatePath("/[locale]/(app)/crm/[leadId]", "page");
  revalidatePath("/[locale]/(app)/crm", "page");
  // buildDemand() falls back to leads.car_interest for leads with no
  // structured interest, so editing it moves the CEO's demand report.
  revalidatePath("/[locale]/(app)/ceo", "page");
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

  const parsed = parseInput(UpdateLeadInterestStatusSchema, input);
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

/**
 * Revises what a buyer wants — the car, the budget, the note, all of it.
 *
 * The alternative was a new row per correction, and it is the wrong one:
 * `buildDemand()` counts DISTINCT leads per car, so a buyer whose budget
 * moved from 21,000 to 24,000 would appear as two people wanting the
 * same Civic the moment the second row landed. One buyer is one row, and
 * revising it is how it stays that way.
 *
 * `lead_id` is never accepted — see UpdateLeadInterestSchema. Everything
 * else the dialog can set comes through, including a switch between a
 * car on the floor and a car the showroom does not have: a wanted Hilux
 * that arrives as stock becomes a linked row rather than a duplicate,
 * which is exactly the moment the demand report should stop counting it
 * as unmet.
 */
export async function updateLeadInterest(input: {
  id: string;
  vehicle_id: string;
  wanted_make: string;
  wanted_model: string;
  wanted_year: string;
  budget_amount: string;
  origin: "requested" | "suggested";
  status: "open" | "shown" | "declined";
  note: string;
}) {
  const auth = await authorize(STAFF_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(UpdateLeadInterestSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // Same reasoning as addLeadInterest: no branch assertion, because
  // nothing is reserved by noting that a customer wants a car sitting at
  // another branch — but the car must be one this actor can see, or the
  // row would name a vehicle they cannot read back.
  if (parsed.data.vehicle_id) {
    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("id")
      .eq("id", parsed.data.vehicle_id)
      .maybeSingle();
    if (!vehicle) return { error: "That vehicle is not available to you." };
  }

  const { id, ...fields } = parsed.data;
  const { data, error } = await supabase
    .from("lead_vehicle_interests")
    .update(fields)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return toUserError(error);
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
  vat_rate: number | null;
  vat_amount: number | null;
  price_includes_vat: boolean | null;
  settlement_method: "bank_transfer" | "cheque" | "instapay" | "cash" | null;
  settlement_reference: string | null;
  settlement_bank: string | null;
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

  const branchError = await assertBranch(auth.profile, v.branch_id);
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
      vat_rate: parsed.data.vat_rate,
      vat_amount: parsed.data.vat_amount,
      price_includes_vat: parsed.data.price_includes_vat,
      settlement_method: parsed.data.settlement_method,
      settlement_reference: parsed.data.settlement_reference,
      settlement_bank: parsed.data.settlement_bank,
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
  // asking_price, never purchase_price: this feeds the CRM's vehicle
  // pickers, which the sales floor uses — cost stays off their wire (0028).
  const { data } = await supabase
    .from("vehicles")
    .select("id, year, make, model, trim, asking_price")
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
