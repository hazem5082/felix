// Hostname -> showroom slug. Pure and dependency-free, kept apart from
// `./tenant` so it can be unit-tested without pulling in `server-only`
// or next/headers. Every request's tenant is decided here, so the edge
// cases are covered in tenant-host.test.ts rather than left to
// inspection.

// The showroom that owns the original demo data, reached at
// demo-felix.508.world. The bare felix.508.world now serves the static
// FELIX product page from the marketing site, not this app.
export const FLAGSHIP_SLUG = "felix";

/**
 * Extracts the client slug from a hostname.
 *
 *   clientb-felix.508.world -> "clientb"
 *   demo-felix.508.world    -> "felix"   (the flagship demo)
 *   felix.508.world         -> "felix"   (harmless legacy — see below)
 *   localhost:3000          -> "felix"   (dev convenience)
 *   clientb.localhost:3000  -> "clientb" (dev: exercise a real tenant)
 *
 * Topology: felix.508.world is the FELIX product-showroom page, served
 * statically by the 508.world Worker out of the marketing site's export —
 * that Worker no longer proxies it here. The flagship demo app answers at
 * demo-felix.508.world, licensed clients at <slug>-felix.508.world. The
 * `demo-felix` label must be recognised BEFORE the generic `<slug>-felix`
 * extraction, which would otherwise read it as tenant "demo" — a showroom
 * that does not exist — and 404. The bare `felix` label keeps resolving to
 * the flagship: no app traffic arrives for it anymore, and refusing it
 * would only break direct workers.dev-style smoke visits.
 *
 * An unrecognised hostname returns null, NOT the flagship. A typo'd or
 * unmapped subdomain used to fall through to `felix` — which is a real
 * showroom holding real data — so any wrong hostname served a genuine
 * tenant's login page. `getTenant()` turns null into "no showroom",
 * which the app answers with a 404. Deployment URLs and localhost are
 * the two deliberate exceptions below.
 *
 * Why `<slug>-felix` and not `<slug>.felix`
 * -----------------------------------------
 * A TLS wildcard matches exactly one label, and Cloudflare's Universal SSL
 * issues only `508.world` and `*.508.world`. So `clientb.felix.508.world`
 * is not covered by any certificate on the zone and fails the handshake
 * outright (alert 40) — it cannot be fixed in DNS or in the Worker, only by
 * buying Advanced Certificate Manager. Flattening to `clientb-felix` keeps
 * every showroom one label deep, inside the existing wildcard, at no cost.
 *
 * This also matches the convention the 508.world vault settled on for every
 * other product: `<module>-<client>.508.world`.
 */
export function slugFromHost(host: string | null): string | null {
  if (!host) return null;

  const hostname = host.split(":")[0].toLowerCase().replace(/\.$/, "");
  if (!hostname) return null;

  if (hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1") {
    return FLAGSHIP_SLUG;
  }

  const labels = hostname.split(".");

  // Local development. `clientb.localhost` resolves in browsers with no
  // hosts-file entry, which is what makes offline multi-tenant testing
  // possible. Kept dot-separated because there is no certificate involved.
  if (labels[labels.length - 1] === "localhost") {
    return labels.length > 1 ? labels[0] : FLAGSHIP_SLUG;
  }

  // The deploy URL has no tenant in it and is used for smoke-testing the
  // Worker directly, so it keeps resolving to the flagship.
  if (hostname.endsWith(".workers.dev")) return FLAGSHIP_SLUG;

  // Only the leftmost label is considered, so a deeper hostname cannot
  // smuggle a different tenant in ahead of the real one.
  const first = labels[0];

  if (first === FLAGSHIP_SLUG) return FLAGSHIP_SLUG;

  // The flagship demo's own host. Checked before the generic suffix match
  // below, which would extract "demo" — not a showroom that exists.
  if (first === "demo-felix") return FLAGSHIP_SLUG;

  const suffixed = first.match(/^([a-z0-9]+)-felix$/);
  if (suffixed) return suffixed[1];

  // Anything else is not a showroom we serve.
  return null;
}
