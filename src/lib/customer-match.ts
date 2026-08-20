/**
 * Which customer, if any, a lead belongs to.
 *
 * `leads` was the customer record (0020's header says so), and at group
 * scale that means the same person becomes three unrelated rows across
 * three branches. Migration 0031 adds `customers` and `leads.customer_id`;
 * this module is the decision that fills the column in.
 *
 * Pure, and it knows nothing about the database on purpose. The write
 * side (lib/customer-link.ts) fetches candidates and applies the verdict;
 * everything that could be got wrong — precedence between the two keys,
 * which spelling of a phone number counts as the same number, when a
 * national ID may be attached to a customer identified only by phone —
 * is decided here, where it can be tested without a Postgres.
 *
 * WHY THIS NORMALISES PHONE NUMBERS AND 0031's BACKFILL DOES NOT.
 * Getting a match wrong MERGES TWO PEOPLE, and there is no merge screen
 * to undo it with. In the backfill nobody is watching, so it matches on
 * the exact string and leaves the rest for a human. Here a member of
 * staff has just typed the number, is looking at the screen, and sees the
 * "existing customer" notice before the lead is saved — the extra reach
 * is supervised.
 */

/** Same 14-digit shape as the CHECK on leads (0020) and customers (0031). */
const NATIONAL_ID = /^[0-9]{14}$/;

export function isNationalId(value: string | null | undefined): boolean {
  return typeof value === "string" && NATIONAL_ID.test(value.trim());
}

/**
 * One phone number reduced to the thing that identifies it: the national
 * significant number, with the country code and the trunk `0` stripped.
 *
 *   "010 1234 5678"     → "1012345678"
 *   "+201012345678"     → "1012345678"
 *   "0020-10-1234-5678" → "1012345678"
 *   "02 2345 6789"      → "223456789"    (a Cairo landline)
 *
 * Returns "" for anything with no digits in it. Callers read that as
 * "not a phone number" rather than as a value to match on — an empty
 * normal form would otherwise equal every other empty one and collapse
 * every ID-less customer into a single person.
 *
 * The `20` strip is guarded on length so a local number that merely
 * begins with those digits is left alone: "0223456789" is a Cairo
 * landline, keeps its leading zero through the country-code test, and
 * normalises to "223456789" like any other.
 */
export function normalizePhone(raw: string | null | undefined): string {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return "";

  // 00 is the international access prefix; drop it before looking for 20.
  if (digits.startsWith("00")) digits = digits.slice(2);
  // Egypt's country code, but only when a whole number follows it.
  if (digits.startsWith("20") && digits.length > 10) digits = digits.slice(2);
  // The trunk prefix: present when dialled domestically, absent when the
  // number was written in international form.
  if (digits.startsWith("0")) digits = digits.slice(1);

  return digits;
}

/**
 * The one spelling every customer is guaranteed to be findable under.
 *
 * `customers.phone_numbers` holds numbers as staff typed them, spaces
 * and dashes included (the `phone` schema in validation.ts permits both),
 * so an overlap query built from one spelling would miss a customer
 * recorded under another. mergePhoneNumbers() therefore stores the typed
 * form AND this canonical one, and phoneVariants() always asks for it —
 * which is what makes the lookup reliable without normalising the column
 * itself and losing what somebody actually dials.
 */
export function canonicalPhone(raw: string | null | undefined): string {
  const national = normalizePhone(raw);
  return national ? `0${national}` : "";
}

/**
 * Every spelling of a number worth asking the database about.
 *
 * One GIN-indexed array-overlap query (0031 adds idx_customers_phones)
 * rather than a scan or a fetch-everything. De-duplicated and
 * order-stable, so the same input always produces the same query.
 */
export function phoneVariants(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  const national = normalizePhone(trimmed);
  if (!national) return [];

  const forms = [
    trimmed,
    trimmed.replace(/\D/g, ""),
    national,
    `0${national}`,
    `20${national}`,
    `+20${national}`,
    `0020${national}`,
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const form of forms) {
    if (!form || seen.has(form)) continue;
    seen.add(form);
    out.push(form);
  }
  return out;
}

