import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  agingBuckets,
  allocatePayment,
  applyAllocation,
  buildSchedule,
  canMoveCheque,
  chequeMaturityWeeks,
  daysBetween,
  outstandingOf,
  planStatus,
  planSummary,
  roundMoney,
  weekStart,
  type PlanLine,
} from "./receivables";

const sum = (ns: number[]) => roundMoney(ns.reduce((a, b) => a + b, 0));

/** A stored schedule from a plan, for the allocation tests. */
function lines(
  spec: [seq: number, due: string, due_amount: number, paid: number][]
): PlanLine[] {
  return spec.map(([seq, due_date, amount_due, amount_paid]) => ({
    id: `line-${seq}`,
    seq,
    due_date,
    amount_due,
    amount_paid,
  }));
}

describe("roundMoney", () => {
  it("rounds half up even where the float representation is below the half", () => {
    // Math.round(1.005 * 100) / 100 is 1.00 — the bug this guards.
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(1234.567)).toBe(1234.57);
    expect(roundMoney(-0)).toBe(0);
  });
});

describe("addMonthsClamped", () => {
  it("clamps a day-31 start into a short month", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-31", 3)).toBe("2026-04-30");
  });

  it("clamps from the ORIGINAL day, so March is the 31st again", () => {
    // The chained-addition bug: +1 month twelve times from 31 Jan drags
    // every later date back to the 28th for the rest of the plan.
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsClamped("2026-01-31", 5)).toBe("2026-06-30");
    expect(addMonthsClamped("2026-01-31", 7)).toBe("2026-08-31");
  });

  it("knows about leap years", () => {
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2027-01-29", 1)).toBe("2027-02-28");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonthsClamped("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonthsClamped("2026-02-15", -3)).toBe("2025-11-15");
  });

  it("refuses a date that is not a calendar day", () => {
    expect(() => addMonthsClamped("2026-02-30", 1)).toThrow();
    expect(() => addMonthsClamped("2026-13-01", 1)).toThrow();
    expect(() => addMonthsClamped("31-01-2026", 1)).toThrow();
  });
});

describe("daysBetween", () => {
  it("counts calendar days, sign included", () => {
    expect(daysBetween("2026-08-20", "2026-08-20")).toBe(0);
    expect(daysBetween("2026-08-20", "2026-09-19")).toBe(30);
    expect(daysBetween("2026-09-19", "2026-08-20")).toBe(-30);
  });

  it("is unaffected by DST-shaped month boundaries", () => {
    // Egypt observes DST; a local-midnight implementation returns 30.5
    // days here and rounds inconsistently across the transition.
    expect(daysBetween("2026-04-15", "2026-05-15")).toBe(30);
    expect(daysBetween("2026-10-15", "2026-11-15")).toBe(31);
  });
});

