import { describe, expect, it } from "vitest";
import {
  bucketDay,
  completionPercent,
  dayOfMonthOf,
  parseDayKey,
  splitCounts,
  splitLeads,
  summariseDay,
  sortForBoard,
  templateDueOn,
  templatesDueOn,
  weekdayOf,
} from "./tasks";
import type { TaskStatus } from "./supabase/types";

const task = (status: TaskStatus, title = "t") => ({ status, title });

describe("parseDayKey", () => {
  it("reads a well-formed day at UTC midnight", () => {
    const d = parseDayKey("2026-08-24");
    expect(d?.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("refuses a rolled-over date rather than reporting on 3 March", () => {
    expect(parseDayKey("2026-02-31")).toBeNull();
  });

  it("refuses anything that is not YYYY-MM-DD", () => {
    expect(parseDayKey("24/08/2026")).toBeNull();
    expect(parseDayKey("")).toBeNull();
    expect(parseDayKey("2026-8-4")).toBeNull();
  });
});

describe("weekdayOf / dayOfMonthOf", () => {
  it("counts Sunday as 0, as Postgres extract(dow) does", () => {
    // 2026-08-23 is a Sunday.
    expect(weekdayOf("2026-08-23")).toBe(0);
    expect(weekdayOf("2026-08-24")).toBe(1);
  });

  it("returns null for a malformed key rather than NaN", () => {
    expect(weekdayOf("nope")).toBeNull();
    expect(dayOfMonthOf("nope")).toBeNull();
  });

  it("reads the day of the month", () => {
    expect(dayOfMonthOf("2026-08-24")).toBe(24);
  });
});

describe("templateDueOn — the app's twin of task_template_due()", () => {
  it("a daily template is due every day", () => {
    const spec = { recurrence: "daily", weekday: null, day_of_month: null };
    expect(templateDueOn(spec, "2026-08-24")).toBe(true);
    expect(templateDueOn(spec, "2026-08-25")).toBe(true);
  });

  it("a weekly template is due on its weekday and no other", () => {
    const monday = { recurrence: "weekly", weekday: 1, day_of_month: null };
    expect(templateDueOn(monday, "2026-08-24")).toBe(true);
    expect(templateDueOn(monday, "2026-08-25")).toBe(false);
  });

  it("a monthly template is due on its day of the month", () => {
    const first = { recurrence: "monthly", weekday: null, day_of_month: 1 };
    expect(templateDueOn(first, "2026-09-01")).toBe(true);
    expect(templateDueOn(first, "2026-09-02")).toBe(false);
  });

  it("a weekly template with no weekday is due never, not always", () => {
    expect(
      templateDueOn({ recurrence: "weekly", weekday: null, day_of_month: null }, "2026-08-24")
    ).toBe(false);
  });

  it("an unknown recurrence is due never", () => {
    expect(
      templateDueOn({ recurrence: "hourly", weekday: null, day_of_month: null }, "2026-08-24")
    ).toBe(false);
  });

  it("does not consider `active` — that is a separate question", () => {
    const retired = {
      recurrence: "daily" as const,
      weekday: null,
      day_of_month: null,
      active: false,
    };
    expect(templateDueOn(retired, "2026-08-24")).toBe(true);
    expect(templatesDueOn([retired], "2026-08-24")).toEqual([]);
  });
});

describe("splitLeads", () => {
  const floor = ["ann", "bob", "cid"];

  it("deals one each, round and round", () => {
    expect(splitLeads([1, 2, 3, 4, 5], floor)).toEqual([
      { leadId: 1, assigneeId: "ann" },
      { leadId: 2, assigneeId: "bob" },
      { leadId: 3, assigneeId: "cid" },
      { leadId: 4, assigneeId: "ann" },
      { leadId: 5, assigneeId: "bob" },
    ]);
  });

  it("never differs by more than one", () => {
    const counts = splitCounts(splitLeads([1, 2, 3, 4, 5, 6, 7], floor));
    const values = [...counts.values()].sort();
    expect(values[values.length - 1] - values[0]).toBeLessThanOrEqual(1);
  });

  it("gives everything to the only salesperson on the floor", () => {
    expect(splitLeads([1, 2], ["ann"]).every((a) => a.assigneeId === "ann")).toBe(true);
  });

  it("returns nothing — rather than throwing — when the floor is empty", () => {
    expect(splitLeads([1, 2, 3], [])).toEqual([]);
  });

  it("returns nothing when there are no leads", () => {
    expect(splitLeads([], floor)).toEqual([]);
  });

  it("is deterministic: the same order in, the same split out", () => {
    expect(splitLeads([1, 2, 3, 4], floor)).toEqual(splitLeads([1, 2, 3, 4], floor));
  });
});

describe("summariseDay", () => {
  it("counts each bucket", () => {
    const counts = summariseDay([
      task("done"),
      task("done"),
      task("skipped"),
      task("open"),
      task("cancelled"),
    ]);
    expect(counts).toEqual({ done: 2, skipped: 1, open: 1, cancelled: 1, total: 4 });
  });

  it("leaves withdrawn tasks out of the total", () => {
    const counts = summariseDay([task("cancelled"), task("cancelled")]);
    expect(counts.total).toBe(0);
    expect(counts.cancelled).toBe(2);
  });

  it("is empty for an empty day", () => {
    expect(summariseDay([])).toEqual({
      done: 0,
      skipped: 0,
      open: 0,
      cancelled: 0,
      total: 0,
    });
  });
});

describe("completionPercent", () => {
  it("is whole percent of what was asked", () => {
    expect(completionPercent(summariseDay([task("done"), task("open")]))).toBe(50);
    expect(
      completionPercent(summariseDay([task("done"), task("open"), task("open")]))
    ).toBe(33);
  });

  it("counts a skipped task as not done", () => {
    expect(completionPercent(summariseDay([task("done"), task("skipped")]))).toBe(50);
  });

  it("calls an empty day 100, not 0 and not NaN", () => {
    expect(completionPercent(summariseDay([]))).toBe(100);
    expect(completionPercent(summariseDay([task("cancelled")]))).toBe(100);
  });
});

describe("bucketDay", () => {
  it("splits into done, skipped and ignored, leaving cancelled out of all three", () => {
    const buckets = bucketDay([
      task("done", "a"),
      task("skipped", "b"),
      task("open", "c"),
      task("cancelled", "d"),
    ]);
    expect(buckets.done.map((t) => t.title)).toEqual(["a"]);
    expect(buckets.skipped.map((t) => t.title)).toEqual(["b"]);
    expect(buckets.ignored.map((t) => t.title)).toEqual(["c"]);
  });
});

describe("sortForBoard", () => {
  it("puts unfinished work first and withdrawn work last", () => {
    const sorted = sortForBoard([
      task("done", "b"),
      task("cancelled", "a"),
      task("open", "z"),
      task("skipped", "m"),
    ]);
    expect(sorted.map((t) => t.status)).toEqual(["open", "skipped", "done", "cancelled"]);
  });

  it("breaks ties alphabetically", () => {
    const sorted = sortForBoard([task("open", "b"), task("open", "a")]);
    expect(sorted.map((t) => t.title)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [task("done", "b"), task("open", "a")];
    sortForBoard(input);
    expect(input.map((t) => t.status)).toEqual(["done", "open"]);
  });
});
