import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export interface StageBarStep {
  key: string;
  label: string;
}

/**
 * Horizontal step indicator for a record's pipeline position — e.g. a
 * lead's New → Ticket Created → Closed progression. Purely presentational;
 * the caller decides what `current` means for its own status enum.
 */
export function StageBar({
  steps,
  current,
  className,
}: {
  steps: StageBarStep[];
  current: string;
  className?: string;
}) {
  const currentIndex = steps.findIndex((s) => s.key === current);

  return (
    <ol className={cn("flex items-center", className)}>
      {steps.map((step, i) => {
        const done = currentIndex >= 0 && i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={step.key} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                  done && "border-[var(--color-accent)] bg-[var(--color-accent)] text-white",
                  active && "border-[var(--color-accent)] text-[var(--color-accent)]",
                  !done && !active && "border-[var(--color-border-strong)] text-[var(--color-text-faint)]"
                )}
              >
                {done ? <Check size={11} /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-xs font-medium",
                  active ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
                )}
              >
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "mx-2 h-px w-6 shrink-0",
                  done ? "bg-[var(--color-accent)]" : "bg-[var(--color-border-strong)]"
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
