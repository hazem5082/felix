"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { AlertTriangle, BanknoteArrowDown, CalendarClock, Plus, Wallet } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import {
  CHEQUE_TRANSITIONS,
  buildSchedule,
  isLineOverdue,
  lineRemaining,
  planSummary,
  toIsoDate,
  type ChequeStatus,
  type PlanLine,
} from "@/lib/receivables";
import type { Cheque, DealTicket, ReceiptMethod } from "@/lib/supabase/types";
import {
  addCheque,
  createInstallmentPlan,
  fetchInstallmentBook,
  recordInstallmentPayment,
  updateChequeStatus,
  type InstallmentBook,
} from "./installment-actions";

/**
 * THE IN-HOUSE RECEIVABLE BOOK for one deal ticket (migration 0033).
 *
 * Self-contained on purpose: ticket-panel.tsx carries exactly one line
 * for this, and everything else — the permission check, the data, the
 * dialogs — lives here. It loads through a server action rather than
 * props for the same reason the waterfall preview does: the panel
 * refreshes itself after each write without the page having to know
 * anything about instalments.
 *
 * Renders NOTHING unless the ticket is the showroom's own book: on
 * instalments, with no financing partner. A bank-financed deal has
 * financing_requests and the accountant's partner matrix; a cash deal
 * has nothing to schedule.
 */
const METHODS: ReceiptMethod[] = ["cash", "bank_transfer", "cheque", "instapay"];

const CHEQUE_TONE: Record<ChequeStatus, SemanticTone> = {
  in_safe: "blue",
  deposited: "amber",
  cleared: "green",
  bounced: "red",
  returned_to_customer: "neutral",
};

/**
 * A calendar day rendered at local NOON. `new Date('2026-09-01')` is UTC
 * midnight, which in any negative-offset zone formats as 31 August — a
 * whole schedule shifted a day for a viewer in Cairo who happens to be
 * travelling.
 */
