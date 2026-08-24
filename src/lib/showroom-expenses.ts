/**
 * The showroom expense categories (migration 0050) — the one list, shared
 * by the Zod schema that guards the write, the CHECK constraint that
 * guards the row, and the picker the accountant actually uses.
 *
 * IT LIVES HERE RATHER THAN IN lib/validation.ts, and the reason is
 * structural: validation.ts imports lib/action-messages.ts, which is
 * `server-only`. Any client component that reached into validation.ts for
 * this constant would drag that import into the browser bundle and the
 * build would refuse it. A category list is not validation logic — it is
 * a vocabulary both sides need — so it belongs in a module with no server
 * dependencies at all.
 *
 * KEEP IN SYNC WITH showroom_expenses_category_known in migration 0050.
 * A value here that the CHECK does not know becomes a 23514 at insert
 * time; a value the CHECK knows and this list does not simply cannot be
 * chosen. Neither is silent, but both are avoidable.
 */
export const SHOWROOM_EXPENSE_CATEGORIES = [
  "rent",
  "electricity",
  "water",
  "gas",
  "internet",
  "phone",
  "cleaning",
  "maintenance",
  "security",
  "salaries",
  "transport",
  "marketing",
  "licenses",
  "insurance",
  "bank_fees",
  "other",
] as const;

export type ShowroomExpenseCategoryName = (typeof SHOWROOM_EXPENSE_CATEGORIES)[number];
