import type { FeatureKey, Role } from "@/lib/supabase/types";
import { NO_FEATURES, hasHrAuthority, type ResolvedFeatures } from "@/lib/features";

/**
 * The navigation, which since 0048 is no longer a constant.
 *
 * Two things changed at once and they are easy to confuse:
 *
 *  1. Some entries are now GROUPS — a heading with pages under it. The
 *     HR hub is the first: attendance, payroll and the bonus ladder are
 *     one subject and would otherwise be three peers of "Inventory".
 *
 *  2. The per-role table below is now a DEFAULT rather than the whole
 *     answer. A CEO can hand a person a hub their role does not carry
 *     (a real grant, backed by RLS) or hide one it does (cosmetic — see
 *     lib/features.ts). navFor() applies both.
 *
 * The role table stays as the default because a showroom that has
 * configured nothing must still get a sensible sidebar, and because
 * every grant is an exception somebody had to think about.
 */

// The task board (0053) is carried by everyone who can be given a task
// — the five staff roles plus marketing — and by nobody else. Investors
// are the omission, and it is the same one attendance makes: they are
// outside capital, not staff, and there is no sense in which one is
// assigned the morning call list. Deliberately NOT in FEATURE_HIDEABLE:
// 0048's `feature` CHECK does not know the name, so offering the CEO a
// hide toggle for it would produce a constraint violation.

/**
 * Every addressable nav entry. A superset of FeatureKey: the two HR
 * sub-pages are navigation but not grantable — they live and die with
 * the hub above them, so there is nothing to grant them separately and
 * 0048's CHECK does not know their names.
 */
export type NavKey = FeatureKey | "hrPayroll" | "hrBonuses";

export interface NavLeaf {
  kind: "leaf";
  href: string;
  key: NavKey;
}

export interface NavGroup {
  kind: "group";
  /** A FeatureKey, not a NavKey: a group is what gets granted or hidden. */
  key: FeatureKey;
  /** Where the heading itself navigates — the hub's landing page. */
  href: string;
  children: NavLeaf[];
}

export type NavEntry = NavLeaf | NavGroup;

function leaf(href: string, key: NavKey): NavLeaf {
  return { kind: "leaf", href, key };
}

const ACCOUNTANT_CHILDREN: NavLeaf[] = [
  leaf("/fees", "fees"),
];

/**
 * The HR hub's pages, in the order HR uses them.
 *
 * ATTENDANCE IS LISTED HERE AND IS ALSO A TOP-LEVEL TAB FOR EVERYONE
 * ELSE, pointing at the same /attendance route. That is deliberate and
 * not an oversight: the page is a punch card first and an oversight
 * board second, so a salesperson must keep reaching it directly. Moving
 * the route under /hr would have taken the punch clock away from the
 * people who punch. What "moved into the HR hub" means is that the
 * person who administers attendance now finds it filed with payroll
 * rather than loose in the sidebar.
 */
const HR_CHILDREN: NavLeaf[] = [
  leaf("/employees", "employees"),
  leaf("/hr/payroll", "hrPayroll"),
  leaf("/hr/bonuses", "hrBonuses"),
  leaf("/attendance", "attendance"),
];

export const ALL_NAV: NavEntry[] = [
  leaf("/ceo", "ceoDashboard"),
  leaf("/inventory", "inventory"),
  leaf("/crm", "crm"),
  leaf("/deals", "deals"),
  leaf("/tasks", "tasks"),
  leaf("/marketing", "marketing"),
  { kind: "group", key: "accountant", href: "/accountant", children: ACCOUNTANT_CHILDREN },
  leaf("/network", "network"),
  leaf("/investor", "investor"),
  { kind: "group", key: "hr", href: "/hr", children: HR_CHILDREN },
  leaf("/calendar", "calendar"),
  leaf("/attendance", "attendance"),
  leaf("/mail", "mail"),
  leaf("/support", "support"),
  leaf("/account", "account"),
];

