/**
 * THE IN-HOUSE RECEIVABLE BOOK — the arithmetic (migration 0033).
 *
 * Big Egyptian showrooms lend directly: تقسيط مباشر. The buyer pays a
 * down payment, signs a schedule, hands over post-dated cheques as
 * security, and the showroom keeps the ownership papers until the last
 * instalment clears. The showroom IS the bank, so the schedule, the
 * outstanding balance and the arrears are the showroom's own books
 * rather than something a partner reports back.
 *
 * Everything here is PURE. No database, no `server-only`, no locale —
 * the same functions run inside the server action that writes the
 * allocation and inside the client panel that previews a schedule
 * before anybody commits to it. That is the point: a preview that
 * disagreed with what the action later wrote would be worse than no
 * preview at all.
 *
 * FLAT RATE, NOT AMORTISED. This is the single most important thing in
 * the file and the easiest to get wrong out of habit. A bank quotes a
 * reducing-balance (amortised) rate; an Egyptian showroom quotes a FLAT
 * one — Abaza advertises 7.5% — and flat means:
 *
 *     interest = principal × (rate / 100) × (months / 12)
 *
 * computed once, on the WHOLE principal, for the WHOLE term, and then
 * split evenly across the instalments. It does not fall as the balance
 * falls. Running an amortisation formula over a rate quoted flat
 * understates what the customer owes by roughly half, on every plan, in
 * the customer's favour — a loss no report would ever surface, because
 * every internal number would agree with every other one.
 *
 * MONEY IS EGP TO THE PIASTER. Two decimals, and `roundMoney` is the
 * only rounding in this module — see its own note on why `Math.round`
 * alone is not enough.
 *
 * DATES ARE 'yyyy-mm-dd' STRINGS IN UTC. A due date is a calendar day,
 * not an instant: an instalment due on the 5th is due on the 5th in
 * Cairo, in the Workers runtime's UTC, and in whatever zone the
 * accountant's laptop is set to. Passing Date objects around would let
 * a local-midnight conversion move a due date across a day boundary and
 * silently age a line into the wrong arrears bucket.
 */

// ── Money ───────────────────────────────────────────────────

const PIASTERS = 100;

/**
 * Round to the piaster.
 *
 * `Math.round(n * 100) / 100` is the obvious version and it is wrong
 * often enough to matter: 1.005 is stored as 1.00499999999999989, so
 * `1.005 * 100` is 100.49999999999999 and rounds DOWN to 1.00. Passing
 * through `toFixed(6)` first collapses the representation error before
 * the rounding decision is made. The schedule below is built out of
 * exactly this operation `months` times and then asserted to sum
 * exactly, so a half-piaster drift is not academic here.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * PIASTERS).toFixed(6))) / PIASTERS;
}

/** Equal to the piaster. Direct === on floats would fail on sums. */
function moneyEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

// ── Dates ───────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * A calendar day as 'yyyy-mm-dd', from either a string already in that
 * shape or a Date (read in UTC, never local).
 */
export function toIsoDate(value: string | Date): string {
  if (typeof value !== "string") {
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(
      value.getUTCDate(),
      2
    )}`;
  }
  const head = value.slice(0, 10);
  if (!ISO_DATE.test(head)) throw new Error(`Not a calendar date: ${value}`);
  return head;
}

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new Error(`Not a calendar date: ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Rejects 2026-02-30 and 2026-13-01, both of which Date() would
  // happily roll over into a different (wrong) day.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > lastDay) throw new Error(`Not a calendar date: ${iso}`);
  return { y, m, d };
}

/**
 * Add whole months, clamping the day of the month rather than rolling
 * over: 31 Jan + 1 month is 28 Feb (29 in a leap year), NOT 3 March.
 *
 * Clamping is measured from the ORIGINAL day every time, not from the
 * previous instalment, so a plan starting on the 31st is due on the
 * 28th in February and back on the 31st in March. Chaining "+1 month"
 * twelve times instead would drag every later due date back to the 28th
 * for the rest of the plan — a full contract's dates wrong because of a
 * February.
 */
