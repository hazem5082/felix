import { Panel } from "@/components/ui/panel";

/**
 * Skeleton shaped like the list screens most routes render, so the layout
 * does not jump when the real content streams in.
 */
export default function AppLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-5 w-40 animate-pulse rounded bg-white/[0.06]" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Panel key={i} className="h-24">
            <div className="h-3 w-20 animate-pulse rounded bg-white/[0.06]" />
            <div className="mt-3 h-6 w-28 animate-pulse rounded bg-white/[0.06]" />
          </Panel>
        ))}
      </div>

      <Panel>
        <div className="space-y-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-8 animate-pulse rounded bg-white/[0.04]"
              style={{ animationDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}
