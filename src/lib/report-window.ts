/**
 * Date-window parsing for the report suite. Pure so it can be tested:
 * these bounds go straight into financial queries, and a bad default
 * here silently produces a report whose numbers are for the wrong
 * period — the worst kind of correct-looking document.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Two years — roomy enough for a yearly report, small enough that a
 *  typo'd year can't ask the database for a decade of ledger rows. */
export const MAX_WINDOW_DAYS = 750;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportWindow {
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

/**
 * Minutes east of UTC — the viewer's offset, sent by the launcher.
 * Clamped to the real-world range; anything else is treated as UTC
 * rather than trusted, since it shifts every boundary in the report.
 */
export function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && Math.abs(n) <= 840 ? n : 0;
}

/**
 * A calendar day in a given zone, as a real instant.
 *
 * The naive `new Date(y, m-1, d)` reads the *server's* zone, and on
 * Cloudflare Workers that is always UTC. A Cairo showroom's "July"
 * report then covered 01 Jul 03:00 – 01 Aug 03:00 local, so a sale
 * closed at 01:30 on the 1st was reported in the previous month. The
 * offset makes the boundary mean local midnight where the showroom is.
 */
function dayInZone(y: number, m: number, d: number, offsetMinutes: number): Date {
  return new Date(Date.UTC(y, m - 1, d) - offsetMinutes * 60_000);
}

function parseDay(s: string | undefined, offsetMinutes: number): Date | null {
  if (!s || !ISO_DAY.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  // Reject a rolled-over date (e.g. 2026-02-31 → 3 March) rather than
  // reporting on a window the user never asked for.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return dayInZone(y, m, d, offsetMinutes);
}

/**
 * Resolve ?from=YYYY-MM-DD&to=YYYY-MM-DD (to is INCLUSIVE in the URL,
 * as a human reads it; the returned bound is exclusive), interpreting
 * both as local days in `offsetMinutes`. Anything missing or malformed
 * falls back to the current calendar month in that same zone.
 */
export function resolveWindow(
  fromParam: string | undefined,
  toParam: string | undefined,
  now: Date = new Date(),
  offsetMinutes = 0
): ReportWindow {
  const from = parseDay(fromParam, offsetMinutes);
  const toInclusive = parseDay(toParam, offsetMinutes);

  if (from && toInclusive) {
    const to = new Date(toInclusive.getTime() + DAY_MS);
    if (to > from && to.getTime() - from.getTime() <= MAX_WINDOW_DAYS * DAY_MS) {
      return { from, to };
    }
  }

  // "This month" as the viewer's calendar sees it.
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  return {
    from: dayInZone(y, m, 1, offsetMinutes),
    to: dayInZone(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, offsetMinutes),
  };
}

export const REPORT_KINDS = ["operating", "investors", "expenses", "salaries"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(s: string): s is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(s);
}
