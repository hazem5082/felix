"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, REVIEWER_ROLES } from "@/lib/auth";
import { ChecklistSchema, RejectTicketSchema, Uuid, parseInput } from "@/lib/validation";
import type { WaterfallPreview } from "@/lib/supabase/types";

// Every export here is a public HTTP endpoint. The `canReview` prop that
// hides these controls in the UI does nothing for a hand-crafted POST, so
// each action re-checks the caller's role and branch before it writes.

/** Loads just enough of a ticket to authorize acting on it. */
async function loadTicketScope(ticketId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("deal_tickets")
    .select("id, branch_id, status, salesperson_id")
    .eq("id", ticketId)
    .maybeSingle();
  return data as
    | { id: string; branch_id: string; status: string; salesperson_id: string }
    | null;
}

function revalidateDeals() {
  revalidatePath("/[locale]/(app)/deals", "page");
  revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");
}

export async function updateChecklist(
  ticketId: string,
  checklist: {
    financial_check_passed?: boolean;
    discount_validated?: boolean;
    rate_revalidated?: boolean;
  }
) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(ticketId);
  if (!id.success) return { error: "Unknown deal ticket." };

  // The TypeScript parameter type is erased at runtime, so without an
  // explicit whitelist the caller could pass agreed_price, discount_amount
  // or branch_id here and have them written straight through.
  const parsed = parseInput(ChecklistSchema, checklist);
  if (!parsed.ok) return parsed.error;

  const ticket = await loadTicketScope(id.data);
  if (!ticket) return { error: "Unknown deal ticket." };

  const branchError = assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  if (ticket.status !== "submitted") {
    return { error: "This ticket has already been reviewed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("deal_tickets").update(parsed.data).eq("id", id.data);
  if (error) return { error: error.message };

  revalidateDeals();
  return { ok: true };
}

export async function approveTicket(ticketId: string) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(ticketId);
  if (!id.success) return { error: "Unknown deal ticket." };

  const ticket = await loadTicketScope(id.data);
  if (!ticket) return { error: "Unknown deal ticket." };

  const branchError = assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  // A reviewer approving a deal they raised themselves defeats the point of
  // having a review step at all.
  if (ticket.salesperson_id === auth.profile.id) {
    return { error: "You cannot approve a deal ticket you raised yourself." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("deal_tickets")
    .update({ status: "approved" })
    .eq("id", id.data)
    .eq("status", "submitted");
  if (error) return { error: error.message };

  revalidateDeals();
  return { ok: true };
}

export async function rejectTicket(ticketId: string, reason: string) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(RejectTicketSchema, { ticketId, reason });
  if (!parsed.ok) return parsed.error;

  const ticket = await loadTicketScope(parsed.data.ticketId);
  if (!ticket) return { error: "Unknown deal ticket." };

  const branchError = assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("deal_tickets")
    .update({ status: "rejected", rejection_reason: parsed.data.reason })
    .eq("id", parsed.data.ticketId);
  if (error) return { error: error.message };

  revalidateDeals();
  return { ok: true };
}

export async function executeSale(ticketId: string) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(ticketId);
  if (!id.success) return { error: "Unknown deal ticket." };

  const ticket = await loadTicketScope(id.data);
  if (!ticket) return { error: "Unknown deal ticket." };

  // execute_vehicle_sale is SECURITY DEFINER and so bypasses the RLS branch
  // filter. Migration 0003 re-checks the branch inside the function; this is
  // the matching check on the way in, so the user gets a readable error
  // rather than a raw Postgres exception.
  const branchError = assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("execute_vehicle_sale", {
    p_deal_ticket_id: id.data,
  });
  if (error) return { error: error.message };

  revalidateDeals();
  revalidatePath("/[locale]/(app)/inventory", "page");
  revalidatePath("/[locale]/(app)/ceo", "page");
  revalidatePath("/[locale]/(app)/investor", "page");
  return { ok: true, result: data };
}

export async function fetchWaterfallPreview(
  vehicleId: string,
  agreedPrice: number,
  discount: number
): Promise<WaterfallPreview | null> {
  const auth = await authorize(["ceo", "accountant", "branch_manager", "sales_exec", "investor"]);
  if (!auth.ok) return null;

  const id = Uuid.safeParse(vehicleId);
  if (!id.success) return null;
  if (!Number.isFinite(agreedPrice) || !Number.isFinite(discount)) return null;

  const supabase = await createClient();
  // Post-0003 this function is SECURITY DEFINER with its own scope check, so
  // a sales_exec now sees the true expense and overhead figures instead of
  // silently getting zeros for the rows RLS hides from them.
  const { data, error } = await supabase.rpc("preview_vehicle_sale_waterfall", {
    p_vehicle_id: id.data,
    p_agreed_price: agreedPrice,
    p_discount: discount,
  });
  if (error) return null;
  return data as WaterfallPreview;
}
