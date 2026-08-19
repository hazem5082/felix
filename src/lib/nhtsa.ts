"use client";

// NHTSA vPIC vehicle API — free, no key required, CORS-enabled.
// `https://vpic.nhtsa.dot.gov` is allow-listed in `connect-src` (next.config.ts);
// drop that entry and every lookup here silently falls back.
//
// We deliberately do NOT use /GetAllMakes. It returns ~12,300 entries — every
// manufacturer ever registered with the NHTSA, which is overwhelmingly trailer
// builders, golf-cart makers and one-off custom shops ("280 Trailers",
// "1/off Kustoms, Llc"). Sorted alphabetically that buries Toyota at position
// ~10,880 behind a wall of junk, which reads as a broken control rather than a
// long one. /GetMakesForVehicleType/{car,mpv,truck} is the same live API scoped
// to the things a showroom actually trades, and yields ~400.
const VEHICLE_TYPES = ["car", "mpv", "truck"] as const;

const REQUEST_TIMEOUT_MS = 8000;

const FALLBACK_MAKES = [
  "Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "BMW", "Mercedes-Benz",
  "Audi", "Hyundai", "Kia", "Volkswagen", "Lexus", "Mazda", "Jeep",
  "Land Rover", "Porsche", "Volvo", "Subaru", "Mitsubishi", "GMC",
];

export const YEARS = Array.from({ length: 2027 - 1995 + 1 }, (_, i) => 2027 - i);

export const COMMON_TRIMS = ["Base", "Sport", "Premium", "Luxury", "Limited", "Other"];

// vPIC has no colour endpoint — colour is a build-sheet attribute, not a
// VIN-derived one, so there is no public API to bind this to. These are the
// canonical values stored in vehicles.color; the UI renders them through the
// `colors` message namespace so Arabic gets Arabic names while the database
// keeps one spelling. A showroom trading something off-list types it into the
// free-text field instead, which is why the column carries no CHECK.
export const COMMON_COLORS = [
  "White", "Black", "Silver", "Gray", "Blue", "Red", "Green",
  "Brown", "Beige", "Gold", "Orange", "Yellow", "Burgundy",
];

// vPIC returns make names SHOUTED. The make string is persisted to
// vehicles.make and rendered across inventory, contracts and reports, so the
// casing applied here is the casing the showroom lives with. Splitting on
// spaces alone (the previous behaviour) produced "Bmw" and "Mercedes-benz".
const KEEP_UPPER = new Set(["BMW", "GMC", "RAM", "MINI", "AM", "MV", "KTM", "BYD", "MG", "DS", "SRT", "AMG", "INC", "LLC", "USA"]);
const EXACT_CASE: Record<string, string> = { MCLAREN: "McLaren" };

function properCase(raw: string): string {
  const trimmed = raw.trim();
  const exact = EXACT_CASE[trimmed.toUpperCase()];
  if (exact) return exact;
  // Split on whitespace/hyphen/slash but KEEP the delimiters, so
  // "MERCEDES-BENZ" -> "Mercedes-Benz" rather than "Mercedes-benz".
  return trimmed
    .split(/(\s+|-|\/)/)
    .map((tok) => {
      if (!tok || /^(\s+|-|\/)$/.test(tok)) return tok;
      const upper = tok.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      return upper.charAt(0) + tok.slice(1).toLowerCase();
    })
    .join("");
}

async function getJson(url: string): Promise<{ Results?: unknown } | null> {
  try {
    // Some vPIC paths answer with an HTML error page instead of JSON (any make
    // containing "/", for one), so res.json() alone can throw on a 200.
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rows(payload: { Results?: unknown } | null): Record<string, unknown>[] {
  // `Results` is absent on error payloads and can be null, not just empty.
  return Array.isArray(payload?.Results) ? (payload.Results as Record<string, unknown>[]) : [];
}

export interface MakesResult {
  makes: string[];
  /** True when every upstream call failed and `makes` is the offline list. */
  degraded: boolean;
}

// The dialog mounts fresh on every open; without a cache that is a fresh
// 3-request fan-out each time the user adds a vehicle. In-flight dedupe keeps
// a double-open from doubling the traffic.
let makesCache: MakesResult | null = null;
let makesInFlight: Promise<MakesResult> | null = null;

export function fetchMakes(): Promise<MakesResult> {
  if (makesCache) return Promise.resolve(makesCache);
  if (makesInFlight) return makesInFlight;

  makesInFlight = (async () => {
    const payloads = await Promise.all(
      VEHICLE_TYPES.map((t) =>
        getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/${t}?format=json`)
      )
    );

    const names = new Set<string>();
    for (const payload of payloads) {
      for (const row of rows(payload)) {
        const name = row.MakeName;
        if (typeof name === "string" && name.trim()) names.add(properCase(name));
      }
    }

    const result: MakesResult = names.size
      ? { makes: [...names].sort((a, b) => a.localeCompare(b)), degraded: false }
      : { makes: FALLBACK_MAKES, degraded: true };

    // Only a real answer is worth keeping; a degraded one should retry on the
    // next open rather than pinning the offline list for the whole session.
    if (!result.degraded) makesCache = result;
    makesInFlight = null;
    return result;
  })();

  return makesInFlight;
}

const modelsCache = new Map<string, string[]>();

export async function fetchModels(make: string, year: string): Promise<string[]> {
  if (!make || !year) return [];

  const key = `${make.toLowerCase()}|${year}`;
  const cached = modelsCache.get(key);
  if (cached) return cached;

  const payload = await getJson(
    `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
      make
    )}/modelyear/${year}?format=json`
  );

  const models = [
    ...new Set(
      rows(payload)
        .map((r) => r.Model_Name)
        .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        .map((m) => m.trim())
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (models.length) modelsCache.set(key, models);
  return models;
}
