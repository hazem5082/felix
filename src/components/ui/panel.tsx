import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function Panel({
  className,
  raised,
  ...props
}: HTMLAttributes<HTMLDivElement> & { raised?: boolean }) {
  return (
    <div
      className={cn("panel", raised && "panel-raised", "p-5", className)}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium tracking-wide text-[var(--color-text)]">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}
