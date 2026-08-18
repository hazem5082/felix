// Reads the tenant out of an access token. Pure and dependency-free so
// it can be unit-tested without `server-only` or next/headers, the same
// reason tenant-host.ts is kept separate.

export type TenantClaim = {
  slug: string;
  schema: string;
};

/**
 * Extracts the `felix_tenant` claim that migration 0010's access token
 * hook attaches at login.
 *
 * WHY IT IS SAFE TO READ THIS WITHOUT VERIFYING THE SIGNATURE
 * -----------------------------------------------------------
 * This value chooses which Postgres schema the request ASKS for. It does
 * not decide what the request may read — that is the `role` claim, which
 * PostgREST verifies against the JWT secret before it will SET ROLE.
 *
 * So a forged token gets rejected at the database boundary regardless of
 * what this function returns. The worst a tampered `felix_tenant` can
 * achieve is naming a schema the session's real role has no privilege on,
 * which fails with `permission denied for schema ...`. It cannot widen
 * access, because the two claims are checked by different parties and the
 * one that grants privilege is the one that is verified.
 *
 * Verifying here anyway would mean either shipping the JWT secret into
 * the app (worse) or an extra network round trip per request (slower, and
 * it buys nothing given the above).
 */
export function tenantClaimFromToken(token: string | null | undefined): TenantClaim | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let payload: unknown;
  try {
    // base64url, and Buffer tolerates the missing padding that JWTs omit.
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  const claim = (payload as Record<string, unknown>).felix_tenant;
  if (typeof claim !== "object" || claim === null) return null;

  const { slug, schema } = claim as Record<string, unknown>;
  if (typeof slug !== "string" || typeof schema !== "string") return null;

  // The schema name is interpolated into a PostgREST Accept-Profile
  // header. Constrained to the shape migration 0008 guarantees rather
  // than trusted, so a malformed token cannot put arbitrary text into a
  // header we send.
  if (!/^t_[a-z0-9]+$/.test(schema)) return null;
  if (!/^[a-z0-9]+$/.test(slug)) return null;

  return { slug, schema };
}
