import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Liveness + dependency check for uptime monitoring and deploy gates.
// Deliberately unauthenticated but deliberately uninformative: it reports
// whether the process can reach its dependencies, never why it cannot.

export const dynamic = "force-dynamic";

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PUBLIC_URL",
] as const;

export async function GET() {
  const startedAt = Date.now();
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

  let database: "ok" | "degraded" | "unreachable" = "unreachable";
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    // branches is readable by any authenticated role and tiny; head-only so
    // this stays cheap enough to poll every 30s.
    const { error } = await supabase.from("branches").select("id", { head: true, count: "exact" });
    database = error ? "degraded" : "ok";
  } catch {
    database = "unreachable";
  }

  const healthy = database !== "unreachable" && missingEnv.length === 0;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "unhealthy",
      checks: {
        database,
        configuration: missingEnv.length === 0 ? "ok" : "incomplete",
        // Names only — never values.
        missingEnv: missingEnv.length ? missingEnv : undefined,
      },
      latencyMs: Date.now() - startedAt,
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
