import type { SemanticTone } from "@/components/ui/status-pill";

/**
 * Ageing and odometer helpers for the inventory floor (migration 0036).
 *
 * There is no database column for "how long has this car been sitting
 * here" and there never needs to be one: it is entirely a function of
 * `created_at`, `sold_at` and the clock, which is exactly what belongs
 * in a pure, tested module rather than a stored or generated value that
 * could drift from the definition below.
 */

export type AgeBucket = "fresh" | "aging" | "stale" | "dead";

/**
 * Days a vehicle has spent in stock. `soldAt` stops the clock at the
 * moment of sale — a sold car's age is fixed history, not still
 * ticking up on every page load; a still-unsold car's clock runs to
 * `now`. Floored at 0 so a car intaken moments ago, or a small clock
 * skew between the browser and the database, never reads as negative.
 */
export function daysInStock(
  createdAt: string | Date,
  soldAt: string | Date | null,
  now: string | Date = new Date()
): number {
  const start = new Date(createdAt).getTime();
  const end = (soldAt ? new Date(soldAt) : new Date(now)).getTime();
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

/**
 * The trade's own cutoffs: a car is FRESH for its first month, starts
 * AGEING through its second, is STALE through its third, and past 90
 * days is DEAD stock — the kind that costs more in carry (financing,
 * insurance, a parking spot that could hold something that sells) than
 * it is worth continuing to negotiate over.
 *
 * UI buckets only; nothing in the database enforces or stores these.
 */
export function ageBucket(days: number): AgeBucket {
  if (days < 30) return "fresh";
  if (days < 60) return "aging";
  if (days < 90) return "stale";
  return "dead";
}

/**
 * The status-tone key each bucket renders as, per src/lib/status-tone.ts
 * and components/ui/status-pill.tsx's conventions. 'orange' is new with
 * this migration (status-pill.tsx, stat-card.tsx and time-ago-dot.tsx
 * all gained it, additively) — four buckets need four colours, and none
 * of the existing five read as "not dead yet, but past due" without it.
 */
export function ageTone(bucket: AgeBucket): SemanticTone {
  switch (bucket) {
    case "fresh":
      return "green";
    case "aging":
      return "amber";
    case "stale":
      return "orange";
    case "dead":
      return "red";
  }
}

/**
 * Odometer display. "km" is kept as a bare Latin suffix, unlocalized and
 * untranslated, on the same reasoning the VIN and the e-invoice item
 * code keep dir="ltr" in the Arabic UI: it is a technical unit read the
 * same way in both languages. Only the digit grouping — and, for
 * Arabic, the digit shapes — follow locale, mirroring formatMoney in
 * lib/currency.ts. `null` (not yet recorded) renders as an em dash, the
 * same convention every other optional number in this app uses.
 */
export function formatOdometer(km: number | null, locale: string = "en"): string {
  if (km == null) return "—";
  const intlLocale = locale === "ar" || locale.startsWith("ar-") ? "ar-EG" : "en";
  return `${new Intl.NumberFormat(intlLocale).format(km)} km`;
}
