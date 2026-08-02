import "server-only";

/**
 * A temporary credential the recipient is expected to change on first
 * sign-in. Web Crypto CSPRNG — `Math.random()` is not acceptable for a
 * credential even a single-use one, and `crypto` is global on both Node
 * and the Workers runtime.
 *
 * The alphabet omits 0/O/1/l/I so a password read aloud or copied off a
 * screen can't be mistyped. The fixed "!7" suffix satisfies any
 * digit+symbol complexity rule without weakening the 20 random
 * characters that carry the entropy (~116 bits).
 */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("") + "!7";
}
