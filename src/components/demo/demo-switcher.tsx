"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  FlaskConical,
  Crown,
  Building2,
  MapPin,
  Calculator,
  Car,
  CarFront,
  Megaphone,
  PieChart,
  TrendingUp,
  UsersRound,
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { switchDemoRole, type DemoSwitchState } from "@/app/[locale]/demo/actions";
import type { DemoAccountKey, DemoPersona } from "@/lib/demo-accounts";
import type { Role } from "@/lib/supabase/types";

const PERSONA_CONFIG: Record<
  DemoAccountKey,
  {
    icon: LucideIcon;
    iconColor: string;
    iconBg: string;
  }
> = {
  ceo: {
    icon: Crown,
    iconColor: "text-amber-800",
    iconBg: "bg-amber-100",
  },
  manager: {
    icon: Building2,
    iconColor: "text-blue-800",
    iconBg: "bg-blue-100",
  },
  manager2: {
    icon: MapPin,
    iconColor: "text-teal-800",
    iconBg: "bg-teal-100",
  },
  accountant: {
    icon: Calculator,
    iconColor: "text-emerald-800",
    iconBg: "bg-emerald-100",
  },
  sales: {
    icon: Car,
    iconColor: "text-orange-800",
    iconBg: "bg-orange-100",
  },
  sales2: {
    icon: CarFront,
    iconColor: "text-lime-800",
    iconBg: "bg-lime-100",
  },
  hr: {
    icon: UsersRound,
    iconColor: "text-rose-800",
    iconBg: "bg-rose-100",
  },
  marketing: {
    icon: Megaphone,
    iconColor: "text-purple-800",
    iconBg: "bg-purple-100",
  },
  investor1: {
    icon: PieChart,
    iconColor: "text-indigo-800",
    iconBg: "bg-indigo-100",
  },
  investor2: {
    icon: TrendingUp,
    iconColor: "text-cyan-800",
    iconBg: "bg-cyan-100",
  },
};

/**
 * How the dropdown clusters personas: by what they do, not by seed
 * order, so "Sales" reads as a team (Salesperson 1 — Downtown,
 * Salesperson 2 — Airport Road) rather than a flat list of ten chips.
 * Labels come from messages/*.json under demo.groups.
 */
type GroupKey = "executive" | "managers" | "sales" | "backOffice" | "investors";

const GROUP_FOR_ROLE: Record<Role | string, GroupKey> = {
  ceo: "executive",
  branch_manager: "managers",
  sales_exec: "sales",
  accountant: "backOffice",
  marketing: "backOffice",
  hr: "backOffice",
  investor: "investors",
};

const GROUP_ORDER: GroupKey[] = ["executive", "managers", "sales", "backOffice", "investors"];

