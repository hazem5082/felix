"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Select } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import { chequeMaturityWeeks, type ChequeStatus } from "@/lib/receivables";
import { fetchReceivablesOverview, type ReceivablesOverview } from "./receivables-actions";

/**
 * THE IN-HOUSE RECEIVABLE BOOK, ORG-WIDE (migration 0033).
 *
 * Self-contained: accountant/page.tsx carries one line for this, and the
 * data, the filtering and the arithmetic all live here or in
 * receivables-actions.ts. Read-only by design — a plan is opened and a
 * payment is taken on the deal it belongs to, where the person doing it
 * can see the car, the customer and the cheques together. This screen
 * answers the two questions the hub is for: how much are we owed, and
 * what is late.
 *
 * Scope is whatever can_read_branch() admits: everything for the CEO and
 * the accountant, one branch (plus 0030 grants) for everybody else. No
 * branch picker, because there is nothing to pick between for the people
 * who can see more than one — the aging is the group's.
 */

const FILTERS = ["all", "overdue", "active", "settled", "defaulted"] as const;
type Filter = (typeof FILTERS)[number];

const CHEQUE_TONE: Record<ChequeStatus, SemanticTone> = {
  in_safe: "blue",
  deposited: "amber",
  cleared: "green",
  bounced: "red",
  returned_to_customer: "neutral",
};

