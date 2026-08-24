"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Ban, Check, Pencil, Power, RotateCcw } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { formatMoney } from "@/lib/currency";
import type {
  Branch,
  OverheadBasis,
  OverheadBranchView,
  OverheadMonthView,
  OverheadOverview,
  OverheadRateSource,
} from "@/lib/supabase/types";
import { clearOverheadMonth, setOverheadMonth, setOverheadPolicy } from "./actions";

/**
 * THE FEE CONSOLE (migration 0050).
 *
 * One card per branch. The top half is the policy — the switch, where
 * the rate comes from — and the bottom half is the calendar, twelve
 * months of resolved rates with their provenance next to each.
 *
 * THE PROVENANCE BADGE IS THE POINT. Before 0050 the fee was a single
 * hand-typed number with nothing behind it, and an investor being
 * charged it had nothing to read. Every row here says where its figure
 * came from: a month the CEO set by hand, the average of the recorded
 * bills, the branch's manual figure, or the switch being off.
 *
 * Everything is optimistic-free: each write goes to the server and the
 * page is refreshed from it, because the resolved rate is computed by
 * effective_overhead_rate() in Postgres and guessing at it here is
 * exactly the second implementation this feature was built to avoid.
 */

const SOURCE_TONE: Record<OverheadRateSource, SemanticTone> = {
  month: "blue",
  average: "green",
  manual: "neutral",
  off: "red",
  unset: "neutral",
};

export function FeesConsole({
  overview,
  branches,
  canEdit,
}: {
  overview: OverheadOverview;
  branches: Branch[];
  canEdit: boolean;
}) {
  const t = useTranslations("fees");

  if (overview.branches.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-[var(--color-text-muted)]">{t("noBranches")}</p>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <Panel>
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">{t("explainer")}</p>
      </Panel>
      {overview.branches.map((b) => (
        <BranchCard key={b.branch_id} branch={b} canEdit={canEdit} thisMonth={overview.this_month} />
      ))}
      {branches.length > overview.branches.length && (
        <p className="text-xs text-[var(--color-text-faint)]">{t("scopedToYourBranches")}</p>
      )}
    </div>
  );
}

