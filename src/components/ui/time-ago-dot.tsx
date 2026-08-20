import { cn } from "@/lib/utils";
import type { SemanticTone } from "./status-pill";

export interface TimeBand {
  /** Upper bound in hours; the last band should omit this to catch everything older. */
  maxHours?: number;
  tone: SemanticTone;
}

const DOT_TONE: Record<SemanticTone, string> = {
  green: "bg-[var(--color-accent-green)]",
  red: "bg-[var(--color-accent-red)]",
  amber: "bg-[var(--color-accent-amber)]",
  blue: "bg-[var(--color-accent-blue)]",
  neutral: "bg-[var(--color-text-faint)]",
  orange: "bg-[var(--color-accent-orange)]",
};

/**
 * A colored freshness dot + compact "Xh"/"Xd" elapsed-time label. The color
 * escalates through `bands` (ordered, ascending `maxHours`) — e.g. green for
 * same-day, amber for a couple of days, red once it's gone stale. Generic
 * over what "since" means, so the same component drives both a lead's
 * last-contact freshness and its age in the system with different bands.
 */
export function TimeAgoDot({
  since,
  bands,
  emptyLabel,
  className,
}: {
  since: string | null;
  bands: TimeBand[];
  emptyLabel: string;
  className?: string;
}) {
  if (!since) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-[var(--color-text-faint)]", className)}>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT_TONE.neutral)} />
        {emptyLabel}
      </span>
    );
  }

  const hours = Math.max(0, (Date.now() - new Date(since).getTime()) / 3_600_000);
  const band = bands.find((b) => b.maxHours === undefined || hours <= b.maxHours) ?? bands[bands.length - 1];
  const label = hours < 48 ? `${Math.max(1, Math.round(hours))}h` : `${Math.round(hours / 24)}d`;

  return (
    <span className={cn("num inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]", className)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT_TONE[band.tone])} />
      {label}
    </span>
  );
}
