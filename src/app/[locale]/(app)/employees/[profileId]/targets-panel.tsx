"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import type { TargetMetric } from "@/lib/supabase/types";
import { setEmployeeTarget } from "../actions";

const METRICS: TargetMetric[] = ["calls", "new_leads", "deals_closed"];

/**
 * The "Edit targets" button + dialog. Only rendered for manager-or-above;
 * the action and RLS re-check that server-side.
 */
export function TargetsPanel({
  profileId,
  periodMonth,
  monthLabel,
  current,
}: {
  profileId: string;
  /** YYYY-MM-01 — the month being targeted. */
  periodMonth: string;
  monthLabel: string;
  current: Partial<Record<TargetMetric, number>>;
}) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<Record<TargetMetric, string>>({
    calls: current.calls != null ? String(current.calls) : "",
    new_leads: current.new_leads != null ? String(current.new_leads) : "",
    deals_closed: current.deals_closed != null ? String(current.deals_closed) : "",
  });

  const labels: Record<TargetMetric, string> = {
    calls: t("metricCalls"),
    new_leads: t("metricNewLeads"),
    deals_closed: t("metricDealsClosed"),
  };

  function save() {
    setError(null);
    startTransition(async () => {
      for (const metric of METRICS) {
        const raw = form[metric].trim();
        if (!raw) continue; // blank = leave as-is; there is no clear path
        const value = Number(raw);
        const unchanged = current[metric] != null && current[metric] === value;
        if (unchanged) continue;
        const res = await setEmployeeTarget({
          profile_id: profileId,
          metric,
          target_value: value,
          period_month: periodMonth,
        });
        if (res && "error" in res) {
          setError(`${labels[metric]}: ${res.error}`);
          return;
        }
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Target size={12} />
        {t("editTargets")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title={t("targetsFor", { month: monthLabel })}>
            <p className="mb-4 text-xs text-[var(--color-text-muted)]">{t("targetsHint")}</p>
            <div className="space-y-3">
              {METRICS.map((metric) => (
                <div key={metric}>
                  <Label>{labels[metric]}</Label>
                  <Input
                    type="number"
                    dir="ltr"
                    min={1}
                    step={1}
                    placeholder={t("noTarget")}
                    value={form[metric]}
                    onChange={(e) => setForm((f) => ({ ...f, [metric]: e.target.value }))}
                  />
                </div>
              ))}
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                {common("cancel")}
              </Button>
              <Button
                variant="accent"
                onClick={save}
                disabled={
                  pending ||
                  METRICS.every((m) => !form[m].trim()) ||
                  METRICS.some((m) => {
                    const raw = form[m].trim();
                    if (!raw) return false;
                    const n = Number(raw);
                    return !Number.isInteger(n) || n < 1;
                  })
                }
              >
                {common("save")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