function BranchCard({
  branch,
  canEdit,
  thisMonth,
}: {
  branch: OverheadBranchView;
  canEdit: boolean;
  thisMonth: string;
}) {
  const t = useTranslations("fees");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OverheadMonthView | null>(null);

  const [feesEnabled, setFeesEnabled] = useState(branch.fees_enabled);
  const [basis, setBasis] = useState<OverheadBasis>(branch.basis);
  const [amount, setAmount] = useState(String(branch.monthly_opex_amount));
  const [windowMonths, setWindowMonths] = useState(String(branch.average_window_months));

  const dirty =
    feesEnabled !== branch.fees_enabled ||
    basis !== branch.basis ||
    Number(amount) !== Number(branch.monthly_opex_amount) ||
    Number(windowMonths) !== Number(branch.average_window_months);

  function savePolicy(next?: Partial<{ fees_enabled: boolean }>) {
    setError(null);
    startTransition(async () => {
      const res = await setOverheadPolicy({
        branch_id: branch.branch_id,
        fees_enabled: next?.fees_enabled ?? feesEnabled,
        basis,
        monthly_opex_amount: Number(amount || "0"),
        average_window_months: Number(windowMonths || "6"),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function clearMonth(month: string) {
    setError(null);
    startTransition(async () => {
      const res = await clearOverheadMonth({
        branch_id: branch.branch_id,
        period_month: month.slice(0, 7),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Panel>
      <PanelHeader
        title={branch.branch_name}
        subtitle={t("branchSubtitle", { count: branch.in_stock_count })}
        action={
          <div className="flex items-center gap-2">
            <StatusPill
              label={
                branch.current_enabled
                  ? t(`source_${branch.current_source}`)
                  : t("feesOff")
              }
              tone={SOURCE_TONE[branch.current_source]}
            />
            {canEdit && (
              <Button
                variant={feesEnabled ? "outline" : "success"}
                size="sm"
                disabled={pending}
                onClick={() => {
                  const next = !feesEnabled;
                  setFeesEnabled(next);
                  savePolicy({ fees_enabled: next });
                }}
              >
                <Power size={13} />
                {feesEnabled ? t("turnOff") : t("turnOn")}
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("currentRate")} value={formatMoney(branch.current_rate, locale)} />
        <Stat label={t("inStock")} value={String(branch.in_stock_count)} />
        {/* The number that makes this page worth opening: what the cars
            still on the forecourt have already run up, and will hand
            over out of their profit share the day they sell. */}
        <Stat
          label={t("accruedUnsold")}
          value={formatMoney(branch.accrued_unsold, locale)}
          tone="amber"
        />
      </div>

      {canEdit && (
        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-1">
            <Label>{t("basis")}</Label>
            <Select value={basis} onChange={(e) => setBasis(e.target.value as OverheadBasis)}>
              <option value="manual">{t("basis_manual")}</option>
              <option value="average">{t("basis_average")}</option>
            </Select>
          </div>
          <div>
            <Label>{t("manualAmount")}</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <Label>{t("averageWindow")}</Label>
            <Input
              type="number"
              min="1"
              max="36"
              value={windowMonths}
              onChange={(e) => setWindowMonths(e.target.value)}
              disabled={basis !== "average"}
            />
          </div>
          <div className="flex items-end">
            <Button variant="accent" size="sm" disabled={pending || !dirty} onClick={() => savePolicy()}>
              <Check size={13} />
              {t("savePolicy")}
            </Button>
          </div>
          <p className="text-[11px] text-[var(--color-text-faint)] sm:col-span-4">
            {basis === "average" ? t("basisAverageHint") : t("basisManualHint")}
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

      <div className="mt-6">
        <p className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">
          {t("calendarTitle")}
        </p>
        <Table>
          <THead>
            <Th>{t("month")}</Th>
            <Th>{t("billsRecorded")}</Th>
            <Th>{t("rateCharged")}</Th>
            <Th>{t("whereFrom")}</Th>
          </THead>
          <TBody>
            {[...branch.months].reverse().map((m) => {
              const isThis = m.month.slice(0, 7) === thisMonth.slice(0, 7);
              return (
                <Tr key={m.month} toneBar={isThis ? "var(--color-accent-blue)" : undefined}>
                  <Td className={isThis ? "font-medium" : "text-[var(--color-text-muted)]"}>
                    {m.month.slice(0, 7)}
                    {isThis && (
                      <span className="ms-2 text-[10px] uppercase tracking-wide text-[var(--color-accent-blue)]">
                        {t("thisMonth")}
                      </span>
                    )}
                  </Td>
                  <Td className="num text-[var(--color-text-muted)]">
                    {m.bills > 0 ? formatMoney(m.recorded, locale) : "—"}
                  </Td>
                  <Td className={`num ${m.enabled ? "font-medium" : "text-[var(--color-text-faint)]"}`}>
                    {m.enabled ? formatMoney(m.rate, locale) : t("feesOff")}
                  </Td>
                  <Td>
                    <div className="flex items-center justify-between gap-2">
                      <StatusPill
                        label={t(`source_${m.source}`)}
                        tone={SOURCE_TONE[m.source]}
                      />
                      {canEdit && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(m)}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-faint)] transition-colors hover:bg-black/[0.04] hover:text-[var(--color-text)]"
                          >
                            <Pencil size={12} />
                            {t("editMonth")}
                          </button>
                          {m.source === "month" && (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => clearMonth(m.month)}
                              title={t("clearMonthHint")}
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-faint)] transition-colors hover:bg-black/[0.04] hover:text-[var(--color-text)] disabled:opacity-50"
                            >
                              <RotateCcw size={12} />
                              {t("clearMonth")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </div>

      {editing && (
        <MonthDialog
          branchId={branch.branch_id}
          branchName={branch.branch_name}
          month={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </Panel>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "amber";
}) {
  return (
    <div className="rounded-lg bg-black/[0.02] px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-text-faint)]">{label}</p>
      <p
        className={`num mt-1 text-base font-semibold ${
          tone === "amber" ? "text-[var(--color-accent-amber)]" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function MonthDialog({
  branchId,
  branchName,
  month,
  onClose,
  onSaved,
}: {
  branchId: string;
  branchName: string;
  month: OverheadMonthView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("fees");
  const common = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(String(month.rate));
  const [enabled, setEnabled] = useState(month.enabled);
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await setOverheadMonth({
        branch_id: branchId,
        period_month: month.month.slice(0, 7),
        rate_amount: Number(rate || "0"),
        enabled,
        note: note.trim() || null,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onSaved();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${branchName} · ${month.month.slice(0, 7)}`}>
        <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {t("monthDialogHint")}
        </p>
        <div className="space-y-3">
          <div>
            <Label>{t("rateCharged")}</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              disabled={!enabled}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent-blue)]"
            />
            {t("chargeThisMonth")}
          </label>
          {!enabled && (
            <p className="flex items-start gap-1.5 rounded-lg border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 px-3 py-2 text-xs text-[var(--color-accent-amber)]">
              <Ban size={13} className="mt-px shrink-0" />
              {t("monthOffHint")}
            </p>
          )}
          <div>
            <Label>{t("noteCol")}</Label>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {common("cancel")}
          </Button>
          <Button variant="accent" onClick={submit} disabled={pending}>
            {common("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
