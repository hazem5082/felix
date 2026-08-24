import type { Lead, LeadInterestOrigin, LeadVehicleInterest } from "./supabase/types";

/**
 * THE FELIX NETWORK — what a buyer asked for, and how a car answers it.
 *
 * Two halves, both pure and both here rather than in the page, for the
 * reason lib/demand.ts gives: this is the arithmetic a purchasing
 * decision rests on, and it has to be testable without a database.
 *
 *   1. buildWantedList() — the enquiries this showroom could not fill
 *      from its own floor.
 *   2. scoreVehicle() — how well a car at ANOTHER showroom answers one
 *      of them.
 *
 * Nothing in this module knows about tenants, schemas or service-role
 * clients. The fan-out that crosses showrooms lives in the page's
 * actions.ts, which is also where the rule about what may and may not
 * cross a showroom boundary is enforced.
 */

// ── Text ────────────────────────────────────────────────────

/**
 * Lowercased, punctuation-free, single-spaced.
 *
 * Hyphens and dots become SPACES rather than nothing: "e-class" and
 * "e class" are the same car and must produce the same tokens, whereas
 * collapsing to "eclass" would match neither of them against a
 * `model` column that reads "E Class".
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-/.,]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A four-digit model year anywhere in the text — 1900..2099. */
export function yearIn(text: string): number | null {
  const hit = text.match(/\b(19|20)\d{2}\b/);
  return hit ? Number(hit[0]) : null;
}

/**
 * What the search is actually looking for: the words, and the year kept
 * separately.
 *
 * The year is pulled OUT of the word list on purpose. Left in, a search
 * for "Hilux 2022" would reject a 2023 Hilux outright — but a manager
 * hunting a car for a waiting buyer wants to be told about the 2023,
 * with the year difference visible, rather than told there is nothing.
 * So the year stops being a filter and becomes a ranking signal.
 */
export interface NetworkQuery {
  /** Everything the user typed, normalised. Kept for display and logging. */
  text: string;
  /** The words a candidate must contain, year excluded. */
  tokens: string[];
  year: number | null;
}

export function parseQuery(raw: string): NetworkQuery {
  const text = normalise(raw);
  const year = yearIn(text);
  const tokens = text
    .split(" ")
    .filter((t) => t.length > 0 && !(year !== null && t === String(year)));
  return { text, tokens, year };
}

/** Is this query worth sending to the other showrooms at all? */
export function isSearchable(q: NetworkQuery): boolean {
  return q.tokens.join("").length >= 2 || q.year !== null;
}

// ── What the buyer wants ────────────────────────────────────

/**
 * One car this showroom was asked for and did not have.
 *
 * `origin` carries a third value the database does not have. 'requested'
 * and 'suggested' are `lead_vehicle_interests.origin`; 'note' means
 * nobody filled in an interest row and the car is only named in the
 * enquiry's own `car_interest` field. The distinction is the one
 * lib/demand.ts draws with `linked`: a 'note' row is what somebody typed
 * in a hurry, so it may well name a car that IS on the floor, and the
 * screen must not present it as a confirmed gap.
 */
export interface WantedCar {
  /** Stable across renders: the interest row's id, or `lead:<id>`. */
  key: string;
  leadId: string;
  clientName: string;
  phone: string;
  /** What to search the network for — "toyota hilux", never a year alone. */
  query: string;
  /** What to show the manager, year included: "2022 Toyota Hilux". */
  label: string;
  year: number | null;
  budget: number | null;
  note: string | null;
  origin: LeadInterestOrigin | "note";
  branchId: string | null;
  salespersonId: string | null;
  createdAt: string;
}

type WantedLead = Pick<
  Lead,
  "id" | "client_name" | "phone_number" | "car_interest" | "branch_id" | "salesperson_id" | "created_at" | "status"
>;

/**
 * The unfilled asks, newest first.
 *
 * WHAT COUNTS AS UNFILLED, and why each clause is there:
 *
 *   * `vehicle_id is null` — migration 0016's CHECK guarantees a row
 *     names a car one way or the other, so a null vehicle means the
 *     wanted_* fields are filled and the car is not one of ours. An
 *     interest POINTING at a vehicle is already answered by the floor.
 *   * `status = 'open'` — 'shown' and 'declined' are closed
 *     conversations, and sourcing a car for a buyer who already turned
 *     it down is worse than useless.
 *   * origin is NOT filtered. A 'suggested' row with no vehicle behind
 *     it is a salesperson writing down what they would put this buyer
 *     in if they could get one, which is exactly the network's
 *     business. The screen shows which is which.
 *
 * Leads are folded in only where they contribute something the
 * interests do not: a lead with no interest rows at all, still open,
 * whose `car_interest` names something. That is the majority of the
 * back catalogue in a showroom that adopted 0016 late, and dropping it
 * would leave this page empty on day one for exactly the showrooms
 * that need it most.
 */
