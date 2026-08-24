"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { authorizeActiveTenant } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionTenant } from "@/lib/supabase/server";
import { isFlagshipDemo } from "@/lib/demo-accounts";
import { consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import {
  NetworkParticipationSchema,
  NetworkSearchSchema,
  parseInput,
  type ActionError,
} from "@/lib/validation";
import {
  coarseFilter,
  compareMatches,
  isSearchable,
  parseQuery,
  scoreVehicle,
  type NetworkMatch,
  type NetworkSearchResult,
  type NetworkShowroom,
  type NetworkStatus,
} from "@/lib/network";

/**
 * THE FAN-OUT — the only place in FELIX that reads across showrooms.
 *
 * Everything else in this app is confined to one schema by the session's
 * own token (see supabase/server.ts). This file deliberately is not: it
 * holds the service-role client, which can read any tenant schema, and
 * loops it over the registry. That makes it the single most sensitive
 * module in the codebase, so the rules it enforces are written out here
 * rather than left to be inferred from the code:
 *
 *   1. THE CALLER. A CEO or a branch manager, signed in, on their own
 *      showroom's host, with an active licence. authorizeActiveTenant()
 *      checks all four — a Server Action is a public HTTP endpoint and
 *      the role prop that hides the sidebar tab means nothing to a
 *      hand-crafted POST.
 *   2. THE SOURCE. Only showrooms that are `active` AND have
 *      network_opt_in set (migration 0054). Never the caller's own
 *      showroom — they have a whole Inventory screen for that.
 *   3. THE FIELDS. Exactly the columns NetworkVehicle names, listed
 *      explicitly in the select. No `select("*")` anywhere in this file,
 *      because `*` is how a future migration's confidential column
 *      silently starts crossing showroom boundaries.
 *   4. THE STOCK. status = 'in_stock'. A sold car is somebody's
 *      completed transaction and a reserved one is somebody's pending
 *      deal; neither is available and neither is anyone else's business.
 *   5. THE DEMO IS ITS OWN NETWORK — it never sees a licensed
 *      showroom's stock and no licensed showroom ever sees its seed
 *      data. See sameNetworkSide() below.
 *
 * Nothing here writes to another showroom's schema. There is no code
 * path in this file that can.
 */

/** Registry rows are tiny; this is a sanity bound, not a page size. */
const MAX_SHOWROOMS = 50;
/** Rows pulled from each showroom before scoring. */
const PER_SHOWROOM_LIMIT = 40;
/** Matches returned to the screen. */
const MAX_MATCHES = 60;

const NETWORK_ROLES = ["ceo", "branch_manager"] as const;

/** The columns that may cross a showroom boundary. See NetworkVehicle. */
const VEHICLE_COLUMNS =
  "id, year, make, model, trim, color, odometer_km, asking_price, created_at, branches(name, address)";

/**
 * The same list minus everything a migration added after 0009, used
 * once as a retry when the full select fails.
 *
 * A showroom whose schema is a migration or two behind should drop out
 * of the network's RESULTS, not out of the network — the manager
 * hunting a Hilux does not care that somebody else's showroom has not
 * had 0036 applied. `branches(...)` is dropped here too: the embed
 * needs the FK to be visible to PostgREST, and a stale schema cache is
 * one of the ways the first select can fail.
 */
const VEHICLE_COLUMNS_MINIMAL = "id, year, make, model, trim, asking_price, created_at";

interface RegistryRow {
  slug: string;
  name: string;
  schema_name: string;
}

interface RawVehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color?: string | null;
  odometer_km?: number | null;
  asking_price: number | null;
  created_at: string;
  branches?: { name: string | null; address: string | null } | null;
}

/**
 * THE DEMO IS ITS OWN NETWORK.
 *
 * Not "the demo is excluded" — a partition. A showroom may only see
 * showrooms on its own side of this line: demo with demo, licensed with
 * licensed.
 *
 * The reason is the serious half. demo-felix is a shop window with
 * passwordless personas — anyone who opens it can become its CEO — so a
 * demo session that could search the network would be an anonymous
 * visitor reading real showrooms' live stock and phone numbers. The
 * other direction matters too, if less: a paying showroom must not have
 * seed data presented to it as a car it can drive over and buy.
 *
 * Written as a partition rather than an exclusion because it makes the
 * fix a data change instead of a code change. There is one demo tenant
 * today, so the demo's network is empty and says so honestly. Provision
 * a second demo showroom and the feature demonstrates itself, with no
 * line of this file touched and no hole in the rule.
 */
function sameNetworkSide(a: string, b: string): boolean {
  return isFlagshipDemo({ slug: a }) === isFlagshipDemo({ slug: b });
}

function emptyResult(query: string, error?: string): NetworkSearchResult {
  return { query, matches: [], searched: 0, unreachable: 0, truncated: false, error };
}

