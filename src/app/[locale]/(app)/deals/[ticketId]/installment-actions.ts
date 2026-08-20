"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authenticate, authorize, assertBranch } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  AddChequeSchema,
  CreateInstallmentPlanSchema,
  RecordInstallmentPaymentSchema,
  RecordReceiptSchema,
  UpdateChequeStatusSchema,
  Uuid,
  parseInput,
} from "@/lib/validation";
import { allocatePayment, buildSchedule, canMoveCheque } from "@/lib/receivables";
import type {
  Cheque,
  ChequeStatus,
  InstallmentLine,
  InstallmentPlan,
  Receipt,
  Role,
} from "@/lib/supabase/types";

/**
 * THE IN-HOUSE RECEIVABLE BOOK, for one deal ticket (migration 0033).
 *
 * Every export here is a public HTTP endpoint, so each one re-checks the
 * caller's role and branch before it writes and treats RLS as the second
 * layer rather than the only one.
 *
 * WHO MAY LEND THE SHOWROOM'S MONEY. Writing a payment plan is
 * committing the business to a credit agreement, and taking a payment is
 * handling cash — both are management or finance acts, not sales ones.
 * A sales exec READS their branch's book (RLS admits them, and they are
 * the person a customer asks "how much is left?") but does not open one.
 * Deliberately not one of auth.ts's exported role lists: those describe
 * existing duties, and borrowing EXPENSE_ROLES because the membership
 * happens to match today is how two unrelated rules end up joined at the
 * hip.
 */
const BOOK_ROLES: Role[] = ["ceo", "accountant", "branch_manager"];

export type InstallmentBook = {
  plan: InstallmentPlan | null;
  lines: InstallmentLine[];
  cheques: Cheque[];
  receipts: Receipt[];
  /**
   * Whether this session may write to the book. Decided HERE rather than
   * passed down from the page, so the panel is a zero-prop insertion into
   * ticket-panel.tsx and there is no second copy of the rule to drift.
   * It only hides controls; every write re-checks it server-side.
   */
  canManage: boolean;
};

const EMPTY_BOOK: InstallmentBook = {
  plan: null,
  lines: [],
  cheques: [],
  receipts: [],
  canManage: false,
};

function revalidateBook() {
  revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");
  revalidatePath("/[locale]/(app)/accountant", "page");
}

/** Enough of a ticket to authorize acting on it, and to gate the shape. */
async function loadTicket(ticketId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("deal_tickets")
    .select("id, branch_id, status, financing_type, financing_partner_id, agreed_price, down_payment")
    .eq("id", ticketId)
    .maybeSingle();
  return data as
    | {
        id: string;
        branch_id: string;
        status: string;
        financing_type: string;
        financing_partner_id: string | null;
        agreed_price: number;
        down_payment: number | null;
      }
    | null;
}

async function loadPlanScope(planId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("installment_plans")
    .select("id, branch_id, deal_ticket_id, status")
    .eq("id", planId)
    .maybeSingle();
  return data as
    | { id: string; branch_id: string; deal_ticket_id: string; status: string }
    | null;
}

// ── Read ────────────────────────────────────────────────────

/**
 * Everything the ticket's installments panel renders.
 *
 * Authentication only: RLS decides what comes back, and the four
 * SELECT policies are branch-scoped through can_read_branch(), which
 * already carries the CEO, the accountant and 0030's branch grants. A
 * role list here would be a SECOND, hand-maintained copy of that rule.
 */
export async function fetchInstallmentBook(ticketId: string): Promise<InstallmentBook> {
  const auth = await authenticate();
  if (!auth.ok) return EMPTY_BOOK;

  const id = Uuid.safeParse(ticketId);
  if (!id.success) return EMPTY_BOOK;

  const supabase = await createClient();

  const { data: planRow } = await supabase
    .from("installment_plans")
    .select("*")
    .eq("deal_ticket_id", id.data)
    .maybeSingle();
  const plan = (planRow as InstallmentPlan | null) ?? null;

  // Cheques and receipts hang off the TICKET as well as the plan, so
  // they are worth loading even before a plan exists — a deposit cheque
  // taken at signing is in the safe whether or not anybody has written
  // the schedule yet.
  const [{ data: lines }, { data: cheques }, { data: receipts }] = await Promise.all([
    plan
      ? supabase
          .from("installment_lines")
          .select("*")
          .eq("plan_id", plan.id)
          .order("seq", { ascending: true })
      : Promise.resolve({ data: [] as InstallmentLine[] }),
    supabase
      .from("cheques")
      .select("*")
      .eq("deal_ticket_id", id.data)
      .order("due_date", { ascending: true }),
    supabase
      .from("receipts")
      .select("*")
      .eq("deal_ticket_id", id.data)
      .order("received_at", { ascending: false }),
  ]);

  return {
    plan,
    lines: (lines as InstallmentLine[] | null) ?? [],
    cheques: (cheques as Cheque[] | null) ?? [],
    receipts: (receipts as Receipt[] | null) ?? [],
    canManage: BOOK_ROLES.includes(auth.profile.role),
  };
}