// The calendar is the one tab every role carries. Who may *schedule*
// into it is a separate question, settled in the database by
// create_meeting() (migration 0006) rather than by this list.
// Employees is under HR hub (CEO & HR).
//
// Attendance (0038) is carried by everyone who can owe or oversee a
// day: the four staff roles plus marketing. Investors are excluded —
// they are outside capital, not staff, and there is no sense in which
// one attends. The tab still renders for a REMOTE profile: it is where
// they see their own history and their trusted phones, and the page
// tells them plainly that no punch is expected of them, which is a
// better answer than a tab that silently vanishes.
// Mail (0039) is carried by every role, investors included — unlike
// attendance, it is generic correspondence rather than a staff
// obligation, and an investor's own felixmail address is exactly as
// real as anyone else's.
//
// HR (0047) carries the hub and nothing from the sales operation: no
// inventory, no CRM, no deals, no dashboard. That is not a UI opinion,
// it is what the database will serve them — is_hr() is deliberately
// absent from is_staff(), so those pages would render empty. The CEO
// carries the hub too; they carry everything.
//
// The FELIX Network (0054) is the CEO's and the branch managers', and
// nobody else's. Sourcing a car from another business is a negotiation
// between two managements — a margin, a transport cost and a standing
// relationship — so it is not the sales floor's call to ring a
// competitor, and it is not an investor's or HR's business at all. The
// page and both of its actions re-check the pair server-side.
//
// Note that 'hr' and 'accountant' appear as GROUP keys, and
// 'attendance' appears in several lists as a leaf. navFor() drops the loose
// attendance tab for anyone who is getting the hub, so nobody sees it twice.
const NAV_BY_ROLE: Record<Role, NavKey[]> = {
  ceo: ["ceoDashboard", "inventory", "crm", "deals", "tasks", "marketing", "accountant", "network", "hr", "calendar", "attendance", "mail", "support", "account"],
  branch_manager: ["inventory", "crm", "deals", "tasks", "network", "calendar", "attendance", "mail", "support", "account"],
  accountant: ["accountant", "inventory", "deals", "tasks", "calendar", "attendance", "mail", "support", "account"],
  // Sales sees the floor (sticker + optional lowest-offer price only —
  // cost is redacted, see canSeeCost) so they know what is in stock
  // without ever reading what it cost the showroom.
  sales_exec: ["inventory", "crm", "deals", "tasks", "calendar", "attendance", "mail", "support", "account"],
  investor: ["investor", "calendar", "mail", "support", "account"],
  // Marketing lists stock across channels: their workspace, the inventory
  // they advertise (cost hidden — 0028), and the tabs everyone carries.
  marketing: ["marketing", "inventory", "tasks", "calendar", "attendance", "mail", "support", "account"],
  // 0047. The hub, the diary, the inbox, and nothing that would open
  // onto a page RLS leaves empty.
  hr: ["hr", "tasks", "calendar", "attendance", "mail", "support", "account"],
};

/**
 * The navigation this person actually sees.
 *
 * Order of operations, and each step exists for a reason:
 *
 *  1. Start from the role's default list.
 *  2. Add granted features. Only 'hr' is grantable today (0048's
 *     CHECK), but the code is written over the set rather than over
 *     that one key, so wiring a second feature is a one-line change
 *     here and a migration there.
 *  3. Remove hidden features. Applied AFTER the grant so that hiding
 *     something you were granted works — a CEO who grants and then
 *     regrets should not have to revoke to undo.
 *  4. Drop the loose Attendance tab when the HR hub is present, since
 *     the hub already lists it. Without this the person who runs
 *     attendance is the one person who sees it twice.
 *
 * Called with NO_FEATURES from anywhere that has not loaded grants,
 * which yields exactly the pre-0048 behaviour rather than an empty rail.
 */
export function navFor(
  role: Role,
  features: ResolvedFeatures = NO_FEATURES
): NavEntry[] {
  const keys = new Set<NavKey>(NAV_BY_ROLE[role] ?? []);
  for (const key of features.granted) keys.add(key);
  for (const key of features.hidden) keys.delete(key);

  if (keys.has("hr")) keys.delete("attendance");

  return ALL_NAV.filter((entry) => keys.has(entry.key));
}

/** Pre-0048 signature, kept for call sites that have no grant context. */
export function navForRole(role: Role): NavEntry[] {
  return navFor(role, NO_FEATURES);
}

/**
 * Flattened to leaves — the phone tab bar has no room for a disclosure
 * triangle, so a group becomes its children inline.
 */
export function flattenNav(entries: NavEntry[]): NavLeaf[] {
  return entries.flatMap((e) => {
    if (e.kind !== "group") return [e];
    const hasParentLeaf = e.children.some((c) => c.href === e.href);
    return hasParentLeaf ? e.children : [leaf(e.href, e.key), ...e.children];
  });
}

/** Whether this person may open the HR hub at all. Mirrors is_hr(). */
export function canOpenHrHub(role: Role, features: ResolvedFeatures): boolean {
  return hasHrAuthority(role, features);
}
