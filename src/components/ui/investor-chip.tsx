import { investorColor } from "@/lib/utils";

export function InvestorChip({ id, name }: { id: string; name: string }) {
  const color = investorColor(id);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 0 3px ${color}22` }}
      />
      <span className="text-[var(--color-text)]">{name}</span>
    </span>
  );
}
