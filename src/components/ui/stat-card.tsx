"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { Panel } from "./panel";
import { cn } from "@/lib/utils";
import type { SemanticTone } from "./status-pill";

function CountUp({
  value,
  prefix = "",
  suffix = "",
}: {
  value: number;
  prefix?: string;
  suffix?: string;
}) {
  const motionValue = useMotionValue(0);
  const rounded = useTransform(motionValue, (v) => Math.round(v).toLocaleString());
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(motionValue, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] });
    return controls.stop;
  }, [value, motionValue]);

  useEffect(() => {
    return rounded.on("change", (v) => {
      if (ref.current) ref.current.textContent = `${prefix}${v}${suffix}`;
    });
  }, [rounded, prefix, suffix]);

  return <span ref={ref} className="num">{prefix}0{suffix}</span>;
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
  tone = "neutral",
  hint,
  icon,
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  tone?: SemanticTone;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -5, scale: 1.015 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <Panel className="h-full glass-shine">
        <div className="flex items-start justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </span>
          {icon && <span className="text-[var(--color-text-faint)] transition-colors hover:text-white">{icon}</span>}
        </div>
        <div className={cn("mt-2 text-2xl font-bold tabular-nums tracking-tight", TONE_TEXT[tone])}>
          <CountUp value={value} prefix={prefix} suffix={suffix} />
        </div>
        {hint && <p className="mt-1 text-xs text-[var(--color-text-faint)]">{hint}</p>}
      </Panel>
    </motion.div>
  );
}