describe("buildSchedule", () => {
  it("computes FLAT interest on the whole principal for the whole term", () => {
    // 300,000 at 7.5% flat over 24 months = 300,000 × 0.075 × 2 = 45,000.
    // An amortised reading of the same rate would produce ~24,000 and
    // undercharge the customer by nearly half.
    const s = buildSchedule({
      principal: 300_000,
      annualFlatRate: 7.5,
      months: 24,
      startDate: "2026-09-01",
    });
    expect(s.interest).toBe(45_000);
    expect(s.totalPayable).toBe(345_000);
    expect(s.monthlyAmount).toBe(14_375);
    expect(s.lines).toHaveLength(24);
    expect(sum(s.lines.map((l) => l.amount_due))).toBe(345_000);
  });

  it("treats a null rate as interest-free", () => {
    const s = buildSchedule({
      principal: 120_000,
      annualFlatRate: null,
      months: 12,
      startDate: "2026-01-01",
    });
    expect(s.interest).toBe(0);
    expect(s.totalPayable).toBe(120_000);
    expect(s.monthlyAmount).toBe(10_000);
  });

  it("puts the rounding remainder on the LAST line so the schedule sums exactly", () => {
    // 100,000 over 7 months = 14,285.714…; round to 14,285.71, and
    // 7 × 14,285.71 = 99,999.97 — three piasters short. The last line
    // must carry them.
    const s = buildSchedule({
      principal: 100_000,
      annualFlatRate: 0,
      months: 7,
      startDate: "2026-03-10",
    });
    expect(s.monthlyAmount).toBe(14_285.71);
    expect(s.lines.slice(0, 6).every((l) => l.amount_due === 14_285.71)).toBe(true);
    expect(s.lines[6].amount_due).toBe(14_285.74);
    expect(sum(s.lines.map((l) => l.amount_due))).toBe(100_000);
  });

  it("keeps the last line exact when the remainder runs the other way", () => {
    // 10,000 over 3 = 3,333.33…; 3 × 3,333.33 = 9,999.99, so the last
    // line is a piaster LARGER.
    const s = buildSchedule({
      principal: 10_000,
      annualFlatRate: 0,
      months: 3,
      startDate: "2026-05-05",
    });
    expect(s.lines.map((l) => l.amount_due)).toEqual([3_333.33, 3_333.33, 3_333.34]);
    expect(sum(s.lines.map((l) => l.amount_due))).toBe(10_000);
  });

  it("every line is strictly positive, which the amount_due CHECK requires", () => {
    for (const months of [1, 2, 7, 11, 13, 36, 60, 119, 120]) {
      const s = buildSchedule({
        principal: 250_000,
        annualFlatRate: 12.25,
        months,
        startDate: "2026-01-31",
      });
      expect(s.lines).toHaveLength(months);
      expect(s.lines.every((l) => l.amount_due > 0)).toBe(true);
      expect(sum(s.lines.map((l) => l.amount_due))).toBe(s.totalPayable);
    }
  });

  it("runs due dates monthly from the start date, first instalment on it", () => {
    const s = buildSchedule({
      principal: 90_000,
      annualFlatRate: 0,
      months: 4,
      startDate: "2026-01-31",
    });
    expect(s.lines.map((l) => l.due_date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("refuses input the database would reject anyway", () => {
    const base = { principal: 100_000, annualFlatRate: 5, months: 12, startDate: "2026-01-01" };
    expect(() => buildSchedule({ ...base, principal: 0 })).toThrow(/greater than zero/);
    expect(() => buildSchedule({ ...base, principal: -1 })).toThrow(/greater than zero/);
    expect(() => buildSchedule({ ...base, months: 0 })).toThrow(/whole number of months/);
    expect(() => buildSchedule({ ...base, months: 121 })).toThrow(/whole number of months/);
    expect(() => buildSchedule({ ...base, months: 6.5 })).toThrow(/whole number of months/);
    expect(() => buildSchedule({ ...base, annualFlatRate: 101 })).toThrow(/between 0 and 100/);
    expect(() => buildSchedule({ ...base, annualFlatRate: -1 })).toThrow(/between 0 and 100/);
    // Too small to give every instalment a positive amount.
    expect(() => buildSchedule({ ...base, principal: 50, months: 120 })).toThrow(/too small/);
  });
});

describe("allocatePayment", () => {
  const schedule = () =>
    lines([
      [1, "2026-01-05", 1_000, 0],
      [2, "2026-02-05", 1_000, 0],
      [3, "2026-03-05", 1_000, 0],
    ]);

  it("fills the oldest unpaid line first", () => {
    const res = allocatePayment(schedule(), 1_000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.allocations).toEqual([
      { id: "line-1", seq: 1, applied: 1_000, amountPaid: 1_000, fullyPaid: true },
    ]);
    expect(res.planSettled).toBe(false);
  });

  it("splits on the boundary line and leaves it partly paid", () => {
    const res = allocatePayment(schedule(), 1_500);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.allocations).toEqual([
      { id: "line-1", seq: 1, applied: 1_000, amountPaid: 1_000, fullyPaid: true },
      { id: "line-2", seq: 2, applied: 500, amountPaid: 500, fullyPaid: false },
    ]);
    expect(res.applied).toBe(1_500);
  });

  it("continues from an existing partial payment rather than restarting the line", () => {
    const partly = lines([
      [1, "2026-01-05", 1_000, 400],
      [2, "2026-02-05", 1_000, 0],
    ]);
    const res = allocatePayment(partly, 700);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.allocations).toEqual([
      { id: "line-1", seq: 1, applied: 600, amountPaid: 1_000, fullyPaid: true },
      { id: "line-2", seq: 2, applied: 100, amountPaid: 100, fullyPaid: false },
    ]);
  });

  it("skips lines already settled", () => {
    const partly = lines([
      [1, "2026-01-05", 1_000, 1_000],
      [2, "2026-02-05", 1_000, 1_000],
      [3, "2026-03-05", 1_000, 0],
    ]);
    const res = allocatePayment(partly, 250);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.allocations.map((a) => a.seq)).toEqual([3]);
  });

  it("allocates oldest-first by seq even when the rows arrive shuffled", () => {
    const shuffled = [schedule()[2], schedule()[0], schedule()[1]];
    const res = allocatePayment(shuffled, 2_000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.allocations.map((a) => a.seq)).toEqual([1, 2]);
  });

  it("settles the plan exactly on the outstanding balance", () => {
    const nearlyDone = lines([
      [1, "2026-01-05", 1_000, 1_000],
      [2, "2026-02-05", 1_000, 600],
      [3, "2026-03-05", 1_000, 0],
    ]);
    const res = allocatePayment(nearlyDone, 1_400);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.planSettled).toBe(true);
    const after = applyAllocation(nearlyDone, res.allocations);
    expect(outstandingOf(after)).toBe(0);
    expect(planStatus(after)).toBe("settled");
  });

  it("REFUSES an overpayment, naming the real outstanding figure", () => {
    const res = allocatePayment(schedule(), 3_000.01);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/3000\.00/);
    expect(res.error).toMatch(/more than the outstanding balance/i);
  });

  it("refuses a payment on a plan with nothing left to pay", () => {
    const done = lines([[1, "2026-01-05", 1_000, 1_000]]);
    const res = allocatePayment(done, 100);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already settled/i);
  });

  it("refuses zero, negative and non-finite amounts", () => {
    for (const bad of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = allocatePayment(schedule(), bad);
      expect(res.ok).toBe(false);
    }
  });

  it("settles a rounded schedule to the piaster, remainder line included", () => {
    // The end-to-end version of the rounding test: build a real
    // schedule, pay it off in three uneven instalments, and land on
    // exactly zero.
    const s = buildSchedule({
      principal: 100_000,
      annualFlatRate: 7.5,
      months: 7,
      startDate: "2026-03-10",
    });
    let stored: PlanLine[] = s.lines.map((l) => ({ ...l, amount_paid: 0 }));

    for (const payment of [50_000, 40_000, roundMoney(s.totalPayable - 90_000)]) {
      const res = allocatePayment(stored, payment);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      stored = applyAllocation(stored, res.allocations);
    }

    expect(outstandingOf(stored)).toBe(0);
    expect(planStatus(stored)).toBe("settled");
    expect(sum(stored.map((l) => l.amount_paid))).toBe(s.totalPayable);
  });
});