function dayOf(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

export function InstallmentsPanel({ ticket }: { ticket: DealTicket }) {
  const t = useTranslations("receivables");
  const common = useTranslations("common");
  const locale = useLocale();
  const fmt = useFormatter();

  const [book, setBook] = useState<InstallmentBook | null>(null);
  const [today] = useState(() => toIsoDate(new Date()));

  const inHouse =
    ticket.financing_type === "installments" && ticket.financing_partner_id === null;

  const reload = useCallback(async () => {
    const next = await fetchInstallmentBook(ticket.id);
    setBook(next);
  }, [ticket.id]);

  useEffect(() => {
    if (!inHouse) return;
    let active = true;
    fetchInstallmentBook(ticket.id).then((next) => {
      if (active) setBook(next);
    });
    return () => {
      active = false;
    };
  }, [inHouse, ticket.id]);

  if (!inHouse) return null;

  const lines: PlanLine[] = (book?.lines ?? []).map((l) => ({
    id: l.id,
    seq: l.seq,
    due_date: l.due_date,
    amount_due: Number(l.amount_due),
    amount_paid: Number(l.amount_paid),
  }));
  const summary = planSummary(lines, today);
  const plan = book?.plan ?? null;
  const canManage = book?.canManage ?? false;

  return (
    <div className="space-y-6 md:col-span-2">
      <Panel>
        <PanelHeader
          title={t("title")}
          subtitle={t("subtitle")}
          action={
            plan ? (
              <div className="flex items-center gap-2">
                <StatusPill
                  label={t(`planStatus_${plan.status}`)}
                  tone={
                    plan.status === "settled"
                      ? "green"
                      : plan.status === "defaulted"
                        ? "red"
                        : "blue"
                  }
                />
                {canManage && plan.status !== "settled" && lines.length > 0 && (
                  <PaymentDialog
                    planId={plan.id}
                    outstanding={summary.outstanding}
                    onDone={reload}
                  />
                )}
              </div>
            ) : canManage && ticket.status === "executed" ? (
              <CreatePlanDialog
                ticketId={ticket.id}
                agreedPrice={Number(ticket.agreed_price)}
                downPayment={ticket.down_payment === null ? 0 : Number(ticket.down_payment)}
                onDone={reload}
              />
            ) : undefined
          }
        />

        {book === null ? (
          <p className="text-xs text-[var(--color-text-faint)]">{common("loading")}</p>
        ) : !plan ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            {ticket.status === "executed" ? t("noPlan") : t("notExecuted")}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label={t("outstanding")} value={formatMoney(summary.outstanding, locale)} />
              <Figure label={t("paid")} value={formatMoney(summary.paid, locale)} />
              <Figure
                label={t("nextDue")}
                value={
                  summary.nextDue
                    ? fmt.dateTime(dayOf(summary.nextDue.due_date), { dateStyle: "medium" })
                    : "—"
                }
              />
              <Figure
                label={t("monthlyAmount")}
                value={formatMoney(Number(plan.monthly_amount), locale)}
              />
            </div>

            {summary.overdueCount > 0 && (
              <p className="flex items-center gap-2 rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 px-3 py-2 text-xs text-[var(--color-accent-red)]">
                <AlertTriangle size={14} />
                {t("overdueBanner", {
                  count: summary.overdueCount,
                  amount: formatMoney(summary.overdueAmount, locale),
                })}
              </p>
            )}

            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              <Term label={t("principal")} value={formatMoney(Number(plan.principal), locale)} />
              <Term
                label={t("rate")}
                value={plan.annual_flat_rate === null ? t("interestFree") : `${plan.annual_flat_rate}%`}
              />
              <Term label={t("months")} value={String(plan.months)} />
              <Term
                label={t("totalPayable")}
                value={formatMoney(Number(plan.total_payable), locale)}
              />
            </dl>

            {plan.ownership_retained && (
              <p className="text-xs text-[var(--color-text-muted)]">{t("ownershipRetainedNote")}</p>
            )}
            {plan.notes && <p className="text-xs text-[var(--color-text-muted)]">{plan.notes}</p>}

            <Table>
              <THead>
                <Th className="w-12">#</Th>
                <Th>{t("dueDate")}</Th>
                <Th className="text-end">{t("amountDue")}</Th>
                <Th className="text-end">{t("amountPaid")}</Th>
                <Th>{common("status")}</Th>
              </THead>
              <TBody>
                {lines.map((line) => {
                  const remaining = lineRemaining(line);
                  const overdue = isLineOverdue(line, today);
                  return (
                    <Tr
                      key={line.seq}
                      toneBar={overdue ? "var(--color-accent-red)" : undefined}
                    >
                      <Td className="num text-[var(--color-text-faint)]">{line.seq}</Td>
                      <Td>{fmt.dateTime(dayOf(line.due_date), { dateStyle: "medium" })}</Td>
                      <Td className="num text-end">{formatMoney(line.amount_due, locale)}</Td>
                      <Td className="num text-end">{formatMoney(line.amount_paid, locale)}</Td>
                      <Td>
                        <StatusPill
                          label={
                            remaining <= 0
                              ? t("linePaid")
                              : overdue
                                ? t("lineOverdue")
                                : line.amount_paid > 0
                                  ? t("linePartial")
                                  : t("linePending")
                          }
                          tone={
                            remaining <= 0
                              ? "green"
                              : overdue
                                ? "red"
                                : line.amount_paid > 0
                                  ? "amber"
                                  : "neutral"
                          }
                        />
                      </Td>
                    </Tr>
                  );
                })}
                {lines.length === 0 && (
                  <Tr>
                    <Td className="text-center text-[var(--color-text-faint)]">
                      {t("noSchedule")}
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </div>
        )}
      </Panel>

      {book !== null && (
        <Panel>
          <PanelHeader
            title={t("cheques")}
            subtitle={t("chequesSubtitle")}
            action={
              canManage ? (
                <ChequeDialog
                  ticketId={ticket.id}
                  planId={plan?.id ?? null}
                  suggestedAmount={plan ? Number(plan.monthly_amount) : null}
                  onDone={reload}
                />
              ) : undefined
            }
          />
          {book.cheques.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">{t("noCheques")}</p>
          ) : (
            <div className="space-y-2">
              {book.cheques.map((cheque) => (
                <ChequeRow
                  key={cheque.id}
                  cheque={cheque}
                  canManage={canManage}
                  onDone={reload}
                />
              ))}
            </div>
          )}
        </Panel>
      )}

      {book !== null && book.receipts.length > 0 && (
        <Panel>
          <PanelHeader title={t("receipts")} subtitle={t("receiptsSubtitle")} />
          <Table>
            <THead>
              <Th>{t("receivedAt")}</Th>
              <Th>{t("method")}</Th>
              <Th>{t("reference")}</Th>
              <Th className="text-end">{common("amount")}</Th>
            </THead>
            <TBody>
              {book.receipts.map((r) => (
                <Tr key={r.id}>
                  <Td>{fmt.dateTime(new Date(r.received_at), { dateStyle: "medium" })}</Td>
                  <Td>{t(`method_${r.method}`)}</Td>
                  <Td className="num text-xs" dir="ltr">
                    {r.reference ?? "—"}
                  </Td>
                  <Td className="num text-end">{formatMoney(Number(r.amount), locale)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Panel>
      )}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--color-text-muted)]">{label}</p>
      <p className="num mt-0.5 text-sm font-medium">{value}</p>
    </div>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="num font-medium">{value}</dd>
    </div>
  );
}

/**
 * Opening the book. The schedule preview is built by the SAME function
 * the server action inserts from, so what the salesperson shows the
 * customer is what gets written — see src/lib/receivables.ts.
 */
function CreatePlanDialog({
  ticketId,
  agreedPrice,
  downPayment,
  onDone,
}: {
  ticketId: string;
  agreedPrice: number;
  downPayment: number;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("receivables");
  const common = useTranslations("common");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [principal, setPrincipal] = useState(String(Math.max(agreedPrice - downPayment, 0)));
  const [rate, setRate] = useState("");
  const [months, setMonths] = useState("24");
  const [startDate, setStartDate] = useState(() => toIsoDate(new Date()));
  const [ownership, setOwnership] = useState(true);
  const [notes, setNotes] = useState("");

  let preview: ReturnType<typeof buildSchedule> | null = null;
  let previewError: string | null = null;
  try {
    preview = buildSchedule({
      principal: Number(principal),
      annualFlatRate: rate.trim() === "" ? null : Number(rate),
      months: Number(months),
      startDate,
    });
  } catch (err) {
    previewError = err instanceof Error ? err.message : null;
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createInstallmentPlan({
        ticketId,
        principal: Number(principal),
        annual_flat_rate: rate.trim() === "" ? null : rate.trim(),
        months: Number(months),
        start_date: startDate,
        ownership_retained: ownership,
        notes: notes.trim() === "" ? null : notes.trim(),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      await onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm">
          <Plus size={14} />
          {t("createPlan")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("createPlan")}>
          <div className="space-y-3">
            <div>
              <Label>{t("principal")}</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {t("principalHint")}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>{t("rate")}</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="7.5"
                />
              </div>
              <div>
                <Label>{t("months")}</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                />
              </div>
              <div>
                <Label>{t("startDate")}</Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)]">{t("rateHint")}</p>

            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ownership}
                onChange={(e) => setOwnership(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent-blue)]"
              />
              {t("ownershipRetained")}
            </label>

            <div>
              <Label>{common("note")}</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            <div className="rounded-lg border border-[var(--color-border)] bg-black/[0.02] p-3">
              <p className="mb-2 text-xs font-medium">{t("schedulePreview")}</p>
              {preview ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <Term label={t("interest")} value={formatMoney(preview.interest, locale)} />
                  <Term
                    label={t("totalPayable")}
                    value={formatMoney(preview.totalPayable, locale)}
                  />
                  <Term
                    label={t("monthlyAmount")}
                    value={formatMoney(preview.monthlyAmount, locale)}
                  />
                  <Term
                    label={t("lastInstalment")}
                    value={formatMoney(
                      preview.lines[preview.lines.length - 1].amount_due,
                      locale
                    )}
                  />
                </dl>
              ) : (
                <p className="text-xs text-[var(--color-accent-amber)]">
                  {previewError ?? t("previewUnavailable")}
                </p>
              )}
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="accent" onClick={submit} disabled={pending || !preview}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Taking an instalment. Allocation is oldest-unpaid-first, server-side. */
function PaymentDialog({
  planId,
  outstanding,
  onDone,
}: {
  planId: string;
  outstanding: number;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("receivables");
  const common = useTranslations("common");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [payer, setPayer] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await recordInstallmentPayment({
        planId,
        amount: Number(amount),
        method,
        reference: reference.trim() === "" ? null : reference.trim(),
        payer_name: payer.trim() === "" ? null : payer.trim(),
        note: note.trim() === "" ? null : note.trim(),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setAmount("");
      setReference("");
      await onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="success" size="sm">
          <BanknoteArrowDown size={14} />
          {t("recordPayment")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("recordPayment")}>
          <div className="space-y-3">
            <div>
              <Label>{common("amount")}</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {t("outstandingHint", { amount: formatMoney(outstanding, locale) })}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>{t("method")}</Label>
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`method_${m}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t("reference")}</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  dir="ltr"
                />
              </div>
            </div>
            <div>
              <Label>{t("payerName")}</Label>
              <Input value={payer} onChange={(e) => setPayer(e.target.value)} />
            </div>
            <div>
              <Label>{common("note")}</Label>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)]">{t("allocationHint")}</p>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="accent" onClick={submit} disabled={pending || amount.trim() === ""}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function ChequeDialog({
  ticketId,
  planId,
  suggestedAmount,
  onDone,
}: {
  ticketId: string;
  planId: string | null;
  suggestedAmount: number | null;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("receivables");
  const common = useTranslations("common");

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [number, setNumber] = useState("");
  const [bank, setBank] = useState("");
  const [drawer, setDrawer] = useState("");
  const [amount, setAmount] = useState(suggestedAmount ? String(suggestedAmount) : "");
  const [dueDate, setDueDate] = useState(() => toIsoDate(new Date()));
  const [status, setStatus] = useState<string>("in_safe");
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await addCheque({
        ticketId,
        planId,
        cheque_number: number.trim(),
        bank_name: bank.trim(),
        drawer_name: drawer.trim(),
        amount: Number(amount),
        due_date: dueDate,
        status,
        note: note.trim() === "" ? null : note.trim(),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setNumber("");
      setNote("");
      await onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus size={14} />
          {t("addCheque")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addCheque")}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>{t("chequeNumber")}</Label>
                <Input value={number} onChange={(e) => setNumber(e.target.value)} dir="ltr" />
              </div>
              <div>
                <Label>{t("bankName")}</Label>
                <Input value={bank} onChange={(e) => setBank(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>{t("drawerName")}</Label>
              <Input value={drawer} onChange={(e) => setDrawer(e.target.value)} />
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t("drawerHint")}</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>{common("amount")}</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div>
                <Label>{t("dueDate")}</Label>
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
              <div>
                <Label>{common("status")}</Label>
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="in_safe">{t("chequeStatus_in_safe")}</option>
                  <option value="deposited">{t("chequeStatus_deposited")}</option>
                </Select>
              </div>
            </div>
            <div>
              <Label>{common("note")}</Label>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="accent" onClick={submit} disabled={pending}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * One cheque in the safe, with the moves it may actually make.
 *
 * The menu is built from CHEQUE_TRANSITIONS, which is the same table
 * guard_cheque_status() enforces — so it never offers a move the
 * database will refuse, and a cleared cheque simply has no menu.
 */
function ChequeRow({
  cheque,
  canManage,
  onDone,
}: {
  cheque: Cheque;
  canManage: boolean;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("receivables");
  const locale = useLocale();
  const fmt = useFormatter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const moves = CHEQUE_TRANSITIONS[cheque.status] ?? [];

  function move(next: string) {
    setError(null);
    startTransition(async () => {
      const res = await updateChequeStatus({
        chequeId: cheque.id,
        status: next,
        note: cheque.note,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      await onDone();
    });
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            <span className="num" dir="ltr">
              {cheque.cheque_number}
            </span>{" "}
            · {cheque.bank_name}
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {cheque.drawer_name} ·{" "}
            <CalendarClock size={11} className="inline align-[-1px]" />{" "}
            {fmt.dateTime(dayOf(cheque.due_date), { dateStyle: "medium" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="num text-sm font-medium">
            {formatMoney(Number(cheque.amount), locale)}
          </span>
          <StatusPill
            label={t(`chequeStatus_${cheque.status}`)}
            tone={CHEQUE_TONE[cheque.status]}
          />
          {canManage && moves.length > 0 && (
            <Select
              className="h-8 w-auto text-xs"
              value=""
              disabled={pending}
              onChange={(e) => {
                if (e.target.value) move(e.target.value);
              }}
            >
              <option value="">{t("moveCheque")}</option>
              {moves.map((m) => (
                <option key={m} value={m}>
                  {t(`chequeStatus_${m}`)}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-[var(--color-accent-red)]">{error}</p>}
      {cheque.note && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
          <Wallet size={11} />
          {cheque.note}
        </p>
      )}
    </div>
  );
}