function groupPersonas(personas: DemoPersona[]): { group: GroupKey; members: DemoPersona[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    members: personas.filter((p) => (GROUP_FOR_ROLE[p.role] ?? "backOffice") === group),
  })).filter((g) => g.members.length > 0);
}

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
 *             Since the persona set outgrew a chip row (two salespeople,
 *             two managers, each pinned to a showroom), the bar carries a
 *             single dropdown grouped by role, each entry naming its
 *             person and their showroom.
 *
 *   "login" — the same personas as "enter as…" shortcuts under the sign-in
 *             form, so nobody ever has to be given a demo password.
 *
 * The controls only ever send a persona key. See app/[locale]/demo/
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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on any click outside it and on Escape — the two
  // gestures every menu on the platform answers to. Listener registered
  // only while open, so the shell pays nothing the rest of the time.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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
    setOpen(false);
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

  const branchLabel = (persona: DemoPersona) =>
    persona.branch ? t(`branches.${persona.branch}`) : t("branches.companyWide");

  if (variant === "login") {
    return (
      <div className="panel panel-raised overflow-hidden rounded-2xl border border-[var(--color-border)] p-5 shadow-sm sm:p-6">
        <div className="flex flex-col items-center border-b border-[var(--color-border)] pb-4 text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent-amber)]/30 bg-[var(--color-accent-amber-dim)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent-amber)] shadow-xs">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            <span>{t("badge")}</span>
          </div>
          <p className="mt-3 text-sm font-semibold text-[var(--color-text)]">
            {t("loginHint")}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            {t("hint")}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2.5 pt-4 sm:grid-cols-2">
          {personas.map((persona) => {
            const config = PERSONA_CONFIG[persona.key] ?? {
              icon: ShieldCheck,
              iconColor: "text-[var(--color-text-muted)]",
              iconBg: "bg-gray-100",
            };
            const Icon = config.icon;
            const isBusy = persona.key === busyKey;

            return (
              <button
                key={persona.key}
                type="button"
                onClick={() => pick(persona.key)}
                disabled={pending}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-start transition-all duration-150",
                  "hover:border-[var(--color-accent-amber)]/50 hover:bg-[var(--color-accent-amber-dim)]/30 hover:shadow-xs active:scale-[0.99]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-amber)]/50",
                  "disabled:pointer-events-none disabled:opacity-60",
                  isBusy && "border-[var(--color-accent-amber)] bg-[var(--color-accent-amber-dim)]/50"
                )}
              >
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105",
                    config.iconBg,
                    config.iconColor
                  )}
                >
                  {isBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent-amber)]" />
                  ) : (
                    <Icon className="h-4 w-4" aria-hidden />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <p className="truncate text-xs font-semibold text-[var(--color-text)]">
                      {isBusy ? t("switching") : t(`personas.${persona.key}`)}
                    </p>
                  </div>
                  <p className="truncate text-[11px] text-[var(--color-text-muted)]">
                    {persona.name} · {branchLabel(persona)}
                  </p>
                </div>

                <ChevronRight
                  className="h-4 w-4 shrink-0 text-[var(--color-text-faint)] opacity-40 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 group-hover:text-[var(--color-accent-amber)] rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                  aria-hidden
                />
              </button>
            );
          })}
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-[var(--color-accent-red)]/20 bg-[var(--color-accent-red-dim)] p-2.5 text-center text-xs font-medium text-[var(--color-accent-red)]"
          >
            {error}
          </div>
        )}
      </div>
    );
  }

  const current = currentKey ? personas.find((p) => p.key === currentKey) ?? null : null;
  const currentConfig = current ? PERSONA_CONFIG[current.key] : null;
  const CurrentIcon = currentConfig?.icon ?? ShieldCheck;

  return (
    <div className="relative z-40 shrink-0 border-b border-[var(--color-accent-amber)]/25 bg-[var(--color-accent-amber-dim)]/80 backdrop-blur-md">
      <div className="flex h-10 items-center gap-2.5 px-3 md:px-5">
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent-amber)] sm:flex">
          <FlaskConical size={13} aria-hidden />
          {t("badge")}
        </span>

        {/* One dropdown instead of a chip per persona: ten chips no longer
            fit a phone, and the grouping (a sales TEAM across two
            showrooms, a manager PER showroom) is the thing being
            demonstrated — a flat row hides it. */}
        <div ref={menuRef} className="relative min-w-0">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={pending}
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn(
              "flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--color-accent-amber)]/40 bg-white/85 px-2.5 py-1 text-xs font-medium text-[var(--color-text)] shadow-xs transition-colors",
              "hover:border-[var(--color-accent-amber)] hover:bg-white disabled:cursor-progress disabled:opacity-60"
            )}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-accent-amber)]" aria-hidden />
            ) : (
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
                  currentConfig?.iconBg ?? "bg-gray-100",
                  currentConfig?.iconColor ?? "text-[var(--color-text-muted)]"
                )}
              >
                <CurrentIcon className="h-3 w-3" aria-hidden />
              </span>
            )}
            <span className="truncate font-semibold">
              {pending
                ? t("switching")
                : current
                  ? `${t(`personas.${current.key}`)} — ${current.name}`
                  : t("choosePersona")}
            </span>
            {current && !pending && (
              <span className="hidden truncate text-[11px] text-[var(--color-text-muted)] sm:inline">
                {branchLabel(current)}
              </span>
            )}
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-[var(--color-accent-amber)] transition-transform",
                open && "rotate-180"
              )}
              aria-hidden
            />
          </button>

          {open && (
            <div
              role="listbox"
              aria-label={t("choosePersona")}
              className="absolute start-0 top-full z-50 mt-1.5 max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface,#fff)] bg-white p-1.5 shadow-lg"
            >
              {groupPersonas(personas).map(({ group, members }) => (
                <div key={group} className="pb-1 last:pb-0">
                  <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)] first:pt-1">
                    {t(`groups.${group}`)}
                  </p>
                  {members.map((persona) => {
                    const config = PERSONA_CONFIG[persona.key] ?? {
                      icon: ShieldCheck,
                      iconColor: "text-[var(--color-text-muted)]",
                      iconBg: "bg-gray-100",
                    };
                    const Icon = config.icon;
                    const active = persona.key === currentKey;
                    const isBusy = persona.key === busyKey;
                    return (
                      <button
                        key={persona.key}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => pick(persona.key)}
                        disabled={pending}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors",
                          "hover:bg-[var(--color-accent-amber-dim)]/60 disabled:cursor-progress disabled:opacity-60",
                          active && "bg-[var(--color-accent-amber-dim)]"
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                            config.iconBg,
                            config.iconColor
                          )}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent-amber)]" />
                          ) : (
                            <Icon className="h-3.5 w-3.5" aria-hidden />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[var(--color-text)]">
                            {t(`personas.${persona.key}`)} — {persona.name}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                            {branchLabel(persona)}
                          </span>
                        </span>
                        {active && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-amber)]" aria-hidden />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <span role="alert" className="min-w-0 flex-1 truncate text-xs text-[var(--color-accent-red)]">
            {error}
          </span>
        ) : (
          <span className="hidden min-w-0 flex-1 truncate text-end text-xs text-[var(--color-text-muted)] lg:block">
            {t("hint")}
          </span>
        )}
      </div>
    </div>
  );
}
