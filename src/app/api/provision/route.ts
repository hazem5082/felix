import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

// Provisions a licensed FELIX showroom.
//
// Called by the 508.world Worker's POST /api/partners/approve, after an
// admin approves a licence request on partners.508.world. That is the
// only supported way a tenant comes into existence — nothing here is
// reachable by a showroom's own users, and there is no self-signup path.
//
// The endpoint owns provisioning for FELIX specifically, rather than the
// Worker reaching into FELIX's schema itself. The Worker holds the
// service-role key for the shared platform project and *could* do the
// work directly, but then every future module's provisioning logic would
// accumulate inside one router. Each product exposing its own
// /api/provision keeps that logic with the product it belongs to.

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // Becomes <slug>-felix.508.world, and must satisfy the same check
  // constraint as tenants.slug. Lowercase alphanumeric only, so the
  // hostname can always be split back into slug + product
  // unambiguously.
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+$/, "Slug must be lowercase letters and digits only"),
  name: z.string().trim().min(1).max(120),
  ceo_email: z.string().trim().toLowerCase().email(),
  ceo_full_name: z.string().trim().min(1).max(120),
  first_branch_name: z.string().trim().min(1).max(120).default("Main Showroom"),
  licensed_via: z.string().trim().max(120).optional(),
});

// Slugs that would shadow the product's own hostnames rather than
// namespace a client under them.
const RESERVED_SLUGS = new Set([
  "felix", "www", "api", "admin", "app", "partners", "dev", "saas",
  "man", "empi", "mail", "static", "assets", "cdn", "status",
]);

function bad(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/**
 * A password the CEO is expected to change on first sign-in. Generated
 * with the Web Crypto CSPRNG — `Math.random()` is not acceptable for a
 * credential, even a temporary one, and this runs on the Workers
 * runtime where `crypto` is global.
 */
function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  // Rejection-free mapping is unnecessary here: the alphabet length
  // divides evenly enough that modulo bias across 56 symbols is
  // negligible for a 20-character single-use password.
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("") + "!7";
}

export async function POST(request: Request) {
  // Shared-secret auth. This endpoint creates accounts and tenants, so
  // it is deliberately not reachable with a user session at all — only
  // by a caller holding the secret, which lives as a Worker secret on
  // the 508.world side and an env var here.
  const expected = process.env.PROVISION_SECRET;
  if (!expected) {
    console.error("[provision] PROVISION_SECRET is not configured");
    return bad("Provisioning is not configured", 503);
  }

  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Length-independent compare would be better, but the secret is
  // high-entropy and this is a single non-enumerable endpoint; a
  // constant-time compare across a network boundary buys nothing here.
  if (!presented || presented !== expected) {
    return bad("Forbidden", 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return bad("Malformed request body", 400);
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return bad(parsed.error.issues[0]?.message ?? "Invalid provisioning request", 400);
  }

  const { slug, name, ceo_email, ceo_full_name, first_branch_name, licensed_via } = parsed.data;

  if (RESERVED_SLUGS.has(slug)) {
    return bad(`"${slug}" is a reserved subdomain`, 409);
  }

  // provision_tenant lives in the `platform` schema since 0010, and it
  // now creates the showroom's SCHEMA and ROLE as well as its rows.
  // Service-role only: provisioning is a licensing action.
  const admin = createAdminClient("platform");

  // Step 1 — tenant, schema, role, baseline rows, and the CEO's
  // invitation. Idempotent on slug, so a retried approval after a network
  // timeout converges instead of erroring or creating a second showroom.
  const { data: provisioned, error: provisionError } = await admin.rpc("provision_tenant", {
    p_slug: slug,
    p_name: name,
    p_ceo_email: ceo_email,
    p_ceo_full_name: ceo_full_name,
    p_first_branch_name: first_branch_name,
    p_licensed_via: licensed_via ?? "508.world",
  });

  if (provisionError) {
    console.error("[provision] provision_tenant failed", { slug, error: provisionError.message });
    return bad(`Could not create tenant: ${provisionError.message}`, 500);
  }

  const result = provisioned as {
    tenant: { id: string; slug: string; name: string; status: string };
    branch_id: string;
  };

  // Step 1b — expose the new schema to PostgREST. provision_tenant()
  // deliberately does not call this itself (0010: "so a rolled-back
  // provision never announces a schema that does not exist"), which
  // means the caller must — and until this line existed, nothing did.
  // Every showroom provisioned through this route had a schema and role
  // but was unreachable via the API until someone ran
  // platform.sync_postgrest_schemas() by hand. Failure here does not fail
  // provisioning: the tenant and CEO account are already real, and the
  // next provision/suspend/resume anywhere will self-heal the exposed
  // list anyway.
  const { error: syncError } = await admin.rpc("sync_postgrest_schemas");
  if (syncError) {
    console.error("[provision] sync_postgrest_schemas failed after provisioning", {
      slug,
      error: syncError.message,
    });
  }

  // Step 2 — the CEO's auth account. Created *after* the invitation row
  // exists, because handle_new_user() reads that row to decide the new
  // profile's role and tenant. Reversing these two would silently
  // produce a tenant-less sales_exec who can see nothing.
  const temp = temporaryPassword();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: ceo_email,
    password: temp,
    email_confirm: true,
    user_metadata: { full_name: ceo_full_name },
  });

  let temporaryPasswordToReturn: string | null = temp;

  if (createError) {
    // Re-approving an already-provisioned showroom is a normal retry, so
    // an existing account is not an error — but we must not hand back a
    // password that was never set on it.
    const alreadyExists =
      createError.status === 422 || /already (been )?registered|already exists/i.test(createError.message);

    if (!alreadyExists) {
      console.error("[provision] CEO account creation failed", {
        slug,
        error: createError.message,
      });
      return bad(`Tenant created, but the CEO account failed: ${createError.message}`, 500);
    }
    temporaryPasswordToReturn = null;
  }

  const loginUrl = `https://${slug}-felix.508.world/en/login`;

  console.log("[provision] provisioned showroom", {
    slug,
    tenantId: result.tenant.id,
    ceoCreated: Boolean(created?.user),
  });

  return NextResponse.json({
    ok: true,
    tenant: {
      id: result.tenant.id,
      slug: result.tenant.slug,
      name: result.tenant.name,
      status: result.tenant.status,
      login_url: loginUrl,
    },
    ceo: {
      email: ceo_email,
      // Null when the account already existed — the CEO keeps whatever
      // password they already have, and the admin UI says so rather
      // than showing a credential that would not work.
      temporary_password: temporaryPasswordToReturn,
    },
  });
}
