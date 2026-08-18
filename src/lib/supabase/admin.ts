import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS. Server-only, never import from
// a Client Component. Used for: creating staff/investor auth accounts,
// the public referral-link intake route (anon visitors need to insert a
// lead without ever holding elevated DB privileges themselves), and the
// control-plane reads in tenant.ts.
//
// SINCE 0011 THE SCHEMA MATTERS. Business data lives in t_<slug> and the
// registry lives in `platform`; neither is the default. Callers say which
// one they mean, and the default stays `public` so that a caller who has
// not thought about it gets the old behaviour rather than silently
// reading some showroom's tables.
export function createAdminClient(schema?: string) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — add it to .env.local from Supabase Dashboard > Project Settings > API."
    );
  }

  // This client bypasses RLS, so a schema name reaching it from anywhere
  // near user input would be the most dangerous string in the codebase.
  // Constrained to the two shapes 0008 and 0009 can produce.
  if (schema !== undefined && !/^(platform|t_[a-z0-9]+)$/.test(schema)) {
    throw new Error(`Refusing to build a service-role client for schema "${schema}"`);
  }

  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(schema ? { db: { schema } } : {}),
  });
}
