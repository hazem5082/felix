// Demo mode, minus everything that needs a server.
//
// Kept apart from ./demo for the same reason tenant-host.ts is kept apart
// from tenant.ts: ./demo pulls in `server-only` and the service-role
// client, neither of which can be loaded under vitest. The two pieces
// actually worth testing — the persona allowlist and the fail-open parse
// of a `public.demo_status` row — are pure, so they live here and ./demo
// re-exports them. Callers only ever need to import ./demo.

import { FLAGSHIP_SLUG } from "./tenant-host";
import type { Role } from "./supabase/types";

/**
 * Every showroom that IS a demo. The flagship at demo-felix.508.world
 * (tenant slug `felix`) plus the second demo showroom at
 * demo2-felix.508.world (tenant slug `demo2`, seeded so the FELIX
 * Network's cross-showroom search has a peer to demonstrate against).
 *
 * A slug listed here gets the whole demo treatment: personas-only login,
 * the switcher bar, the demo_status kill switch, and the demo side of
 * the network partition. A licensed showroom must never appear here —
 * that is the invariant that keeps demo mode invisible to paying
 * clients. Additions also need: seeding (scripts/seed-demo.mjs --slug=…),
 * and the slug reserved in /api/provision's RESERVED_SLUGS and the
 * partners portal's RESERVED_CLIENT_SLUGS so no customer can claim it.
 */
export const DEMO_TENANT_SLUGS: readonly string[] = [FLAGSHIP_SLUG, "demo2"];

/**
 * The seeded personas, by the key the switcher sends over the wire.
 *
 * THE KEY IS THE ONLY THING A CLIENT EVER SUPPLIES. The switch action is
 * a public HTTP endpoint reachable by direct POST, so if it accepted an
 * email it would be an unauthenticated "issue me a session for any
 * address on this Supabase project" oracle — and auth.users is shared
 * with A-Star and Calendar (see scripts/seed-demo.mjs), so that address
 * space contains real accounts for other products. Taking an opaque key
 * and looking the address up here means the set of accounts this endpoint
 * can ever sign anyone into is fixed at build time, in this file — the
 * demo-tenant slugs above times the persona keys below, nothing else.
 */
export type DemoAccountKey =
  | "ceo"
  | "manager"
  | "manager2"
  | "accountant"
  | "sales"
  | "sales2"
  | "marketing"
  | "hr"
  | "investor1"
  | "investor2";

/**
 * Which seeded branch a persona works at, for the switcher's labels.
 * Keys match scripts/seed-demo.mjs's ACCOUNTS entries; the display names
 * live in messages/*.json under demo.branches. Null = company-wide.
 */
export type DemoBranchKey = "downtown" | "airport";

export type DemoAccount = {
  /**
   * The role the seed gives this account. Only a fallback for the
   * post-sign-in redirect — the authoritative role is read from the
   * showroom's own `profiles` row, exactly as the login action does.
   */
  role: Role;
  /** The seeded display name, so the switcher can label the buttons. */
  name: string;
  /** The seeded branch assignment, or null for company-wide roles. */
  branch: DemoBranchKey | null;
};

/**
 * Mirrors the ACCOUNTS array in scripts/seed-demo.mjs — keys, names,
 * roles AND branch assignments. If the seed changes, this must change
 * with it — nothing derives one from the other at runtime. Addresses are
 * derived per demo tenant by demoEmailFor(), matching the seed's own
 * emailFor().
 */
export const DEMO_ACCOUNTS: Record<DemoAccountKey, DemoAccount> = {
  ceo: { role: "ceo", name: "Alex Carter", branch: null },
  manager: { role: "branch_manager", name: "Dana Reyes", branch: "downtown" },
  // Airport Road Branch's manager (0042) — the peer Dana Reyes requests
  // and receives stock transfers with. Without this second account there
  // is nobody but the CEO who can ever accept a transfer into that branch.
  manager2: { role: "branch_manager", name: "Riley Nasser", branch: "airport" },
  accountant: { role: "accountant", name: "Sam Nguyen", branch: "downtown" },
  sales: { role: "sales_exec", name: "Jordan Blake", branch: "downtown" },
  // The second salesperson, at the other branch, so the switcher can
  // demonstrate what per-branch sales visibility means: two people with
  // the same role seeing different floors.
  sales2: { role: "sales_exec", name: "Omar Khalil", branch: "airport" },
  marketing: { role: "marketing", name: "Farah Adel", branch: null },
  // 0047. Without this persona the HR hub is only ever visible to the
  // CEO, and a prospect cannot see the thing the role exists to
  // demonstrate: an account that runs payroll and cannot see a car.
  hr: { role: "hr", name: "Nadia Fouad", branch: null },
  investor1: { role: "investor", name: "Morgan Lee", branch: null },
  investor2: { role: "investor", name: "Priya Shah", branch: null },
};

/** Insertion order is the order the switcher renders them in. */
export const DEMO_ACCOUNT_KEYS = Object.keys(DEMO_ACCOUNTS) as DemoAccountKey[];

export type DemoPersona = {
  key: DemoAccountKey;
  name: string;
  role: Role;
  branch: DemoBranchKey | null;
};

/**
 * The switcher's option list, with the addresses stripped.
 *
 * The switcher is a Client Component, so anything it imports is bundled
 * and shipped to the browser. It needs labels per persona and nothing
 * else, so the server passes it this instead of DEMO_ACCOUNTS — which
 * keeps the email derivation on the server side of the boundary and
 * keeps the "the client never names an account" rule visible in the
 * type of the prop rather than only in a comment.
 */
