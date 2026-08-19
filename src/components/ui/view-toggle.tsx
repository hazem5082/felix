import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";

export type ViewMode = "grid" | "list";

export function ViewToggle({
  value,
  onChange,
  gridLabel,
  listLabel,
  className,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  gridLabel: string;
  listLabel: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5",
        className
      )}
      role="group"
    >
      <button
        type="button"
        onClick={() => onChange("grid")}
        aria-pressed={value === "grid"}
        aria-label={gridLabel}
        className={cn(
          "flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
          value === "grid"
            ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        )}
      >
        <LayoutGrid size={13} />
      </button>
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-pressed={value === "list"}
        aria-label={listLabel}
        className={cn(
          "flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
          value === "list"
            ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        )}
      >
        <List size={13} />
      </button>
    </div>
  );
}
