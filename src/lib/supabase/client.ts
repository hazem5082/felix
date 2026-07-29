import { createBrowserClient } from "@supabase/ssr";

// Not parameterized with a generated Database type (no CLI access to
// generate one against the live project) — reads are cast to the
// interfaces in ./types at each call site instead.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
