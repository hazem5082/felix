// Relative, not aliased, for the reason branch-authority.ts gives: this
// module is under vitest, which resolves no tsconfig paths here.
import type { Role } from "./supabase/types";
import { canActOnBranchWithGrants } from "./branch-authority";

/**
 * Who may administer whom.
 *
 * FELIX has had exactly one answer to this since 0003 — "the CEO" — and
 * it is the right answer for staff creation, roles, branches and wages.
 * It is the wrong answer for one narrow thing: a sign-in address.
 *
 * An email changes for mundane reasons (a typo at hire, a personal
 * address replaced by a company one, a married name) and it changes
 * URGENTLY when someone has lost access to the inbox their attendance
 * codes are sent to. Routing every one of those through the CEO of a
 * ten-branch group is how a salesperson ends up locked out for a week.
 *
 * WHAT THIS DOES NOT WIDEN
 * Nothing about the database. A sign-in address lives in `auth.users`,
 * which no tenant role can touch at all, so the change is made with the
 * admin client inside a Server Action. The fence is therefore this
 * module plus the fact that the CALLER'S OWN SESSION must be able to
 * see the target first: `profiles_select` confines a branch manager to
 * their own branch, so a manager cannot even name a profile in another
 * showroom, let alone another tenant. That is the same construction
 * `resetEmployeePassword` has used since 0009 — RLS proves the target
 * is in scope, then the admin key acts on an id RLS has vouched for.
 */

/**
 * Rank exists to answer "is this person above that one", and nothing
 * else. It is NOT a permission scale — an accountant outranks a
 * salesperson here while having none of a branch manager's authority
 * over them — which is why SUPERVISES below is a separate, explicit
 * table rather than a comparison against these numbers.
 */
export const ROLE_RANK: Record<Role, number> = {
  ceo: 100,
  branch_manager: 60,
  accountant: 50,
  // 0047. Level with the accountant: a staff function that reports to
  // the CEO and manages nobody. The number is only ever read as "is this
  // person above that one" — see the note above on why SUPERVISES is a
  // separate table rather than a comparison against these.
  hr: 50,
  marketing: 30,
  sales_exec: 30,
  investor: 10,
};

/**
 * Which roles each role may administer, stated as a list rather than
 * derived from rank.
 *
 * A branch manager supervises the floor — sales and marketing — and
 * nobody else. Deliberately NOT "everyone below rank 60": that would
 * quietly include the accountant, whose email is the address the
 * showroom's tax filings and bank correspondence answer to, and who
 * does not report to a branch. Deriving authority from a number is how
 * an org chart acquires a rule nobody decided.
 *
 * An accountant supervises nobody. They are finance, not line
 * management, and 0009's policy set has never given them authority over
 * a person.
 */
export const SUPERVISES: Record<Role, readonly Role[]> = {
  ceo: ["ceo", "branch_manager", "accountant", "marketing", "sales_exec", "investor", "hr"],
  branch_manager: ["sales_exec", "marketing"],
  accountant: [],
  // HR supervises NOBODY, and the omission is the point.
  //
  // This table governs exactly one thing: who may change whose SIGN-IN
  // ADDRESS, which is a full account takeover — the new address can
  // request a password reset. HR administering someone's payroll record
  // is a different power with a different fence (the payroll arm of
  // guard_profile_privilege_columns, migration 0047), and conflating
  // the two would hand a payroll clerk every account in the showroom.
  //
  // A locked-out salesperson still has a route: their branch manager,
  // or the CEO.
  hr: [],
  marketing: [],
  sales_exec: [],
  investor: [],
};

export interface EmailChangeSubject {
  id: string;
  role: Role;
  branch_id: string | null;
}

export type EmailChangeVerdict =
  | { allowed: true; reason: "self" | "supervisor" }
  | { allowed: false; reason: "not_supervised" | "other_branch" | "last_ceo_self_only" };

/**
 * May `actor` change `target`'s sign-in address?
 *
 * Pure, so the employees page can hide the control with the same rule
 * the Server Action enforces — and so it can be tested, which a rule
 * about who can take over an account should be.
 *
 * THE CEO CASE IS THE INTERESTING ONE. `ceo` supervises `ceo`, so one
 * CEO can change another's address; that is correct for a group with a
 * chairman and a managing director. What it must never become is a
 * branch manager changing a CEO's address, which is a full takeover of
 * the account that satisfies every is_ceo() predicate in the schema —
 * hence SUPERVISES.branch_manager not containing 'ceo', and the branch
 * check below being an AND rather than an OR.
 */
export function canChangeSignInEmail(
  actor: { id: string; role: Role; branch_id: string | null },
  target: EmailChangeSubject,
  grantedBranchIds: readonly string[] = []
): EmailChangeVerdict {
  // Everyone owns their own address. The Server Action still demands
  // the current password for this path — see employees/actions.ts.
  if (actor.id === target.id) return { allowed: true, reason: "self" };

  if (!SUPERVISES[actor.role].includes(target.role)) {
    return { allowed: false, reason: "not_supervised" };
  }

  // The CEO is org-wide; everyone else is confined to the branches they
  // may act on, which since 0030 means their home branch plus grants.
  // Reusing the same predicate the database uses keeps the app and
  // Postgres agreeing on what "my branch" means.
  if (actor.role !== "ceo") {
    if (!canActOnBranchWithGrants(actor.role, actor.branch_id, target.branch_id, grantedBranchIds)) {
      return { allowed: false, reason: "other_branch" };
    }
  }

  return { allowed: true, reason: "supervisor" };
}

/**
 * The roles whose staff-administration screens exist at all. Used to
 * decide whether to render the employee list's email column as an
 * editable control or as text.
 */
export function canAdministerAnyone(role: Role): boolean {
  return SUPERVISES[role].length > 0;
}
