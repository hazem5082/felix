import { describe, expect, it } from "vitest";
import { resolveWindow, isReportKind, parseOffset, MAX_WINDOW_DAYS } from "./report-window";

const NOW = new Date("2026-07-15T12:00:00Z");
const utc = (s: string) => new Date(s);

describe("resolveWindow", () => {
  it("parses a from/to pair, upper bound exclusive of the next day", () => {
    const w = resolveWindow("2026-01-01", "2026-03-31", NOW);
    expect(w.from).toEqual(utc("2026-01-01T00:00:00Z"));
    expect(w.to).toEqual(utc("2026-04-01T00:00:00Z")); // 31 Mar inclusive → 1 Apr exclusive
  });

  it("defaults to the current month when params are missing", () => {
    const w = resolveWindow(undefined, undefined, NOW);
    expect(w.from).toEqual(utc("2026-07-01T00:00:00Z"));
    expect(w.to).toEqual(utc("2026-08-01T00:00:00Z"));
  });

  it("falls back rather than trusting garbage", () => {
    for (const [f, t] of [
      ["not-a-date", "2026-01-31"],
      ["2026-01-01", "2026-13-01"],
      ["2026-02-30", "2026-03-01"], // rolls over in Date — must be rejected
      ["2026-03-01", "2026-01-01"], // inverted
    ] as const) {
      const w = resolveWindow(f, t, NOW);
      expect(w.from).toEqual(utc("2026-07-01T00:00:00Z"));
      expect(w.to).toEqual(utc("2026-08-01T00:00:00Z"));
    }
  });

  it("caps the span so a typo'd year cannot demand a decade of ledger", () => {
    const w = resolveWindow("2020-01-01", "2026-01-01", NOW);
    expect(w.from).toEqual(utc("2026-07-01T00:00:00Z")); // fell back
  });

  it("accepts a full-year window (needed for the yearly report)", () => {
    const w = resolveWindow("2025-01-01", "2025-12-31", NOW);
    expect(w.from).toEqual(utc("2025-01-01T00:00:00Z"));
    expect(w.to).toEqual(utc("2026-01-01T00:00:00Z"));
    expect((w.to.getTime() - w.from.getTime()) / 86_400_000).toBeLessThanOrEqual(MAX_WINDOW_DAYS);
  });

  it("a single day is a valid window", () => {
    const w = resolveWindow("2026-05-10", "2026-05-10", NOW);
    expect(w.from).toEqual(utc("2026-05-10T00:00:00Z"));
    expect(w.to).toEqual(utc("2026-05-11T00:00:00Z"));
  });

  // The bug this guards: the server runs UTC on Workers, so a Cairo
  // showroom's "July" was cut at 03:00 local and a sale closed at 01:30
  // on the 1st was reported in June.
  it("cuts the window at local midnight in the viewer's zone", () => {
    const cairo = 180; // UTC+3
    const w = resolveWindow("2026-07-01", "2026-07-31", NOW, cairo);
    expect(w.from).toEqual(utc("2026-06-30T21:00:00Z")); // 1 Jul 00:00 Cairo
    expect(w.to).toEqual(utc("2026-07-31T21:00:00Z")); // 1 Aug 00:00 Cairo
  });

  it("includes a sale closed just after local midnight", () => {
    const cairo = 180;
    const sale = utc("2026-06-30T22:30:00Z"); // 1 Jul 01:30 Cairo
    const w = resolveWindow("2026-07-01", "2026-07-31", NOW, cairo);
    expect(sale >= w.from && sale < w.to).toBe(true);

    // …and the same instant is correctly OUT of June's window.
    const june = resolveWindow("2026-06-01", "2026-06-30", NOW, cairo);
    expect(sale >= june.from && sale < june.to).toBe(false);
  });

  it("handles a negative offset and the December year roll", () => {
    const nyc = -300; // UTC-5
    const w = resolveWindow(undefined, undefined, utc("2026-12-15T12:00:00Z"), nyc);
    expect(w.from).toEqual(utc("2026-12-01T05:00:00Z"));
    expect(w.to).toEqual(utc("2027-01-01T05:00:00Z"));
  });
});

describe("parseOffset", () => {
  it("accepts real-world offsets", () => {
    expect(parseOffset("180")).toBe(180);
    expect(parseOffset("-300")).toBe(-300);
    expect(parseOffset("0")).toBe(0);
  });

  it("treats anything out of range or malformed as UTC", () => {
    for (const junk of [undefined, "", "abc", "9999", "-1000", "12.5", "1e3"]) {
      expect(parseOffset(junk)).toBe(0);
    }
  });
});

describe("isReportKind", () => {
  it("accepts exactly the five kinds", () => {
    for (const k of ["operating", "investors", "expenses", "salaries", "vat"]) {
      expect(isReportKind(k)).toBe(true);
    }
    for (const k of ["monthly", "OPERATING", "", "ledger", "../secrets"]) {
      expect(isReportKind(k)).toBe(false);
    }
  });
});
