// Relative, not aliased, for the reason branch-authority.ts gives: this
// module is under vitest, which resolves no tsconfig paths here.
import type { TaskStatus } from "./supabase/types";

/**
 * The task board's pure half (migration 0053).
 *
 * Three rules live here and nowhere else:
 *
 *   1. WHEN A TEMPLATE FALLS DUE. The database owns the authoritative
 *      copy in task_template_due(); this is the app's twin, and the two
 *      must agree. If this one says Tuesday and Postgres says Wednesday,
 *      the page shows a duty that never materialises — which reads to
 *      the person looking at it as work they were never given.
 *
 *   2. HOW LEADS SPLIT ACROSS THE FLOOR. Round robin over the salespeople
 *      on duty, in a stated order, so that "who got the awkward one" is
 *      a question with an answer rather than a suspicion.
 *
 *   3. WHAT THE DAY ADDS UP TO. The counts the end-of-day report is
 *      built from. Written once, because the badge on the page and the
 *      number in the manager's inbox disagreeing is the fastest way to
 *      make both untrustworthy.
 */

export const RECURRENCES = ["daily", "weekly", "monthly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

/**
 * The ceiling on a monthly task's day, and a CHECK in the database
 * rather than a convention. A duty due on the 31st would silently never
 * fall due in February — a recurring instruction that skips a month is
 * worse than a form that refused the number.
 */
export const MAX_DAY_OF_MONTH = 28;

/** 0 = Sunday, matching Postgres `extract(dow …)` and `Date.getUTCDay()`. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** A calendar day as the showroom writes it: YYYY-MM-DD. */
export type DayKey = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a day key as a real instant at UTC midnight.
 *
 * UTC deliberately: a DayKey has already had the viewer's offset applied
 * (dayKey() in lib/attendance.ts produces these). Re-reading it in the
 * server's zone — always UTC on Workers, but not on a developer's
 * laptop — would shift the weekday of every task by a day for half the
 * world.
 */
export function parseDayKey(day: DayKey): Date | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Refuses a rolled-over date (2026-02-31 becomes 3 March) rather than
  // reporting on a day nobody asked about.
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return probe;
}

/** 0 = Sunday. Null for a malformed key rather than a silent NaN. */
export function weekdayOf(day: DayKey): number | null {
  return parseDayKey(day)?.getUTCDay() ?? null;
}

/** 1-31. Null for a malformed key. */
export function dayOfMonthOf(day: DayKey): number | null {
  return parseDayKey(day)?.getUTCDate() ?? null;
}

export interface RecurrenceSpec {
  recurrence: Recurrence | string;
  weekday: number | null;
  day_of_month: number | null;
}

/**
 * Does this template fall due on this day?
 *
 * The app-side twin of task_template_due() (0053), and the two must stay
 * in step. An INACTIVE template is deliberately not considered here:
 * `active` is a separate question that every caller asks separately,
 * because "is it due today" and "is it still policy" are different
 * facts, and folding them together makes a retired duty look like one
 * that simply never comes round.
 */
export function templateDueOn(spec: RecurrenceSpec, day: DayKey): boolean {
  switch (spec.recurrence) {
    case "daily":
      return true;
    case "weekly":
      return spec.weekday != null && weekdayOf(day) === spec.weekday;
    case "monthly":
      return spec.day_of_month != null && dayOfMonthOf(day) === spec.day_of_month;
    default:
      return false;
  }
}

/** The active templates that fall due on `day` — the "today's duties" list. */
export function templatesDueOn<T extends RecurrenceSpec & { active: boolean }>(
  templates: readonly T[],
  day: DayKey
): T[] {
  return templates.filter((t) => t.active && templateDueOn(t, day));
}

// ── Splitting the leads ─────────────────────────────────────

export interface LeadAssignment<Id> {
  leadId: Id;
  assigneeId: string;
}