/** The fields of a customer this decision actually reads. */
export interface CustomerCandidate {
  id: string;
  national_id: string | null;
  phone_numbers: string[] | null;
}

/** The lead being saved, as far as identity is concerned. */
export interface LeadIdentity {
  national_id?: string | null;
  phone_number?: string | null;
}

export type CustomerLinkPlan =
  | {
      action: "link";
      customerId: string;
      /** Which key matched. Not branched on by the writer; read by tests and logs. */
      matchedOn: "national_id" | "phone";
      /**
       * A national ID to attach to a customer that had none. Only ever
       * set on a phone match — see decideCustomerLink.
       */
      setNationalId: string | null;
    }
  | { action: "create" };

/**
 * Does this customer already know this number, under any spelling?
 *
 * Compared on the normal form, which is the whole reason this is not
 * `Array.includes`.
 */
export function customerKnowsPhone(
  candidate: CustomerCandidate,
  phone: string | null | undefined
): boolean {
  const national = normalizePhone(phone);
  if (!national) return false;
  return (candidate.phone_numbers ?? []).some((p) => normalizePhone(p) === national);
}

/**
 * The phone list a customer should carry once this number is known.
 *
 * Adds two things at most: the string as typed (what somebody dials, and
 * how this person is written down at the counter) and the canonical
 * `0…` form (what makes them findable). Both are added only when absent,
 * and the returned array is a NEW array with the same contents when
 * nothing changed — the writer compares lengths and skips the UPDATE
 * entirely, because a write that changes nothing still fires the audit
 * trigger and would put "Sara edited this customer" in the trail every
 * time a lead is saved.
 *
 * Bounded at two entries per handset by construction, so a customer
 * contacted fifty times does not accumulate fifty spellings.
 */
export function mergePhoneNumbers(
  existing: string[] | null | undefined,
  phone: string | null | undefined
): string[] {
  const out = [...(existing ?? [])];
  const trimmed = (phone ?? "").trim();
  const canonical = canonicalPhone(trimmed);
  if (!canonical) return out;

  if (!out.includes(trimmed)) out.push(trimmed);
  if (!out.includes(canonical)) out.push(canonical);
  return out;
}

/**
 * Link this lead to an existing customer, or mint one.
 *
 * PRECEDENCE IS NOT NEGOTIABLE: the national ID wins. It is a government
 * document that one person holds; a phone number is a handset that gets
 * handed to a son, resold with the SIM, or written down wrong. Where the
 * two disagree, following the phone would file a sale under the wrong
 * person's identity on the one record the tax authority reads.
 *
 * A national ID that matches nobody does NOT block a phone match. That is
 * the ordinary case of a returning customer whose ID was never collected
 * the first time: they match on the handset, and the ID is attached to
 * the customer they matched — `setNationalId` — so the second visit is
 * the one that completes the identity. It is set ONLY when the matched
 * customer had no ID at all. Overwriting one ID with another would be
 * asserting that two documents belong to one person, and nobody in this
 * flow is in a position to make that claim.
 *
 * @param candidates customers already narrowed by the caller's query to
 *   those sharing this national ID or one of the phone's spellings, in a
 *   stable order (oldest first). The first phone match wins; that order
 *   is the caller's promise, not this function's guess.
 */
export function decideCustomerLink(
  lead: LeadIdentity,
  candidates: CustomerCandidate[]
): CustomerLinkPlan {
  const nationalId = (lead.national_id ?? "").trim();
  const phone = (lead.phone_number ?? "").trim();
  const hasPhone = normalizePhone(phone) !== "";

  if (isNationalId(nationalId)) {
    const byId = candidates.find((c) => (c.national_id ?? "").trim() === nationalId);
    if (byId) {
      return {
        action: "link",
        customerId: byId.id,
        matchedOn: "national_id",
        setNationalId: null,
      };
    }
  }

  if (hasPhone) {
    const byPhone = candidates.find((c) => customerKnowsPhone(c, phone));
    if (byPhone) {
      return {
        action: "link",
        customerId: byPhone.id,
        matchedOn: "phone",
        setNationalId:
          isNationalId(nationalId) && !(byPhone.national_id ?? "").trim() ? nationalId : null,
      };
    }
  }

  return { action: "create" };
}
