import type { Lead, LeadVehicleInterest, Vehicle } from "@/lib/supabase/types";

/**
 * What buyers are asking for, and what they say they will pay.
 *
 * The CEO's question is not "who is interested in this car" — the vehicle
 * page answers that. It is "what is walking through the door, how much of
 * it is there, and are we holding it": three people wanting a Civic when
 * the floor has none is a purchasing decision, and it is invisible in any
 * per-lead or per-vehicle view.
 *
 * Server-side and pure, so the CEO page stays a Server Component and the
 * arithmetic is testable without a database.
 */

/** One car, and every live interest in it. */
export interface DemandRow {
  key: string;
  label: string;
  /** Set when the wanted car is a row in `vehicles`. */
  vehicleId: string | null;
  inStock: boolean;
  /**
   * Whether anyone has actually recorded what these buyers want, as
   * opposed to the row existing only because of the `car_interest`
   * fallback below.
   *
   * The distinction matters on screen: an unlinked row says nothing about
   * whether the showroom holds the car, and rendering it as "not in
   * stock" would tell a CEO they are missing a Civic while one sits on
   * the floor. `linked: false` means "nobody has said", not "no".
   */
  linked: boolean;
  /** What the showroom paid for it, when it holds one. */
  purchasePrice: number | null;
  /** Distinct leads who asked for this car themselves. */
  requestedBy: number;
  /** Distinct leads a salesperson matched to it. */
  suggestedTo: number;
  /** How many of those leads named a figure at all. */
  quoted: number;
  topBudget: number | null;
  lowBudget: number | null;
}

const normalise = (label: string) => label.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Drops standalone model years, so a described car groups by what it is
 * rather than by which year each buyer happened to name.
 *
 * The report answers "should we source one of these", and two buyers
 * after a Hilux are two buyers after a Hilux whether one wants a 2022 and
 * the other a 2024. Keeping the year in the key split exactly that case
 * into two single-buyer rows — which reads as no demand at all, and is
 * the opposite of what the row exists to say. The years are not lost:
 * they stay on each lead's own page, where the buyer's ask belongs.
 */
const withoutYear = (label: string) =>
  normalise(label.replace(/\b(?:19|20)\d{2}\b/g, " "));

export function vehicleLabel(v: Pick<Vehicle, "year" | "make" | "model" | "trim">): string {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
}

/**
 * What an interest row is about, whether or not it names a vehicle.
 *
 * Carries the year, because on a lead's own page the year is part of what
 * the buyer asked for. The demand key deliberately drops it.
 */
export function interestLabel(i: LeadVehicleInterest): string {
  if (i.vehicles) return vehicleLabel(i.vehicles);
  return [i.wanted_year, i.wanted_make, i.wanted_model].filter(Boolean).join(" ") || "—";
}

interface Bucket {
  label: string;
  vehicleId: string | null;
  purchasePrice: number | null;
  requested: Set<string>;
  suggested: Set<string>;
  budgets: number[];
  /** At least one real interest row landed here, not just free text. */
  linked: boolean;
}

/** Everything the fallback needs, and nothing the caller must fetch for it. */
export type DemandLead = Pick<Lead, "id" | "car_interest" | "status">;

/**
 * @param interests  every interest row the caller may read, with `vehicles`
 *                   joined where one is named.
 * @param leads      the caller's leads, used only for the `car_interest`
 *                   fallback described below.
 */