// ── Write ───────────────────────────────────────────────────

/**
 * Open the showroom's own book against an executed in-house ticket.
 *
 * THE THREE THINGS THAT MAKE A TICKET "IN-HOUSE" are checked here and
 * again by enforce_in_house_installment_plan() in the database: the
 * ticket is on instalments, it names NO financing partner, and it has
 * been executed. The first two are what migration 0033 gave a meaning
 * to; the third is this action's own rule — a schedule starts when the
 * customer drives the car away, and a plan against an unexecuted ticket
 * would put arrears on a sale that may still be rejected.
 *
 * WRITING THE PLAN AND WRITING THE SCHEDULE ARE TWO STATEMENTS, and
 * PostgREST gives no transaction to wrap them in. The failure between
 * them — a plan with no lines — is REPAIRED RATHER THAN ROLLED BACK,
 * because §6f grants DELETE on nothing and there is no undo to offer.
 * Everything the schedule is built from (principal, rate, months,
 * start_date) is stored on the plan row, so re-running this action
 * against a plan that has no lines rebuilds exactly the schedule the
 * first attempt would have written. That is why the guard below is on
 * the LINES existing, not on the plan existing.
 */
export async function createInstallmentPlan(input: {
  ticketId: string;
  principal: number;
  annual_flat_rate: string | null;
  months: number;
  start_date: string;
  ownership_retained: boolean;
  notes: string | null;
}) {
  const auth = await authorize(BOOK_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateInstallmentPlanSchema, input);
  if (!parsed.ok) return parsed.error;

  const ticket = await loadTicket(parsed.data.ticketId);
  if (!ticket) return { error: "Unknown deal ticket." };

  const branchError = await assertBranch(auth.profile, ticket.branch_id);
  if (branchError) return branchError;

  if (ticket.status !== "executed") {
    return { error: "A payment plan is opened once the sale has been executed." };
  }
  if (ticket.financing_type !== "installments") {
    return { error: "This is a cash deal — there is nothing to schedule." };
  }
  if (ticket.financing_partner_id !== null) {
    return {
      error:
        "This deal is financed by a bank. An in-house plan is only for deals the showroom finances itself.",
    };
  }

  const supabase = await createClient();

  const { data: existingRow } = await supabase
    .from("installment_plans")
    .select("*")
    .eq("deal_ticket_id", parsed.data.ticketId)
    .maybeSingle();
  let plan = (existingRow as InstallmentPlan | null) ?? null;

  if (plan) {
    const { count } = await supabase
      .from("installment_lines")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", plan.id);
    if ((count ?? 0) > 0) {
      return { error: "This deal already has a payment plan." };
    }
  }

  // Built from the PARSED input on a fresh plan, and from the STORED
  // row on a repair — a repair must reproduce the schedule the plan
  // already promises, not the one the form happens to show now.
  const schedule = buildSchedule(
    plan
      ? {
          principal: plan.principal,
          annualFlatRate: plan.annual_flat_rate,
          months: plan.months,
          startDate: plan.start_date,
        }
      : {
          principal: parsed.data.principal,
          annualFlatRate: parsed.data.annual_flat_rate,
          months: parsed.data.months,
          startDate: parsed.data.start_date,
        }
  );

  if (!plan) {
    const { data: inserted, error } = await supabase
      .from("installment_plans")
      .insert({
        deal_ticket_id: parsed.data.ticketId,
        // From the TICKET, never from the client. The database pins it
        // too, so a forged branch id fails twice.
        branch_id: ticket.branch_id,
        principal: parsed.data.principal,
        annual_flat_rate: parsed.data.annual_flat_rate,
        months: parsed.data.months,
        start_date: parsed.data.start_date,
        monthly_amount: schedule.monthlyAmount,
        total_payable: schedule.totalPayable,
        ownership_retained: parsed.data.ownership_retained,
        notes: parsed.data.notes,
        created_by: auth.profile.id,
      })
      .select("*")
      .single();
    if (error) return toUserError(error, "createInstallmentPlan");
    plan = inserted as InstallmentPlan;
  }

  // Pinned to a const: narrowing of a captured `let` is a TypeScript
  // convenience rather than a guarantee, and this closure is the only
  // place plan_id is written.
  const planId = plan.id;

  const { error: linesError } = await supabase.from("installment_lines").insert(
    schedule.lines.map((l) => ({
      plan_id: planId,
      seq: l.seq,
      due_date: l.due_date,
      amount_due: l.amount_due,
    }))
  );
  if (linesError) {
    return {
      error:
        "The plan was saved but its schedule was not. Open this deal again and save the plan once more to rebuild it.",
    };
  }

  revalidateBook();
  return { ok: true };
}

