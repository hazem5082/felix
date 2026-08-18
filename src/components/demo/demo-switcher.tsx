"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { switchDemoRole, type DemoSwitchState } from "@/app/[locale]/demo/actions";
import type { DemoAccountKey, DemoPersona } from "@/lib/demo-accounts";

/**
 * The persona switcher.
 *
 * Two shapes, one behaviour:
 *
 *   "bar"   — a slim strip pinned above the whole authenticated shell, so
 *             the product is always one click from being seen through
 *             another role. Amber, uppercase, flask icon: it must read as
 *             scaffolding wrapped around the product, never as part of
 *             it, because a prospect who mistakes it for a feature will
 *             ask where the role switcher went in their own showroom.
 *
 *   "login" — the same personas as "enter as…" shortcuts under the sign-in
 *             form, so nobody ever has to be given a demo password.
 *
 * On phones the bar becomes a horizontally scrollable row of chips at the
 * TOP of the shell. It deliberately does not float or dock to the bottom:
 * MobileNav is `fixed inset-x-0 bottom-0`, and anything else down there
 * either covers the tab bar or gets covered by it.
 *
 * The buttons only ever send a persona key. See app/[locale]/demo/
 * actions.ts for why that matters and what the server checks.
 */
export function DemoSwitcher({
  locale,
  personas,
  currentKey,
  variant = "bar",
}: {
  locale: string;
  personas: DemoPersona[];
  /** Which persona is signed in, for the highlight. Null on the login page. */
  currentKey: DemoAccountKey | null;
  variant?: "bar" | "login";
}) {
  const t = useTranslations("demo");
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<DemoAccountKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  function message(state: NonNullable<DemoSwitchState>): string {
    if (state.error === "throttled") return `${t("throttled")} ${state.message ?? ""}`.trim();
    if (state.error === "demoOff") return t("offTitle");
    if (state.error === "wrongTenant") return t("wrongTenant");
    if (state.error === "denied") return t("denied");
    return t("failed");
  }

  function pick(key: DemoAccountKey) {
    setError(null);
    setBusyKey(key);
    startTransition(async () => {
      try {
        const state = await switchDemoRole(locale, key);
        // A successful switch redirects out of this component (the router
        // handles it; the promise still resolves), so anything that comes
        // back is a refusal worth showing.
        if (state) setError(message(state));
      } catch {
        // The action call itself did not complete — offline, or the Worker
        // rejected the POST. Nothing actionable to show beyond "try again".
        setError(t("failed"));
      } finally {
        setBusyKey(null);
      }
    });
  }

  const buttons = personas.map((persona) => {
    const active = persona.key === currentKey;
    const busy = persona.key === busyKey;
    return (
      <button
        key={persona.key}
        type="button"
        onClick={() => pick(persona.key)}
        disabled={pending}
        aria-current={active ? "true" : undefined}
        title={persona.name}
        className={cn(
          "shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-progress disabled:opacity-50",
          active
            ? "border-[var(--color-accent-amber)]/60 bg-[var(--color-accent-amber)]/25 text-[var(--color-accent-amber)]"
            : "border-white/12 bg-white/[0.04] text-[var(--color-text-muted)] hover:border-white/25 hover:text-white"
        )}
      >
        {busy ? t("switching") : t(`personas.${persona.key}`)}
      </button>
    );
  });

  if (variant === "login") {
    return (
      <div className="mt-5 rounded-2xl border border-[var(--color-accent-amber)]/25 bg-[var(--color-accent-amber-dim)] p-3">
        <p className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent-amber)]">
          <FlaskConical size={12} aria-hidden />
          {t("badge")}
        </p>
        <p className="mb-2.5 text-center text-xs text-[var(--color-text-muted)]">
          {t("loginHint")}
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {personas.map((persona) => (
            <button
              key={persona.key}
              type="button"
              onClick={() => pick(persona.key)}
              disabled={pending}
              className="flex min-w-0 flex-col items-center rounded-lg border border-white/12 bg-white/[0.04] px-2 py-1.5 text-xs font-medium text-white transition-colors hover:border-white/25 hover:bg-white/[0.08] disabled:cursor-progress disabled:opacity-50"
            >
              <span className="w-full truncate">
                {persona.key === busyKey ? t("switching") : t(`personas.${persona.key}`)}
              </span>
              <span className="w-full truncate text-[10px] font-normal text-[var(--color-text-faint)]">
                {persona.name}
              </span>
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-center text-xs text-[var(--color-accent-red)]">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-[var(--color-accent-amber)]/25 bg-[var(--color-accent-amber-dim)] backdrop-blur-2xl">
      <div className="flex items-center gap-2.5 px-3 py-1.5 md:px-5">
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent-amber)] sm:flex">
          <FlaskConical size={13} aria-hidden />
          {t("badge")}
        </span>
        {/* The scroll container, not the page: a six-chip row is wider
            than a phone, and the shell itself must never scroll sideways. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
          {buttons}
        </div>
        {error ? (
          <span role="alert" className="hidden shrink-0 text-xs text-[var(--color-accent-red)] md:inline">
            {error}
          </span>
        ) : (
          <span className="hidden shrink-0 text-xs text-[var(--color-text-faint)] lg:inline">
            {t("hint")}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="px-3 pb-1.5 text-xs text-[var(--color-accent-red)] md:hidden">
          {error}
        </p>
      )}
    </div>
  );
}
