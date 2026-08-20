"use server";

import { createClient } from "@/lib/supabase/server";
import { authenticate } from "@/lib/auth";
import {
  EMPTY_AGING,
  addAging,
  agingBuckets,
  planSummary,
  roundMoney,
  toIsoDate,
  type AgingBuckets,
  type PlanLine,
} from "@/lib/receivables";
import type {
  Branch,
  Cheque,
  InstallmentLine,
  InstallmentPlan,
  InstallmentPlanStatus,
} from "@/lib/supabase/types";

/**
 * THE RECEIVABLE BOOK, ORG-WIDE (migration 0033) — the accountant hub's
 * read side.
 *
 * "Org-wide" means whatever can_read_branch() says it means for this
 * session: everything for a CEO or an accountant, one branch plus any
 * 0030 grants for a manager or a sales exec. There is deliberately no
 * role list here and no branch filter in the queries — adding either
 * would be a second, hand-maintained copy of a rule Postgres already
 * enforces, and the two would eventually disagree.
 *
 * Every figure is computed HERE rather than in the browser, from the
 * same pure functions the ticket panel uses. The client receives
 * numbers, not schedules, so a hub showing forty plans does not ship
 * two thousand instalment rows to render five totals.
 */

export type ReceivablePlanRow = {
  id: string;
  ticketId: string;
  branchId: string;
  status: InstallmentPlanStatus;
  vehicle: string | null;
  total: number;
  paid: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  /** ISO date of the earliest line still owing anything, or null. */
  nextDue: string | null;
  monthlyAmount: number;
};

export type ReceivablesOverview = {
  plans: ReceivablePlanRow[];
  aging: AgingBuckets;
  totalOutstanding: number;
  activeCount: number;
  /** Cheques maturing in the next 30 days, soonest first. */
  upcomingCheques: Cheque[];
  /** Every bounced cheque still on the books, newest move first. */
  bouncedCheques: Cheque[];
  branchNames: Record<string, string>;
  /** The day every arrears figure above was computed against. */
  today: string;
};

const EMPTY: ReceivablesOverview = {
  plans: [],
  aging: EMPTY_AGING,
  totalOutstanding: 0,
  activeCount: 0,
  upcomingCheques: [],
  bouncedCheques: [],
  branchNames: {},
  today: "1970-01-01",
};

type PlanWithLines = InstallmentPlan & {
  installment_lines?: InstallmentLine[];
  deal_tickets?: {
    id: string;
    vehicles?: { year: number; make: string; model: string } | null;
  } | null;
};

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return toIsoDate(new Date(Date.UTC(y, m - 1, d + days)));
}

export async function fetchReceivablesOverview(): Promise<ReceivablesOverview> {
  const auth = await authenticate();
  if (!auth.ok) return EMPTY;

  const supabase = await createClient();
  const today = toIsoDate(new Date());

  const [{ data: planRows }, { data: upcoming }, { data: bounced }, { data: branches }] =
    await Promise.all([
      supabase
        .from("installment_plans")
        .select("*, installment_lines(*), deal_tickets(id, vehicles(year, make, model))")
        .order("created_at", { ascending: false }),
      // The maturity window. The upper bound is inclusive of day 30, and
      // the lower bound is TODAY rather than "now" — a cheque due this
      // morning has not stopped being due.
      supabase
        .from("cheques")
        .select("*")
        .in("status", ["in_safe", "deposited"])
        .gte("due_date", today)
        .lte("due_date", addDays(today, 30))
        .order("due_date", { ascending: true }),
      // No date bound: a cheque that bounced in March is still a debt in
      // June, and dropping it off the screen is how it gets forgotten.
      supabase
        .from("cheques")
        .select("*")
        .eq("status", "bounced")
        .order("due_date", { ascending: true }),
      supabase.from("branches").select("id, name"),
    ]);

  const plans: ReceivablePlanRow[] = [];
  let aging = EMPTY_AGING;

  for (const raw of (planRows as PlanWithLines[] | null) ?? []) {
    const lines: PlanLine[] = (raw.installment_lines ?? []).map((l) => ({
      id: l.id,
      seq: l.seq,
      due_date: l.due_date,
      amount_due: Number(l.amount_due),
      amount_paid: Number(l.amount_paid),
    }));

    const summary = planSummary(lines, today);
    const v = raw.deal_tickets?.vehicles ?? null;

    plans.push({
      id: raw.id,
      ticketId: raw.deal_ticket_id,
      branchId: raw.branch_id,
      status: raw.status,
      vehicle: v ? `${v.year} ${v.make} ${v.model}` : null,
      total: summary.total,
      paid: summary.paid,
      outstanding: summary.outstanding,
      overdueAmount: summary.overdueAmount,
      overdueCount: summary.overdueCount,
      nextDue: summary.nextDue?.due_date ?? null,
      monthlyAmount: Number(raw.monthly_amount),
    });

    // A defaulted plan's balance still counts: it is money the showroom
    // is owed and has not written off. Only a settled plan contributes
    // nothing, and it contributes nothing because its lines are paid.
    aging = addAging(aging, agingBuckets(lines, today));
  }

  const branchNames: Record<string, string> = {};
  for (const b of ((branches as Branch[] | null) ?? [])) branchNames[b.id] = b.name;

  return {
    plans,
    aging,
    totalOutstanding: roundMoney(plans.reduce((s, p) => s + p.outstanding, 0)),
    activeCount: plans.filter((p) => p.status === "active").length,
    upcomingCheques: (upcoming as Cheque[] | null) ?? [],
    bouncedCheques: (bounced as Cheque[] | null) ?? [],
    branchNames,
    today,
  };
}
