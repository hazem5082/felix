import "server-only";
import type { createClient } from "@/lib/supabase/server";
import {
  decideCustomerLink,
  isNationalId,
  mergePhoneNumbers,
  phoneVariants,
  type CustomerCandidate,
} from "@/lib/customer-match";

/**
 * The write half of the customer link (migration 0031).
 *
 * lib/customer-match.ts decides WHO a lead belongs to; this file finds
 * the candidates it decides between and performs the writes. It runs on
 * the caller's own client — the salesperson's session, their RLS, their
 * name in the audit trail — never the service role. There is no
 * privileged path into `customers` at all.
 *
 * WHY THIS IS NOT A DATABASE TRIGGER. A BEFORE INSERT trigger on `leads`
 * would be shorter and it would be wrong: the public referral form
 * (refer/[salespersonId]/actions.ts) inserts leads through the service
 * role from an unauthenticated page, so a stranger typing a number into
 * a web form would mint a permanent, org-wide customer identity that no
 * member of staff decided to create — and a mistyped digit would attach
 * that submission to somebody else's. Linking belongs to the CRM's own
 * write paths, where a human typed the fields.
 *
 * NOTHING HERE IS FATAL. A lead that saved is saved; the identity behind
 * it is an enrichment. Every failure path returns `{ customerId: null }`
 * and logs, so a deployment whose database is still on 0030 (no
 * `customers` table, no `leads.customer_id`) keeps creating and editing
 * leads exactly as it did before, rather than 500ing on a column that is
 * not there yet.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

/**
 * The matcher only needs the two keys; the writer also needs to know
 * which optional fields are still blank, so it can fill them in without
 * ever overwriting something a colleague already recorded.
 */
type CustomerRow = CustomerCandidate & {
  address: string | null;
  nationality: string | null;
};

const CUSTOMER_COLS = "id, national_id, phone_numbers, address, nationality";

/** What a lead knows about the person behind it. */
export interface CustomerFacts {
  full_name: string;
  phone_number: string | null;
  national_id: string | null;
  address: string | null;
  nationality: string | null;
}

export interface CustomerLinkResult {
  /** Null when the link could not be established — never an error to the caller. */
  customerId: string | null;
  created: boolean;
  matchedOn: "national_id" | "phone" | null;
}

const NOT_LINKED: CustomerLinkResult = { customerId: null, created: false, matchedOn: null };

/**
 * Customers who could plausibly be this person, oldest first.
 *
 * Two narrow queries rather than one broad one. The national ID is a
 * unique index lookup; the phones are an array-overlap against
 * idx_customers_phones, asking for every spelling phoneVariants() knows
 * about. Neither fetches the table.
 *
 * Ordering is load-bearing: decideCustomerLink() takes the FIRST phone
 * match, so `created_at` ascending means the oldest identity wins a tie
 * rather than whichever row the planner happened to return.
 *
 * Returns null — distinct from an empty array — when a query FAILED. The
 * difference matters: "nobody matches" means mint a customer, while "the
 * lookup broke" must never mint one, because that is how a transient
 * error becomes a duplicate identity nobody can merge away.
 */
