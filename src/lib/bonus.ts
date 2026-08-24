// Relative, not aliased, for the reason branch-authority.ts gives: this
// module is under vitest, which resolves no tsconfig paths here.
import type { BonusRule } from "./supabase/types";

/**
 * The volume bonus ladder (migration 0049).
 *
 * ONE RULE, WRITTEN ONCE: a salesperson earns the SINGLE HIGHEST active
 * rung whose min_units is at or below the cars they executed that
 * calendar month. It is not cumulative — reaching rung 3 does not also
 * pay rungs 1 and 2.
 *
 * That sentence is the whole reason this module exists rather than an
 * inline `.find()` in the HR page. A bonus scheme is the one thing every
 * reader assumes differently, so the rule lives in one tested function
 * and the page renders whatever it returns. The migration header says
 * the same thing in SQL's voice.
 *
 * Inactive rungs are ignored rather than deleted: a scheme revised in
 * June still has to explain what May paid.
 */

/** The rung a given unit count earns, or null if it earns nothing. */
export function earnedRung(
  rules: readonly BonusRule[],
  units: number
): BonusRule | null {
  if (!Number.isFinite(units) || units <= 0) return null;
  let best: BonusRule | null = null;
  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.min_units > units) continue;
    if (!best || rule.min_units > best.min_units) best = rule;
  }
  return best;
}

/** What that person is owed for volume this month. Zero, not null. */
export function bonusFor(rules: readonly BonusRule[], units: number): number {
  return earnedRung(rules, units)?.bonus_amount ?? 0;
}

/**
 * The next rung up, for the "two more cars and you're on 6 000" line the
 * salesperson's own view shows. Null once they are on the top rung.
 */
export function nextRung(
  rules: readonly BonusRule[],
  units: number
): BonusRule | null {
  let next: BonusRule | null = null;
  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.min_units <= units) continue;
    if (!next || rule.min_units < next.min_units) next = rule;
  }
  return next;
}

/** Ascending by rung, which is the only order the ladder reads in. */
export function sortLadder(rules: readonly BonusRule[]): BonusRule[] {
  return [...rules].sort((a, b) => a.min_units - b.min_units);
}

/**
 * The ceiling migration 0049 puts on min_units, restated so the form can
 * enforce it before the round trip. The database CHECK is the fence;
 * this is the label on it.
 */
export const MAX_BONUS_UNITS = 15;
