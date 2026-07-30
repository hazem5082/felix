import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "@/i18n/navigation";
import type { Profile, Role } from "@/lib/supabase/types";
import type { ActionError } from "@/lib/validation";

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
    .single();

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
