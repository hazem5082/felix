import { describe, expect, it } from "vitest";
import {
  addMonths,
  bucketByDay,
  dayKey,
  gridWindow,
  isSameMonth,
  monthGrid,
  monthKey,
  monthStart,
  toLocalInputValue,
} from "./calendar";

describe("monthStart", () => {
  const now = new Date(2026, 6, 31); // 31 Jul 2026

  it("parses a YYYY-MM key", () => {
    expect(monthStart("2026-03", now)).toEqual(new Date(2026, 2, 1));
    expect(monthStart("2025-12", now)).toEqual(new Date(2025, 11, 1));
  });

  it("falls back to the current month rather than an invalid Date", () => {
    for (const junk of [undefined, "", "nonsense", "2026-13", "2026-00", "2026-3", "26-03"]) {
      expect(monthStart(junk, now)).toEqual(new Date(2026, 6, 1));
    }
  });

  it("never returns an unparseable date for hand-edited input", () => {
    // A NaN date here would propagate into the RPC's from/to window,
    // which raises rather than returning an empty calendar.
    expect(Number.isNaN(monthStart("2026-99", now).getTime())).toBe(false);
  });
});

describe("addMonths", () => {
  it("rolls over the year boundary in both directions", () => {
    expect(addMonths(new Date(2026, 11, 1), 1)).toEqual(new Date(2027, 0, 1));
    expect(addMonths(new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 1));
  });
});

describe("monthGrid", () => {
  it("is always six weeks, so the page does not change height", () => {
    for (let m = 0; m < 12; m++) {
      expect(monthGrid(new Date(2026, m, 1))).toHaveLength(42);
    }
  });

  it("starts on the configured weekday", () => {
    // 1 Feb 2026 is a Sunday.
    expect(monthGrid(new Date(2026, 1, 1), 0)[0]).toEqual(new Date(2026, 1, 1));
    // Week starting Monday pulls in the preceding Monday, 26 Jan.
    expect(monthGrid(new Date(2026, 1, 1), 1)[0]).toEqual(new Date(2026, 0, 26));
  });

  it("includes the whole month plus the spill days either side", () => {
    const cells = monthGrid(new Date(2026, 6, 1)); // July 2026, starts Wednesday
    expect(cells[0]).toEqual(new Date(2026, 5, 28));
    expect(cells.filter((d) => d.getMonth() === 6)).toHaveLength(31);
  });

  it("produces consecutive days with no gaps or repeats", () => {
    const cells = monthGrid(new Date(2026, 2, 1));
    for (let i = 1; i < cells.length; i++) {
      const gap = cells[i].getTime() - cells[i - 1].getTime();
      // Not exactly 24h: a DST boundary makes one step 23 or 25 hours.
      expect(gap).toBeGreaterThan(22 * 3600_000);
      expect(gap).toBeLessThan(26 * 3600_000);
    }
    expect(new Set(cells.map(dayKey)).size).toBe(42);
  });
});

describe("gridWindow", () => {
  it("covers every visible cell, including the spill days", () => {
    const start = new Date(2026, 6, 1);
    const cells = monthGrid(start);
    const { from, to } = gridWindow(start);
    expect(from.getTime()).toBeLessThanOrEqual(cells[0].getTime());
    // Exclusive upper bound: the last cell's meetings must still fall inside.
    expect(to.getTime()).toBeGreaterThan(cells[41].getTime());
  });

  it("stays well inside the RPC's 400-day limit", () => {
    const { from, to } = gridWindow(new Date(2026, 6, 1));
    expect(to.getTime() - from.getTime()).toBeLessThan(400 * 24 * 3600_000);
  });
});

describe("bucketByDay", () => {
  it("groups meetings by the local day they start on", () => {
    const a = { starts_at: new Date(2026, 6, 14, 9, 0).toISOString() };
    const b = { starts_at: new Date(2026, 6, 14, 16, 30).toISOString() };
    const c = { starts_at: new Date(2026, 6, 15, 9, 0).toISOString() };

    const buckets = bucketByDay([a, b, c]);
    expect(buckets.get("2026-07-14")).toEqual([a, b]);
    expect(buckets.get("2026-07-15")).toEqual([c]);
    expect(buckets.get("2026-07-16")).toBeUndefined();
  });

  it("drops unparseable timestamps instead of creating a NaN bucket", () => {
    const buckets = bucketByDay([{ starts_at: "not a date" }]);
    expect(buckets.size).toBe(0);
  });
});

describe("isSameMonth", () => {
  it("distinguishes the same month in different years", () => {
    expect(isSameMonth(new Date(2026, 6, 1), new Date(2026, 6, 30))).toBe(true);
    expect(isSameMonth(new Date(2026, 6, 1), new Date(2025, 6, 1))).toBe(false);
  });
});

describe("toLocalInputValue", () => {
  it("emits local wall-clock time, not a UTC instant", () => {
    // datetime-local has no zone; handing it an ISO Z string silently
    // shifts every prefilled time by the user's offset.
    expect(toLocalInputValue(new Date(2026, 6, 5, 9, 5))).toBe("2026-07-05T09:05");
  });

  it("zero-pads every component", () => {
    expect(toLocalInputValue(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01T00:00");
  });
});

describe("monthKey", () => {
  it("round-trips through monthStart", () => {
    const d = new Date(2026, 8, 1);
    expect(monthStart(monthKey(d))).toEqual(d);
  });
});
