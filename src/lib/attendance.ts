import type { SemanticTone } from "@/components/ui/status-pill";

/**
 * The attendance day, derived from the event stream (migration 0038).
 *
 * Nothing here is stored. `attendance_events` is append-only and holds
 * punches; "when did he arrive", "how long was he on break", "is he
 * still in" are all functions over those punches, and they belong in a
 * pure tested module rather than in a column that could drift from the
 * definition below — the same call 0036 made for stock ageing.
 *
 * WHY THE STREAM AND NOT A ROW PER DAY
 * A day-shaped row has to decide in advance how many breaks a person
 * may take, and it loses the ability to answer "when did he ACTUALLY
 * leave" once somebody changes their mind. The stream answers both and
 * costs one GROUP BY.
 */

export const PUNCH_KINDS = ["in", "break_start", "break_end", "out"] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];

export function isPunchKind(s: string): s is PunchKind {
  return (PUNCH_KINDS as readonly string[]).includes(s);
}

export const WORK_MODES = ["on_site", "remote"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export function isWorkMode(s: string): s is WorkMode {
  return (WORK_MODES as readonly string[]).includes(s);
}

/** The shape the pages select. A subset of the table, not all of it. */
export interface AttendanceEvent {
  id: string;
  profile_id: string;
  branch_id: string;
  kind: PunchKind;
  occurred_at: string;
  latitude: number | string | null;
  longitude: number | string | null;
  accuracy_m: number | string | null;
  distance_m: number | string | null;
  within_geofence: boolean | null;
  source: "device" | "adjustment";
  recorded_by: string | null;
  reason: string | null;
  voided_at: string | null;
}

/**
 * Where a person stands right now.
 *   out      — not on the premises (or never arrived today)
 *   in       — clocked in and working
 *   on_break — stepped out, expected back
 */
export type PunchState = "out" | "in" | "on_break";

/**
 * VOIDED ROWS ARE NOT EVENTS. A struck punch stays in the table because
 * nothing in FELIX is deleted, but it must not affect a total, a state
 * or a report line — otherwise voiding would be decoration. Every
 * function in this module funnels through here, and none of them
 * filters on its own.
 */
export function liveEvents(events: readonly AttendanceEvent[]): AttendanceEvent[] {
  return events.filter((e) => e.voided_at === null);
}

function chronological(events: readonly AttendanceEvent[]): AttendanceEvent[] {
  return [...liveEvents(events)].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
}

/**
 * The state a stream leaves a person in.
 *
 * Written as a fold rather than "look at the last event" because the
 * last event is not always decisive: a `break_end` after an `out` is a
 * correction somebody filed out of order, and a fold reaches the same
 * answer as a human reading the list top to bottom.
 */
export function stateAfter(events: readonly AttendanceEvent[]): PunchState {
  let state: PunchState = "out";
  for (const e of chronological(events)) {
    switch (e.kind) {
      case "in":
        state = "in";
        break;
      case "break_start":
        // Only meaningful while working; a break from "out" is noise.
        if (state === "in") state = "on_break";
        break;
      case "break_end":
        state = "in";
        break;
      case "out":
        state = "out";
        break;
    }
  }
  return state;
}

/**
 * Which buttons the punch screen may offer.
 *
 * A second shift on the same day is legitimate — a salesperson who
 * leaves at 14:00 and is called back at 19:00 punches in again — so
 * "out" always allows "in". What is NOT allowed is punching in twice
 * without leaving, which would silently double the day.
 */
export function allowedNext(state: PunchState): PunchKind[] {
  switch (state) {
    case "out":
      return ["in"];
    case "in":
      return ["break_start", "out"];
    case "on_break":
      return ["break_end", "out"];
  }
}

export function canPunch(state: PunchState, kind: PunchKind): boolean {
  return allowedNext(state).includes(kind);
}

// ── Local days ──────────────────────────────────────────────
//
// The server runs on Cloudflare Workers, which is always UTC. A Cairo
// showroom's "Tuesday" is not UTC Tuesday, and a punch at 01:30 local
// would otherwise be filed under Monday. Every boundary below takes the
// viewer's offset in minutes east of UTC, exactly as the report suite
// does (src/lib/report-window.ts).

/** YYYY-MM-DD, as the calendar on the wall of the showroom reads it. */
export function dayKey(occurredAt: string | Date, offsetMinutes = 0): string {
  const local = new Date(new Date(occurredAt).getTime() + offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}`;
}

/** HH:MM in the viewer's zone. */
export function localTime(occurredAt: string | Date, offsetMinutes = 0): string {
  const local = new Date(new Date(occurredAt).getTime() + offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`;
}

export interface DaySummary {
  /** YYYY-MM-DD in the viewer's zone. */
  date: string;
  profileId: string;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
  breaks: number;
  /** Punches the database judged to be outside the fence. */
  outsideFence: number;
  /** Punches taken where the branch had no pin — verdict unavailable. */
  unassessed: number;
  /** At least one row was entered by a manager rather than punched. */
  adjusted: boolean;
  /** Still in or on break when the window closed. */
  open: boolean;
  events: AttendanceEvent[];
}

/**
 * Roll one person's one day up into a timesheet line.
 *
 * `now` closes a still-open interval so that somebody who has been on
 * the floor since 09:00 does not read as zero minutes worked at 14:00.
 * It is passed in rather than read from the clock so this stays pure
 * and testable; the caller supplies `new Date()`.
 *
 * An interval is only counted when it CLOSES. An `in` with no matching
 * `out` and a `now` earlier than the punch (clock skew) contributes
 * nothing rather than something negative.
 */
export function summariseDay(
  events: readonly AttendanceEvent[],
  opts: { date: string; profileId: string; offsetMinutes?: number; now?: Date }
): DaySummary {
  const offset = opts.offsetMinutes ?? 0;
  const now = opts.now ?? new Date();
  const day = chronological(events).filter((e) => dayKey(e.occurred_at, offset) === opts.date);

  let workedMs = 0;
  let breakMs = 0;
  let breaks = 0;
  let openWorkAt: number | null = null;
  let openBreakAt: number | null = null;
  let firstIn: string | null = null;
  let lastOut: string | null = null;

  const close = (start: number | null, end: number): number =>
    start === null ? 0 : Math.max(0, end - start);

  for (const e of day) {
    const t = new Date(e.occurred_at).getTime();
    switch (e.kind) {
      case "in":
        if (!firstIn) firstIn = e.occurred_at;
        // Re-punching "in" without leaving must not open a second
        // interval; the first one simply continues.
        if (openWorkAt === null) openWorkAt = t;
        break;
      case "break_start":
        workedMs += close(openWorkAt, t);
        openWorkAt = null;
        if (openBreakAt === null) {
          openBreakAt = t;
          breaks += 1;
        }
        break;
      case "break_end":
        breakMs += close(openBreakAt, t);
        openBreakAt = null;
        if (openWorkAt === null) openWorkAt = t;
        break;
      case "out":
        workedMs += close(openWorkAt, t);
        breakMs += close(openBreakAt, t);
        openWorkAt = null;
        openBreakAt = null;
        lastOut = e.occurred_at;
        break;
    }
  }

  // Still in or on break: run the clock to `now`, but never past the end
  // of the day being summarised — a report for last Tuesday must not
  // credit somebody with the eight days since.
  const open = openWorkAt !== null || openBreakAt !== null;
  if (open) {
    const endOfDay = endOfLocalDay(opts.date, offset);
    const until = Math.min(now.getTime(), endOfDay);
    workedMs += close(openWorkAt, until);
    breakMs += close(openBreakAt, until);
  }

  return {
    date: opts.date,
    profileId: opts.profileId,
    firstIn,
    lastOut,
    workedMinutes: Math.round(workedMs / 60_000),
    breakMinutes: Math.round(breakMs / 60_000),
    breaks,
    outsideFence: day.filter((e) => e.within_geofence === false).length,
    unassessed: day.filter((e) => e.within_geofence === null && e.source === "device").length,
    adjusted: day.some((e) => e.source === "adjustment"),
    open,
    events: day,
  };
}

/** Midnight at the END of a local day, as an epoch millisecond value. */
function endOfLocalDay(date: string, offsetMinutes: number): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d + 1) - offsetMinutes * 60_000;
}

