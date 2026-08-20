/**
 * vehicles.country_of_origin stores canonical English (the color
 * pattern — see vehicle-color.ts), so the Arabic UI and the CPA
 * windshield sticker translate on the way out. Values outside the
 * picker are free text a showroom typed in and have no message key —
 * those pass through unchanged rather than rendering as a
 * missing-key error.
 *
 * The list is the manufacturing origins that actually move through
 * the Egyptian market; the Combobox stays free-text, so anything
 * missing here can still be typed on intake.
 */
export const COMMON_ORIGINS = [
  "Japan",
  "Germany",
  "South Korea",
  "China",
  "USA",
  "France",
  "Italy",
  "UK",
  "Spain",
  "Czech Republic",
  "Turkey",
  "India",
  "Thailand",
  "Morocco",
  "Egypt",
  "Sweden",
] as const;

/** Message keys under the `origins` namespace, keyed by canonical value. */
const ORIGIN_KEYS: Record<string, string> = {
  Japan: "japan",
  Germany: "germany",
  "South Korea": "southKorea",
  China: "china",
  USA: "usa",
  France: "france",
  Italy: "italy",
  UK: "uk",
  Spain: "spain",
  "Czech Republic": "czechRepublic",
  Turkey: "turkey",
  India: "india",
  Thailand: "thailand",
  Morocco: "morocco",
  Egypt: "egypt",
  Sweden: "sweden",
};

export function originKey(value: string): string | undefined {
  return ORIGIN_KEYS[value];
}

export function originLabel(
  translate: (key: string) => string,
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const key = ORIGIN_KEYS[value];
  return key ? translate(key) : value;
}