/**
 * Deal the leads round the floor, one each, until they run out.
 *
 * ROUND ROBIN, NOT RANDOM, and not "whoever has the fewest open tasks".
 * Two reasons, both about the people rather than the algorithm:
 *
 *   * A manager has to be able to explain the split to the person who
 *     got the eleventh lead. "In order, one each, round and round" is an
 *     explanation; "the system balanced it" is not.
 *   * Balancing on open task count rewards the salesperson who never
 *     ticks anything, by handing them less work. That is backwards.
 *
 * With nobody on the floor this returns nothing rather than throwing: an
 * empty roster is a real state on a Friday, and the caller says so on
 * the screen instead of crashing.
 *
 * The ORDER of `salespeople` is part of the contract — the pages sort by
 * name, so the same list of leads always splits the same way.
 */
export function splitLeads<Id>(
  leadIds: readonly Id[],
  salespeople: readonly string[]
): LeadAssignment<Id>[] {
  if (salespeople.length === 0) return [];
  return leadIds.map((leadId, i) => ({
    leadId,
    assigneeId: salespeople[i % salespeople.length],
  }));
}

/** How many each person ends up with — what the confirmation shows. */
export function splitCounts<Id>(
  assignments: readonly LeadAssignment<Id>[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of assignments) {
    counts.set(a.assigneeId, (counts.get(a.assigneeId) ?? 0) + 1);
  }
  return counts;
}

// ── What the day added up to ────────────────────────────────

export interface DayCounts {
  done: number;
  skipped: number;
  open: number;
  cancelled: number;
  /**
   * Everything actually asked of the person — done + skipped + open.
   * Withdrawn tasks are NOT counted: a manager who cancels an
   * instruction has un-asked for it, and leaving it in the denominator
   * would score somebody down for work nobody wanted done.
   */
  total: number;
}

export const EMPTY_DAY: DayCounts = {
  done: 0,
  skipped: 0,
  open: 0,
  cancelled: 0,
  total: 0,
};

export function summariseDay(tasks: readonly { status: TaskStatus }[]): DayCounts {
  const counts: DayCounts = { ...EMPTY_DAY };
  for (const task of tasks) {
    if (task.status === "done") counts.done += 1;
    else if (task.status === "skipped") counts.skipped += 1;
    else if (task.status === "cancelled") counts.cancelled += 1;
    else counts.open += 1;
  }
  counts.total = counts.done + counts.skipped + counts.open;
  return counts;
}

/**
 * Whole percent done, out of what was asked. A day with nothing asked of
 * it is 100 rather than 0 or NaN — no tasks is not a failing day, and a
 * red 0% against an empty board is a lie the report should not tell.
 */
export function completionPercent(counts: DayCounts): number {
  if (counts.total === 0) return 100;
  return Math.round((counts.done / counts.total) * 100);
}

/**
 * The three buckets the evening mail lists, in the order it lists them:
 * what was done, what was consciously declined and why, and what was
 * simply left. A cancelled task appears in none of them.
 */
export interface DayBuckets<T> {
  done: T[];
  skipped: T[];
  ignored: T[];
}

export function bucketDay<T extends { status: TaskStatus }>(
  tasks: readonly T[]
): DayBuckets<T> {
  return {
    done: tasks.filter((t) => t.status === "done"),
    skipped: tasks.filter((t) => t.status === "skipped"),
    ignored: tasks.filter((t) => t.status === "open"),
  };
}

/** Board order: unfinished first, then alphabetical. */
export function sortForBoard<T extends { status: TaskStatus; title: string }>(
  tasks: readonly T[]
): T[] {
  const rank: Record<TaskStatus, number> = {
    open: 0,
    skipped: 1,
    done: 2,
    cancelled: 3,
  };
  return [...tasks].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)
  );
}

/** Narrow a string off a form to a status the database will accept. */
export function isTaskStatus(value: string): value is TaskStatus {
  return (
    value === "open" || value === "done" || value === "skipped" || value === "cancelled"
  );
}
