/**
 * The FELIX mail domain, and the one question worth asking about an
 * address string: is it somebody's FELIX address?
 *
 * Deliberately NOT in mail-send.ts. That module is `server-only`, and
 * the compose form needs this same rule to name the mistake before a
 * round trip — two copies of the literal is exactly how the client and
 * the server drift apart on a security boundary. One module, no
 * `server-only`, imported by both.
 */

/**
 * Every FELIX address in every showroom lives here:
 * firstname.lastname.<tenant>@felixmail.508.world (migration 0039).
 */
export const FELIX_MAIL_DOMAIN = "felixmail.508.world";

/**
 * True for an address belonging to SOME FELIX showroom — not necessarily
 * the caller's own.
 *
 * That distinction is the whole point. A caller's colleague is reachable
 * by profile id through the compose picker, resolved against the
 * caller's own tenant schema, and never reaches the outbound path at
 * all. So a FELIX address arriving as free-text "outside FELIX" input is
 * either a colleague typed out by hand instead of picked, or a stranger
 * at another showroom — and since sending it would hand the message to
 * Resend and let the inbound webhook file it under a different tenant,
 * callers refuse it rather than guess which one it was.
 */
export function isFelixMailAddress(address: string): boolean {
  return address.trim().toLowerCase().endsWith(`@${FELIX_MAIL_DOMAIN}`);
}
