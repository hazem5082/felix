import "server-only";
import { getTranslations } from "next-intl/server";
import type { ActionError } from "@/lib/validation";

/**
 * Server-side localization for the SHARED error paths.
 *
 * The app's error strings were written as English literals in three
 * modules every action funnels through — auth.ts (the guards),
 * db-error.ts (the Postgres translator) and validation.ts (zod) — so an
 * Arabic-locale user rejecting a deal read English prose. Rather than
 * teach ~50 forms to translate codes (the login action's pattern, which
 * does not scale backwards), these messages are localized where they are
 * BORN: next-intl resolves the request locale inside Server Actions, so
 * every existing form renders already-localized text with no changes.
 *
 * The dictionary keys on the exact English literal. A string that is not
 * in the map passes through verbatim — bespoke one-off action messages
 * keep working while they wait to be migrated.
 *
 * SQL-authored P0001 RAISE EXCEPTION messages pass through too; they are
 * a separate migration-shaped problem and deliberately out of scope here.
 */

const KEYS: Readonly<Record<string, string>> = {
  // ── auth.ts ─────────────────────────────────────────────
  "You do not have permission to perform this action.": "denied",
  "Your session has expired. Please sign in again.": "sessionExpired",
  "That record belongs to another branch.": "otherBranch",

  // ── db-error.ts ─────────────────────────────────────────
  "That record already exists.": "alreadyExists",
  "That refers to something that no longer exists.": "missingReference",
  "Some of those values are not allowed together.": "conflict",
  "A required field was missing.": "requiredMissing",
  "You do not have permission to do that.": "forbidden",
  "Something went wrong. Please try again.": "generic",

  // ── validation.ts: parseInput fallback ──────────────────
  "Please check the values you entered.": "checkValues",

  // ── rate-limit.ts callers (throttle prefixes) ───────────
  "Too many submissions.": "tooManySubmissions",
  "Too many attendance actions.": "tooManyAttendanceActions",
  "Too many verification codes requested.": "tooManyCodesRequested",
  "Too many attempts.": "tooManyAttempts",

  // ── validation.ts: zod schema messages ──────────────────
  "A budget must be greater than zero": "budgetPositive",
  "A cheque must be recorded against a deal or a payment plan": "chequeNeedsTarget",
  "A client can carry at most 20 note points": "notePointsMax",
  "A consigned vehicle deploys no capital - its cost is zero": "consignedCostZero",
  "A consigned vehicle has no equity splits - the showroom does not own it": "consignedNoSplits",
  "A consignment needs a commission type": "consignmentCommissionType",
  "A consignment needs a commission value": "consignmentCommissionValue",
  "A consignment needs the consignor's name": "consignorNameRequired",
  "A deposit must be positive": "depositPositive",
  "A meeting may not run longer than 12 hours": "meetingDurationMax",
  "A meeting must end after it starts": "meetingEndAfterStart",
  "A non-CEO ledger entry must name its holder": "ledgerHolderRequired",
  "A percentage commission cannot exceed 100%": "commissionPercentMax",
  "A purchased vehicle needs an equity split": "purchasedNeedsSplit",
  "A withdrawal must be negative": "withdrawalNegative",
  "Add at least one recipient.": "recipientRequired",
  "Amount cannot be zero": "amountNotZero",
  "Amount must be a number": "amountNumber",
  "Amount must be greater than zero": "amountPositive",
  "An investor split must name an investor; a CEO split must not": "splitHolderMismatch",
  "Branch staff must be assigned to a branch": "branchAssignmentRequired",
  "Date must be between 2000 and 2100": "dateRange",
  "Describe the trade-in car before allowing anything against it": "tradeInDescriptionRequired",
  "Discount cannot exceed the agreed price": "discountExceedsPrice",
  "Down payment cannot exceed the agreed price": "downPaymentExceedsPrice",
  "Each tier must be strictly greater than the one below it": "tierOrdering",
  "Enter the six-digit code from your email.": "codeRequired",
  "Enter your current password": "currentPasswordRequired",
  "Equity splits must sum to exactly 100%": "splitsSumTo100",
  "File name must not contain path separators": "fileNameSeparators",
  "Give a reason for changing this sale's showroom fee.": "feeChangeReasonRequired",
  "Invite at least one person": "inviteAtLeastOne",
  "Must be a non-negative number": "nonNegativeNumber",
  "National ID must be exactly 14 digits": "nationalIdDigits",
  "New password must be at least 10 characters": "newPasswordMinLength",
  "New password must be at most 72 characters": "newPasswordMaxLength",
  "Not a valid date": "invalidDate",
  "Not a valid date and time": "invalidDateTime",
  "Nothing to update": "nothingToUpdate",
  "Phone number contains invalid characters": "phoneCharacters",
  "Pick a car from stock, or say which make the buyer is asking for": "pickCarOrMake",
  "Pick a date": "pickDate",
  "Pick a month": "pickMonth",
  "Rate must be between 0 and 100": "rateRange",
  "Record at least the ETA UUID, long ID or a status": "etaIdentifierRequired",
  "Target month must be the first day of the month": "targetMonthFirstDay",
  "Term must be a whole number of months (max 480)": "termWholeMonths",
  "The discount and the trade-in allowance together exceed the agreed price":
    "discountPlusTradeInExceedsPrice",
  "The lowest offer cannot exceed the sticker price": "lowestOfferExceedsPrice",
  "The rate must be between 0 and 100": "rateRangeAlt",
  "The same investor cannot hold two splits on one vehicle": "duplicateInvestorSplit",
  "The same person cannot be invited twice": "duplicateInvitee",
  "VAT cannot exceed the expense amount": "vatExceedsExpense",
  "VIN must be 17 characters (no I, O or Q)": "vinLength",
  "Year must be between 1950 and next year": "yearRange",
};

/**
 * Localizes one known message; unknown strings pass through untouched.
 */
export async function localizeErrorMessage(message: string): Promise<string> {
  const key = KEYS[message];
  if (!key) return message;
  const t = await getTranslations("errors.actions");
  return t(key);
}

/**
 * Localizes an ActionError in place — the banner plus any per-field
 * messages zod produced.
 */
export async function localizeActionError(error: ActionError): Promise<ActionError> {
  const t = await getTranslations("errors.actions");

  const banner = KEYS[error.error] ? t(KEYS[error.error]) : error.error;

  let fieldErrors: Record<string, string[]> | undefined;
  if (error.fieldErrors) {
    fieldErrors = Object.fromEntries(
      Object.entries(error.fieldErrors).map(([field, messages]) => [
        field,
        messages.map((m) => (KEYS[m] ? t(KEYS[m]) : m)),
      ])
    );
  }

  return { error: banner, ...(fieldErrors ? { fieldErrors } : {}) };
}
