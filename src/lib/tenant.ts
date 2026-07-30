import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { FLAGSHIP_SLUG, slugFromHost } from "@/lib/tenant-host";

export { FLAGSHIP_SLUG, slugFromHost };

// Which showroom is this request for?
//
// FELIX is licensed per showroom. Each licensed showroom is reached at
// <slug>-felix.508.world, and the subdomain is how a visitor lands on
// theirs. This module is the only place that maps a hostname to a
// tenant.
//
// The subdomain is ROUTING, NOT AUTHORIZATION. It decides which
// showroom's login page to present and which name to show in the shell.
// It never decides which rows a request may read — that is
// current_tenant_id() in the database, which reads the authenticated
// user's own profile and cannot be influenced by the host, a header, or
// a URL. So a visitor who forges any of those gets, at most, a
// differently-branded login page for a showroom they still cannot enter.

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended";
};

/**
 * Resolves the tenant for the current request.
 *
 * Reads with the service-role client on purpose: an anonymous visitor
 * standing on a tenant's login page has no session yet, so RLS would
 * (correctly) hide every tenants row from them. Only the three
 * non-sensitive fields below are ever returned, and the slug being
 * looked up comes from the hostname the request already arrived on —
 * so this reveals nothing a visitor did not already supply.
 */
export const getTenant = cache(async (): Promise<Tenant | null> => {
  const h = await headers();

  // The 508.world Worker proxies <slug>-felix.508.world to this app and
  // strips Host in the process, so it forwards the slug explicitly.
  // Trusted only as a routing hint — see the note at the top of the file.
  const slug = h.get("x-felix-tenant")?.trim().toLowerCase() || slugFromHost(h.get("host"));
  if (!slug || !/^[a-z0-9]+$/.test(slug)) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("tenants")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  return (data as Tenant) ?? null;
});
