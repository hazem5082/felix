"use client";

import { useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Pencil, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { MAX_BONUS_UNITS, bonusFor, earnedRung, nextRung, sortLadder } from "@/lib/bonus";
import type { BonusRule } from "@/lib/supabase/types";
import { setBonusRule, setBonusRuleActive } from "../actions";

export interface RosterEntry {
  id: string;
  full_name: string;
  units: number;
}

/**
 * Two tables: the scheme, and what it currently owes.
 *
 * The second is computed entirely from the first by lib/bonus.ts, which
 * is the only implementation of "highest rung reached, not the sum of
 * the rungs below". Recomputing it inline here would be a second
 * implementation of a rule everybody assumes differently.
 */
export function BonusLadder({
  rules,
  roster,
  monthLabel,
}: {
  rules: BonusRule[];
  roster: RosterEntry[];
  monthLabel: string;
}) {
  const t = useTranslations("hr");
  const locale = useLocale();
  const [editing, setEditing] = useState<BonusRule | "new" | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const ladder = useMemo(() => sortLadder(rules), [rules]);
  const earners = useMemo(
    () =>
      roster
        .map((p) => ({
          ...p,
          rung: earnedRung(ladder, p.units),
          amount: bonusFor(ladder, p.units),
          next: nextRung(ladder, p.units),
        }))
        // Highest earner first, then most cars — HR reads this to pay
        // people, and the people being paid are the interesting rows.
        .sort((a, b) => b.amount - a.amount || b.units - a.units),
    [roster, ladder]
  );

  const payable = earners.reduce((sum, e) => sum + e.amount, 0);
  // The rungs still free. A ladder can hold at most fifteen and the
  // dialog must not offer a threshold that already exists — the unique
  // index would refuse it, and "that rung is taken" is a worse
  // explanation than not offering it.
  const takenUnits = new Set(ladder.map((r) => r.min_units));

  function toggleActive(rule: BonusRule) {
    startTransition(async () => {
      await setBonusRuleActive({ id: rule.id, active: !rule.active });
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title={t("ladderTitle")}
          subtitle={t("ladderSubtitle", { max: MAX_BONUS_UNITS })}
          action={
            <Button
              variant="accent"
              size="sm"
              onClick={() => setEditing("new")}
              disabled={takenUnits.size >= MAX_BONUS_UNITS}
            >
              <Plus size={12} />
              {t("addRung")}
            </Button>
          }
        />

        {ladder.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t("ladderEmpty")}</p>
        ) : (
          <Table>
            <THead>
              <Th>{t("colRung")}</Th>
              <Th className="text-end">{t("colBonus")}</Th>
              <Th>{t("colNote")}</Th>
              <Th>{t("colStatus")}</Th>
              <Th className="text-end">{""}</Th>
            </THead>
            <TBody>
              {ladder.map((rule) => (
                <Tr key={rule.id} className={rule.active ? undefined : "opacity-55"}>
                  <Td className="font-medium tabular-nums">
                    {t("rungLabel", { units: rule.min_units })}
                  </Td>
                  <Td className="text-end tabular-nums">
                    {formatMoney(rule.bonus_amount, locale)}
                  </Td>
                  <Td className="text-[var(--color-text-muted)]">{rule.note ?? "—"}</Td>
                  <Td>
                    <span
                      className={
                        rule.active
                          ? "text-xs text-[var(--color-accent-green)]"
                          : "text-xs text-[var(--color-text-faint)]"
                      }
                    >
                      {rule.active ? t("rungActive") : t("rungRetired")}
                    </span>
                  </Td>
                  <Td className="text-end">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(rule)}>
                        <Pencil size={12} />
                        {t("edit")}
                      </Button>
                      <Button
                        variant={rule.active ? "ghost" : "success"}
                        size="sm"
                        disabled={pending}
                        onClick={() => toggleActive(rule)}
                      >
                        <RotateCcw size={12} />
                        {rule.active ? t("retireRung") : t("restoreRung")}
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        {/* The rule everybody assumes differently, stated on the screen
            rather than only in the code that implements it. */}
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">{t("ladderNotCumulative")}</p>
      </Panel>

      <Panel>
        <PanelHeader
          title={t("thisMonthTitle", { month: monthLabel })}
          subtitle={t("thisMonthSubtitle", { amount: formatMoney(payable, locale) })}
        />
        {earners.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t("noSalesStaff")}</p>
        ) : (
          <Table>
            <THead>
              <Th>{t("colEmployee")}</Th>
              <Th className="text-end">{t("colUnits")}</Th>
              <Th>{t("colRungReached")}</Th>
              <Th className="text-end">{t("colEarned")}</Th>
              <Th>{t("colNextRung")}</Th>
            </THead>
            <TBody>
              {earners.map((e) => (
                <Tr key={e.id}>
                  <Td className="font-medium">{e.full_name}</Td>
                  <Td className="text-end tabular-nums">{e.units}</Td>
                  <Td className="text-[var(--color-text-muted)]">
                    {e.rung ? t("rungLabel", { units: e.rung.min_units }) : "—"}
                  </Td>
                  <Td className="text-end tabular-nums font-medium">
                    {e.amount > 0 ? formatMoney(e.amount, locale) : "—"}
                  </Td>
                  <Td className="text-xs text-[var(--color-text-muted)]">
                    {e.next
                      ? t("needsMore", {
                          count: e.next.min_units - e.units,
                          amount: formatMoney(e.next.bonus_amount, locale),
                        })
                      : t("topOfLadder")}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        {/* Said plainly, because a screen that shows an amount owed and
            does not say whether it has been paid invites the assumption
            that it has. */}
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">{t("notAPayment")}</p>
      </Panel>

      <RungDialog
        target={editing}
        takenUnits={takenUnits}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function RungDialog({
  target,
  takenUnits,
  onClose,
}: {
  target: BonusRule | "new" | null;
  takenUnits: ReadonlySet<number>;
  onClose: () => void;
}) {
  const t = useTranslations("hr");
  const common = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const existing = target !== null && target !== "new" ? target : null;
  const [units, setUnits] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  // The dialog is remounted per target (key below), so state seeded
  // here is correct for exactly one rung and cannot leak into the next.
  const [seeded, setSeeded] = useState(false);
  if (!seeded && target !== null) {
    setSeeded(true);
    setUnits(existing ? String(existing.min_units) : "");
    setAmount(existing ? String(existing.bonus_amount) : "");
    setNote(existing?.note ?? "");
  }

  const unitsNum = Number(units);
  const unitsBad =
    !Number.isInteger(unitsNum) || unitsNum < 1 || unitsNum > MAX_BONUS_UNITS;
  // Editing a rung keeps its own threshold; only a NEW rung can collide.
  const unitsTaken =
    !unitsBad && takenUnits.has(unitsNum) && existing?.min_units !== unitsNum;
  const amountNum = Number(amount);
  const amountBad = !Number.isFinite(amountNum) || amountNum < 0 || amount.trim() === "";

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await setBonusRule({
        min_units: unitsNum,
        bonus_amount: amountNum,
        active: existing ? existing.active : true,
        note,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setSeeded(false);
          onClose();
        }
      }}
    >
      {target !== null && (
        <DialogContent title={existing ? t("editRung") : t("addRung")}>
          <div className="space-y-3">
            <div>
              <Label>{t("fieldUnits")}</Label>
              <Input
                type="number"
                dir="ltr"
                min={1}
                max={MAX_BONUS_UNITS}
                step={1}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
              />
              {unitsBad && units !== "" && (
                <p className="mt-1 text-xs text-[var(--color-accent-red)]">
                  {t("unitsRange", { max: MAX_BONUS_UNITS })}
                </p>
              )}
              {unitsTaken && (
                <p className="mt-1 text-xs text-[var(--color-accent-red)]">{t("unitsTaken")}</p>
              )}
            </div>
            <div>
              <Label>{t("fieldBonus")}</Label>
              <Input
                type="number"
                dir="ltr"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("fieldNote")}</Label>
              <Textarea
                rows={2}
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {error && <p className="text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-2 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setSeeded(false);
                  onClose();
                }}
                disabled={pending}
              >
                {common("cancel")}
              </Button>
              <Button
                variant="accent"
                onClick={save}
                disabled={pending || unitsBad || unitsTaken || amountBad}
              >
                {common("save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
