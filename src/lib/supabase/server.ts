import "server-only";
import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { tenantClaimFromToken } from "@/lib/tenant-claim";

// Use inside Server Components, Server Actions, and Route Handlers.
//
// EVERY QUERY IN THIS APP GOES THROUGH HERE, and since migration 0011
// the business tables no longer live in `public` — each showroom has its
// own schema, t_<slug>. This function is the single place that decides
// which one a request talks to, which is why none of the ~98 call sites
// had to change: `db: { schema }` makes supabase-js send the right
// Accept-Profile/Content-Profile header on every .from() and .rpc().
//
// The schema comes from the session's own access token, not from the
// hostname. The hostname is attacker-supplied routing (see tenant.ts);
// the token is issued by GoTrue from the user's membership row. Where
// they disagree, the token is right — and the licence gate in auth.ts is
// what notices the disagreement and refuses.
//
// Authorization is still the database's job. This picks a schema; the
// `role` claim decides what may be read, PostgREST verifies it, and the
// GRANTs from 0009 §6 enforce it. A session that somehow asked for
// another showroom's schema would be refused by Postgres, not by this
// file.
//
// Not parameterized with a generated Database type (no CLI access to
// generate one against the live project) — reads are cast to the
// interfaces in ./types at each call site instead.

/**
 * Thrown when an authenticated session carries no tenant claim.
 *
 * This is deliberately fatal rather than a fallback to `public`. Before
 * 0011, `public` held the flagship's real data; falling back would mean
 * one misconfigured session reading a showroom it does not belong to,
 * which is the exact failure the schema split exists to make impossible.
 * The likeliest cause is that the access token hook is not registered in
 * Supabase (Authentication > Hooks), in which case NO session has the
 * claim and this fails loudly on the first request rather than serving
 * the wrong rows quietly.
 */
export class MissingTenantClaimError extends Error {
  constructor() {
    super(
      "This session carries no showroom claim. If this is happening for every user, the custom access token hook is probably not registered in Supabase (Authentication > Hooks -> platform.custom_access_token_hook)."
    );
    this.name = "MissingTenantClaimError";
  }
}

/**
 * Memoized per request. Previously each call built a fresh client; now
 * that building one involves reading the session, doing it once per
 * request matters.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  const cookieAdapter = {
    getAll() {
      return cookieStore.getAll();
    },
    setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
      try {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)
        );
      } catch {
        // Called from a Server Component — session refresh is handled
        // by proxy.ts instead, so this can be safely ignored.
      }
    },
  };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Built without a schema first, purely to read the session. getSession()
  // is local — it decodes what is already in the cookie rather than
  // calling the Auth server — so this costs no round trip.
  const anonymous = createServerClient(url, key, { cookies: cookieAdapter });

  const {
    data: { session },
  } = await anonymous.auth.getSession();

  // No session at all is a legitimate state: the login page, the public
  // referral intake, anything before sign-in. Those paths use auth
  // methods or the service-role client, never a tenant table, so the
  // default schema is correct for them.
  if (!session) return anonymous;

  const claim = tenantClaimFromToken(session.access_token);
  if (!claim) throw new MissingTenantClaimError();

  return createServerClient(url, key, {
    cookies: cookieAdapter,
    db: { schema: claim.schema },
  });
});

/**
 * The schema `createClient()` would pin itself to, for the rare caller
 * that has to NAME the tenant rather than just query through it.
 *
 * Exists for the service-role writes that are about a message rather
 * than by its sender — see sendMail's delivery bookkeeping. Same source
 * of truth as createClient (the session's own claim, never the
 * hostname), and the same local decode, so it costs no round trip.
 */
export const currentTenantSchema = cache(async (): Promise<string | null> => {
  const cookieStore = await cookies();

  const anonymous = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // Read-only: refreshing the session is proxy.ts's job, and this
        // is only ever called from a request that already has one.
        setAll() {},
      },
    }
  );

  const {
    data: { session },
  } = await anonymous.auth.getSession();
  if (!session) return null;

  return tenantClaimFromToken(session.access_token)?.schema ?? null;
});

/**
 * A client pinned to an explicitly-named schema, bypassing the memoized
 * session lookup above.
 *
 * Exists for exactly one situation: the sign-in action. `createClient()`
 * is necessarily built before the session exists, so it carries no schema
 * — and because it is memoized per request, calling it again after
 * signInWithPassword() returns the same schema-less client. Any query
 * made with it would hit `public`, which until the post-0011 cleanup
 * still holds the flagship's real rows. Reading the wrong showroom's data
 * on the login path is not a mistake worth risking on a cache detail.
 *
 * The schema must come from the freshly-issued token's own claim, never
 * from the hostname.
 */
export async function createClientForSchema(schema: string) {
  if (!/^t_[a-z0-9]+$/.test(schema)) {
    throw new Error(`Refusing to build a client for schema "${schema}"`);
  }

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component context; proxy.ts owns refresh.
          }
        },
      },
      db: { schema },
    }
  );
}

/** The showroom this request's session belongs to, or null if signed out. */
export const getSessionTenant = cache(async () => {
  const cookieStore = await cookies();
  const anonymous = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Read-only probe; refresh is proxy.ts's job.
        },
      },
    }
  );

  const {
    data: { session },
  } = await anonymous.auth.getSession();

  return tenantClaimFromToken(session?.access_token);
});
