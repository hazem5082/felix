import { describe, expect, it } from "vitest";
import { ageBucket, ageTone, daysInStock, formatOdometer } from "./stock-age";

describe("daysInStock", () => {
  it("counts from intake to now for an unsold car", () => {
    const created = "2026-07-01T00:00:00Z";
    const now = "2026-07-15T00:00:00Z";
    expect(daysInStock(created, null, now)).toBe(14);
  });

  it("stops the clock at sold_at rather than running to now", () => {
    const created = "2026-06-01T00:00:00Z";
    const sold = "2026-06-10T00:00:00Z";
    const now = "2026-08-20T00:00:00Z"; // long after the sale
    expect(daysInStock(created, sold, now)).toBe(9);
  });

  it("never goes negative on a clock skew or same-moment intake", () => {
    expect(daysInStock("2026-07-15T12:00:00Z", null, "2026-07-15T11:00:00Z")).toBe(0);
    expect(daysInStock("2026-07-15T00:00:00Z", null, "2026-07-15T00:00:00Z")).toBe(0);
  });

  it("floors partial days rather than rounding up", () => {
    // 1.5 days elapsed — a car taken in at noon, checked the next evening.
    expect(daysInStock("2026-07-01T12:00:00Z", null, "2026-07-03T00:00:00Z")).toBe(1);
  });
});

describe("ageBucket", () => {
  it("is fresh under 30 days", () => {
    expect(ageBucket(0)).toBe("fresh");
    expect(ageBucket(29)).toBe("fresh");
  });

  it("is aging from 30 up to 59 days", () => {
    expect(ageBucket(30)).toBe("aging");
    expect(ageBucket(59)).toBe("aging");
  });

  it("is stale from 60 up to 89 days", () => {
    expect(ageBucket(60)).toBe("stale");
    expect(ageBucket(89)).toBe("stale");
  });

  it("is dead at 90 days and beyond", () => {
    expect(ageBucket(90)).toBe("dead");
    expect(ageBucket(400)).toBe("dead");
  });
});

describe("ageTone", () => {
  it("maps each bucket to the trade's own colour escalation", () => {
    expect(ageTone("fresh")).toBe("green");
    expect(ageTone("aging")).toBe("amber");
    expect(ageTone("stale")).toBe("orange");
    expect(ageTone("dead")).toBe("red");
  });
});

describe("formatOdometer", () => {
  it("renders an em dash for a car with no recorded reading", () => {
    expect(formatOdometer(null)).toBe("—");
  });

  it("groups digits and keeps the km suffix untranslated in English", () => {
    expect(formatOdometer(45000, "en")).toBe("45,000 km");
  });

  it("keeps km untranslated but switches digit shapes in Arabic", () => {
    const result = formatOdometer(45000, "ar");
    expect(result.endsWith("km")).toBe(true);
    // Eastern Arabic digits, not Latin — same reasoning as formatMoney's ar-EG mapping.
    expect(result).not.toMatch(/[0-9]/);
  });

  it("does not lose precision on small readings", () => {
    expect(formatOdometer(0, "en")).toBe("0 km");
  });
});
