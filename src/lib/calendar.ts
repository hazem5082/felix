/**
 * Month-grid arithmetic for the calendar tab.
 *
 * Everything here works in the *server's* local zone via the plain Date
 * constructor, because the grid is a picture of a wall calendar: the cell
 * a meeting lands in has to match the day the user would say it is on.
 * The instants themselves stay UTC — only the bucketing is local.
 */

/** `YYYY-MM`, the shape the `?month=` query parameter uses. */
export type MonthKey = string;

export function monthKey(d: Date): MonthKey {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * First instant of a `YYYY-MM`. Falls back to the current month for
 * anything unparseable, so a hand-edited URL degrades to "this month"
 * rather than to an invalid Date that poisons every downstream call.
 */
export function monthStart(key: MonthKey | undefined, now: Date = new Date()): Date {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key ?? "");
  if (!match) return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date(Number(match[1]), Number(match[2]) - 1, 1);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * The 42 cells of a six-week grid, starting on the given weekday.
 *
 * Always six weeks, never five: a grid that changes height between
 * months makes the whole page jump when you page through it.
 */
export function monthGrid(start: Date, weekStartsOn = 0): Date[] {
  const offset = (start.getDay() - weekStartsOn + 7) % 7;
  const first = new Date(start.getFullYear(), start.getMonth(), 1 - offset);
  return Array.from(
    { length: 42 },
    (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)
  );
}

/**
 * The window to ask `calendar_meetings()` for: the whole visible grid,
 * not just the month. A meeting on the 31st of the previous month is
 * drawn in the first row, so it has to be fetched too.
 */
export function gridWindow(start: Date, weekStartsOn = 0): { from: Date; to: Date } {
  const cells = monthGrid(start, weekStartsOn);
  const first = cells[0];
  const last = cells[cells.length - 1];
  return {
    from: new Date(first.getFullYear(), first.getMonth(), first.getDate()),
    to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
  };
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * Bucket meetings by the local day they start on, keyed like `dayKey`.
 * A meeting is listed on its start day only — the 12-hour cap in
 * migration 0006 means nothing legitimately spans a day boundary by
 * more than a few hours.
 */
export function bucketByDay<T extends { starts_at: string }>(
  items: T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const d = new Date(item.starts_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time, never an ISO Z string. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