export function buildDemand(
  interests: LeadVehicleInterest[],
  leads: DemandLead[] = []
): DemandRow[] {
  const buckets = new Map<string, Bucket>();

  /**
   * Year-stripped description -> the bucket of a car on the floor that
   * matches it, so "Honda Civic Sport" written by hand finds the actual
   * 2023 Honda Civic Sport instead of opening a second row beside it.
   *
   * `null` marks the description as ambiguous. Two Civic Sports of
   * different years are two cars, and a buyer who wrote "Honda Civic
   * Sport" has not said which — attributing them to whichever was
   * bucketed first would put a real offer against the wrong vehicle's
   * cost. Under-merging is the safe direction throughout this file.
   */
  const alias = new Map<string, string | null>();

  const bucket = (key: string, label: string) => {
    let b = buckets.get(key);
    if (!b) {
      b = {
        label,
        vehicleId: null,
        purchasePrice: null,
        requested: new Set(),
        suggested: new Set(),
        budgets: [],
        linked: false,
      };
      buckets.set(key, b);
    }
    return b;
  };

  const record = (b: Bucket, leadId: string, origin: string, budget: number | null) => {
    (origin === "suggested" ? b.suggested : b.requested).add(leadId);
    if (budget !== null) b.budgets.push(Number(budget));
  };

  // A declined interest is not demand. Keeping it would make the report
  // grow monotonically and never reflect a buyer who walked away, which is
  // the one thing that makes a demand list stop being read.
  const live = interests.filter((i) => i.status !== "declined");

  // PASS 1 — cars on the floor, keyed by the vehicle itself. Its own
  // identity, not a description of it: two model years of the same trim
  // are two cars with two costs and must never share a row.
  for (const i of live) {
    if (!i.vehicles) continue;
    const key = `v:${i.vehicles.id}`;
    const label = vehicleLabel(i.vehicles);
    const b = bucket(key, label);
    b.linked = true;
    b.label = label;
    b.vehicleId = i.vehicles.id;
    b.purchasePrice = Number(i.vehicles.purchase_price);
    record(b, i.lead_id, i.origin, i.budget_amount);

    const description = withoutYear(label);
    alias.set(description, alias.has(description) && alias.get(description) !== key ? null : key);
  }

  // PASS 2 — cars nobody holds. Grouped by make and model, and folded into
  // a vehicle's row when one unambiguously matches.
  for (const i of live) {
    if (i.vehicles) continue;
    const label = [i.wanted_make, i.wanted_model].filter(Boolean).join(" ");
    if (!label) continue;
    const description = withoutYear(label);
    const b = bucket(alias.get(description) ?? `w:${description}`, label);
    b.linked = true;
    record(b, i.lead_id, i.origin, i.budget_amount);
  }

  // PASS 3 — the fallback. Leads captured before migration 0016, and every
  // lead taken through the public referral form, carry their ask as free
  // text in `car_interest` and nothing else. Dropping them would show an
  // empty report to a showroom whose pipeline is full.
  //
  // Only for leads with no structured interest at all: once somebody has
  // recorded what a buyer actually wants, the free text is superseded, and
  // counting both would double that buyer.
  const structured = new Set(live.map((i) => i.lead_id));
  for (const l of leads) {
    if (l.status === "closed") continue;
    if (structured.has(l.id)) continue;
    const label = (l.car_interest ?? "").trim();
    if (!label) continue;
    const description = withoutYear(label);
    // Best-effort by construction: "Civic" and "Honda Civic" stay two
    // rows, and no normalising fixes that without a make/model dictionary
    // the showroom has not been asked to maintain.
    bucket(alias.get(description) ?? `w:${description}`, label).requested.add(l.id);
  }

  return Array.from(buckets.entries())
    .map(([key, b]) => ({
      key,
      label: b.label,
      vehicleId: b.vehicleId,
      inStock: b.vehicleId !== null,
      linked: b.linked,
      purchasePrice: b.purchasePrice,
      requestedBy: b.requested.size,
      // A lead a salesperson pointed at this car does not stop being
      // interested because they also asked for it — but it must not be
      // counted twice, and the buyer's own ask is the stronger signal.
      suggestedTo: Array.from(b.suggested).filter((id) => !b.requested.has(id)).length,
      quoted: b.budgets.length,
      topBudget: b.budgets.length ? Math.max(...b.budgets) : null,
      lowBudget: b.budgets.length ? Math.min(...b.budgets) : null,
    }))
    .filter((r) => r.requestedBy + r.suggestedTo > 0)
    .sort(
      (a, b) =>
        b.requestedBy - a.requestedBy ||
        (b.topBudget ?? -1) - (a.topBudget ?? -1) ||
        b.suggestedTo - a.suggestedTo ||
        a.label.localeCompare(b.label)
    );
}