export function buildWantedList(input: {
  interests: LeadVehicleInterest[];
  leads: WantedLead[];
}): WantedCar[] {
  const leadById = new Map(input.leads.map((l) => [l.id, l]));
  const leadsWithInterests = new Set(input.interests.map((i) => i.lead_id));
  const out: WantedCar[] = [];

  for (const i of input.interests) {
    if (i.vehicle_id) continue;
    if (i.status !== "open") continue;

    const lead = leadById.get(i.lead_id);
    if (!lead) continue; // RLS handed us the interest but not the lead.

    const words = [i.wanted_make, i.wanted_model].filter(Boolean).join(" ").trim();
    const query = normalise(words);
    // An interest row with a year and nothing else is legitimate (0016's
    // CHECK counts it) and unsearchable. Kept in the list, since a
    // manager still has to deal with the buyer, but it searches as blank.
    if (!query && !i.wanted_year) continue;

    out.push({
      key: i.id,
      leadId: lead.id,
      clientName: lead.client_name,
      phone: lead.phone_number,
      query,
      label: [i.wanted_year, words].filter(Boolean).join(" ") || "—",
      year: i.wanted_year,
      budget: i.budget_amount,
      note: i.note,
      origin: i.origin,
      branchId: lead.branch_id,
      salespersonId: lead.salesperson_id,
      createdAt: i.created_at,
    });
  }

  for (const lead of input.leads) {
    if (leadsWithInterests.has(lead.id)) continue;
    if (lead.status !== "pending") continue;

    const raw = lead.car_interest?.trim();
    if (!raw) continue;

    const year = yearIn(raw);
    // The year is stripped from the search words for the reason
    // parseQuery gives, but kept on the row so the manager sees the
    // whole ask.
    const query = parseQuery(raw).tokens.join(" ");
    if (!query) continue;

    out.push({
      key: `lead:${lead.id}`,
      leadId: lead.id,
      clientName: lead.client_name,
      phone: lead.phone_number,
      query,
      label: raw,
      year,
      budget: null,
      note: null,
      origin: "note",
      branchId: lead.branch_id,
      salespersonId: lead.salesperson_id,
      createdAt: lead.created_at,
    });
  }

  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── How well a car answers the ask ──────────────────────────

/** The fields of another showroom's car that the score is allowed to see. */
export interface ScorableVehicle {
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
}

/**
 * The searchable text of one car. Colour is in it deliberately: buyers
 * ask for "white Land Cruiser" as one phrase, and a colour word that
 * matched nothing would sink the whole row.
 */
export function vehicleHaystack(v: ScorableVehicle): string {
  return normalise([v.make, v.model, v.trim, v.color].filter(Boolean).join(" "));
}

/**
 * How well this car answers this query, or null if it does not.
 *
 * EVERY word must appear — an AND, not an OR. A search for "toyota
 * hilux" that returned every Toyota would bury the one car the manager
 * is looking for under forty Corollas, and a network result nobody
 * scrolls through is the same as no network.
 *
 * Word-start matching rather than bare `includes`: "rav" must find
 * "RAV4" (a buyer's spelling of a model is not the showroom's), while
 * "s" must not match every car with an S in it.
 *
 * The year then ranks what survived: exact +3, one year either side +1,
 * further away 0. Never negative and never disqualifying — see
 * NetworkQuery.
 */
export function scoreVehicle(v: ScorableVehicle, q: NetworkQuery): number | null {
  const haystack = ` ${vehicleHaystack(v)}`;
  let score = 0;

  for (const token of q.tokens) {
    if (!haystack.includes(` ${token}`)) return null;
    // A token that IS a whole word is a better signal than one that
    // merely starts one: "civic" against "Civic" beats "civ".
    score += haystack.includes(` ${token} `) || haystack.endsWith(` ${token}`) ? 2 : 1;
  }

  if (q.year !== null) {
    const gap = Math.abs(v.year - q.year);
    score += gap === 0 ? 3 : gap === 1 ? 1 : 0;
  }

  return score;
}

/** Sort key: best match first, then the newest car, then stable by id. */
export function compareMatches(
  a: { score: number; vehicle: { year: number; id: string } },
  b: { score: number; vehicle: { year: number; id: string } }
): number {
  return (
    b.score - a.score ||
    b.vehicle.year - a.vehicle.year ||
    a.vehicle.id.localeCompare(b.vehicle.id)
  );
}

// ── What crosses a showroom boundary ────────────────────────
//
// These three interfaces ARE the privacy contract of this feature: a
// field that is not here is a field another showroom never sees. They
// are declared in this module, next to the matching rules, so that
// widening the contract means editing the file whose header says what
// the contract is — rather than quietly adding a column to a select in
// actions.ts.

/** The showroom holding the car, and how to reach it. */
export interface NetworkShowroom {
  slug: string;
  /** Trade name from company_settings (0046), else the licence name. */
  name: string;
  phone: string | null;
  email: string | null;
}

/**
 * A car on somebody else's floor — the windscreen, and nothing behind
 * it.
 *
 * DELIBERATELY ABSENT, each for its own reason:
 *   * purchase_price and min_price — what the car cost and the floor it
 *     will drop to. Confidential inside a showroom already (canSeeCost),
 *     and handing them to a competitor would end the network.
 *   * vin, plate_number, engine_number — the car's identity papers.
 *     Nothing about sourcing needs them, and 0021 put them there for the
 *     traffic authority, not for browsing.
 *   * photos — they live behind signed R2 URLs scoped to the owning
 *     showroom (lib/r2.ts). Minting cross-tenant signed URLs is a real
 *     decision, not a side effect of a search screen.
 *   * anything about a customer, a deal or an equity split.
 */
export interface NetworkVehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
  odometerKm: number | null;
  /** The sticker. Null when the holding showroom has not priced it yet. */
  askingPrice: number | null;
  /** Where it physically is, so a manager knows the drive. */
  branchName: string | null;
  branchAddress: string | null;
  /** How long it has been on that floor — the other half of "will they deal". */
  createdAt: string;
}

