import { COMMON_COLORS } from "@/lib/nhtsa";

/**
 * vehicles.color stores canonical English (see COMMON_COLORS), so the
 * Arabic UI has to translate on the way out. Values outside the picker are
 * free text a showroom typed in ("Nardo Grey") and have no message key —
 * those pass through unchanged rather than rendering as a missing-key error.
 */
export function colorLabel(
  translate: (key: string) => string,
  value: string | null | undefined
): string | null {
  if (!value) return null;
  return COMMON_COLORS.includes(value) ? translate(value.toLowerCase()) : value;
}

/**
 * Swatch fills for the picker. Deliberately muted rather than pure CSS
 * keywords — a `red` dot next to `Red` on a near-black panel reads as an
 * error state, and `white` as a blown-out hole. Custom colours get no swatch:
 * guessing a fill for arbitrary text would be wrong more often than blank.
 */
export const COLOR_SWATCHES: Record<string, string> = {
  White: "#f1f2f4",
  Black: "#15171b",
  Silver: "#c3c8ce",
  Gray: "#7b828b",
  Blue: "#2f6fe0",
  Red: "#d33b3b",
  Green: "#2f9e5a",
  Brown: "#6d4626",
  Beige: "#ded0b0",
  Gold: "#c9a227",
  Orange: "#e0702c",
  Yellow: "#e3bd25",
  Burgundy: "#7c2436",
};

export function colorSwatch(value: string): string | undefined {
  return COLOR_SWATCHES[value];
}
