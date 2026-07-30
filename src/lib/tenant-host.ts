// Hostname -> showroom slug. Pure and dependency-free, kept apart from
// `./tenant` so it can be unit-tested without pulling in `server-only`
// or next/headers. Every request's tenant is decided here, so the edge
// cases are covered in tenant-host.test.ts rather than left to
// inspection.

// The showroom that owns the original demo data, reached at the bare
// felix.508.world with no client subdomain in front of it.
export const FLAGSHIP_SLUG = "felix";

/**
 * Extracts the client slug from a hostname.
 *
 *   clientb-felix.508.world -> "clientb"
 *   felix.508.world         -> "felix"   (the flagship itself)
 *   localhost:3000          -> "felix"   (dev convenience)
 *   clientb.localhost:3000  -> "clientb" (dev: exercise a real tenant)
 *
 * Falls back to the flagship for hosts with no tenant in them (the
 * *.workers.dev deployment URL, previews) so a direct visit still
 * renders instead of erroring.
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

  // Only the leftmost label is considered, so a deeper hostname cannot
  // smuggle a different tenant in ahead of the real one.
  const first = labels[0];

  if (first === FLAGSHIP_SLUG) return FLAGSHIP_SLUG;

  const suffixed = first.match(/^([a-z0-9]+)-felix$/);
  if (suffixed) return suffixed[1];

  return FLAGSHIP_SLUG;
}