/**
 * Is this the "column does not exist" that means 0054 has not been
 * applied here yet? Postgres says 42703; PostgREST forwards it, and
 * also answers 42P01/PGRST205 while its schema cache is cold.
 */
function looksUnmigrated(code: string | undefined, message: string | undefined): boolean {
  return (
    code === "42703" ||
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    !!message?.includes("network_opt_in")
  );
}

/**
 * This feature's own refusals, localized where they are born.
 *
 * lib/action-messages.ts localizes the SHARED refusals by looking their
 * English text up in a dictionary — the right tool for messages that
 * predate localization and are raised in modules with no message
 * namespace of their own. A new feature with its own namespace does not
 * need that indirection: next-intl resolves the request locale inside a
 * Server Action, so these read from `network.errors` directly.
 */
async function refusals() {
  return getTranslations("network.errors");
}

/**
 * Every participating showroom except the caller's own and the demo.
 *
 * Returns an error — distinct from an empty list — when the registry
 * itself could not be read, so the screen can tell "nobody else has
 * joined" apart from "this is broken".
 */
async function participatingShowrooms(
  mySlug: string
): Promise<{ rows: RegistryRow[] } | { error: string }> {
  const platform = createAdminClient("platform");
  const { data, error } = await platform
    .from("tenants")
    .select("slug, name, schema_name")
    .eq("status", "active")
    .eq("network_opt_in", true)
    .order("name")
    .limit(MAX_SHOWROOMS);

  if (error) {
    console.error("[network] registry read failed", error);
    const t = await refusals();
    return { error: looksUnmigrated(error.code, error.message) ? t("notMigrated") : t("unavailable") };
  }

  const rows = ((data as RegistryRow[]) ?? []).filter(
    (t) => t.slug !== mySlug && sameNetworkSide(t.slug, mySlug)
  );
  return { rows };
}

/** One showroom's contact card, or the licence name alone if it has none. */
async function showroomIdentity(tenant: RegistryRow): Promise<NetworkShowroom> {
  const fallback: NetworkShowroom = {
    slug: tenant.slug,
    name: tenant.name,
    phone: null,
    email: null,
  };

  try {
    const { data, error } = await createAdminClient(tenant.schema_name)
      .from("company_settings")
      .select("trade_name, legal_name, phone, email")
      .maybeSingle();

    // Absent row or absent table (0046 not applied) — the licence name
    // is a perfectly good answer and this must never fail a search.
    if (error || !data) return fallback;

    const row = data as {
      trade_name: string | null;
      legal_name: string | null;
      phone: string | null;
      email: string | null;
    };
    return {
      slug: tenant.slug,
      name: row.trade_name?.trim() || row.legal_name?.trim() || tenant.name,
      phone: row.phone?.trim() || null,
      email: row.email?.trim() || null,
    };
  } catch {
    return fallback;
  }
}

/** One showroom's in-stock cars matching the coarse filter. */
async function candidateVehicles(
  tenant: RegistryRow,
  filter: string | null
): Promise<RawVehicle[] | null> {
  const client = createAdminClient(tenant.schema_name);

  const run = (columns: string) => {
    const q = client.from("vehicles").select(columns).eq("status", "in_stock");
    // One expression covering every word — see coarseFilter(). Null for
    // a year-only search, which fetches the newest stock and lets
    // scoreVehicle() rank it.
    return (filter ? q.or(filter) : q)
      .order("created_at", { ascending: false })
      .limit(PER_SHOWROOM_LIMIT);
  };

  try {
    const { data, error } = await run(VEHICLE_COLUMNS);
    if (!error) return (data as unknown as RawVehicle[]) ?? [];

    // One retry on the reduced column set, for a showroom whose schema
    // is behind. Anything that fails twice is genuinely unreachable.
    const retry = await run(VEHICLE_COLUMNS_MINIMAL);
    if (retry.error) {
      console.error("[network] showroom unreadable", { slug: tenant.slug, error: retry.error });
      return null;
    }
    return (retry.data as unknown as RawVehicle[]) ?? [];
  } catch (err) {
    console.error("[network] showroom threw", { slug: tenant.slug, err });
    return null;
  }
}

/**
 * Search every other participating showroom's floor.
 *
 * Returns a result object rather than throwing, including for the
 * refusals: this is called from a button, and a manager with a waiting
 * customer needs to be told what happened in the panel they are looking
 * at.
 */
