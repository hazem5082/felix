/**
 * Geofence arithmetic for attendance (migration 0038).
 *
 * THIS MODULE DOES NOT DECIDE ANYTHING.
 *
 * The verdict that gets stored — `attendance_events.distance_m` and
 * `.within_geofence` — is computed by `stamp_attendance_geofence()`
 * inside Postgres, on every insert, from `branches`' own pin, and it
 * discards whatever the client sent for those two columns before it
 * looks at anything else. That is deliberate and it is the whole
 * security property of the feature: a browser's `navigator.geolocation`
 * can be monkey-patched from a console, so coordinates are a claim, and
 * a claim must never be allowed to carry its own verdict.
 *
 * What this module is for is the PREVIEW. The punch screen wants to say
 * "you're 40 m from the showroom" before the punch is taken, and the
 * report wants to render a distance it was given. Both are display, and
 * both must agree with the database or the UI will contradict the
 * record it just wrote — so the formula below is a line-for-line mirror
 * of the SQL, including the accuracy clamp. If one changes, change both.
 */

/** Metres. Mirrors the constant in stamp_attendance_geofence(). */
const EARTH_RADIUS_M = 6_371_000;

/**
 * The most GPS slack a punch can ever be given, in metres — mirrors
 * `least(coalesce(new.accuracy_m, 0), 100)` in the trigger.
 *
 * Without the clamp, a client reporting `accuracy_m: 999999` would buy
 * itself a thousand-kilometre fence and the feature would be decorative.
 */
export const MAX_ACCURACY_SLACK_M = 100;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface Geofence extends Coordinates {
  radiusM: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres, rounded to the nearest metre.
 *
 * Haversine on a spherical earth, as the trigger uses. The error
 * against a proper geodesic is a few metres in a thousand kilometres,
 * which is irrelevant at a fence measured in tens of metres.
 */
export function distanceMetres(a: Coordinates, b: Coordinates): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(h)));
}

/**
 * `null` means NOT ASSESSED, and it is a third answer rather than a
 * missing one: a branch nobody has placed on the map must not read as a
 * branch everybody is absent from. Same three-valued logic as the
 * `within_geofence` column.
 */
export function isWithinGeofence(
  fence: Geofence | null,
  at: Coordinates | null,
  accuracyM: number | null = null
): boolean | null {
  if (!fence || !at) return null;
  if (!Number.isFinite(fence.latitude) || !Number.isFinite(fence.longitude)) return null;
  const slack = Math.min(Math.max(accuracyM ?? 0, 0), MAX_ACCURACY_SLACK_M);
  return distanceMetres(fence, at) <= fence.radiusM + slack;
}

/**
 * Build a fence from a `branches` row, or null when it has never been
 * pinned. Both coordinates must be present — a branch with a latitude
 * and no longitude is half-entered, not half-fenced.
 */
export function geofenceFromBranch(branch: {
  latitude: number | string | null;
  longitude: number | string | null;
  geofence_radius_m: number | string | null;
}): Geofence | null {
  const lat = Number(branch.latitude);
  const lng = Number(branch.longitude);
  if (branch.latitude === null || branch.longitude === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = Number(branch.geofence_radius_m);
  return {
    latitude: lat,
    longitude: lng,
    radiusM: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_RADIUS_M,
  };
}

/** Mirrors the column default in migration 0038. */
export const DEFAULT_RADIUS_M = 150;
/** The CHECK constraint's bounds, restated so the form can enforce them. */
export const MIN_RADIUS_M = 25;
export const MAX_RADIUS_M = 5000;

/** Human distance: metres under a kilometre, then one decimal place. */
export function formatDistance(metres: number | string | null): string {
  const m = Number(metres);
  if (metres === null || !Number.isFinite(m)) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Latitude/longitude typed into a form, or pasted out of Google Maps.
 * Returns null rather than NaN for anything unusable, so a bad paste
 * clears the pin instead of placing it off the coast of Africa at 0,0.
 */
export function parseCoordinate(raw: string, kind: "lat" | "lng"): number | null {
  const trimmed = String(raw).trim();
  // `Number("")` is 0, not NaN — so without this an empty field would
  // silently place the showroom's pin in the Atlantic at 0°,0° and
  // every punch would read as 4,000 km outside the fence.
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const limit = kind === "lat" ? 90 : 180;
  return Math.abs(n) <= limit ? n : null;
}

/**
 * A "1234 Showroom" style Google Maps link for a pin, so a manager can
 * check on a full map that they have placed the fence on the building
 * and not on the roundabout outside it.
 */
export function googleMapsLink(at: Coordinates): string {
  return `https://www.google.com/maps/search/?api=1&query=${at.latitude},${at.longitude}`;
}
