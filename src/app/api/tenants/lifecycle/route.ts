import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateWebhook } from "@/lib/webhook-auth";

// Tenant lifecycle for the partners portal: list, deactivate (suspend),
// reactivate (resume), and delete showrooms.
//
// Called by the 508.world Worker's /api/partners/tenants routes after an
// admin acts on the portal's Tenants tab — the same trust shape as
// /api/provision: nothing here is reachable with a user session, only by
// a caller holding PROVISION_SECRET (lifecycle IS a licensing action, so
// it shares provisioning's secret rather than minting a fourth one).
//
// The database functions carry the real guards (0060): the flagship demo
// can be neither suspended nor deleted, and delete refuses any tenant
// that is not already suspended — so the destructive click is always the
// second of two clicks, with a working undo between them.

export const dynamic = "force-dynamic";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.enum(["suspend", "resume", "delete"]),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9]+$/, "Slug must be lowercase letters and digits only"),
  }),
]);

function bad(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  const verified = await authenticateWebhook(request, "PROVISION_SECRET", "tenants-lifecycle");
  if (!verified.ok) {
    return bad(verified.error, verified.status);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(verified.body);
  } catch {
    return bad("Malformed request body", 400);
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return bad(parsed.error.issues[0]?.message ?? "Invalid lifecycle request", 400);
  }

  const admin = createAdminClient("platform");

  if (parsed.data.action === "list") {
    const { data, error } = await admin
      .from("tenants")
      .select("slug, name, status, licensed_via, created_at")
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[tenants-lifecycle] list failed", { error: error.message });
      return bad(`Could not list tenants: ${error.message}`, 500);
    }
    return NextResponse.json({
      ok: true,
      tenants: (data ?? []).map((t) => ({
        ...t,
        login_url:
          t.slug === "felix"
            ? "https://demo-felix.508.world/en/login"
            : `https://${t.slug}-felix.508.world/en/login`,
      })),
    });
  }

  const { action, slug } = parsed.data;

  // Belt and braces above the SQL guard: the flagship is refused here
  // too, so a bug in a future migration cannot quietly widen the API.
  if (slug === "felix") {
    return bad("The flagship demo cannot be modified through the lifecycle API", 403);
  }

  if (action === "suspend" || action === "resume") {
    const fn = action === "suspend" ? "suspend_tenant" : "resume_tenant";
    const { data, error } = await admin.rpc(fn, { p_slug: slug });
    if (error) {
      console.error(`[tenants-lifecycle] ${fn} failed`, { slug, error: error.message });
      const status = /TENANT_NOT_FOUND/.test(error.message) ? 404 : 500;
      return bad(error.message, status);
    }
    return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
  }

  // action === "delete" — two phases, auth accounts first.
  //
  // delete_tenant() deliberately does not touch auth.users (GoTrue's
  // tables, shared with A-Star and Calendar), so this route removes the
  // accounts properly through the admin API — but ONLY the ones whose
  // sole tenant membership is the showroom being deleted. An account
  // that also belongs to another showroom keeps its identity; only its
  // membership row goes (inside delete_tenant).
  const { data: tenantRow, error: tenantError } = await admin
    .from("tenants")
    .select("id, slug, status")
    .eq("slug", slug)
    .maybeSingle();
  if (tenantError) {
    return bad(`Could not read tenant: ${tenantError.message}`, 500);
  }
  if (!tenantRow) {
    return bad(`No tenant with slug "${slug}"`, 404);
  }
  if (tenantRow.status !== "suspended") {
    // Same rule the SQL enforces, surfaced before any account deletion
    // can happen: accounts must never be removed for a tenant whose
    // delete would then be refused.
    return bad("Deactivate the tenant first — deletion is only offered to suspended tenants", 409);
  }

  const { data: memberships, error: memberError } = await admin
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenantRow.id);
  if (memberError) {
    return bad(`Could not read tenant memberships: ${memberError.message}`, 500);
  }

  const userIds = (memberships ?? []).map((m) => m.user_id as string);
  let authDeleted = 0;
  let authKept = 0;
  for (const userId of userIds) {
    const { count, error: otherError } = await admin
      .from("tenant_users")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .neq("tenant_id", tenantRow.id);
    if (otherError || (count ?? 0) > 0) {
      // Errs on the side of keeping the account: an orphaned auth user
      // can sign into nothing (no membership, no tenant claim), while a
      // wrongly deleted one is somebody's login on another showroom.
      authKept += 1;
      continue;
    }
    const { error: delError } = await admin.auth.admin.deleteUser(userId);
    if (delError) {
      console.error("[tenants-lifecycle] auth user deletion failed", {
        slug,
        userId,
        error: delError.message,
      });
      authKept += 1;
    } else {
      authDeleted += 1;
    }
  }

  const { data: deleted, error: deleteError } = await admin.rpc("delete_tenant", {
    p_slug: slug,
  });
  if (deleteError) {
    console.error("[tenants-lifecycle] delete_tenant failed", { slug, error: deleteError.message });
    return bad(deleteError.message, 500);
  }

  console.log("[tenants-lifecycle] deleted showroom", { slug, authDeleted, authKept });

  return NextResponse.json({
    ok: true,
    ...(deleted as Record<string, unknown>),
    auth_users_deleted: authDeleted,
    auth_users_kept: authKept,
  });
}
