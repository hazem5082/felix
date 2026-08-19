"use client";

import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export type SemanticTone = "green" | "red" | "amber" | "blue" | "neutral";

const TONE_CLASSES: Record<SemanticTone, string> = {
  green: "bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)] ring-1 ring-inset ring-[var(--color-accent-green)]/20",
  red: "bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)] ring-1 ring-inset ring-[var(--color-accent-red)]/20",
  amber: "bg-[var(--color-accent-amber-dim)] text-[var(--color-accent-amber)] ring-1 ring-inset ring-[var(--color-accent-amber)]/20",
  blue: "bg-[var(--color-accent-blue-dim)] text-[var(--color-accent-blue)] ring-1 ring-inset ring-[var(--color-accent-blue)]/20",
  neutral: "bg-black/[0.04] text-[var(--color-text-muted)] ring-1 ring-inset ring-black/[0.06]",
};

export function StatusPill({
  label,
  tone,
  className,
}: {
  label: string;
  tone: SemanticTone;
  className?: string;
}) {
  return (
    <span className="relative inline-flex">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={`${label}-${tone}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18 }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
            TONE_CLASSES[tone],
            className
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {label}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
