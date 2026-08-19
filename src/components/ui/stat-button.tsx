import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * A record-header "smart button": a small bordered box showing a count next
 * to a label, that jumps to the section it summarizes. Deliberately plain —
 * it reads as data navigation, not a call to action.
 */
export function StatButton({
  count,
  label,
  href,
  icon,
  className,
}: {
  count: number;
  label: string;
  href: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm transition-colors hover:border-[var(--color-border-strong)] hover:bg-black/[0.02]",
        className
      )}
    >
      {icon && <span className="text-[var(--color-text-faint)]">{icon}</span>}
      <span className="num font-semibold text-[var(--color-text)]">{count}</span>
      <span className="text-[var(--color-text-muted)]">{label}</span>
    </Link>
  );
}
