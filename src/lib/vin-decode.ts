"use client";

// VIN validation + decode. Two independent layers:
//
//   1. CHECKSUM — the ISO 3779 / SAE J853 position-9 check digit, computed
//      locally (no network call). This is a REAL algorithm, not a guess,
//      but it is only MANDATORY for North-American-market cars (US FMVSS
//      115). A showroom in Egypt trades plenty of genuine JDM/EU/GCC-spec
//      stock whose 9th character was never meant to satisfy this formula.
//      A mismatch is therefore surfaced as a soft warning ("double-check
//      this"), never a hard rejection — see vehicle-form.tsx.
//
//   2. DECODE — NHTSA's free vPIC API (same host already allow-listed in
//      next.config.ts for nhtsa.ts's make/model lookups). It returns
//      make/model/year/trim/body class/engine/drivetrain and, when the
//      VIN is one it recognises, the assembly plant's country — which is
//      the best available signal for "country of origin".
//
// DELIBERATELY NOT HERE: exterior colour and top speed. Neither is
// encoded in a VIN, and no free API ties either one to a VIN — vPIC has
// no colour endpoint (see nhtsa.ts) and top speed is a trim-level spec
// sheet fact, not a VIN-decodable one. Faking either would be worse than
// leaving them blank.

import { type CountryHit, countryHit, countryFromNhtsaName } from "@/lib/country-flag";

const REQUEST_TIMEOUT_MS = 8000;

// ── 1. CHECKSUM ──────────────────────────────────────────────

const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * Computes the expected position-9 check digit for a 17-character VIN
 * (caller guarantees the standard alphabet — see VinSchema in
 * lib/validation.ts) and reports whether the VIN's actual 9th character
 * matches it. A `false` result means "not a NA-formula VIN", which is
 * routine for imported stock — see the file header.
 */
export function vinChecksumMatches(vin: string): boolean {
  if (vin.length !== 17) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /[0-9]/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    if (value === undefined) return false;
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? "X" : String(remainder);
  return vin[8] === expected;
}

// ── 2. DECODE ────────────────────────────────────────────────

export interface VinDecodeResult {
  /** True when NHTSA returned nothing usable — an unrecognised/foreign
   *  WMI, not necessarily a fake VIN. See the file header. */
  decoded: boolean;
  checksumOk: boolean;
  /** NHTSA's own error text, when it flagged something (informational —
   *  never blocks). */
  errorText: string | null;
  make: string | null;
  model: string | null;
  year: string | null;
  trim: string | null;
  bodyType: string | null;
  driveType: string | null;
  doors: number | null;
  engineInfo: string | null;
  countryOfOrigin: string | null;
  countryFlag: string | null;
}

interface VpicRow {
  Make?: string;
  Model?: string;
  ModelYear?: string;
  Trim?: string;
  Series?: string;
  BodyClass?: string;
  DriveType?: string;
  Doors?: string;
  EngineCylinders?: string;
  DisplacementL?: string;
  FuelTypePrimary?: string;
  PlantCountry?: string;
  ErrorCode?: string;
  ErrorText?: string;
}

function titleCase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildEngineInfo(row: VpicRow): string | null {
  const parts: string[] = [];
  // vPIC's DisplacementL is metric-converted from cubic inches and often
  // arrives as "2.998832712" rather than "3.0" — round to one decimal for
  // a figure a person actually reads.
  const displacementRaw = row.DisplacementL?.trim();
  const displacement =
    displacementRaw && !Number.isNaN(Number(displacementRaw)) ? Number(displacementRaw).toFixed(1) : displacementRaw;
  const cylinders = row.EngineCylinders?.trim();
  if (displacement) parts.push(`${displacement}L`);
  if (cylinders) parts.push(`${cylinders}-Cyl`);
  const fuel = row.FuelTypePrimary?.trim();
  const head = parts.join(" ");
  if (head && fuel) return `${head}, ${titleCase(fuel)}`;
  if (head) return head;
  if (fuel) return titleCase(fuel);
  return null;
}