export async function searchNetwork(rawQuery: string): Promise<NetworkSearchResult> {
  const parsed = await parseInput(NetworkSearchSchema, { q: rawQuery });
  if (!parsed.ok) return emptyResult(rawQuery, parsed.error.error);

  const auth = await authorizeActiveTenant([...NETWORK_ROLES]);
  if (!auth.ok) return emptyResult(parsed.data.q, auth.error.error);

  const t = await refusals();

  const claim = await getSessionTenant();
  if (!claim) return emptyResult(parsed.data.q, t("sessionExpired"));

  const query = parseQuery(parsed.data.q);
  if (!isSearchable(query)) return emptyResult(parsed.data.q, t("queryTooShort"));

  const limit = await consume(`network:search:${auth.profile.id}`, LIMITS.networkSearch);
  if (!limit.allowed) {
    return emptyResult(parsed.data.q, `${t("throttled")} ${await retryMessage(limit.retryAfter)}`);
  }

  const registry = await participatingShowrooms(claim.slug);
  if ("error" in registry) return emptyResult(parsed.data.q, registry.error);
  if (registry.rows.length === 0) {
    return { ...emptyResult(parsed.data.q), searched: 0 };
  }

  const filter = coarseFilter(query);

  // One showroom at a time would make the search take as long as the
  // network is wide. Each showroom is independent, and one that is down
  // must not take the others with it — hence the per-showroom nulls
  // rather than a rejected Promise.all.
  const perShowroom = await Promise.all(
    registry.rows.map(async (tenant) => {
      const [vehicles, showroom] = await Promise.all([
        candidateVehicles(tenant, filter),
        showroomIdentity(tenant),
      ]);
      return { tenant, vehicles, showroom };
    })
  );

  const matches: NetworkMatch[] = [];
  let unreachable = 0;

  for (const { vehicles, showroom } of perShowroom) {
    if (vehicles === null) {
      unreachable += 1;
      continue;
    }

    for (const v of vehicles) {
      const score = scoreVehicle(
        { year: v.year, make: v.make, model: v.model, trim: v.trim, color: v.color ?? null },
        query
      );
      if (score === null) continue;

      matches.push({
        score,
        showroom,
        vehicle: {
          id: v.id,
          year: v.year,
          make: v.make,
          model: v.model,
          trim: v.trim,
          color: v.color ?? null,
          odometerKm: v.odometer_km ?? null,
          askingPrice: v.asking_price,
          branchName: v.branches?.name ?? null,
          branchAddress: v.branches?.address ?? null,
          createdAt: v.created_at,
        },
      });
    }
  }

  matches.sort(compareMatches);

  return {
    query: parsed.data.q,
    matches: matches.slice(0, MAX_MATCHES),
    searched: perShowroom.length - unreachable,
    unreachable,
    truncated: matches.length > MAX_MATCHES,
  };
}

/**
 * Who is on the network, and is this showroom one of them.
 *
 * Read by the page on every load. Deliberately does NOT reveal which
 * showrooms — a count is what the screen needs to say whether searching
 * is worth the click, and the names arrive with the results of a real
 * search rather than as a browsable directory of competitors.
 */
export async function fetchNetworkStatus(): Promise<NetworkStatus> {
  const unknown: NetworkStatus = { participating: false, peers: 0, available: false };

  const auth = await authorizeActiveTenant([...NETWORK_ROLES]);
  if (!auth.ok) return unknown;

  const claim = await getSessionTenant();
  if (!claim) return unknown;

  const platform = createAdminClient("platform");
  const { data, error } = await platform
    .from("tenants")
    .select("slug, status, network_opt_in")
    .limit(MAX_SHOWROOMS);

  if (error) {
    console.error("[network] status read failed", error);
    const t = await refusals();
    return {
      ...unknown,
      reason: looksUnmigrated(error.code, error.message) ? t("notMigrated") : t("unavailable"),
    };
  }

  const rows = (data as { slug: string; status: string; network_opt_in: boolean }[]) ?? [];
  const me = rows.find((t) => t.slug === claim.slug);

  return {
    participating: !!me?.network_opt_in,
    peers: rows.filter(
      (t) =>
        t.slug !== claim.slug &&
        sameNetworkSide(t.slug, claim.slug) &&
        t.status === "active" &&
        t.network_opt_in
    ).length,
    available: true,
  };
}

/**
 * Join or leave the network. The CEO's decision alone — a branch
 * manager searches it, but publishing the group's whole floor is not a
 * branch-level call.
 *
 * Writes platform.tenants by SLUG FROM THE SESSION'S OWN TOKEN. There
 * is no parameter naming a showroom and there must never be one: the
 * only row this action can touch is the caller's own licence.
 */
export async function setNetworkParticipation(input: {
  enabled: boolean;
}): Promise<ActionError | { ok: true }> {
  const parsed = await parseInput(NetworkParticipationSchema, input);
  if (!parsed.ok) return parsed.error;

  const auth = await authorizeActiveTenant(["ceo"]);
  if (!auth.ok) return auth.error;

  const t = await refusals();

  const claim = await getSessionTenant();
  if (!claim) return { error: t("sessionExpired") };

  const { error } = await createAdminClient("platform")
    .from("tenants")
    .update({ network_opt_in: parsed.data.enabled })
    .eq("slug", claim.slug);

  if (error) {
    console.error("[network] participation write failed", error);
    return { error: looksUnmigrated(error.code, error.message) ? t("notMigrated") : t("saveFailed") };
  }

  revalidatePath("/[locale]/(app)/network", "page");
  return { ok: true };
}