/**
 * Every day in the window for one person, including the days they did
 * not appear — an attendance report whose absences are invisible is not
 * an attendance report. Days with no punches come back as zeroed
 * summaries rather than being skipped.
 */
export function summariseRange(
  events: readonly AttendanceEvent[],
  opts: {
    profileId: string;
    from: Date;
    /** Exclusive, as resolveWindow() returns it. */
    to: Date;
    offsetMinutes?: number;
    now?: Date;
  }
): DaySummary[] {
  const offset = opts.offsetMinutes ?? 0;
  const out: DaySummary[] = [];
  const mine = events.filter((e) => e.profile_id === opts.profileId);

  for (let t = opts.from.getTime(); t < opts.to.getTime(); ) {
    const date = dayKey(new Date(t), offset);
    out.push(summariseDay(mine, { date, profileId: opts.profileId, offsetMinutes: offset, now: opts.now }));
    t = endOfLocalDay(date, offset);
  }
  return out;
}

/** "7h 25m", or "—" for a day with nothing on it. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * How a day reads at a glance.
 *   absent    — on-site and no punches at all
 *   flagged   — punched from outside the fence
 *   adjusted  — a manager entered or corrected it
 *   open      — still in
 *   present   — a clean, closed day
 * Order matters: a day that is both flagged and adjusted reads as
 * flagged, because that is the one somebody has to look at.
 */
export type DayStatus = "absent" | "flagged" | "adjusted" | "open" | "present";

export function dayStatus(day: DaySummary): DayStatus {
  if (day.events.length === 0) return "absent";
  if (day.outsideFence > 0) return "flagged";
  if (day.adjusted) return "adjusted";
  if (day.open) return "open";
  return "present";
}

export function dayTone(status: DayStatus): SemanticTone {
  switch (status) {
    case "present":
      return "green";
    case "open":
      return "blue";
    case "adjusted":
      return "amber";
    case "flagged":
      return "red";
    case "absent":
      return "neutral";
  }
}
