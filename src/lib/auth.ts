import "server-only";
import { cache } from "react";
import { createClient, getSessionTenant } from "@/lib/supabase/server";
import { getTenant, type Tenant } from "@/lib/tenant";
import { getDemoStatus, isFlagshipDemo } from "@/lib/demo";
import type { TenantClaim } from "@/lib/tenant-claim";
import { redirect } from "@/i18n/navigation";
import type { Profile, Role } from "@/lib/supabase/types";
import type { ActionError } from "@/lib/validation";

/**
 * Does the showroom this HOST serves match the showroom this SESSION
 * belongs to?
 *
 * Until 0011 this was `tenant.id === profile.tenant_id`. profiles no
 * longer carries tenant_id — the schema the row lives in IS its tenant —
 * so the comparison moved to the session's access token claim, which
 * migration 0010's hook derives from platform.tenant_users.
 *
 * Both sides still matter and neither is redundant. The claim says which
 * showroom the user belongs to; the host says which showroom's front
 * door they knocked on. A mismatch means someone is signed into showroom
 * A and browsing showroom B's subdomain — harmless at the database level
 * (their role has no privilege on B's schema) but it must not render B's
 * branding around A's data, and it is worth refusing outright.
 */
function sameShowroom(tenant: Tenant, claim: TenantClaim): boolean {
  return tenant.slug === claim.slug && tenant.schema_name === claim.schema;
}

/**
 * Has the flagship demo been switched off underneath this request?
 *
 * The (app) layout has its own copy of this check, which covers every
 * page inside that route group. This one exists for the pages that render
 * OUTSIDE it — the /print contracts and reports — for exactly the reason
 * requireActiveTenant() exists at all: a guard that lives in a layout
 * protects only what that layout wraps, and the print routes wrap
 * themselves.
 *
 * Returns false without a single database read for every licensed
 * showroom, which is the whole point of leading with isFlagshipDemo().
 */
async function demoIsOff(tenant: Tenant): Promise<boolean> {
  if (!isFlagshipDemo(tenant)) return false;
  return !(await getDemoStatus()).enabled;
}

// Memoized per-request — safe to call from many Server Components
// without duplicating the round trip.
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return (data as Profile) ?? null;
});

// ── Page guards (redirecting) ───────────────────────────────

export async function requireProfile(locale: string): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) {
    redirect({ href: "/login", locale });
    throw new Error("unreachable");
  }
  return profile;
}

export async function requireRole(locale: string, allowed: Role[]): Promise<Profile> {
  const profile = await requireProfile(locale);
  if (!allowed.includes(profile.role)) {
    redirect({ href: defaultRouteForRole(profile.role), locale });
    throw new Error("unreachable");
  }
  return profile;
}

/**
 * The licence gate, for authenticated pages that do NOT render inside
 * the `(app)` layout — print documents, and anything else added later
 * outside that route group.
 *
 * The layout's check was the only enforcement of "this session belongs
 * to this host's showroom, and that showroom's licence is active". Any
 * page outside it inherited none of it, so a suspended showroom's staff
 * could still pull the full P&L, cap table and ledger from the print
 * routes with a cookie issued before suspension. Session refresh is
 * independent of `tenants.status`, so that would have continued
 * indefinitely.
 */
export async function requireActiveTenant(
  locale: string,
  allowed?: Role[]
): Promise<Profile> {
  const [profile, tenant, claim] = await Promise.all([
    getProfile(),
    getTenant(),
    getSessionTenant(),
  ]);

  if (!profile || !tenant || !claim || !sameShowroom(tenant, claim) || tenant.status === "suspended") {
    redirect({ href: "/login", locale });
    throw new Error("unreachable");
  }

  // Sent to /login rather than rendering the notice inline: these pages
  // are a bare A4 sheet with no shell to put a notice in, and /login is
  // where the notice lives for unauthenticated visitors anyway. The login
  // page checks the demo gate before its own signed-in redirect, so this
  // lands on the notice rather than bouncing onward to a dashboard.
  if (await demoIsOff(tenant)) {
    redirect({ href: "/login", locale });
    throw new Error("unreachable");
  }

  if (allowed && !allowed.includes(profile.role)) {
    redirect({ href: defaultRouteForRole(profile.role), locale });
    throw new Error("unreachable");
  }

  return profile;
}

/** Non-redirecting equivalent, for route handlers. */
export async function authorizeActiveTenant(allowed: Role[]): Promise<Authorized> {
  const [profile, tenant, claim] = await Promise.all([
    getProfile(),
    getTenant(),
    getSessionTenant(),
  ]);
  if (!profile) return { ok: false, error: UNAUTHENTICATED };
  if (!tenant || !claim || !sameShowroom(tenant, claim) || tenant.status === "suspended") {
    return { ok: false, error: DENIED };
  }
  // Same gate as the redirecting twin above. Without it, /api/export/ledger
  // would keep streaming the demo's full ledger as CSV while every page
  // that reaches it says the demo is off.
  if (await demoIsOff(tenant)) return { ok: false, error: DENIED };
  if (!allowed.includes(profile.role)) return { ok: false, error: DENIED };
  return { ok: true, profile };
}

// ── Action guards (non-redirecting) ─────────────────────────
//
// A Server Action is a public HTTP endpoint: the role props that hide a
// button in the UI vanish the moment someone POSTs the action directly.
// Every mutating action calls `authorize` first, and treats RLS as the
// second layer rather than the only one.

export type Authorized =
  | { ok: true; profile: Profile }
  | { ok: false; error: ActionError };

const DENIED: ActionError = {
  error: "You do not have permission to perform this action.",
};
const UNAUTHENTICATED: ActionError = { error: "Your session has expired. Please sign in again." };

export async function authorize(allowed: Role[]): Promise<Authorized> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: UNAUTHENTICATED };
  if (!allowed.includes(profile.role)) return { ok: false, error: DENIED };
  return { ok: true, profile };
}

export async function authenticate(): Promise<Authorized> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: UNAUTHENTICATED };
  return { ok: true, profile };
}

/**
 * CEO and accountants operate org-wide; everyone else is confined to the
 * branch on their profile. Mirrors `can_act_on_branch()` in migration 0003
 * so the app and the database agree on what "my branch" means.
 */
export function canActOnBranch(profile: Profile, branchId: string | null): boolean {
  if (profile.role === "ceo" || profile.role === "accountant") return true;
  return branchId !== null && branchId === profile.branch_id;
}

export function assertBranch(profile: Profile, branchId: string | null): ActionError | null {
  return canActOnBranch(profile, branchId)
    ? null
    : { error: "That record belongs to another branch." };
}

export const REVIEWER_ROLES: Role[] = ["ceo", "branch_manager"];
export const STAFF_ROLES: Role[] = ["ceo", "accountant", "branch_manager", "sales_exec"];
export const FINANCE_ROLES: Role[] = ["ceo", "accountant"];
export const INTAKE_ROLES: Role[] = ["ceo", "branch_manager"];
export const EXPENSE_ROLES: Role[] = ["ceo", "accountant", "branch_manager"];

export function defaultRouteForRole(role: Role) {
  switch (role) {
    case "ceo":
      return "/ceo";
    case "branch_manager":
      return "/deals";
    case "accountant":
      return "/accountant";
    case "investor":
      return "/investor";
    case "sales_exec":
    default:
      return "/crm";
  }
}
