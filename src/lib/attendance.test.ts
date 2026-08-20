import { describe, expect, it } from "vitest";
import {
  allowedNext,
  canPunch,
  dayKey,
  dayStatus,
  formatDuration,
  localTime,
  stateAfter,
  summariseDay,
  summariseRange,
  type AttendanceEvent,
  type PunchKind,
} from "./attendance";

let seq = 0;
function ev(kind: PunchKind, occurredAt: string, extra: Partial<AttendanceEvent> = {}): AttendanceEvent {
  return {
    id: `e${seq++}`,
    profile_id: "p1",
    branch_id: "b1",
    kind,
    occurred_at: occurredAt,
    latitude: null,
    longitude: null,
    accuracy_m: null,
    distance_m: null,
    within_geofence: true,
    source: "device",
    recorded_by: "p1",
    reason: null,
    voided_at: null,
    ...extra,
  };
}

const NOW = new Date("2026-08-20T23:00:00Z");

describe("stateAfter", () => {
  it("starts out, not in", () => {
    expect(stateAfter([])).toBe("out");
  });

  it("follows a normal day", () => {
    expect(stateAfter([ev("in", "2026-08-20T07:00:00Z")])).toBe("in");
    expect(
      stateAfter([ev("in", "2026-08-20T07:00:00Z"), ev("break_start", "2026-08-20T11:00:00Z")])
    ).toBe("on_break");
    expect(
      stateAfter([
        ev("in", "2026-08-20T07:00:00Z"),
        ev("break_start", "2026-08-20T11:00:00Z"),
        ev("break_end", "2026-08-20T11:30:00Z"),
      ])
    ).toBe("in");
    expect(
      stateAfter([ev("in", "2026-08-20T07:00:00Z"), ev("out", "2026-08-20T15:00:00Z")])
    ).toBe("out");
  });

  it("folds rather than trusting the last row, so out-of-order rows do not lie", () => {
    // A manager files a missing break_end AFTER the person already left.
    // Read naively, "last event is break_end" would say they are still in.
    const events = [
      ev("in", "2026-08-20T07:00:00Z"),
      ev("break_start", "2026-08-20T11:00:00Z"),
      ev("out", "2026-08-20T15:00:00Z"),
      ev("break_end", "2026-08-20T11:30:00Z", { source: "adjustment", reason: "forgot" }),
    ];
    expect(stateAfter(events)).toBe("out");
  });

  it("ignores voided rows entirely", () => {
    const events = [
      ev("in", "2026-08-20T07:00:00Z"),
      ev("out", "2026-08-20T15:00:00Z", { voided_at: "2026-08-20T16:00:00Z" }),
    ];
    expect(stateAfter(events)).toBe("in");
  });

  it("ignores a break taken while not clocked in", () => {
    expect(stateAfter([ev("break_start", "2026-08-20T11:00:00Z")])).toBe("out");
  });
});

describe("allowedNext", () => {
  it("offers only arrival when out, and allows a second shift the same day", () => {
    expect(allowedNext("out")).toEqual(["in"]);
    expect(canPunch("out", "in")).toBe(true);
    expect(canPunch("out", "break_start")).toBe(false);
    expect(canPunch("out", "out")).toBe(false);
  });

  it("refuses a second arrival without leaving, which would double the day", () => {
    expect(canPunch("in", "in")).toBe(false);
    expect(allowedNext("in")).toEqual(["break_start", "out"]);
  });

  it("lets someone leave for the day straight from a break", () => {
    expect(allowedNext("on_break")).toEqual(["break_end", "out"]);
    expect(canPunch("on_break", "out")).toBe(true);
  });
});