/**
 * Take an instalment payment: one receipt, plus the allocation it
 * causes, plus the plan status if it closes.
 *
 * ORDER IS DELIBERATE AND IT IS RECEIPT FIRST. Without a transaction one
 * of the two halves can land alone, so the question is which orphan is
 * survivable. A receipt with no allocation overstates what the customer
 * owes: visible on the plan (the receipts total no longer matches what
 * the lines say is paid), correctable, and it never claims money the
 * showroom does not have. Lines with no receipt is the opposite — the
 * book says paid and nothing anywhere records who took it.
 *
 * Each line update is conditioned on the amount_paid it was READ with,
 * so two staff members submitting the same payment at once produce one
 * allocation and one clear error, rather than two allocations that both
 * think they were first.
 */
export async function recordInstallmentPayment(input: {
  planId: string;
  amount: number;
  method: string;
  reference: string | null;
  payer_name: string | null;
  note: string | null;
}) {
  const auth = await authorize(BOOK_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(RecordInstallmentPaymentSchema, input);
  if (!parsed.ok) return parsed.error;

  const plan = await loadPlanScope(parsed.data.planId);
  if (!plan) return { error: "Unknown payment plan." };

  const branchError = await assertBranch(auth.profile, plan.branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { data: lineRows } = await supabase
    .from("installment_lines")
    .select("*")
    .eq("plan_id", plan.id)
    .order("seq", { ascending: true });
  const lines = (lineRows as InstallmentLine[] | null) ?? [];
  if (lines.length === 0) return { error: "This plan has no schedule yet." };

  const allocation = allocatePayment(lines, parsed.data.amount);
  if (!allocation.ok) return { error: allocation.error };

  const { error: receiptError } = await supabase.from("receipts").insert({
    branch_id: plan.branch_id,
    deal_ticket_id: plan.deal_ticket_id,
    plan_id: plan.id,
    amount: parsed.data.amount,
    method: parsed.data.method,
    reference: parsed.data.reference,
    payer_name: parsed.data.payer_name,
    note: parsed.data.note,
    received_by: auth.profile.id,
  });
  if (receiptError) return toUserError(receiptError, "recordInstallmentPayment");

  const now = new Date().toISOString();
  const bySeq = new Map(lines.map((l) => [l.seq, l]));

  for (const move of allocation.allocations) {
    const before = bySeq.get(move.seq);
    if (!before) continue;
    const { data: touched, error } = await supabase
      .from("installment_lines")
      .update({
        amount_paid: move.amountPaid,
        paid_at: move.fullyPaid ? now : before.paid_at,
      })
      .eq("id", before.id)
      // The optimistic lock. A concurrent payment moves amount_paid, so
      // this matches nothing and the update is refused rather than
      // silently overwriting the other allocation.
      .eq("amount_paid", before.amount_paid)
      .select("id");
    if (error) return toUserError(error, "recordInstallmentPayment/lines");
    if (!touched || touched.length === 0) {
      return {
        error:
          "The receipt was recorded, but this plan changed while you were paying. Reload the deal and check the schedule.",
      };
    }
  }

  if (allocation.planSettled && plan.status !== "settled") {
    await supabase.from("installment_plans").update({ status: "settled" }).eq("id", plan.id);
  }

  revalidateBook();
  return { ok: true };
}

/**
 * Put a post-dated cheque in the branch safe.
 *
 * The branch comes from the plan or the ticket the cheque is recorded
 * against — never from the client. A cheque filed under the wrong
 * branch is invisible to the people holding the paper and visible to
 * people who are not.
 */
export async function addCheque(input: {
  ticketId: string | null;
  planId: string | null;
  cheque_number: string;
  bank_name: string;
  drawer_name: string;
  amount: number;
  due_date: string;
  status: string;
  note: string | null;
}) {
  const auth = await authorize(BOOK_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(AddChequeSchema, input);
  if (!parsed.ok) return parsed.error;

  let branchId: string | null = null;
  let ticketId = parsed.data.ticketId;

  if (parsed.data.planId) {
    const plan = await loadPlanScope(parsed.data.planId);
    if (!plan) return { error: "Unknown payment plan." };
    branchId = plan.branch_id;
    ticketId = ticketId ?? plan.deal_ticket_id;
  } else if (ticketId) {
    const ticket = await loadTicket(ticketId);
    if (!ticket) return { error: "Unknown deal ticket." };
    branchId = ticket.branch_id;
  }
  if (!branchId) return { error: "Unknown deal ticket." };

  const branchError = await assertBranch(auth.profile, branchId);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { error } = await supabase.from("cheques").insert({
    branch_id: branchId,
    deal_ticket_id: ticketId,
    plan_id: parsed.data.planId,
    cheque_number: parsed.data.cheque_number,
    bank_name: parsed.data.bank_name,
    drawer_name: parsed.data.drawer_name,
    amount: parsed.data.amount,
    due_date: parsed.data.due_date,
    status: parsed.data.status,
    note: parsed.data.note,
    created_by: auth.profile.id,
  });
  if (error) return toUserError(error, "addCheque");

  revalidateBook();
  return { ok: true };
}

/**
 * Move a cheque along its life.
 *
 * The transition table is checked here as well as by
 * guard_cheque_status(), so the user gets "a cheque cannot go back to
 * the safe once it has cleared" instead of a Postgres exception — and
 * so a POST that skips the UI is refused on the same rule the menu was
 * built from.
 */
export async function updateChequeStatus(input: {
  chequeId: string;
  status: string;
  note: string | null;
}) {
  const auth = await authorize(BOOK_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(UpdateChequeStatusSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data: chequeRow } = await supabase
    .from("cheques")
    .select("id, branch_id, status")
    .eq("id", parsed.data.chequeId)
    .maybeSingle();
  const cheque = chequeRow as { id: string; branch_id: string; status: ChequeStatus } | null;
  if (!cheque) return { error: "Unknown cheque." };

  const branchError = await assertBranch(auth.profile, cheque.branch_id);
  if (branchError) return branchError;

  if (cheque.status !== parsed.data.status && !canMoveCheque(cheque.status, parsed.data.status)) {
    return { error: "A cheque cannot move there from where it is." };
  }

  const { error } = await supabase
    .from("cheques")
    .update({ status: parsed.data.status, note: parsed.data.note })
    .eq("id", cheque.id);
  if (error) return toUserError(error, "updateChequeStatus");

  revalidateBook();
  return { ok: true };
}

/**
 * Money taken at the counter that is NOT an instalment payment — a
 * deposit to hold a car, a balance settled after delivery, an
 * administrative fee. Nothing is allocated: the receipt is the whole
 * record, which is exactly what was missing before migration 0033.
 *
 * An instalment payment goes through recordInstallmentPayment() so that
 * the schedule moves with the money; this one takes no plan allocation
 * even when a plan_id is supplied, and the panel says so.
 */
export async function recordReceipt(input: {
  branchId: string;
  ticketId: string | null;
  planId: string | null;
  amount: number;
  method: string;
  reference: string | null;
  payer_name: string | null;
  note: string | null;
}) {
  const auth = await authorize(BOOK_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(RecordReceiptSchema, input);
  if (!parsed.ok) return parsed.error;

  const branchError = await assertBranch(auth.profile, parsed.data.branchId);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { error } = await supabase.from("receipts").insert({
    branch_id: parsed.data.branchId,
    deal_ticket_id: parsed.data.ticketId,
    plan_id: parsed.data.planId,
    amount: parsed.data.amount,
    method: parsed.data.method,
    reference: parsed.data.reference,
    payer_name: parsed.data.payer_name,
    note: parsed.data.note,
    received_by: auth.profile.id,
  });
  if (error) return toUserError(error, "recordReceipt");

  revalidateBook();
  return { ok: true };
}