export async function decodeVin(vin: string): Promise<VinDecodeResult | null> {
  const checksumOk = vinChecksumMatches(vin);
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const payload = JSON.parse(await res.text()) as { Results?: VpicRow[] };
    const row = payload.Results?.[0];
    if (!row) return null;

    const make = row.Make?.trim() || null;
    const model = row.Model?.trim() || null;
    const bodyType = row.BodyClass?.trim() || null;

    // NHTSA's own signal that this WMI/VIN carries nothing it recognises —
    // routine for grey-import/non-US-market stock, not proof of a fake VIN.
    const decoded = Boolean(make || model || bodyType);

    const plantCountry = row.PlantCountry?.trim();
    const origin = plantCountry ? countryFromNhtsaName(plantCountry) : wmiCountryGuess(vin);

    const doorsRaw = row.Doors?.trim();
    const doors = doorsRaw && /^\d+$/.test(doorsRaw) ? Number(doorsRaw) : null;

    const errorCodes = (row.ErrorCode ?? "").split(",").map((c) => c.trim());
    // Code "1" is specifically "check digit does not calculate properly" —
    // NHTSA's own confirmation of what vinChecksumMatches already found.
    const errorText =
      row.ErrorText && row.ErrorText.trim() && row.ErrorText.trim() !== "Additional Error Text"
        ? row.ErrorText.trim()
        : errorCodes.includes("1")
          ? "Check digit (9th position) does not match the North-American formula."
          : null;

    return {
      decoded,
      checksumOk,
      errorText,
      make: make ? properCaseMake(make) : null,
      model,
      year: row.ModelYear?.trim() || null,
      trim: row.Trim?.trim() || row.Series?.trim() || null,
      bodyType,
      driveType: row.DriveType?.trim() || null,
      doors,
      engineInfo: buildEngineInfo(row),
      countryOfOrigin: origin?.name ?? null,
      countryFlag: origin?.flag ?? null,
    };
  } catch {
    return { decoded: false, checksumOk, errorText: null, make: null, model: null, year: null, trim: null, bodyType: null, driveType: null, doors: null, engineInfo: null, countryOfOrigin: null, countryFlag: null };
  }
}

// vPIC shouts make names, same as GetMakesForVehicleType — reuse of
// nhtsa.ts's own casing table would create a circular import for one
// function, so a small local pass covers the common cases instead.
function properCaseMake(raw: string): string {
  const upper = raw.trim().toUpperCase();
  const KEEP: Record<string, string> = {
    BMW: "BMW", GMC: "GMC", RAM: "RAM", MINI: "MINI", KTM: "KTM", BYD: "BYD", MG: "MG",
    "MERCEDES-BENZ": "Mercedes-Benz", MCLAREN: "McLaren",
  };
  if (KEEP[upper]) return KEEP[upper];
  return upper
    .split(/(\s+|-|\/)/)
    .map((tok) => (/^(\s+|-|\/)$/.test(tok) || !tok ? tok : tok.charAt(0) + tok.slice(1).toLowerCase()))
    .join("");
}

// ── COUNTRY + FLAG ───────────────────────────────────────────
//
// The canonical-name/ISO2/flag table lives in lib/country-flag.ts, shared
// with the server-rendered vehicle detail page so a stored
// country_of_origin gets the same flag a fresh decode would have applied.

// Best-effort WMI (World Manufacturer Identifier) fallback for when vPIC
// has no PlantCountry — routine for a VIN outside NHTSA's US-centric
// coverage. NOT an exhaustive ISO 3780 registry: it covers the WMI
// prefixes that actually show up on an Egyptian used-car floor. Checked
// longest-prefix-first.
const WMI_PREFIXES: [string, string][] = [
  ["VF", "France"], ["VS", "Spain"], ["VW", "Germany"],
  ["TM", "Czech Republic"], ["MR", "Thailand"],
  ["JT", "Japan"], ["JH", "Japan"], ["JN", "Japan"], ["JM", "Japan"], ["JF", "Japan"],
  ["KM", "South Korea"], ["KN", "South Korea"], ["KL", "South Korea"],
  ["WA", "Germany"], ["WB", "Germany"], ["WD", "Germany"], ["WM", "Germany"], ["WP", "Germany"], ["WV", "Germany"],
  ["ZA", "Italy"], ["ZF", "Italy"],
  ["SA", "UK"], ["SB", "UK"],
  ["YV", "Sweden"],
  ["NM", "Turkey"], ["NL", "Turkey"],
  ["MA", "India"], ["MB", "India"], ["MC", "India"],
  ["LS", "China"], ["LF", "China"], ["LV", "China"], ["LG", "China"],
];

const WMI_SINGLE: [string, string][] = [
  ["J", "Japan"], ["K", "South Korea"], ["L", "China"], ["W", "Germany"],
  ["S", "UK"], ["Z", "Italy"], ["Y", "Sweden"], ["N", "Turkey"], ["M", "India"],
  ["1", "USA"], ["4", "USA"], ["5", "USA"], ["2", "Canada"], ["3", "Mexico"],
  ["9", "Brazil"], ["8", "Argentina"], ["6", "Australia"], ["7", "New Zealand"],
];

function wmiCountryGuess(vin: string): CountryHit | null {
  const prefix2 = vin.slice(0, 2).toUpperCase();
  for (const [p, country] of WMI_PREFIXES) {
    if (prefix2 === p) return countryHit(country);
  }
  const c1 = vin[0].toUpperCase();
  for (const [p, country] of WMI_SINGLE) {
    if (c1 === p) return countryHit(country);
  }
  return null;
}
