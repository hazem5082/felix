/**
 * The arithmetic behind the two acquisition modes migration 0032 added.
 *
 * Both sums are computed twice in this application — once in the browser,
 * where a salesperson watches the number move as they type, and once in
 * Postgres, inside execute_vehicle_sale(), which is the copy that
 * actually books money. That is deliberate: a preview that has to make a
 * round trip is a preview nobody waits for. It is also exactly how the
 * two copies drift, so the browser's half lives here, pure and tested,
 * rather than inline in a form where nobody can look at it.
 *
 * The SQL is the authority. Every function below is written to agree
 * with it — including where it clamps — and the tests name the clamps.
 */

/** The commission terms a consigned vehicle carries (0032). */
export type CommissionType = "fixed" | "percent";

/**
 * The settlement channels a payout can move through. Same four as a
 * sale's (0023): it is the same question asked about the other
 * direction, so it gets the same answer set.
 */
export const PAYOUT_METHODS = ["bank_transfer", "cheque", "instapay", "cash"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** Two decimal places, the way Postgres' round(numeric, 2) does it. */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * What the buyer actually settles: the agreed price, less any discount,
 * less anything allowed for the car they handed over.
 *
 * Never negative. An allowance larger than the car being bought is a
 * data-entry error rather than a refund the showroom owes, and showing
 * it as a negative "to pay" reads as though it were one.
 */
export function netToPay(input: {
  agreedPrice: number;
  discount?: number;
  tradeInAllowance?: number | null;
}): number {
  const agreed = Number.isFinite(input.agreedPrice) ? input.agreedPrice : 0;
  const discount = Number.isFinite(input.discount ?? 0) ? (input.discount ?? 0) : 0;
  const allowance =
    input.tradeInAllowance != null && Number.isFinite(input.tradeInAllowance)
      ? input.tradeInAllowance
      : 0;
  return money(Math.max(0, agreed - discount - allowance));
}

/**
 * What the house keeps on a consignment, and what is left owing to the
 * person who still owns the car.
 *
 * `salePrice` is the price the deal actually settled at — agreed less
 * discount — because that is what execute_vehicle_sale() uses, and a
 * percentage of a price nobody paid is not a commission anybody agreed
 * to.
 *
 * THE TWO CLAMPS ARE THE SQL's, RESTATED. A fixed fee typed larger than
 * the car eventually sold for would make amount_due negative, and
 * consignment_payouts CHECKs it at zero or more; a sale is not worth
 * refusing over a mistyped fee, so the fee is capped at the sale price
 * and the accountant sees a zero payout and asks. A vehicle taken in
 * before 0032 existed carries no terms at all, and zero is the only
 * honest answer — the alternative is inventing a fee.
 */
export function consignmentSplit(input: {
  salePrice: number;
  commissionType: CommissionType | null | undefined;
  commissionValue: number | null | undefined;
}): { commission: number; amountDue: number } {
  const sale = Number.isFinite(input.salePrice) ? Math.max(0, input.salePrice) : 0;
  const value =
    input.commissionValue != null && Number.isFinite(input.commissionValue)
      ? input.commissionValue
      : 0;

  let commission: number;
  if (input.commissionType === "fixed") commission = value;
  else if (input.commissionType === "percent") commission = money((sale * value) / 100);
  else commission = 0;

  commission = money(Math.min(Math.max(commission, 0), sale));
  return { commission, amountDue: money(sale - commission) };
}

/**
 * Is this ticket describing a car well enough for the allowance on it to
 * mean anything?
 *
 * An appraisal with no car attached is a discount wearing a different
 * name — it leaves the ledger with a vehicle row nobody can identify and
 * a cost basis nobody can defend. The make and the model are the
 * minimum; everything else about a trade-in is genuinely optional at the
 * counter, and the SQL fills the gaps.
 *
 * Mirrors the refinement on CreateDealTicketSchema, and exists
 * separately from it so the form can grey out its own submit button
 * without waiting for a round trip to say the same thing.
 */
export function tradeInIsDescribed(input: {
  allowance: number | null;
  make: string;
  model: string;
}): boolean {
  if (input.allowance == null) return true;
  return input.make.trim().length > 0 && input.model.trim().length > 0;
}
