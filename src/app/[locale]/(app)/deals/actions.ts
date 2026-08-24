"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, REVIEWER_ROLES, COST_ROLES } from "@/lib/auth";
import { ChecklistSchema, RejectTicketSchema, TicketOverheadSchema, Uuid, parseInput } from "@/lib/validation";
import type { TicketOverheadResult, TicketWaterfall, WaterfallPreview } from "@/lib/supabase/types";
import { toUserError } from "@/lib/db-error";

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
  const parsed = await parseInput(ChecklistSchema, checklist);
  if (!parsed.ok) return parsed.error;

  const ticket = await loadTicketScope(id.data);
  if (!ticket) return { error: "Unknown deal ticket." };

  const branchError = await assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  if (ticket.status !== "submitted") {
    return { error: "This ticket has already been reviewed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("deal_tickets").update(parsed.data).eq("id", id.data);
  if (error) return toUserError(error);

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

  const branchError = await assertBranch(auth.profile, ticket.branch_id);
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
  if (error) return toUserError(error);

  revalidateDeals();
  return { ok: true };
}

export async function rejectTicket(ticketId: string, reason: string) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(RejectTicketSchema, { ticketId, reason });
  if (!parsed.ok) return parsed.error;

  const ticket = await loadTicketScope(parsed.data.ticketId);
  if (!ticket) return { error: "Unknown deal ticket." };

  const branchError = await assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("deal_tickets")
    .update({ status: "rejected", rejection_reason: parsed.data.reason })
    .eq("id", parsed.data.ticketId);
  if (error) return toUserError(error);

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
  const branchError = await assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("execute_vehicle_sale", {
    p_deal_ticket_id: id.data,
  });
  if (error) return toUserError(error);

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
  // COST ROLES ONLY (0028): the waterfall names the purchase price, the
  // expense total and the overhead — exactly the figures a showroom does
  // not show its sales floor. A sales exec sees the ticket, its checklist
  // and its status; the profit anatomy is management's.
  //
  // The list below IS COST_ROLES spelled out against auth.ts on purpose:
  // it used to admit branch_manager too, which contradicted the redaction
  // model everywhere else — the UI hides this panel from managers
  // (canSeeCost), but a manager POSTing directly got purchase price,
  // expenses and overhead nobody intended to show them.
  const auth = await authorize(COST_ROLES);
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

/**
 * The waterfall AS THIS TICKET IS PRICED (migration 0050).
 *
 * Distinct from fetchWaterfallPreview above, and the difference is the
 * whole of 0050's third fix: that one asks "what would this car's
 * waterfall be today", which recomputes the showroom fee live from
 * today's configuration. Right for a car still in stock; WRONG for a car
 * already sold, whose ledger rows were written from the fee that applied
 * at settlement. Before 0050 a settled ticket was redrawn with a fee the
 * ledger had never paid, and nothing on the screen said which of the two
 * numbers was real.
 *
 * ticket_waterfall() reads the frozen snapshot for a settled sale, the
 * CEO's override where one has been set, and the live accrual only while
 * the ticket is still open — and returns all three so the UI can show the
 * gap.
 *
 * Same COST ROLES gate as the preview: the waterfall names the purchase
 * price, the expense total and the fee.
 */
export async function fetchTicketWaterfall(ticketId: string): Promise<TicketWaterfall | null> {
  // Same COST_ROLES gate as the preview above — including dropping
  // branch_manager, for the same reason.
  const auth = await authorize(COST_ROLES);
  if (!auth.ok) return null;

  const id = Uuid.safeParse(ticketId);
  if (!id.success) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ticket_waterfall", {
    p_deal_ticket_id: id.data,
  });
  // Null covers both "not authorized by the function's own four-way
  // check" and "migration 0050 has not been applied here yet". The panel
  // falls back to the plain preview in either case rather than showing
  // an error where a waterfall should be.
  if (error) return null;
  return data as TicketWaterfall;
}

/**
 * The CEO's per-sale showroom fee edit (migration 0050).
 *
 * The one deliberate crack in the freeze: a fee charged against the
 * wrong month, or a car that sat on the forecourt for a reason that was
 * not the investor's fault, is corrected HERE — on the ticket, with a
 * reason, attributed and audited — rather than by a configuration change
 * that would quietly rewrite a hundred other sales.
 *
 * On a settled sale the database also moves the money, by posting
 * adjustment rows to the ledger per equity holder. It does not edit the
 * rows already written: ledger_entries has no UPDATE policy and the
 * tenant role holds no DELETE, and that is the property which makes the
 * ledger worth trusting.
 *
 * `overhead: null` clears the override — back to the frozen snapshot on
 * a settled sale, back to the live accrual on an open one. Clearing also
 * moves money, by the same mechanism and in the opposite direction.
 *
 * CEO ONLY, and set_ticket_overhead() re-checks is_ceo() inside the
 * function, where a hand-crafted POST cannot reach past it.
 */
export async function setTicketOverhead(input: {
  ticket_id: string;
  overhead: number | null;
  reason: string | null;
}) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(TicketOverheadSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_ticket_overhead", {
    p_deal_ticket_id: parsed.data.ticket_id,
    p_overhead: parsed.data.overhead,
    p_reason: parsed.data.reason,
  });
  if (error) return toUserError(error);

  revalidateDeals();
  // The fee comes off the profit before the cap table divides it, so an
  // adjustment moves the MTD figure, every investor wallet and the
  // ledger export as well as this ticket.
  revalidatePath("/[locale]/(app)/ceo", "page");
  revalidatePath("/[locale]/(app)/investor", "page");
  revalidatePath("/[locale]/(app)/fees", "page");
  return { ok: true, result: data as TicketOverheadResult };
}
