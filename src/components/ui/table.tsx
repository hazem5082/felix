import { cn } from "@/lib/utils";

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <table className={cn("w-full border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-white/[0.03] text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-4 py-2.5 text-start font-medium", className)}>{children}</th>;
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-[var(--color-border)]">{children}</tbody>;
}

export function Tr({
  children,
  className,
  toneBar,
}: {
  children: React.ReactNode;
  className?: string;
  /** hex color for a semantic left border, e.g. profit/loss row coding */
  toneBar?: string;
}) {
  return (
    <tr
      className={cn("transition-colors hover:bg-white/[0.03]", className)}
      style={toneBar ? { boxShadow: `inset 3px 0 0 0 ${toneBar}` } : undefined}
    >
      {children}
    </tr>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-4 py-2.5 align-middle", className)}>{children}</td>;
}
