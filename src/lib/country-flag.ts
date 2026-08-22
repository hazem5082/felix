// Country name -> flag emoji, shared between the VIN decoder
// (lib/vin-decode.ts, "use client" — network calls) and any server
// component that just needs to render a flag next to an already-stored
// country_of_origin value. No "use client": nothing here touches the
// network or the DOM.

export interface CountryHit {
  /** Canonical spelling — matches COMMON_ORIGINS (vehicle-origin.ts)
   *  where the country is on that curated list. */
  name: string;
  flag: string;
}

export function flagFor(iso2: string): string {
  return String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}

// Canonical name -> ISO 3166-1 alpha-2, covering COMMON_ORIGINS
// (vehicle-origin.ts) plus the handful of extra countries vPIC's
// PlantCountry commonly names that are not on that curated list.
export const COUNTRY_ISO2: Record<string, string> = {
  Japan: "JP", Germany: "DE", "South Korea": "KR", China: "CN", USA: "US",
  France: "FR", Italy: "IT", UK: "GB", Spain: "ES", "Czech Republic": "CZ",
  Turkey: "TR", India: "IN", Thailand: "TH", Morocco: "MA", Egypt: "EG",
  Sweden: "SE", Canada: "CA", Mexico: "MX", Brazil: "BR", Argentina: "AR",
  "South Africa": "ZA", Belgium: "BE", Austria: "AT", Slovakia: "SK",
  Poland: "PL", Hungary: "HU", Romania: "RO", Russia: "RU", Indonesia: "ID",
  Malaysia: "MY", "United Arab Emirates": "AE", Australia: "AU",
};

export function countryHit(name: string): CountryHit | null {
  const iso2 = COUNTRY_ISO2[name];
  return iso2 ? { name, flag: flagFor(iso2) } : null;
}

// vPIC's PlantCountry is free text lifted from manufacturer submissions —
// "UNITED STATES (USA)", "CANADA", "MEXICO", "JAPAN", "GERMANY" and so on.
// This normalises the common spellings onto the canonical names above.
export const NHTSA_COUNTRY_ALIASES: Record<string, string> = {
  "UNITED STATES": "USA", "UNITED STATES (USA)": "USA", USA: "USA",
  CANADA: "Canada", MEXICO: "Mexico", JAPAN: "Japan", GERMANY: "Germany",
  "SOUTH KOREA": "South Korea", "KOREA, SOUTH": "South Korea", "REPUBLIC OF KOREA": "South Korea",
  CHINA: "China", FRANCE: "France", ITALY: "Italy",
  "UNITED KINGDOM": "UK", ENGLAND: "UK", SPAIN: "Spain",
  "CZECH REPUBLIC": "Czech Republic", CZECHIA: "Czech Republic",
  TURKEY: "Turkey", TURKIYE: "Turkey", INDIA: "India", THAILAND: "Thailand",
  MOROCCO: "Morocco", EGYPT: "Egypt", SWEDEN: "Sweden", BRAZIL: "Brazil",
  ARGENTINA: "Argentina", "SOUTH AFRICA": "South Africa", BELGIUM: "Belgium",
  AUSTRIA: "Austria", SLOVAKIA: "Slovakia", POLAND: "Poland", HUNGARY: "Hungary",
  ROMANIA: "Romania", RUSSIA: "Russia", INDONESIA: "Indonesia", MALAYSIA: "Malaysia",
  "UNITED ARAB EMIRATES": "United Arab Emirates", AUSTRALIA: "Australia",
};

export function countryFromNhtsaName(raw: string): CountryHit | null {
  const key = raw.trim().toUpperCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  const canonical = NHTSA_COUNTRY_ALIASES[key] ?? NHTSA_COUNTRY_ALIASES[raw.trim().toUpperCase()];
  return canonical ? countryHit(canonical) : null;
}

/**
 * Flag for an already-stored `vehicles.country_of_origin` value. Returns
 * null for free text a showroom typed that is not on the curated list —
 * same "pass through unchanged" posture originLabel() takes, rather than
 * guessing a flag for arbitrary text.
 */
export function flagForOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso2 = COUNTRY_ISO2[value];
  return iso2 ? flagFor(iso2) : null;
}
