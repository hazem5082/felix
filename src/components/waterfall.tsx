"use client";

import { motion } from "framer-motion";
import { useLocale, useTranslations } from "next-intl";
import { InvestorChip } from "@/components/ui/investor-chip";
import { formatMoney } from "@/lib/currency";
import type { WaterfallPreview } from "@/lib/supabase/types";

function Line({
  label,
  value,
  index,
  emphasize,
  negative,
  badge,
}: {
  label: string;
  value: number;
  index: number;
  emphasize?: boolean;
  negative?: boolean;
  /** Rendered next to the label — the showroom fee's provenance (0050). */
  badge?: React.ReactNode;
}) {
  const locale = useLocale();
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.07, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-center justify-between border-b border-[var(--color-border)] py-2 text-sm last:border-0 ${
        emphasize ? "text-base font-semibold" : "text-[var(--color-text-muted)]"
      }`}
    >
      <span className="flex items-center gap-2">
        {label}
        {badge}
      </span>
      <span
        className={`num ${
          emphasize
            ? value >= 0
              ? "text-[var(--color-accent-green)]"
              : "text-[var(--color-accent-red)]"
            : negative
              ? "text-[var(--color-accent-red)]"
              : "text-[var(--color-text)]"
        }`}
      >
        {negative && value !== 0 ? "−" : ""}{formatMoney(Math.abs(value), locale)}
      </span>
    </motion.div>
  );
}

export function Waterfall({
  preview,
  investorNames,
  overheadBadge,
  overheadFootnote,
}: {
  preview: WaterfallPreview;
  investorNames: Record<string, string>;
  /**
   * Where the showroom fee on this line came from (migration 0050) —
   * frozen at settlement, overridden by the CEO, or still accruing.
   * Optional: the plain preview has no ticket behind it and no
   * provenance to show.
   */
  overheadBadge?: React.ReactNode;
  /** The gap between the fee charged and what the calendar says today. */
  overheadFootnote?: React.ReactNode;
}) {
  const t = useTranslations("deals");
  const locale = useLocale();

  return (
    <div>
      <Line label={t("salePrice")} value={preview.sale_price} index={0} />
      <Line label="Purchase price" value={preview.purchase_price} index={1} negative />
      <Line label="Direct expenses" value={preview.total_expenses} index={2} negative />
      <Line
        label={`${t("overhead")} (${preview.months_in_inventory} mo.)`}
        value={preview.overhead_total}
        index={3}
        negative
        badge={overheadBadge}
      />
      {overheadFootnote}
      {preview.discount > 0 && <Line label={t("discount")} value={preview.discount} index={4} negative />}
      <Line label={t("netProfit")} value={preview.net_profit} index={5} emphasize />

      <div className="mt-4 space-y-2">
        {preview.shares.map((s, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 + i * 0.08, duration: 0.3 }}
            className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-sm"
          >
            {s.holder_type === "ceo" ? (
              <span>CEO</span>
            ) : (
              <InvestorChip id={s.holder_id ?? String(i)} name={investorNames[s.holder_id ?? ""] ?? "Investor"} />
            )}
            <span className="num text-[var(--color-text-muted)]">
              {s.percentage}% ·{" "}
              <span className={s.share >= 0 ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}>
                {formatMoney(s.share, locale)}
              </span>
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