describe("summariseDay", () => {
  const opts = { date: "2026-08-20", profileId: "p1", offsetMinutes: 180, now: NOW };

  it("totals a clean day with one break", () => {
    // Cairo is UTC+3 here: 09:00–17:00 local with a 30-minute break.
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z"),
        ev("break_start", "2026-08-20T10:00:00Z"),
        ev("break_end", "2026-08-20T10:30:00Z"),
        ev("out", "2026-08-20T14:00:00Z"),
      ],
      opts
    );
    expect(d.workedMinutes).toBe(7 * 60 + 30);
    expect(d.breakMinutes).toBe(30);
    expect(d.breaks).toBe(1);
    expect(d.open).toBe(false);
    expect(dayStatus(d)).toBe("present");
  });

  it("does not count break time as worked time", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z"),
        ev("break_start", "2026-08-20T08:00:00Z"),
        ev("break_end", "2026-08-20T09:00:00Z"),
        ev("out", "2026-08-20T10:00:00Z"),
      ],
      opts
    );
    expect(d.workedMinutes).toBe(180);
    expect(d.breakMinutes).toBe(60);
  });

  it("runs an open shift to `now` so a present employee is not shown as zero", () => {
    const d = summariseDay([ev("in", "2026-08-20T06:00:00Z")], {
      ...opts,
      now: new Date("2026-08-20T09:00:00Z"),
    });
    expect(d.workedMinutes).toBe(180);
    expect(d.open).toBe(true);
    expect(dayStatus(d)).toBe("open");
  });

  it("never credits an open shift past the end of its own day", () => {
    // Somebody forgot to punch out three days ago. The report for that
    // day must not award them seventy-odd hours.
    const d = summariseDay([ev("in", "2026-08-17T06:00:00Z")], {
      date: "2026-08-17",
      profileId: "p1",
      offsetMinutes: 180,
      now: NOW,
    });
    // 09:00 local to local midnight = 15 hours, and not one minute more.
    expect(d.workedMinutes).toBe(15 * 60);
  });

  it("treats a re-punched arrival as the same shift, not a second one", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z"),
        ev("in", "2026-08-20T06:05:00Z"),
        ev("out", "2026-08-20T10:00:00Z"),
      ],
      opts
    );
    expect(d.workedMinutes).toBe(240);
  });

  it("counts two shifts in one day", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z"),
        ev("out", "2026-08-20T08:00:00Z"),
        ev("in", "2026-08-20T13:00:00Z"),
        ev("out", "2026-08-20T15:00:00Z"),
      ],
      opts
    );
    expect(d.workedMinutes).toBe(240);
    expect(d.lastOut).toBe("2026-08-20T15:00:00Z");
  });

  it("excludes voided rows from the totals", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z"),
        ev("out", "2026-08-20T07:00:00Z", { voided_at: "2026-08-20T20:00:00Z" }),
        ev("out", "2026-08-20T14:00:00Z"),
      ],
      opts
    );
    expect(d.workedMinutes).toBe(480);
  });

  it("counts punches the database judged outside the fence, and flags the day", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z", { within_geofence: false, distance_m: 4200 }),
        ev("out", "2026-08-20T14:00:00Z"),
      ],
      opts
    );
    expect(d.outsideFence).toBe(1);
    expect(dayStatus(d)).toBe("flagged");
  });

  it("separates 'not assessed' from 'outside' — an unpinned branch is not an absence", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z", { within_geofence: null }),
        ev("out", "2026-08-20T14:00:00Z", { within_geofence: null }),
      ],
      opts
    );
    expect(d.outsideFence).toBe(0);
    expect(d.unassessed).toBe(2);
    expect(dayStatus(d)).toBe("present");
  });

  it("marks a day a manager touched", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z", { source: "adjustment", reason: "phone flat" }),
        ev("out", "2026-08-20T14:00:00Z"),
      ],
      opts
    );
    expect(d.adjusted).toBe(true);
    expect(dayStatus(d)).toBe("adjusted");
  });

  it("reads a flagged AND adjusted day as flagged — that is the one to look at", () => {
    const d = summariseDay(
      [
        ev("in", "2026-08-20T06:00:00Z", { within_geofence: false }),
        ev("out", "2026-08-20T14:00:00Z", { source: "adjustment", reason: "forgot" }),
      ],
      opts
    );
    expect(dayStatus(d)).toBe("flagged");
  });

  it("keeps a punch in the local day it happened in, not the UTC one", () => {
    // 22:30 UTC on the 19th is 01:30 on the 20th in Cairo.
    const d = summariseDay([ev("in", "2026-08-19T22:30:00Z")], opts);
    expect(d.events).toHaveLength(1);
    expect(dayKey("2026-08-19T22:30:00Z", 180)).toBe("2026-08-20");
    expect(dayKey("2026-08-19T22:30:00Z", 0)).toBe("2026-08-19");
  });
});

describe("summariseRange", () => {
  it("emits a row for every day including the empty ones", () => {
    const days = summariseRange(
      [ev("in", "2026-08-18T06:00:00Z"), ev("out", "2026-08-18T14:00:00Z")],
      {
        profileId: "p1",
        from: new Date("2026-08-17T21:00:00Z"), // 18 Aug 00:00 Cairo
        to: new Date("2026-08-20T21:00:00Z"), // 21 Aug 00:00 Cairo, exclusive
        offsetMinutes: 180,
        now: NOW,
      }
    );
    expect(days.map((d) => d.date)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(dayStatus(days[0])).toBe("present");
    expect(dayStatus(days[1])).toBe("absent");
    expect(days[1].workedMinutes).toBe(0);
  });

  it("only counts the person it was asked about", () => {
    const days = summariseRange(
      [
        ev("in", "2026-08-18T06:00:00Z", { profile_id: "someone-else" }),
        ev("out", "2026-08-18T14:00:00Z", { profile_id: "someone-else" }),
      ],
      {
        profileId: "p1",
        from: new Date("2026-08-17T21:00:00Z"),
        to: new Date("2026-08-18T21:00:00Z"),
        offsetMinutes: 180,
        now: NOW,
      }
    );
    expect(days).toHaveLength(1);
    expect(dayStatus(days[0])).toBe("absent");
  });
});

describe("formatting", () => {
  it("formats durations the way a timesheet reads", () => {
    expect(formatDuration(450)).toBe("7h 30m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });

  it("shows clock times in the viewer's zone", () => {
    expect(localTime("2026-08-20T06:05:00Z", 180)).toBe("09:05");
    expect(localTime("2026-08-20T06:05:00Z", 0)).toBe("06:05");
  });
});