function dayOf(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

export function ReceivablesPanel() {
  const t = useTranslations("receivables");
  const common = useTranslations("common");
  const locale = useLocale();
  const fmt = useFormatter();

  const [data, setData] = useState<ReceivablesOverview | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let active = true;
    fetchReceivablesOverview().then((next) => {
      if (active) setData(next);
    });
    return () => {
      active = false;
    };
  }, []);

  if (data === null) {
    return (
      <Panel>
        <PanelHeader title={t("hubTitle")} subtitle={t("hubSubtitle")} />
        <p className="text-xs text-[var(--color-text-faint)]">{common("loading")}</p>
      </Panel>
    );
  }

  // Nothing lent, nothing to say. The hub is already long, and an empty
  // ageing table teaches nobody anything.
  if (data.plans.length === 0 && data.bouncedCheques.length === 0) return null;

  const plans = data.plans.filter((p) =>
    filter === "all"
      ? true
      : filter === "overdue"
        ? p.overdueCount > 0
        : p.status === filter
  );

  const weeks = chequeMaturityWeeks(
    data.upcomingCheques.map((c) => ({ ...c, amount: Number(c.amount) })),
    data.today
  );

  const { aging } = data;

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title={t("hubTitle")}
          subtitle={t("hubSubtitle")}
          action={
            <Select
              className="h-8 w-auto text-xs"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {t(`filter_${f}`)}
                </option>
              ))}
            </Select>
          }
        />

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Figure
            label={t("totalOutstanding")}
            value={formatMoney(data.totalOutstanding, locale)}
          />
          <Figure
            label={t("overdueTotal")}
            value={formatMoney(aging.overdue, locale)}
            tone={aging.overdue > 0 ? "red" : undefined}
          />
          <Figure label={t("activePlans")} value={String(data.activeCount)} />
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{t("aging")}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Bucket label={t("aging_current")} value={aging.current} locale={locale} />
            <Bucket label={t("aging_0_30")} value={aging.d0_30} locale={locale} late />
            <Bucket label={t("aging_31_60")} value={aging.d31_60} locale={locale} late />
            <Bucket label={t("aging_61_90")} value={aging.d61_90} locale={locale} late />
            <Bucket label={t("aging_90plus")} value={aging.d90plus} locale={locale} late />
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">{t("agingHint")}</p>
        </div>

        <Table>
          <THead>
            <Th>{common("vehicle")}</Th>
            <Th>{t("branch")}</Th>
            <Th className="text-end">{t("outstanding")}</Th>
            <Th className="text-end">{t("overdue")}</Th>
            <Th>{t("nextDue")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {plans.map((p) => (
              <Tr key={p.id} toneBar={p.overdueCount > 0 ? "var(--color-accent-red)" : undefined}>
                <Td>
                  <Link
                    href={`/${locale}/deals/${p.ticketId}`}
                    className="hover:text-[var(--color-accent)]"
                  >
                    {p.vehicle ?? common("dealTicket")}
                  </Link>
                </Td>
                <Td className="text-xs text-[var(--color-text-muted)]">
                  {data.branchNames[p.branchId] ?? "—"}
                </Td>
                <Td className="num text-end">{formatMoney(p.outstanding, locale)}</Td>
                <Td
                  className={
                    p.overdueAmount > 0
                      ? "num text-end text-[var(--color-accent-red)]"
                      : "num text-end text-[var(--color-text-faint)]"
                  }
                >
                  {p.overdueAmount > 0 ? formatMoney(p.overdueAmount, locale) : "—"}
                </Td>
                <Td className="text-xs">
                  {p.nextDue ? fmt.dateTime(dayOf(p.nextDue), { dateStyle: "medium" }) : "—"}
                </Td>
                <Td>
                  <StatusPill
                    label={t(`planStatus_${p.status}`)}
                    tone={
                      p.status === "settled" ? "green" : p.status === "defaulted" ? "red" : "blue"
                    }
                  />
                </Td>
              </Tr>
            ))}
            {plans.length === 0 && (
              <Tr>
                <Td className="text-center text-[var(--color-text-faint)]">{t("noPlans")}</Td>
              </Tr>
            )}
          </TBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHeader title={t("chequeCalendar")} subtitle={t("chequeCalendarSubtitle")} />
        {weeks.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">{t("noUpcomingCheques")}</p>
        ) : (
          <div className="space-y-4">
            {weeks.map((week) => (
              <div key={week.weekStart}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] pb-1">
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <CalendarClock size={12} />
                    {t("weekOf", {
                      date: fmt.dateTime(dayOf(week.weekStart), { dateStyle: "medium" }),
                    })}
                  </p>
                  <p className="num text-xs font-medium">{formatMoney(week.total, locale)}</p>
                </div>
                <div className="space-y-1">
                  {week.cheques.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <span className="text-[var(--color-text-muted)]">
                        {fmt.dateTime(dayOf(c.due_date), { day: "2-digit", month: "short" })} ·{" "}
                        <span className="num" dir="ltr">
                          {c.cheque_number}
                        </span>{" "}
                        · {c.bank_name} · {c.drawer_name}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="num font-medium">
                          {formatMoney(Number(c.amount), locale)}
                        </span>
                        <StatusPill
                          label={t(`chequeStatus_${c.status}`)}
                          tone={CHEQUE_TONE[c.status]}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {data.bouncedCheques.length > 0 && (
          <div className="mt-5 rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/[0.06] p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent-red)]">
              <AlertTriangle size={13} />
              {t("bouncedCheques", { count: data.bouncedCheques.length })}
            </p>
            <div className="space-y-1">
              {data.bouncedCheques.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span className="text-[var(--color-text-muted)]">
                    <span className="num" dir="ltr">
                      {c.cheque_number}
                    </span>{" "}
                    · {c.bank_name} · {c.drawer_name} ·{" "}
                    {fmt.dateTime(dayOf(c.due_date), { dateStyle: "medium" })}
                  </span>
                  <span className="num font-medium text-[var(--color-accent-red)]">
                    {formatMoney(Number(c.amount), locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "red";
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--color-text-muted)]">{label}</p>
      <p
        className={
          tone === "red"
            ? "num mt-0.5 text-sm font-medium text-[var(--color-accent-red)]"
            : "num mt-0.5 text-sm font-medium"
        }
      >
        {value}
      </p>
    </div>
  );
}

function Bucket({
  label,
  value,
  locale,
  late,
}: {
  label: string;
  value: number;
  locale: string;
  late?: boolean;
}) {
  const dim = value === 0;
  return (
    <div
      className={
        late && !dim
          ? "rounded-lg border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/[0.05] px-2.5 py-2"
          : "rounded-lg border border-[var(--color-border)] px-2.5 py-2"
      }
    >
      <p className="text-[11px] text-[var(--color-text-muted)]">{label}</p>
      <p
        className={
          dim
            ? "num mt-0.5 text-xs text-[var(--color-text-faint)]"
            : late
              ? "num mt-0.5 text-xs font-medium text-[var(--color-accent-red)]"
              : "num mt-0.5 text-xs font-medium"
        }
      >
        {formatMoney(value, locale)}
      </p>
    </div>
  );
}