export function addMonthsClamped(iso: string, add: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const index = m - 1 + add;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(Math.min(d, lastDay), 2)}`;
}

/** Whole days from `from` to `to`, both calendar days. Negative = future. */
export function daysBetween(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return Math.round(
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000
  );
}

// ── The schedule ────────────────────────────────────────────

export const MAX_PLAN_MONTHS = 120;

/**
 * The smallest average instalment a plan may carry, in EGP.
 *
 * Not arbitrary. With `monthly = round(total / months)` the last line
 * absorbs the remainder, and the arithmetic works out to
 * `last = (total / months) − err × (months − 1)` where |err| ≤ 0.005.
 * At the 120-month ceiling that is a worst case of 0.595 EGP taken off
 * the final line, so any plan whose average instalment is at least
 * 1 EGP is guaranteed a positive last line — which is what the
 * `amount_due > 0` CHECK in migration 0033 requires. Below that the
 * schedule is refused rather than written and rejected by Postgres with
 * a constraint name.
 */
const MIN_AVERAGE_INSTALMENT = 1;

export type ScheduleInput = {
  /** Financed amount — the price AFTER the down payment. */
  principal: number;
  /** Flat annual rate as a percentage. Null or 0 = interest-free. */
  annualFlatRate: number | null;
  months: number;
  /** 'yyyy-mm-dd'. The FIRST instalment falls on this day. */
  startDate: string;
};

export type ScheduleLine = {
  seq: number;
  /** 'yyyy-mm-dd' */
  due_date: string;
  amount_due: number;
};

export type Schedule = {
  principal: number;
  interest: number;
  totalPayable: number;
  /** What the contract quotes. Every line but the last carries exactly this. */
  monthlyAmount: number;
  lines: ScheduleLine[];
};

/**
 * Build the instalment schedule a plan is written from.
 *
 * The first instalment falls ON `startDate` — a showroom writes "أول
 * قسط" against a date the customer names at signing, not a month later.
 * Shifting the run by a month is `addMonthsClamped(startDate, 1)` at
 * the call site, deliberately not a flag here.
 *
 * Throws on input the schema would reject anyway. Every caller parses
 * with zod first (`CreateInstallmentPlanSchema`); this is the second
 * line, and it exists so the client-side preview cannot render a
 * schedule the server would refuse to store.
 */
export function buildSchedule({
  principal,
  annualFlatRate,
  months,
  startDate,
}: ScheduleInput): Schedule {
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error("The financed amount must be greater than zero.");
  }
  if (!Number.isInteger(months) || months < 1 || months > MAX_PLAN_MONTHS) {
    throw new Error(`The term must be a whole number of months, up to ${MAX_PLAN_MONTHS}.`);
  }
  const rate = annualFlatRate ?? 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error("The rate must be between 0 and 100.");
  }

  // FLAT: the whole principal, the whole term, once. See the file header.
  const interest = roundMoney(principal * (rate / 100) * (months / 12));
  const totalPayable = roundMoney(principal + interest);

  if (totalPayable / months < MIN_AVERAGE_INSTALMENT) {
    throw new Error("That amount is too small to split over that many months.");
  }

  const monthlyAmount = roundMoney(totalPayable / months);

  const lines: ScheduleLine[] = [];
  for (let i = 0; i < months; i += 1) {
    const isLast = i === months - 1;
    lines.push({
      seq: i + 1,
      due_date: addMonthsClamped(startDate, i),
      // The last line absorbs the rounding remainder so the schedule
      // sums to totalPayable EXACTLY. Without it a 36-month plan is
      // routinely a few piasters short or long, and the plan can never
      // reach 'settled' because the lines never add up to the total the
      // contract names.
      amount_due: isLast
        ? roundMoney(totalPayable - monthlyAmount * (months - 1))
        : monthlyAmount,
    });
  }

  return { principal: roundMoney(principal), interest, totalPayable, monthlyAmount, lines };
}

// ── Allocation ──────────────────────────────────────────────

/** A stored schedule line. `id` is present when it came from the DB. */
export type PlanLine = {
  id?: string;
  seq: number;
  due_date: string;
  amount_due: number;
  amount_paid: number;
};

export type LineAllocation = {
  /** Present when the caller passed stored lines — what to UPDATE. */
  id?: string;
  seq: number;
  /** How much of this payment lands on this line. Always > 0. */
  applied: number;
  /** The line's amount_paid AFTER this payment. */
  amountPaid: number;
  /** True when this line is now paid in full. */
  fullyPaid: boolean;
};

export type AllocationResult =
  | {
      ok: true;
      allocations: LineAllocation[];
      /** Sum of `applied`. Equal to the rounded payment amount. */
      applied: number;
      /** True when this payment settles the LAST open line of the plan. */
      planSettled: boolean;
    }
  | { ok: false; error: string };

/** What is still owed on one line. Never negative. */
export function lineRemaining(line: PlanLine): number {
  return Math.max(0, roundMoney(line.amount_due - line.amount_paid));
}

/** What is still owed on the whole plan. */
export function outstandingOf(lines: readonly PlanLine[]): number {
  return roundMoney(lines.reduce((sum, l) => sum + lineRemaining(l), 0));
}

/**
 * Apply a payment oldest-unpaid-first, splitting on the boundary line.
 *
 * OVERPAYMENT IS REFUSED, and that is a decision rather than an
 * omission. The tempting alternative — park the excess as a credit on
 * the last line — makes `amount_paid > amount_due` a legal state, which
 * every other function here would then have to defend against: the
 * outstanding total goes negative, the aging buckets stop summing to
 * it, and `planStatus` calls a plan settled that has an unexplained
 * balance sitting on it. Worse, at the counter an overpayment is almost
 * always a typo (an extra zero) or a payment meant for a different
 * plan, and the honest answer to both is a refusal naming the real
 * outstanding figure. A customer genuinely settling early pays exactly
 * the outstanding balance, which this accepts and marks settled.
 *
 * Returns a result rather than throwing: the caller is a server action
 * whose failure path is `{ error }`, and this message is written to be
 * read by a showroom accountant.
 */
export function allocatePayment(
  lines: readonly PlanLine[],
  amount: number
): AllocationResult {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }

  const payment = roundMoney(amount);
  const outstanding = outstandingOf(lines);

  if (outstanding <= 0) {
    return { ok: false, error: "This plan is already settled — there is nothing outstanding." };
  }
  if (payment > outstanding) {
    return {
      ok: false,
      error: `That is more than the outstanding balance of ${outstanding.toFixed(2)}. Enter that amount or less.`,
    };
  }

  // Oldest first, by seq. Sorting on due_date would reorder a schedule
  // that was edited by hand and make the allocation non-deterministic
  // for two lines sharing a date; seq is unique per plan by constraint.
  const ordered = [...lines].sort((a, b) => a.seq - b.seq);

  const allocations: LineAllocation[] = [];
  let rest = payment;

  for (const line of ordered) {
    if (rest <= 0) break;
    const remaining = lineRemaining(line);
    if (remaining <= 0) continue;

    const applied = roundMoney(Math.min(rest, remaining));
    if (applied <= 0) continue;

    const amountPaid = roundMoney(line.amount_paid + applied);
    allocations.push({
      id: line.id,
      seq: line.seq,
      applied,
      amountPaid,
      fullyPaid: moneyEq(amountPaid, line.amount_due) || amountPaid > line.amount_due,
    });
    rest = roundMoney(rest - applied);
  }

  return {
    ok: true,
    allocations,
    applied: roundMoney(payment - rest),
    planSettled: moneyEq(payment, outstanding),
  };
}

/**
 * Apply an allocation to a copy of the lines. Used by the preview and
 * by the tests; the server action writes the same deltas to Postgres.
 */
export function applyAllocation(
  lines: readonly PlanLine[],
  allocations: readonly LineAllocation[]
): PlanLine[] {
  const bySeq = new Map(allocations.map((a) => [a.seq, a]));
  return lines.map((l) => {
    const a = bySeq.get(l.seq);
    return a ? { ...l, amount_paid: a.amountPaid } : { ...l };
  });
}

// ── Status and arrears ──────────────────────────────────────

export type PlanStatus = "active" | "settled" | "defaulted";

/**
 * 'settled' when every line is paid in full, 'active' otherwise.
 *
 * Never returns 'defaulted': default is a JUDGEMENT a human makes about
 * a customer — the cheques bounced, the phone is off, it has gone to
 * the lawyer — and no arrears threshold can make it for them. The
 * status column carries all three values; this function computes the
 * only one that is a fact about the numbers.
 */
export function planStatus(lines: readonly PlanLine[]): PlanStatus {
  if (lines.length === 0) return "active";
  return outstandingOf(lines) <= 0 ? "settled" : "active";
}

/** A line is overdue once its day has passed and it is not fully paid. */
export function isLineOverdue(line: PlanLine, today: string | Date): boolean {
  return lineRemaining(line) > 0 && daysBetween(line.due_date, toIsoDate(today)) > 0;
}

export type AgingBuckets = {
  /** Not yet due, or due today. */
  current: number;
  /** 1–30 days past due. */
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90plus: number;
  /** The four overdue buckets. */
  overdue: number;
  /** current + overdue. Equal to outstandingOf(lines). */
  outstanding: number;
};

/**
 * Split what is outstanding by how long it has been outstanding.
 *
 * A line due TODAY is `current`, not 0–30: it has not been missed yet,
 * and a showroom that shows this morning's instalment in arrears
 * teaches its staff to ignore the arrears column. The first bucket is
 * therefore 1–30 days late, and the boundaries are inclusive at both
 * ends (30 is in the first, 31 in the second, 91 and beyond in the
 * last).
 *
 * Computed, never stored. An `is_overdue` column would be correct only
 * until midnight, and correcting it nightly means a cron whose failure
 * is invisible.
 */
export function agingBuckets(lines: readonly PlanLine[], today: string | Date): AgingBuckets {
  const day = toIsoDate(today);
  const buckets: AgingBuckets = {
    current: 0,
    d0_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90plus: 0,
    overdue: 0,
    outstanding: 0,
  };

  for (const line of lines) {
    const remaining = lineRemaining(line);
    if (remaining <= 0) continue;

    const late = daysBetween(line.due_date, day);
    if (late <= 0) buckets.current += remaining;
    else if (late <= 30) buckets.d0_30 += remaining;
    else if (late <= 60) buckets.d31_60 += remaining;
    else if (late <= 90) buckets.d61_90 += remaining;
    else buckets.d90plus += remaining;
  }

  buckets.current = roundMoney(buckets.current);
  buckets.d0_30 = roundMoney(buckets.d0_30);
  buckets.d31_60 = roundMoney(buckets.d31_60);
  buckets.d61_90 = roundMoney(buckets.d61_90);
  buckets.d90plus = roundMoney(buckets.d90plus);
  buckets.overdue = roundMoney(
    buckets.d0_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90plus
  );
  buckets.outstanding = roundMoney(buckets.current + buckets.overdue);
  return buckets;
}

export function addAging(a: AgingBuckets, b: AgingBuckets): AgingBuckets {
  return {
    current: roundMoney(a.current + b.current),
    d0_30: roundMoney(a.d0_30 + b.d0_30),
    d31_60: roundMoney(a.d31_60 + b.d31_60),
    d61_90: roundMoney(a.d61_90 + b.d61_90),
    d90plus: roundMoney(a.d90plus + b.d90plus),
    overdue: roundMoney(a.overdue + b.overdue),
    outstanding: roundMoney(a.outstanding + b.outstanding),
  };
}

export const EMPTY_AGING: AgingBuckets = {
  current: 0,
  d0_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90plus: 0,
  overdue: 0,
  outstanding: 0,
};

export type PlanSummary = {
  total: number;
  paid: number;
  outstanding: number;
  /** The earliest line still owing anything, or null when settled. */
  nextDue: PlanLine | null;
  overdueAmount: number;
  overdueCount: number;
  settled: boolean;
  aging: AgingBuckets;
};

/** Everything both panels put on screen for one plan, in one pass. */
export function planSummary(lines: readonly PlanLine[], today: string | Date): PlanSummary {
  const ordered = [...lines].sort((a, b) => a.seq - b.seq);
  const day = toIsoDate(today);

  const total = roundMoney(ordered.reduce((s, l) => s + l.amount_due, 0));
  const paid = roundMoney(ordered.reduce((s, l) => s + Math.min(l.amount_paid, l.amount_due), 0));
  const outstanding = outstandingOf(ordered);

  const overdueLines = ordered.filter((l) => isLineOverdue(l, day));

  return {
    total,
    paid,
    outstanding,
    nextDue: ordered.find((l) => lineRemaining(l) > 0) ?? null,
    overdueAmount: roundMoney(overdueLines.reduce((s, l) => s + lineRemaining(l), 0)),
    overdueCount: overdueLines.length,
    settled: outstanding <= 0,
    aging: agingBuckets(ordered, day),
  };
}

// ── Cheques ─────────────────────────────────────────────────

export type ChequeStatus =
  | "in_safe"
  | "deposited"
  | "cleared"
  | "bounced"
  | "returned_to_customer";

/**
 * The status moves a cheque may make, mirroring `guard_cheque_status()`
 * in migration 0033 exactly. Kept here so the UI offers only the moves
 * the database will accept, rather than rendering a menu whose entries
 * fail on submit.
 *
 * bounced → deposited is real and deliberate: re-presenting a bounced
 * cheque after the drawer funds the account is ordinary practice. What
 * has CLEARED never moves again, and neither does one returned to the
 * customer.
 */
export const CHEQUE_TRANSITIONS: Record<ChequeStatus, ChequeStatus[]> = {
  in_safe: ["deposited", "returned_to_customer"],
  deposited: ["cleared", "bounced"],
  bounced: ["deposited"],
  cleared: [],
  returned_to_customer: [],
};

export function canMoveCheque(from: ChequeStatus, to: ChequeStatus): boolean {
  return CHEQUE_TRANSITIONS[from]?.includes(to) ?? false;
}

export type ChequeLike = {
  due_date: string;
  amount: number;
  status: ChequeStatus;
};

/**
 * The maturity calendar: cheques falling due within `days` of `today`,
 * grouped into ISO-ish weeks by the Saturday that starts them.
 *
 * Saturday, not Monday: the Egyptian working week runs Saturday to
 * Thursday, so a Monday-based grid splits every working week across two
 * rows and puts Friday — the one day the bank is shut — in the middle
 * of a group.
 */
export function weekStart(iso: string): string {
  const { y, m, d } = parseIsoDate(iso);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const backTo = (dow + 1) % 7; // Saturday = 6 -> 0 back
  return addDays(iso, -backTo);
}

function addDays(iso: string, add: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const t = new Date(Date.UTC(y, m - 1, d + add));
  return toIsoDate(t);
}

export type ChequeWeek<T extends ChequeLike> = {
  /** 'yyyy-mm-dd' of the Saturday this week starts. */
  weekStart: string;
  cheques: T[];
  total: number;
};

export function chequeMaturityWeeks<T extends ChequeLike>(
  cheques: readonly T[],
  today: string | Date,
  days = 30
): ChequeWeek<T>[] {
  const from = toIsoDate(today);
  const to = addDays(from, days);

  const inWindow = cheques.filter(
    (c) => daysBetween(from, c.due_date) >= 0 && daysBetween(c.due_date, to) >= 0
  );

  const byWeek = new Map<string, T[]>();
  for (const cheque of inWindow) {
    const key = weekStart(cheque.due_date);
    const bucket = byWeek.get(key);
    if (bucket) bucket.push(cheque);
    else byWeek.set(key, [cheque]);
  }

  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([start, list]) => ({
      weekStart: start,
      cheques: [...list].sort((a, b) => (a.due_date < b.due_date ? -1 : 1)),
      total: roundMoney(list.reduce((s, c) => s + c.amount, 0)),
    }));
}
