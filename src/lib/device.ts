/**
 * Device identity for attendance (migration 0038).
 *
 * WHAT A BROWSER CAN AND CANNOT KNOW ABOUT A PHONE
 *
 * It cannot read a hardware identifier. There is no IMEI, no serial, no
 * MAC address, and no stable vendor id available to a web page — every
 * such API was removed from the platform years ago precisely because it
 * enabled silent tracking. Anyone who tells a showroom owner that a web
 * app can "lock the account to the phone" the way an MDM agent can is
 * selling something.
 *
 * So this binds to a SECRET THE APP PLANTS, not to a fact it discovers:
 * a 256-bit random value generated once, stored on the phone, and
 * presented on every punch. The server stores only its SHA-256, so a
 * leaked database row cannot be replayed as a device.
 *
 * That makes it a bearer token, and the honest way to describe the
 * property it gives you is: **copying the device requires deliberate
 * effort**. Someone who hands their unlocked phone to a colleague has
 * handed over their attendance, exactly as they would have handed over
 * a physical clock-in card. What it does stop is the ordinary cheat —
 * punching in from home, or a colleague punching you in from their own
 * phone — because the secret is not on their phone, and enrolling it
 * there costs an emailed code that lands in YOUR inbox.
 *
 * THE USER AGENT IS A LABEL, NEVER PART OF THE HASH
 * "iPhone · iOS 17" exists so a person can recognise their own phone in
 * a list and revoke the right one. Hashing it would silently unenrol
 * every phone in the company on the afternoon Chrome updates.
 */

/** localStorage key. Versioned so the shape can change without clashing. */
export const DEVICE_SECRET_KEY = "felix.device.v1";

/**
 * Mirrors the cookie the punch action sets. The secret lives in BOTH
 * localStorage and an httpOnly-free cookie on purpose: localStorage
 * survives the cookie being cleared by a privacy sweep, and the cookie
 * survives the origin's storage being evicted under pressure, which iOS
 * Safari does aggressively to sites the user has not opened in a week.
 * Either one alone loses phones for reasons the user cannot see.
 */
export const DEVICE_COOKIE = "felix_device";

/** 30 weeks. Long enough that a normal employee never re-enrols. */
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 210;

/**
 * A fresh device secret: 32 random bytes, base64url. `crypto` is the
 * Web Crypto global, which exists in the browser, in Node 18+ and on
 * Cloudflare Workers alike — no import, and no node:crypto, which the
 * Workers runtime would need a compatibility flag for.
 */
export function newDeviceSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * SHA-256 hex. Async because `crypto.subtle` is, everywhere.
 *
 * No salt and no stretching, deliberately: the input is 256 bits of
 * uniform randomness, so there is no dictionary to attack and a slow
 * KDF would only cost latency on the hot path of every punch. That
 * reasoning does NOT carry over to the six-digit email codes, which are
 * a tiny input space — see the note in `hashVerificationCode`.
 */
export async function hashDeviceSecret(secret: string): Promise<string> {
  return sha256Hex(secret);
}

/**
 * The emailed code, hashed for storage.
 *
 * Six digits is a million possibilities, which a hash does not hide
 * from anyone who can read it — that is exactly why migration 0038
 * gives `device_verifications` no policies at all, so no tenant session
 * can read the column in the first place. The hash defends against a
 * leaked backup, not against the showroom's own staff; the row's short
 * expiry and its attempt counter are what defend against guessing.
 */
export async function hashVerificationCode(profileId: string, code: string): Promise<string> {
  // Bound to the profile so a code minted for one person cannot be
  // replayed against another's pending row even if both were captured.
  return sha256Hex(`${profileId}:${code}`);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A six-digit code, uniformly distributed.
 *
 * `Math.random()` is not used: it is not a CSPRNG, and on a hot server
 * two requests in the same millisecond can correlate. Rejection
 * sampling rather than `% 1_000_000` because the modulo of a uint32
 * makes the low codes very slightly likelier, and "very slightly" is
 * not a property worth defending in a security control.
 */
export function newVerificationCode(): string {
  const limit = 1_000_000;
  const max = Math.floor(0xffffffff / limit) * limit;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= max);
  return String(n % limit).padStart(6, "0");
}

/**
 * Constant-time string comparison.
 *
 * The codes are compared as hex digests of equal length, so an early
 * return on the first differing character leaks how much of a guess was
 * right. That is a small leak against a six-digit code with an attempt
 * limit, and it costs one loop to not have it.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface DeviceDescription {
  label: string;
  platform: string;
}

/**
 * A human name for a phone, from its user agent.
 *
 * Best-effort and deliberately coarse. The only job is "which of these
 * three rows is the phone in my hand" — precision beyond that would be
 * fingerprinting, and the string is attacker-controlled anyway (it is
 * rendered as text, never as markup, and is capped here).
 */
export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const ua = (userAgent ?? "").slice(0, 400);

  const platform = /iPhone|iPad|iPod/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
      ? "Android"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown";

  const browser = /EdgA?\//i.test(ua)
    ? "Edge"
    : /OPR\//i.test(ua)
      ? "Opera"
      : /SamsungBrowser\//i.test(ua)
        ? "Samsung Internet"
        : /Firefox\//i.test(ua)
          ? "Firefox"
          : /Chrome\//i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : "Browser";

  const device = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? // "SM-G991B Build/..." — the model, when the UA volunteers one.
          (ua.match(/;\s*([A-Za-z0-9_+ -]{2,30})\s+Build\//)?.[1]?.trim() ?? "Android phone")
        : platform;

  return { label: `${device} · ${browser}`.slice(0, 80), platform };
}

/** How long an emailed code is good for. Short on purpose. */
export const CODE_TTL_MINUTES = 10;
/** Wrong guesses before the pending row is burned and a new code needed. */
export const MAX_CODE_ATTEMPTS = 5;
