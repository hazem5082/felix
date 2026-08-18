import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  DEMO_ON,
  DEMO_STATUS_MODULE_KEY,
  demoKeyForEmail,
  parseDemoStatusRow,
  type DemoAccountKey,
  type DemoStatus,
} from "@/lib/demo-accounts";

// Demo mode — the server half.
//
// FELIX's shop window is the flagship showroom at demo-felix.508.world.
// It is a real tenant with a real schema (t_felix) full of seed data, and
// it is the only tenant any of this applies to. Two capabilities live
// here:
//
//   1. Passwordless persona switching, so a prospect can look at the
//      product through six different pairs of eyes without ever being
//      handed a password (see app/[locale]/demo/actions.ts).
//   2. A kill switch, so the demo can be taken down from a table without
//      a deploy — during a data reset, a migration, or an incident.
//
// Both are gated on isFlagshipDemo(). A licensed showroom takes exactly
// the code paths it took before this file existed.

export {
  DEMO_ACCOUNTS,
  DEMO_ACCOUNT_KEYS,
  DEMO_ON,
  DEMO_STATUS_MODULE_KEY,
  demoKeyForEmail,
  demoPersonas,
  isDemoAccountKey,
  isFlagshipDemo,
  parseDemoStatusRow,
  type DemoAccount,
  type DemoAccountKey,
  type DemoPersona,
  type DemoStatus,
} from "@/lib/demo-accounts";

/**
 * Is the flagship demo currently switched on, and if not, why?
 *
 * Memoized per request: the gate is checked in the layout, in page
 * guards, and in server actions, and there is no reason for one page view
 * to ask the database more than once.
 *
 * WHY THE SERVICE-ROLE CLIENT WITH NO SCHEMA ARGUMENT
 * ---------------------------------------------------
 * `demo_status` is a shared cross-product registry in `public` — the one
 * schema createAdminClient() targets when given no argument. It is not
 * `platform` (that is FELIX's own tenant registry) and it is emphatically
 * not `t_felix`. Service-role is needed because the most important reader
 * is an anonymous visitor standing on the login page with no session at
 * all, for whom RLS would correctly hide everything.
 *
 * WHY EVERY FAILURE MEANS "ON"
 * ----------------------------
 * The table is created by a migration owned by another repository. This
 * code can legitimately be running against a database where it does not
 * exist yet, and a missing migration must never be able to take the
 * product's shop window down. See parseDemoStatusRow for the full
 * reasoning; the catch here covers the cases that never produce a row at
 * all: no table (PGRST205 / 42P01), no service-role key, network fault.
 */
export const getDemoStatus = cache(async (): Promise<DemoStatus> => {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("demo_status")
      .select("enabled, off_message")
      .eq("module_key", DEMO_STATUS_MODULE_KEY)
      .maybeSingle();

    if (error) throw error;
    return parseDemoStatusRow(data);
  } catch (err) {
    // Loud but not fatal — the same posture as the rate limiter, and for
    // the same reason: the safe failure is the permissive one, but it has
    // to be visible in the logs or a real outage looks like normal
    // operation.
    console.warn("[demo] could not read public.demo_status — treating the demo as ON", err);
    return DEMO_ON;
  }
});

/**
 * Which demo persona the current session belongs to, or null.
 *
 * Cosmetic only — it decides which button in the switcher is highlighted.
 * Nothing is authorized on the strength of it, which is why matching on
 * the address is good enough.
 *
 * Callers must guard this with isFlagshipDemo() so a licensed showroom
 * never pays for the extra `auth.getUser()` round trip.
 */
export const currentDemoPersona = cache(async (): Promise<DemoAccountKey | null> => {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return demoKeyForEmail(user?.email);
  } catch {
    // A session with no tenant claim throws out of createClient(). The
    // shell's own guards deal with that; here it just means "no persona".
    return null;
  }
});
