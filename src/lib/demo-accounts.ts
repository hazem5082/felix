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
 * The six seeded personas, by the key the switcher sends over the wire.
 *
 * THE KEY IS THE ONLY THING A CLIENT EVER SUPPLIES. The switch action is
 * a public HTTP endpoint reachable by direct POST, so if it accepted an
 * email it would be an unauthenticated "issue me a session for any
 * address on this Supabase project" oracle — and auth.users is shared
 * with A-Star and Calendar (see scripts/seed-demo.mjs), so that address
 * space contains real accounts for other products. Taking an opaque key
 * and looking the address up here means the set of accounts this endpoint
 * can ever sign anyone into is fixed at build time, in this file.
 */
export type DemoAccountKey =
  | "ceo"
  | "manager"
  | "accountant"
  | "sales"
  | "marketing"
  | "investor1"
  | "investor2";

export type DemoAccount = {
  /** The seeded auth address. Never accepted from, or sent to, a client. */
  email: string;
  /**
   * The role the seed gives this account. Only a fallback for the
   * post-sign-in redirect — the authoritative role is read from the
   * showroom's own `profiles` row, exactly as the login action does.
   */
  role: Role;
  /** The seeded display name, so the switcher can label the buttons. */
  name: string;
};

/**
 * Mirrors the ACCOUNTS array in scripts/seed-demo.mjs, including the
 * `<key>@filex.demo` addresses `emailFor()` builds for the flagship. If
 * the seed's keys or names change, this must change with them — nothing
 * derives one from the other at runtime.
 */
export const DEMO_ACCOUNTS: Record<DemoAccountKey, DemoAccount> = {
  ceo: { email: "ceo@filex.demo", role: "ceo", name: "Alex Carter" },
  manager: { email: "manager@filex.demo", role: "branch_manager", name: "Dana Reyes" },
  accountant: { email: "accountant@filex.demo", role: "accountant", name: "Sam Nguyen" },
  sales: { email: "sales@filex.demo", role: "sales_exec", name: "Jordan Blake" },
  marketing: { email: "marketing@filex.demo", role: "marketing", name: "Farah Adel" },
  investor1: { email: "investor1@filex.demo", role: "investor", name: "Morgan Lee" },
  investor2: { email: "investor2@filex.demo", role: "investor", name: "Priya Shah" },
};

/** Insertion order is the order the switcher renders them in. */
export const DEMO_ACCOUNT_KEYS = Object.keys(DEMO_ACCOUNTS) as DemoAccountKey[];

export type DemoPersona = { key: DemoAccountKey; name: string };

/**
 * The switcher's button list, with the addresses stripped.
 *
 * The switcher is a Client Component, so anything it imports is bundled
 * and shipped to the browser. It needs a label per persona and nothing
 * else, so the server passes it this instead of DEMO_ACCOUNTS — which
 * keeps the email map on the server side of the boundary and keeps the
 * "the client never names an account" rule visible in the type of the
 * prop rather than only in a comment.
 */
export function demoPersonas(): DemoPersona[] {
  return DEMO_ACCOUNT_KEYS.map((key) => ({ key, name: DEMO_ACCOUNTS[key].name }));
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

/** Reverse lookup, for highlighting whichever persona is signed in. */
export function demoKeyForEmail(email: string | null | undefined): DemoAccountKey | null {
  if (!email) return null;
  const needle = email.trim().toLowerCase();
  return DEMO_ACCOUNT_KEYS.find((key) => DEMO_ACCOUNTS[key].email === needle) ?? null;
}

/**
 * Is this request for the flagship demo showroom?
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
export function isFlagshipDemo(tenant: { slug: string } | null | undefined): boolean {
  return tenant?.slug === FLAGSHIP_SLUG;
}

/**
 * The row we care about in `public.demo_status`.
 *
 * That table is a cross-product registry in the shared `public` schema —
 * one row per demo across the 508.world estate — so the key names the
 * product, not the tenant. It happens to equal FLAGSHIP_SLUG; that is a
 * coincidence of naming and not something to derive.
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