export function demoPersonas(): DemoPersona[] {
  return DEMO_ACCOUNT_KEYS.map((key) => ({
    key,
    name: DEMO_ACCOUNTS[key].name,
    role: DEMO_ACCOUNTS[key].role,
    branch: DEMO_ACCOUNTS[key].branch,
  }));
}

/**
 * The seeded auth address for a persona on one demo tenant. Mirrors
 * emailFor() in scripts/seed-demo.mjs exactly: the flagship keeps the
 * original `<key>@filex.demo` addresses (bookmarked, written up in the
 * vault), every other demo tenant namespaces under its own slug so the
 * shared GoTrue instance never sees a collision.
 *
 * Only ever called server-side, and only after the slug has passed
 * isDemoTenant() and the key has passed isDemoAccountKey() — the pair of
 * allowlists is what keeps this from being an address oracle.
 */
export function demoEmailFor(slug: string, key: DemoAccountKey): string {
  return slug === FLAGSHIP_SLUG ? `${key}@filex.demo` : `${key}@${slug}.filex.demo`;
}

/**
 * The allowlist check, and the security boundary of the switch action.
 *
 * `key in DEMO_ACCOUNTS` would be wrong here: `"constructor" in obj` and
 * `"toString" in obj` are both true through the prototype chain, so an
 * attacker-supplied "constructor" would pass and then index to a
 * function. hasOwnProperty is the only form that answers the question
 * actually being asked.
 */
export function isDemoAccountKey(value: unknown): value is DemoAccountKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEMO_ACCOUNTS, value);
}

/** Reverse lookup, for highlighting whichever persona is signed in.
 *
 * Accepts the flagship's `<key>@filex.demo` and every other demo
 * tenant's `<key>@<slug>.filex.demo` — but only for slugs actually in
 * DEMO_TENANT_SLUGS, so a licensed showroom's user can never light up a
 * persona chip by picking a lookalike address.
 */
export function demoKeyForEmail(email: string | null | undefined): DemoAccountKey | null {
  if (!email) return null;
  const needle = email.trim().toLowerCase();

  for (const slug of DEMO_TENANT_SLUGS) {
    const match = DEMO_ACCOUNT_KEYS.find((key) => demoEmailFor(slug, key) === needle);
    if (match) return match;
  }
  return null;
}

/**
 * Is this request for a demo showroom (the flagship or demo2)?
 *
 * EVERY demo-mode check in the codebase starts with this call, and it is
 * the reason demo mode is invisible to licensed clients: a paying
 * showroom never matches, so it never reads demo_status, never renders
 * the switcher, and can never be switched off by a row in a table it has
 * nothing to do with.
 *
 * Takes the tenant structurally rather than importing the `Tenant` type
 * from ./tenant, which is `server-only`.
 */
export function isDemoTenant(tenant: { slug: string } | null | undefined): boolean {
  return tenant != null && DEMO_TENANT_SLUGS.includes(tenant.slug);
}

/**
 * Is this request for the flagship demo showroom specifically?
 *
 * Most demo behaviour now keys on isDemoTenant(); this narrower check
 * remains for anything that is genuinely about the flagship alone.
 */
export function isFlagshipDemo(tenant: { slug: string } | null | undefined): boolean {
  return tenant?.slug === FLAGSHIP_SLUG;
}

/**
 * The row we care about in `public.demo_status`.
 *
 * That table is a cross-product registry in the shared `public` schema —
 * one row per demo across the 508.world estate — so the key names the
 * PRODUCT, not the tenant. Both FELIX demo showrooms (felix and demo2)
 * share this one row: the kill switch takes the whole shop window down,
 * which is what an operator resetting seed data actually wants.
 */
export const DEMO_STATUS_MODULE_KEY = "felix";

export type DemoStatus = {
  enabled: boolean;
  /** Operator-supplied reason, shown instead of the default notice. */
  offMessage: string | null;
};

/**
 * The fail-open answer. A frozen shared object so no caller can mutate
 * the value another caller is about to read.
 */
export const DEMO_ON: DemoStatus = Object.freeze({ enabled: true, offMessage: null });

/**
 * Turns whatever came back from `public.demo_status` into a status.
 *
 * FAILS OPEN, DELIBERATELY. `public.demo_status` is created by a
 * migration that lives in ANOTHER repository, so at any moment this code
 * may be running against a database that has no such table, no such row,
 * or a differently-shaped one. Every one of those cases means "nobody has
 * ever switched this demo off", and the cost of guessing wrong in the
 * other direction is a bricked demo — the whole product's shop window
 * replaced by an apology because a migration had not landed yet.
 *
 * So only one input turns the demo off: a row that exists and whose
 * `enabled` column is literally `false`. A missing row, a null, a
 * string "false", a number — anything ambiguous — leaves it on.
 */
export function parseDemoStatusRow(row: unknown): DemoStatus {
  if (typeof row !== "object" || row === null) return DEMO_ON;

  const { enabled, off_message: offMessage } = row as Record<string, unknown>;

  // Not a boolean means the column is missing or the shape drifted.
  if (typeof enabled !== "boolean") return DEMO_ON;
  if (enabled) return DEMO_ON;

  const message = typeof offMessage === "string" ? offMessage.trim() : "";
  return { enabled: false, offMessage: message.length > 0 ? message : null };
}