export interface NetworkMatch {
  score: number;
  showroom: NetworkShowroom;
  vehicle: NetworkVehicle;
}

export interface NetworkSearchResult {
  /** Echoed back so a slow response can be matched to its query. */
  query: string;
  matches: NetworkMatch[];
  /** Showrooms that answered. */
  searched: number;
  /**
   * Showrooms that did not. A network answer of "nothing found" means
   * something different when two of the five floors could not be read,
   * so the count is carried rather than swallowed.
   */
  unreachable: number;
  /** True when more cars matched than were returned. */
  truncated: boolean;
  /** Set instead of matches when the search could not run at all. */
  error?: string;
}

/**
 * Where this showroom stands in the network, for the header card.
 *
 * `peers` is a COUNT and never a list. What the screen has to answer is
 * "is there anywhere to search" — turning that into a browsable
 * directory of every other licensed showroom on the deployment is a
 * different product with different consent behind it.
 */
export interface NetworkStatus {
  /** Is this showroom's own stock published to the others. */
  participating: boolean;
  /** How many OTHER showrooms are publishing theirs. */
  peers: number;
  /**
   * False when the network could not be read at all — 0054 not applied,
   * or no session. Distinct from `peers: 0`, which means the network
   * works and this showroom is currently alone on it.
   */
  available: boolean;
  /**
   * Why not, when it is not. "The network is unavailable" and "this
   * database has not had 0054 applied" look identical on screen and are
   * fixed by completely different people, so the reason travels with
   * the flag rather than being guessed at by the component.
   */
  reason?: string;
}

/** Columns the coarse filter searches. Matches vehicleHaystack(). */
const FILTER_COLUMNS = ["make", "model", "trim", "color"] as const;

/** More than this and the URL grows faster than the filter helps. */
const MAX_FILTER_TOKENS = 4;

/**
 * The coarse filter sent to Postgres, as ONE PostgREST expression.
 *
 * The network reads other showrooms' floors through PostgREST, one
 * request per showroom, and pulling every in-stock car back to score it
 * in Node would not survive a showroom with real volume. So the words go
 * into the query and scoreVehicle() does the exact work on the much
 * smaller result.
 *
 * The shape is an AND over the words, each an OR over the four name
 * columns — the same AND-of-words rule scoreVehicle() enforces, so the
 * filter narrows without ever discarding a row the scorer would have
 * kept:
 *
 *   and(or(make.ilike.*toyota*,…),or(make.ilike.*hilux*,…))
 *
 * ONE STRING, not one `.or()` call per word. Successive filters on a
 * PostgREST query do compose with AND, but repeating the `or` parameter
 * specifically is the sort of thing that is easy to assume and awkward
 * to prove from the outside — and the failure mode is silent and
 * asymmetric: if only the FIRST group survived, a search for "toyota
 * hilux" would fetch forty Corollas, hit the per-showroom limit, and
 * report that nobody has a Hilux. Building the conjunction explicitly
 * costs one nested string and removes the question.
 *
 * An earlier version picked one "most distinctive" word and filtered on
 * that alone. There is no honest way to guess which word that is —
 * "toyota" is longer than "hilux" and far less selective. Postgres can
 * just do the AND.
 *
 * `ilike` is a plain substring match, deliberately looser than the
 * scorer's word-start rule: the filter's job is to be cheap and never
 * wrong, the scorer's is to be exact. Tokens reach here through
 * normalise(), which leaves only letters, digits and spaces — so
 * nothing in them can be read as PostgREST syntax.
 *
 * Null for a year-only search, which is a legitimate ask ("anything
 * from 2023") with no word to filter on.
 */
export function coarseFilter(q: NetworkQuery): string | null {
  const groups = q.tokens
    .filter((token) => token.length >= 2)
    .slice(0, MAX_FILTER_TOKENS)
    .map((token) => FILTER_COLUMNS.map((col) => `${col}.ilike.*${token}*`).join(","));

  if (groups.length === 0) return null;
  // A single word needs no conjunction — `.or()` wraps it in its own
  // parentheses either way.
  if (groups.length === 1) return groups[0];
  return `and(${groups.map((g) => `or(${g})`).join(",")})`;
}
