"use client";

import { useCallback, useEffect, useRef } from "react";
import { animate, motion, useMotionValue } from "framer-motion";
import { useLocale } from "next-intl";
import { Panel } from "./panel";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/currency";
import type { SemanticTone } from "./status-pill";

/**
 * Counts up to `value` on mount.
 *
 * The real number is rendered into the markup, not a placeholder. An earlier
 * version rendered a literal `0` and relied on an animation callback to
 * imperatively write the true figure in — so any failure of that callback
 * left the card reading "$0" with no error anywhere, presenting a wrong
 * financial figure as though it were real. On the deployed Worker that is
 * exactly what happened: every StatCard sat at $0 indefinitely while the
 * tables beside them, rendered server-side, showed the correct amounts.
 *
 * Now the animation is strictly an enhancement: if it never runs, never
 * fires, or is torn down mid-count, the correct value is already on screen
 * and the cleanup restores it.
 */
function CountUp({
  value,
  format,
}: {
  value: number;
  format: (v: number) => string;
}) {
  const motionValue = useMotionValue(0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Subscribe before starting the animation. The previous version started
    // it in an earlier effect and subscribed in a later one, so any frame
    // emitted in between was lost.
    const unsubscribe = motionValue.on("change", (v) => {
      node.textContent = format(v);
    });

    motionValue.set(0);
    const controls = animate(motionValue, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] });

    return () => {
      controls.stop();
      unsubscribe();
      // Never leave a half-counted figure on screen.
      node.textContent = format(value);
    };
  }, [value, format, motionValue]);

  return (
    <span ref={ref} className="num">
      {format(value)}
    </span>
  );
}

const TONE_TEXT: Record<SemanticTone, string> = {
  green: "text-[var(--color-accent-green)]",
  red: "text-[var(--color-accent-red)]",
  amber: "text-[var(--color-accent-amber)]",
  blue: "text-[var(--color-accent-blue)]",
  neutral: "text-[var(--color-text)]",
};

export function StatCard({
  label,
  value,
  prefix,
  suffix,
  currency,
  tone = "neutral",
  hint,
  icon,
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  /** Render the value as money in the app currency (EGP), locale-aware. */
  currency?: boolean;
  tone?: SemanticTone;
  hint?: string;
  icon?: React.ReactNode;
}) {
  const locale = useLocale();
  // Stable identity so a parent re-render doesn't restart the count-up.
  const format = useCallback(
    (v: number) =>
      currency
        ? formatMoney(v, locale)
        : `${prefix ?? ""}${Math.round(v).toLocaleString()}${suffix ?? ""}`,
    [currency, locale, prefix, suffix]
  );
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      <Panel className="h-full">
        <div className="flex items-start justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </span>
          {icon && <span className="text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]">{icon}</span>}
        </div>
        <div className={cn("mt-2 text-2xl font-bold tabular-nums tracking-tight", TONE_TEXT[tone])}>
          <CountUp value={value} format={format} />
        </div>
        {hint && <p className="mt-1 text-xs text-[var(--color-text-faint)]">{hint}</p>}
      </Panel>
    </motion.div>
  );
}

