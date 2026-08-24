"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { MailCheck, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { completionPercent, summariseDay } from "@/lib/tasks";
import type { DayReport, TaskRow } from "@/lib/supabase/types";
import { endDay, type EndDayResult } from "./actions";

/**
 * END DAY: the one button on this page that talks to somebody else.
 *
 * IT SHOWS THE NUMBERS BEFORE IT SENDS THEM. Nobody should discover what
 * their manager was told by reading their manager's reaction — the three
 * counts on this card are exactly the three the mail carries, computed
 * from the same summariseDay() the action uses, so there is no version
 * of the day the sender has not seen.
 *
 * IT IS NOT A LOCK. Pressing it again after finishing a late task
 * corrects the record and sends the corrected version; day_reports is
 * upserted for precisely this reason. A button that could only be
 * pressed once would teach people to press it late, which defeats the
 * point of an end-of-day report.
 *
 * The optional note is the sender's own words, appended below the
 * tally — the place for "the internet was down until three" that no
 * per-task reason has room for.
 */
export function EndDayCard({
  tasks,
  day,
  report,
}: {
  tasks: TaskRow[];
  day: string;
  report: DayReport | null;
}) {
  const t = useTranslations("tasks");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState(report?.note ?? "");
  const [result, setResult] = useState<EndDayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => summariseDay(tasks), [tasks]);
  const percent = completionPercent(counts);

  function send() {
    setError(null);
    startTransition(async () => {
      const outcome = await endDay({ day, note });
      if ("error" in outcome) setError(outcome.error);
      else {
        setResult(outcome);
        router.refresh();
      }
    });
  }

  return (
    <Panel>
      <PanelHeader
        title={t("endDayTitle")}
        subtitle={report ? t("endDayAlready") : t("endDayBody")}
      />

      <div className="grid grid-cols-3 gap-3">
        <Figure label={t("done")} value={counts.done} tone="green" />
        <Figure label={t("declinedCount")} value={counts.skipped} tone="muted" />
        <Figure label={t("ignored")} value={counts.open} tone={counts.open > 0 ? "red" : "muted"} />
      </div>

      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        {counts.total === 0
          ? t("nothingAsked")
          : t("endDayTally", { done: counts.done, total: counts.total, percent })}
      </p>

      <div className="mt-4">
        <Label htmlFor="end-day-note">{t("endDayNote")}</Label>
        <Textarea
          id="end-day-note"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder={t("endDayNotePlaceholder")}
        />
      </div>

      {error && (
        <p className="mt-3 text-xs font-medium text-[var(--color-accent-red)]">{error}</p>
      )}

      {result && (
        <p className="mt-3 flex items-start gap-2 text-xs text-[var(--color-accent-green)]">
          <MailCheck size={14} className="mt-0.5 shrink-0" />
          <span>
            {result.mailed
              ? t("endDaySent", { people: result.recipients.join(", ") })
              : t("endDayFiledOnly")}
          </span>
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <Button variant="primary" size="md" disabled={pending} onClick={send}>
          <Moon size={14} />
          {report ? t("endDayAgain") : t("endDay")}
        </Button>
      </div>
    </Panel>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "red" | "muted";
}) {
  const color =
    tone === "green"
      ? "text-[var(--color-accent-green)]"
      : tone === "red"
        ? "text-[var(--color-accent-red)]"
        : "text-[var(--color-text)]";
  return (
    <div className="rounded-md border border-[var(--color-border)] px-3 py-2.5">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
