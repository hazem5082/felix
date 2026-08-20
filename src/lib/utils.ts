import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Money formatting lives in src/lib/currency.ts (formatMoney) — the
// app is EGP-denominated and that module is the single seam for it.

export function formatDate(dateStr: string, locale: string = "en") {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(dateStr));
}

// Deterministic color chip for investor identity — same investor
// always renders the same swatch across every table/screen.
const INVESTOR_PALETTE = [
  "#38bdf8", // sky
  "#a78bfa", // violet
  "#fb923c", // orange
  "#4ade80", // green
  "#f472b6", // pink
  "#facc15", // yellow
  "#2dd4bf", // teal
  "#f87171", // red
];

export function investorColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return INVESTOR_PALETTE[Math.abs(hash) % INVESTOR_PALETTE.length];
}