export async function findCustomerCandidates(
  db: Db,
  identity: { national_id: string | null; phone_number: string | null }
): Promise<CustomerRow[] | null> {
  const nationalId = isNationalId(identity.national_id)
    ? (identity.national_id as string).trim()
    : null;
  const variants = phoneVariants(identity.phone_number);

  if (!nationalId && variants.length === 0) return [];

  const byId = nationalId
    ? await db.from("customers").select(CUSTOMER_COLS).eq("national_id", nationalId).limit(1)
    : null;

  const byPhone = variants.length
    ? await db
        .from("customers")
        .select(CUSTOMER_COLS)
        .overlaps("phone_numbers", variants)
        .order("created_at", { ascending: true })
        // A number shared by more than a handful of customers is data to
        // be cleaned up, not a list to be searched. The cap keeps a bad
        // row (an office switchboard typed onto fifty leads) from
        // dragging the whole table over the wire.
        .limit(20)
    : null;

  if (byId?.error || byPhone?.error) {
    console.error(
      "[customers] candidate lookup failed",
      byId?.error?.message ?? byPhone?.error?.message
    );
    return null;
  }

  const seen = new Set<string>();
  const out: CustomerRow[] = [];
  // The national-ID hit first: decideCustomerLink() scans for it before
  // considering any phone, and this keeps the array in the order a reader
  // would expect it to be searched.
  for (const row of [...(byId?.data ?? []), ...(byPhone?.data ?? [])] as CustomerRow[]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Attach a lead to the person behind it, minting that person if this is
 * the first time the showroom has met them.
 *
 * Called after the lead is written, by createLead and updateLead.
 *
 * WHAT AN EDIT DOES, AND WHY IT IS NOT WHAT A CREATE DOES. When the lead
 * already names a customer and the new details match nobody else, this
 * does NOT mint a second identity — it folds the new information into the
 * customer already linked. Otherwise correcting a typo in a phone number
 * would silently move the person to a fresh, empty identity and orphan
 * every prior enquiry attached to the old one. A lead is only MOVED when
 * the details positively match somebody else, which is a real signal:
 * either a national ID was entered, or the number belongs to a customer
 * the showroom already knows.
 *
 * @param currentCustomerId the lead's existing customer_id, if any.
 */
export async function linkLeadToCustomer(
  db: Db,
  leadId: string,
  facts: CustomerFacts,
  currentCustomerId: string | null = null
): Promise<CustomerLinkResult> {
  const nationalId = isNationalId(facts.national_id)
    ? (facts.national_id as string).trim()
    : null;

  const candidates = await findCustomerCandidates(db, {
    national_id: facts.national_id,
    phone_number: facts.phone_number,
  });
  if (candidates === null) return NOT_LINKED;

  const plan = decideCustomerLink(
    { national_id: facts.national_id, phone_number: facts.phone_number },
    candidates
  );

  // ── Which customer this lead ends up on ───────────────────
  let customerId: string | null = null;
  let created = false;
  let matchedOn: "national_id" | "phone" | null = null;

  if (plan.action === "link") {
    customerId = plan.customerId;
    matchedOn = plan.matchedOn;
    const candidate = candidates.find((c) => c.id === plan.customerId);
    const patched = await patchCustomer(db, candidate, facts, plan.setNationalId);
    if (!patched) return NOT_LINKED;
  } else if (currentCustomerId) {
    // An edit that matches nobody new: enrich the identity already there.
    // See the doc comment — minting here would orphan the person's history.
    customerId = currentCustomerId;
    const { data } = await db
      .from("customers")
      .select(CUSTOMER_COLS)
      .eq("id", currentCustomerId)
      .maybeSingle();
    const patched = await patchCustomer(
      db,
      (data as CustomerRow | null) ?? undefined,
      facts,
      nationalId
    );
    if (!patched) return NOT_LINKED;
  } else {
    const { data, error } = await db
      .from("customers")
      .insert({
        full_name: facts.full_name,
        national_id: nationalId,
        phone_numbers: mergePhoneNumbers([], facts.phone_number),
        address: facts.address,
        nationality: facts.nationality,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[customers] could not create a customer", error?.message);
      return NOT_LINKED;
    }
    customerId = (data as { id: string }).id;
    created = true;
  }

  // ── Point the lead at it ──────────────────────────────────
  // Skipped when it already does: an UPDATE that changes nothing still
  // fires trg_audit_leads, and "Sara edited this client" on every save
  // would be noise in the History panel that no reader could act on.
  if (customerId && customerId !== currentCustomerId) {
    const { error } = await db.from("leads").update({ customer_id: customerId }).eq("id", leadId);
    if (error) {
      console.error("[customers] could not attach the customer to the lead", error.message);
      return NOT_LINKED;
    }
  }

  return { customerId, created, matchedOn };
}

/**
 * Fold what the lead knows into a customer that already exists.
 *
 * Three things move, and only ever from nothing to something:
 *   * the phone list gains the spelling just typed (and its canonical
 *     form) when it does not already know the number;
 *   * a national ID is attached when the customer had none — never
 *     overwritten, see decideCustomerLink;
 *   * address / nationality fill in when blank. The NAME never changes:
 *     a customer called "Omar Hassan" whose latest lead says "Omar" has
 *     not been renamed, and letting the newest typing win would degrade
 *     the record every time somebody was in a hurry.
 *
 * Issues no UPDATE at all when nothing moved — the audit trigger fires on
 * every write, and a customer whose trail says "edited" fifty times with
 * no change in it is a trail nobody reads.
 */
async function patchCustomer(
  db: Db,
  candidate: CustomerRow | undefined,
  facts: CustomerFacts,
  setNationalId: string | null
): Promise<boolean> {
  if (!candidate) return true;

  const patch: Record<string, unknown> = {};

  const merged = mergePhoneNumbers(candidate.phone_numbers, facts.phone_number);
  if (merged.length !== (candidate.phone_numbers ?? []).length) patch.phone_numbers = merged;

  if (setNationalId && !(candidate.national_id ?? "").trim()) patch.national_id = setNationalId;

  if (!candidate.address && facts.address) patch.address = facts.address;
  if (!candidate.nationality && facts.nationality) patch.nationality = facts.nationality;

  if (Object.keys(patch).length === 0) return true;

  const { error } = await db.from("customers").update(patch).eq("id", candidate.id);
  if (error) {
    console.error("[customers] could not update the customer", error.message);
    return false;
  }
  return true;
}