describe("planStatus", () => {
  it("is active while a single piaster is outstanding", () => {
    expect(planStatus(lines([[1, "2026-01-05", 1_000, 999.99]]))).toBe("active");
  });

  it("is settled when every line is paid in full", () => {
    expect(
      planStatus(
        lines([
          [1, "2026-01-05", 1_000, 1_000],
          [2, "2026-02-05", 1_000, 1_000],
        ])
      )
    ).toBe("settled");
  });

  it("never invents 'defaulted' — that is a human's call", () => {
    const longOverdue = lines([[1, "2020-01-05", 1_000, 0]]);
    expect(planStatus(longOverdue)).toBe("active");
  });
});

describe("agingBuckets", () => {
  const TODAY = "2026-08-20";

  const book = () =>
    lines([
      [1, "2026-09-20", 1_000, 0], // future            -> current
      [2, "2026-08-20", 1_000, 0], // due TODAY         -> current
      [3, "2026-08-19", 1_000, 0], // 1 day late        -> 0-30
      [4, "2026-07-21", 1_000, 0], // 30 days late      -> 0-30
      [5, "2026-07-20", 1_000, 0], // 31 days late      -> 31-60
      [6, "2026-06-21", 1_000, 0], // 60 days late      -> 31-60
      [7, "2026-06-20", 1_000, 0], // 61 days late      -> 61-90
      [8, "2026-05-22", 1_000, 0], // 90 days late      -> 61-90
      [9, "2026-05-21", 1_000, 0], // 91 days late      -> 90+
      [10, "2025-01-01", 1_000, 1_000], // paid         -> nothing
    ]);

  it("puts a line due today in `current`, not in arrears", () => {
    const a = agingBuckets(book(), TODAY);
    expect(a.current).toBe(2_000);
  });

  it("splits arrears at 30 / 60 / 90 days, inclusive at each boundary", () => {
    const a = agingBuckets(book(), TODAY);
    expect(a.d0_30).toBe(2_000);
    expect(a.d31_60).toBe(2_000);
    expect(a.d61_90).toBe(2_000);
    expect(a.d90plus).toBe(1_000);
    expect(a.overdue).toBe(7_000);
  });

  it("counts only what is still owed on a partly-paid line", () => {
    const a = agingBuckets(lines([[1, "2026-01-01", 1_000, 250]]), TODAY);
    expect(a.d90plus).toBe(750);
    expect(a.outstanding).toBe(750);
  });

  it("always sums back to the plan's outstanding balance", () => {
    const b = book();
    const a = agingBuckets(b, TODAY);
    expect(a.outstanding).toBe(outstandingOf(b));
    expect(roundMoney(a.current + a.d0_30 + a.d31_60 + a.d61_90 + a.d90plus)).toBe(a.outstanding);
  });

  it("accepts a Date and reads it in UTC", () => {
    const a = agingBuckets(book(), new Date("2026-08-20T23:30:00Z"));
    expect(a.current).toBe(2_000);
  });
});

