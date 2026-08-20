import { getTranslations, getLocale } from "next-intl/server";
import { formatMoney } from "@/lib/currency";
import { formatDate } from "@/lib/utils";
import type { VehiclePriceHistory } from "@/lib/supabase/types";

/**
 * A chronological record of every asking/floor price this car has
 * carried (migration 0036). Self-contained: the caller supplies the
 * rows (already RLS-scoped and ordered) and this renders them — the
 * price-history trigger is what writes them, never the app.
 *
 * Visibility mirrors the Pricing panel it sits inside: asking/min price
 * are shown to whoever can read the vehicle at all (not gated behind
 * canSeeCost — see [vehicleId]/page.tsx), so the history of those same
 * two numbers carries the same audience rather than a narrower one.
 */
export async function PriceHistoryCard({ history }: { history: VehiclePriceHistory[] }) {
  const t = await getTranslations("inventory");
  const locale = await getLocale();

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{t("priceHistory")}</p>
      {history.length === 0 ? (
        <p className="text-xs text-[var(--color-text-faint)]">{t("priceHistoryEmpty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {history.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]"
            >
              <span className="shrink-0">{formatDate(row.changed_at, locale)}</span>
              <span className="num flex-1 truncate text-end text-[var(--color-text)]">
                {row.asking_price != null ? formatMoney(row.asking_price, locale) : "—"}
                {" / "}
                {row.min_price != null ? formatMoney(row.min_price, locale) : "—"}
              </span>
              <span className="shrink-0 truncate text-[var(--color-text-faint)]" title={t("priceHistoryChangedBy")}>
                {row.profiles?.full_name ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
