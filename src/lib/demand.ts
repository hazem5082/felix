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

/**
 * Grouping key. Built from the rendered label rather than from the
 * columns, which is what lets a structured row (make "Honda", model
 * "Civic", year 2023) land in the same bucket as the free text a lead was
 * captured with before this table existed ("2023 Honda Civic").
 *
 * Best-effort by construction: "Civic" and "Honda Civic" are two rows, and
 * no amount of normalising fixes that without a make/model dictionary the
 * showroom has not been asked to maintain. Under-merging is the safe
 * direction — it shows two small numbers instead of inventing one big one.
 */
const keyOf = (label: string) => label.toLowerCase().replace(/\s+/g, " ").trim();

export function vehicleLabel(v: Pick<Vehicle, "year" | "make" | "model" | "trim">): string {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
}

/** What an interest row is about, whether or not it names a vehicle. */
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

/** Everything the fallback below needs, and nothing the caller must fetch for it. */
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

  for (const i of interests) {
    // A declined interest is not demand. Keeping it would make the report
    // grow monotonically and never reflect a buyer who walked away, which
    // is the one thing that makes a demand list stop being read.
    if (i.status === "declined") continue;

    const label = interestLabel(i);
    if (label === "—") continue;

    const b = bucket(keyOf(label), label);
    b.linked = true;

    // A vehicle row wins the label and the price: it is the same car under
    // whichever name it was first bucketed.
    if (i.vehicles) {
      b.vehicleId = i.vehicles.id;
      b.label = vehicleLabel(i.vehicles);
      b.purchasePrice = Number(i.vehicles.purchase_price);
    }

    (i.origin === "suggested" ? b.suggested : b.requested).add(i.lead_id);
    if (i.budget_amount !== null) b.budgets.push(Number(i.budget_amount));
  }

  // FALLBACK: leads captured before 0016, and every lead taken through the
  // public referral form, carry their ask as free text in `car_interest`
  // and nothing else. Dropping them would show an empty report to a
  // showroom whose pipeline is full.
  //
  // Only for leads with no structured interest at all — once somebody has
  // recorded what a buyer actually wants, the free text is superseded, and
  // counting both would double that buyer.
  const structured = new Set(interests.map((i) => i.lead_id));
  for (const l of leads) {
    if (l.status === "closed") continue;
    if (structured.has(l.id)) continue;
    const label = (l.car_interest ?? "").trim();
    if (!label) continue;
    bucket(keyOf(label), label).requested.add(l.id);
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