describe("planSummary", () => {
  it("reports the next due line, the arrears, and the totals together", () => {
    const s = planSummary(
      lines([
        [1, "2026-06-05", 1_000, 1_000],
        [2, "2026-07-05", 1_000, 400],
        [3, "2026-08-05", 1_000, 0],
        [4, "2026-09-05", 1_000, 0],
      ]),
      "2026-08-20"
    );
    expect(s.total).toBe(4_000);
    expect(s.paid).toBe(1_400);
    expect(s.outstanding).toBe(2_600);
    expect(s.nextDue?.seq).toBe(2);
    expect(s.overdueCount).toBe(2); // lines 2 and 3
    expect(s.overdueAmount).toBe(1_600);
    expect(s.settled).toBe(false);
  });

  it("has no next due line once the plan is settled", () => {
    const s = planSummary(lines([[1, "2026-01-05", 500, 500]]), "2026-08-20");
    expect(s.nextDue).toBeNull();
    expect(s.settled).toBe(true);
  });
});

describe("cheque transitions", () => {
  it("mirrors the database guard, re-presentation included", () => {
    expect(canMoveCheque("in_safe", "deposited")).toBe(true);
    expect(canMoveCheque("in_safe", "returned_to_customer")).toBe(true);
    expect(canMoveCheque("deposited", "cleared")).toBe(true);
    expect(canMoveCheque("deposited", "bounced")).toBe(true);
    expect(canMoveCheque("bounced", "deposited")).toBe(true);
  });

  it("lets nothing leave cleared, or skip the safe", () => {
    expect(canMoveCheque("cleared", "bounced")).toBe(false);
    expect(canMoveCheque("cleared", "deposited")).toBe(false);
    expect(canMoveCheque("returned_to_customer", "deposited")).toBe(false);
    expect(canMoveCheque("in_safe", "cleared")).toBe(false);
    expect(canMoveCheque("bounced", "cleared")).toBe(false);
  });
});

describe("chequeMaturityWeeks", () => {
  // 2026-08-20 is a Thursday; its week starts Saturday 2026-08-15.
  it("groups on the Saturday that starts the Egyptian working week", () => {
    expect(weekStart("2026-08-20")).toBe("2026-08-15"); // Thu
    expect(weekStart("2026-08-15")).toBe("2026-08-15"); // Sat itself
    expect(weekStart("2026-08-14")).toBe("2026-08-08"); // Fri
    expect(weekStart("2026-08-16")).toBe("2026-08-15"); // Sun
  });

  it("keeps only the next 30 days and orders the weeks", () => {
    const cheques = [
      { due_date: "2026-08-19", amount: 100, status: "in_safe" as const }, // yesterday
      { due_date: "2026-08-20", amount: 200, status: "in_safe" as const },
      { due_date: "2026-08-25", amount: 300, status: "deposited" as const },
      { due_date: "2026-09-19", amount: 400, status: "in_safe" as const }, // day 30
      { due_date: "2026-09-21", amount: 500, status: "in_safe" as const }, // day 32
    ];
    const weeks = chequeMaturityWeeks(cheques, "2026-08-20");
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-08-15", "2026-08-22", "2026-09-19"]);
    expect(weeks[0].total).toBe(200);
    expect(weeks[1].cheques.map((c) => c.amount)).toEqual([300]);
    expect(weeks[2].total).toBe(400);
  });
});
