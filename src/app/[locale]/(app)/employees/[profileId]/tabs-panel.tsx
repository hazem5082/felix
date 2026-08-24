"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { EyeOff, Info, KeyRound } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { FeatureKey } from "@/lib/supabase/types";
import { FEATURE_GRANTABLE, FEATURE_HIDEABLE } from "@/lib/features";
import { setFeatureGrant } from "../actions";

/**
 * "Which tabs does this person get?" — the CEO's control, and the one
 * screen in FELIX where the difference between a tab and a permission
 * has to be visible rather than merely true.
 *
 * TWO LISTS, NOT ONE, and they are not the same kind of thing:
 *
 *   EXTRA HUBS   a real grant. The database policies consult it
 *                (has_feature(), migration 0048), so handing an
 *                accountant the HR hub genuinely makes them able to run
 *                payroll. Only 'hr' is offered, because 'hr' is the only
 *                feature whose policies were wired — feature_grants_
 *                grantable refuses the rest at the database, so offering
 *                them here would produce a constraint violation dressed
 *                up as a product feature.
 *
 *   HIDDEN TABS  cosmetic. It removes the entry from this person's
 *                sidebar and changes nothing in Postgres: the role keeps
 *                every privilege it had, and someone who types the URL
 *                still gets the page. The notice below says so in those
 *                words. A cosmetic control mistaken for a security
 *                control is worse than no control.
 */
export function TabsPanel({
  profileId,
  granted,
  hidden,
  roleDefaults,
}: {
  profileId: string;
  granted: FeatureKey[];
  hidden: FeatureKey[];
  /** The tabs this person's ROLE carries — only those can be hidden. */
  roleDefaults: FeatureKey[];
}) {
  const t = useTranslations("employees");
  const nav = useTranslations("nav");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const grantedSet = new Set(granted);
  const hiddenSet = new Set(hidden);

  function toggle(feature: FeatureKey, mode: "grant" | "hide", enabled: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setFeatureGrant({ profile_id: profileId, feature, mode, enabled, note: "" });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("tabsTitle")} subtitle={t("tabsSubtitle")} />

      <div className="space-y-5">
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <KeyRound size={12} />
            {t("tabsGrantTitle")}
          </h4>
          <p className="mb-2.5 text-xs text-[var(--color-text-muted)]">{t("tabsGrantHint")}</p>
          <div className="flex flex-wrap gap-2">
            {FEATURE_GRANTABLE.map((feature) => (
              <Toggle
                key={feature}
                label={nav(feature)}
                on={grantedSet.has(feature)}
                disabled={pending}
                onChange={(next) => toggle(feature, "grant", next)}
              />
            ))}
          </div>
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <EyeOff size={12} />
            {t("tabsHideTitle")}
          </h4>
          {/* Stated as a warning, not a footnote. See the component
              header: this control does not take anything away. */}
          <p className="mb-2.5 flex items-start gap-1.5 rounded-md bg-[var(--color-accent-amber-dim,rgba(180,120,20,0.08))] px-2.5 py-2 text-xs text-[var(--color-text-muted)]">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>{t("tabsHideWarning")}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {FEATURE_HIDEABLE.filter(
              (feature) => roleDefaults.includes(feature) || grantedSet.has(feature)
            ).map((feature) => (
              <Toggle
                key={feature}
                label={nav(feature)}
                on={hiddenSet.has(feature)}
                disabled={pending}
                tone="warn"
                onChange={(next) => toggle(feature, "hide", next)}
              />
            ))}
          </div>
        </section>

        {error && <p className="text-xs text-[var(--color-accent-red)]">{error}</p>}
      </div>
    </Panel>
  );
}

function Toggle({
  label,
  on,
  disabled,
  tone = "accent",
  onChange,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  tone?: "accent" | "warn";
  onChange: (next: boolean) => void;
}) {
  const activeClass =
    tone === "warn"
      ? "border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)]"
      : "border-[var(--color-accent)]/40 bg-[var(--color-accent-dim)] text-[var(--color-accent)]";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={[
        "cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
        on
          ? activeClass
          : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-black/[0.03]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
