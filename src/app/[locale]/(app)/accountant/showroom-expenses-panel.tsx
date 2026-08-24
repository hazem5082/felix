"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Plus, Undo2 } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import { formatMoney } from "@/lib/currency";
import { SHOWROOM_EXPENSE_CATEGORIES } from "@/lib/showroom-expenses";
import type { Branch, ShowroomExpense, ShowroomExpenseCategory } from "@/lib/supabase/types";
import {
  createShowroomExpense,
  fetchShowroomExpenses,
  voidShowroomExpense,
} from "../fees/actions";

/**
 * THE SHOWROOM'S OWN BILLS (migration 0050).
 *
 * The electricity, the water, the cleaner, the rent — recorded here, in
 * the hub where the accountant already works, and turned into the
 * monthly fee a car is charged by the CEO's control page at /fees.
 *
 * Self-contained the way ReceivablesPanel is: accountant/page.tsx carries
 * one line for this and the loading, the grouping and the writes all
 * live here. It renders an empty state rather than disappearing when
 * nothing is recorded — an accountant looking for "where do I put the
 * electricity bill" needs to find the panel before there is anything in
 * it.
 *
 * DEGRADES, DOES NOT CRASH. fetchShowroomExpenses() returns [] when the
 * migration has not been applied yet (supabase-js hands back an error
 * rather than throwing), so this is an empty book until the table
 * exists.
 */

/** `YYYY-MM` for the current month, in the browser's own calendar. */
function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function ShowroomExpensesPanel({
  branches,
  canEdit,
}: {
  branches: Branch[];
  /** Accountant or CEO. Everyone else who can see this panel reads it. */
  canEdit: boolean;
}) {
  const t = useTranslations("fees");
  const common = useTranslations("common");
  const locale = useLocale();

  const [rows, setRows] = useState<ShowroomExpense[] | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reload() {
    fetchShowroomExpenses().then(setRows);
  }

  useEffect(() => {
    let active = true;
    fetchShowroomExpenses().then((next) => {
      if (active) setRows(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const branchName = useMemo(
    () => new Map(branches.map((b) => [b.id, b.name])),
    [branches]
  );

  // Newest month first, and within a month the largest bill first — the
  // order somebody checking "what did August cost us" reads in.
  const grouped = useMemo(() => {
    const byMonth = new Map<string, ShowroomExpense[]>();
    for (const r of rows ?? []) {
      const key = r.period_month.slice(0, 7);
      const list = byMonth.get(key) ?? [];
      list.push(r);
      byMonth.set(key, list);
    }
    return [...byMonth.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([month, list]) => ({
        month,
        list: [...list].sort((a, b) => Number(b.amount) - Number(a.amount)),
        total: list
          .filter((e) => !e.voided_at)
          .reduce((s, e) => s + Number(e.amount), 0),
      }));
  }, [rows]);

  function handleVoid(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await voidShowroomExpense(id);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      reload();
    });
  }

  return (
    <Panel>
      <PanelHeader
        title={t("expensesTitle")}
        subtitle={t("expensesHint")}
        action={
          canEdit ? (
            <ExpenseFormDialog branches={branches} onSaved={reload} />
          ) : undefined
        }
      />

      {error && <p className="mb-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

      {rows === null ? (
        <p className="text-xs text-[var(--color-text-faint)]">{common("loading")}</p>
      ) : grouped.length === 0 ? (
        <p className="text-xs text-[var(--color-text-faint)]">{t("noExpenses")}</p>
      ) : (
        <div className="space-y-5">
          {grouped.map((g) => (
            <div key={g.month}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                  {g.month}
                </span>
                <span className="num text-xs font-semibold">
                  {formatMoney(g.total, locale)}
                </span>
              </div>
              <Table>
                <THead>
                  <Th>{t("category")}</Th>
                  <Th>{t("branch")}</Th>
                  <Th>{common("amount")}</Th>
                  <Th>{t("noteCol")}</Th>
                </THead>
                <TBody>
                  {g.list.map((e) => (
                    <Tr key={e.id}>
                      <Td className={e.voided_at ? "text-[var(--color-text-faint)] line-through" : ""}>
                        {t(`category_${e.category}`)}
                      </Td>
                      <Td className="text-[var(--color-text-muted)]">
                        {e.branches?.name ?? branchName.get(e.branch_id) ?? "—"}
                      </Td>
                      <Td
                        className={`num ${
                          e.voided_at ? "text-[var(--color-text-faint)] line-through" : "font-medium"
                        }`}
                      >
                        {formatMoney(Number(e.amount), locale)}
                      </Td>
                      <Td>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {e.note ?? ""}
                          </span>
                          {e.voided_at ? (
                            <StatusPill label={t("voided")} tone="neutral" />
                          ) : canEdit ? (
                            <button
                              type="button"
                              onClick={() => handleVoid(e.id)}
                              disabled={pending}
                              title={t("voidHint")}
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-faint)] transition-colors hover:bg-black/[0.04] hover:text-[var(--color-accent-red)] disabled:opacity-50"
                            >
                              <Undo2 size={12} />
                              {t("void")}
                            </button>
                          ) : null}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ExpenseFormDialog({
  branches,
  onSaved,
}: {
  branches: Branch[];
  onSaved: () => void;
}) {
  const t = useTranslations("fees");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [month, setMonth] = useState(thisMonth());
  const [category, setCategory] = useState<ShowroomExpenseCategory>("electricity");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createShowroomExpense({
        branch_id: branchId,
        period_month: month,
        category,
        amount: Number(amount),
        note: note.trim() || null,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setAmount("");
      setNote("");
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm">
          <Plus size={14} />
          {t("addExpense")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addExpense")}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>{t("branch")}</Label>
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t("month")}</Label>
                {/* A month input, not a date one: the fee calendar works in
                    whole months and the database CHECKs the first of the
                    month, so there is nothing for a day picker to offer. */}
                <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>{t("category")}</Label>
                <Select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ShowroomExpenseCategory)}
                >
                  {SHOWROOM_EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`category_${c}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{common("amount")}</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>{t("noteCol")}</Label>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button
              variant="accent"
              onClick={submit}
              disabled={pending || !branchId || !amount || Number(amount) <= 0}
            >
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
