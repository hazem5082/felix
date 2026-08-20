// Relative, not aliased, for the reason demo-accounts.ts gives: this
// module is under vitest, which resolves no tsconfig paths here.
import type { Role } from "./supabase/types";

/**
 * "Which branches may this person act on?" — the app-side twin of
 * migration 0030's widened `can_act_on_branch()` / `can_read_branch()`.
 *
 * Pure, and deliberately in its own module rather than in `lib/auth.ts`:
 * the branch picker in `inventory/vehicle-form.tsx` is a client component
 * and cannot import anything marked `server-only`, but it must narrow its
 * dropdown by exactly the rule the server action will apply. One copy of
 * the rule, imported from both sides.
 *
 * None of this is authorization on its own. The Server Action re-checks
 * (lib/auth.ts) and Postgres re-checks again through RLS; what lives here
 * is only the part both layers must agree about.
 */

/**
 * CEO and accountants are org-wide by role, so a grant would tell them
 * nothing they did not already have. 0009's branch predicates lead with
 * exactly these two.
 */
const ORG_WIDE_ROLES: readonly Role[] = ["ceo", "accountant"];

export function isOrgWide(role: Role): boolean {
  return ORG_WIDE_ROLES.includes(role);
}

/**
 * The only two roles a branch grant means anything for. An investor's
 * scope is the vehicles they hold equity in, not a branch, and the two
 * org-wide roles are covered above — so a grant on any of the three is
 * refused at the point it is offered rather than quietly stored.
 */
export function acceptsBranchGrants(role: Role): boolean {
  return role === "branch_manager" || role === "sales_exec";
}

/**
 * Home branch OR any granted branch. Mirrors the widened SQL predicate
 * arm for arm, including the null test: `current_branch_id()` is null for
 * an unassigned profile, and `null = null` is null rather than true, so an
 * unassigned profile must not compare equal to a null branch_id.
 */
export function canActOnBranchWithGrants(
  role: Role,
  homeBranchId: string | null,
  branchId: string | null,
  grantedBranchIds: readonly string[]
): boolean {
  if (isOrgWide(role)) return true;
  if (branchId === null) return false;
  if (homeBranchId !== null && branchId === homeBranchId) return true;
  return grantedBranchIds.includes(branchId);
}

/**
 * The branches a picker should offer. Returns the full list for the
 * org-wide roles, and home-plus-grants for everyone else — in the order
 * the caller supplied, so a list sorted by name stays sorted by name.
 *
 * The vehicle intake picker used to offer every branch to a branch
 * manager and then have `createVehicle` reject the choice. That was a
 * bug before grants existed; narrowing here is what makes the dropdown
 * and the action agree.
 */
export function selectableBranches<T extends { id: string }>(
  role: Role,
  homeBranchId: string | null,
  grantedBranchIds: readonly string[],
  branches: readonly T[]
): T[] {
  if (isOrgWide(role)) return [...branches];
  return branches.filter((b) =>
    canActOnBranchWithGrants(role, homeBranchId, b.id, grantedBranchIds)
  );
}
