import { describe, expect, it } from "vitest";
import { bonusFor, earnedRung, nextRung, sortLadder } from "./bonus";
import type { BonusRule } from "./supabase/types";

function rung(min_units: number, bonus_amount: number, active = true): BonusRule {
  return {
    id: `r${min_units}`,
    min_units,
    bonus_amount,
    active,
    note: null,
    updated_at: "2026-08-01T00:00:00Z",
    updated_by: null,
  };
}

// The scheme used throughout: three rungs, deliberately non-contiguous,
// because a ladder with gaps is the case an off-by-one gets wrong.
const LADDER = [rung(3, 2000), rung(8, 6000), rung(12, 12000)];

describe("earnedRung", () => {
  it("pays nothing below the first rung", () => {
    expect(earnedRung(LADDER, 0)).toBeNull();
    expect(earnedRung(LADDER, 2)).toBeNull();
  });

  it("pays a rung exactly at its threshold", () => {
    expect(earnedRung(LADDER, 3)?.bonus_amount).toBe(2000);
    expect(earnedRung(LADDER, 8)?.bonus_amount).toBe(6000);
  });

  it("pays the highest rung reached, not the sum of the rungs below it", () => {
    // The single assertion this whole module exists for. 9 cars clears
    // rungs 3 and 8; it pays 6 000, not 8 000.
    expect(bonusFor(LADDER, 9)).toBe(6000);
    expect(bonusFor(LADDER, 20)).toBe(12000);
  });

  it("ignores inactive rungs rather than treating them as zero", () => {
    // Retiring the top rung must drop the earner to the one below, not
    // to nothing — a scheme revised in June still explains May.
    const revised = [rung(3, 2000), rung(8, 6000), rung(12, 12000, false)];
    expect(bonusFor(revised, 14)).toBe(6000);
  });

  it("refuses nonsense unit counts instead of guessing", () => {
    expect(bonusFor(LADDER, -1)).toBe(0);
    expect(bonusFor(LADDER, Number.NaN)).toBe(0);
  });

  it("pays nothing from an empty ladder", () => {
    expect(bonusFor([], 15)).toBe(0);
  });
});

describe("nextRung", () => {
  it("names the rung being chased", () => {
    expect(nextRung(LADDER, 0)?.min_units).toBe(3);
    expect(nextRung(LADDER, 3)?.min_units).toBe(8);
  });

  it("is null on the top rung", () => {
    expect(nextRung(LADDER, 12)).toBeNull();
    expect(nextRung(LADDER, 99)).toBeNull();
  });

  it("skips an inactive rung when looking upward", () => {
    const revised = [rung(3, 2000), rung(8, 6000, false), rung(12, 12000)];
    expect(nextRung(revised, 3)?.min_units).toBe(12);
  });
});

describe("sortLadder", () => {
  it("orders ascending without mutating the input", () => {
    const jumbled = [rung(12, 12000), rung(3, 2000), rung(8, 6000)];
    expect(sortLadder(jumbled).map((r) => r.min_units)).toEqual([3, 8, 12]);
    expect(jumbled[0].min_units).toBe(12);
  });
});
