// Relative, not aliased, for the reason branch-authority.ts gives: this
// module is under vitest, which resolves no tsconfig paths here.
import type { FeatureKey, FeatureGrant, Role } from "./supabase/types";

/**
 * Per-person navigation, and the line between a tab and a permission.
 *
 * Migration 0048 lets a CEO hand somebody a hub their role does not
 * carry, or take away one it does. This module is the app's half of
 * that: pure, testable, and shared by the sidebar, the mobile tab bar
 * and the page guards, so all three answer "may this person open the HR
 * hub?" from one place.
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------
 * A GRANT is real authority. `feature_grants_grantable` in 0048 refuses
 * any grant except 'hr', because 'hr' is the only feature whose RLS
 * policies consult has_feature(). Handing out a tab whose data the
 * database will not serve produces an empty screen and a support
 * ticket, so the CHECK exists to make that impossible rather than
 * merely discouraged.
 *
 * A HIDE is cosmetic. It removes the tab and changes nothing in
 * Postgres: the role keeps every privilege it had, and someone who
 * types the URL still gets the page. That is fine for decluttering a
 * four-person showroom's sidebar and it is NOT a security control. The
 * admin screen has to say so, which is why HIDE_IS_COSMETIC exists as a
 * named export rather than a comment somebody can render without.
 */

/** Features a CEO may GRANT — must match feature_grants_grantable. */
export const FEATURE_GRANTABLE: readonly FeatureKey[] = ["hr"] as const;

/**
 * Tabs a CEO may HIDE. Everything addressable except the two nobody
 * should be locked out of — mirrors feature_grants_hideable (0048).
 */
export const FEATURE_HIDEABLE: readonly FeatureKey[] = [
  "ceoDashboard",
  "inventory",
  "crm",
  "deals",
  "marketing",
  "accountant",
  "investor",
  "calendar",
  "employees",
  "attendance",
  "mail",
  "hr",
] as const;

/**
 * Read by the admin panel so the warning next to the "hide" column is
 * impossible to ship without. See the module header.
 */
export const HIDE_IS_COSMETIC = true;

/**
 * The roles that carry HR authority natively. A grant adds to this; it
 * never replaces it.
 *
 * The CEO is here because every is_hr() fence in 0047 is written
 * `is_ceo() or is_hr()` in the database, and the app must not be
 * stricter than the database in a way that hides a working screen.
 */
export const HR_ROLES: readonly Role[] = ["ceo", "hr"] as const;

/** The live grants for one person, reduced to the two sets that matter. */
export interface ResolvedFeatures {
  granted: ReadonlySet<FeatureKey>;
  hidden: ReadonlySet<FeatureKey>;
}

/**
 * Reduce raw feature_grants rows to the two sets the navigation needs.
 *
 * `revoked_at` is re-checked here even though the query filters on it:
 * the same clause guards has_feature() in Postgres, and a revoked grant
 * must stop counting in the app on the same request it stops counting
 * in the database. Cheap, and the alternative is a screen that disagrees
 * with the rows it is about to be denied.
 */
export function resolveFeatures(grants: readonly FeatureGrant[]): ResolvedFeatures {
  const granted = new Set<FeatureKey>();
  const hidden = new Set<FeatureKey>();
  for (const g of grants) {
    if (g.revoked_at) continue;
    if (g.mode === "grant") granted.add(g.feature);
    else hidden.add(g.feature);
  }
  return { granted, hidden };
}

/**
 * Does this session hold HR authority — by role, or by grant?
 *
 * The app-side twin of is_hr() as migration 0048 redefines it. Both
 * must say the same thing: if this returns true where the database
 * returns false the user gets an empty page, and if it returns false
 * where the database returns true the feature is simply unreachable.
 */
export function hasHrAuthority(role: Role, features: ResolvedFeatures): boolean {
  return HR_ROLES.includes(role) || features.granted.has("hr");
}

/** No grants at all — the answer for a signed-out or unresolved session. */
export const NO_FEATURES: ResolvedFeatures = {
  granted: new Set<FeatureKey>(),
  hidden: new Set<FeatureKey>(),
};
