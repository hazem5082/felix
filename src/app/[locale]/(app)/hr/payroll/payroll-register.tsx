"use client";

import { useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Lock, Pencil, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import type { EmploymentType, Role } from "@/lib/supabase/types";
import { updatePayroll } from "../actions";

export interface PayrollRow {
  id: string;
  full_name: string;
  role: Role;
  branch_name: string | null;
  national_id: string | null;
  social_insurance_number: string | null;
  hire_date: string | null;
  monthly_wage: number | null;
  employment_type: EmploymentType | null;
  is_self: boolean;
  is_ceo_row: boolean;
}

/**
 * The register, in two tables.
 *
 * ON THE PAYROLL is anyone with a wage on file; NOT YET is everyone
 * else. That split is the whole of "add a salesman to the payroll" —
 * there is no enrolment flag to toggle, because a wage IS the
 * enrolment and a second boolean saying so would be free to disagree
 * with it. Rendering them apart makes the gap visible without inventing
 * a column.
 *
 * Two rows are read-only, and the lock icon says which and why rather
 * than the row simply refusing to save:
 *
 *   your own      — separation of duties. The payroll arm of
 *                   guard_profile_privilege_columns() (0047) refuses it
 *                   for HR, so this is the UI agreeing with the
 *                   database rather than guarding on its own.
 *   a CEO's       — HR may not touch a CEO's profile at all. A CEO
 *                   viewing this page edits both freely; the
 *                   restriction is on HR, not on the page.
 */
export function PayrollRegister({
  rows,
  viewerIsCeo,
}: {
  rows: PayrollRow[];
  viewerIsCeo: boolean;
}) {
  const t = useTranslations("hr");
  const locale = useLocale();
  const [editing, setEditing] = useState<PayrollRow | null>(null);

  const { onPayroll, notYet } = useMemo(() => {
    return {
      onPayroll: rows.filter((r) => r.monthly_wage != null),
      notYet: rows.filter((r) => r.monthly_wage == null),
    };
  }, [rows]);

  function lockReason(row: PayrollRow): string | null {
    if (viewerIsCeo) return null;
    if (row.is_self) return t("lockedSelf");
    if (row.is_ceo_row) return t("lockedCeo");
    return null;
  }

  const total = onPayroll.reduce((sum, r) => sum + (r.monthly_wage ?? 0), 0);

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title={t("onPayroll")}
          subtitle={t("monthlyTotal", { amount: formatMoney(total, locale) })}
        />
        <RegisterTable
          rows={onPayroll}
          locale={locale}
          t={t}
          lockReason={lockReason}
          onEdit={setEditing}
          emptyLabel={t("nobodyOnPayroll")}
        />
      </Panel>

      {notYet.length > 0 && (
        <Panel>
          <PanelHeader title={t("notOnPayroll")} subtitle={t("notOnPayrollHint")} />
          <RegisterTable
            rows={notYet}
            locale={locale}
            t={t}
            lockReason={lockReason}
            onEdit={setEditing}
            emptyLabel={t("nobodyOnPayroll")}
            addMode
          />
        </Panel>
      )}

      <PayrollDialog row={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function RegisterTable({
  rows,
  locale,
  t,
  lockReason,
  onEdit,
  emptyLabel,
  addMode = false,
}: {
  rows: PayrollRow[];
  locale: string;
  t: (key: string, values?: Record<string, string | number>) => string;
  lockReason: (row: PayrollRow) => string | null;
  onEdit: (row: PayrollRow) => void;
  emptyLabel: string;
  addMode?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)]">{emptyLabel}</p>;
  }

  return (
    <Table>
      <THead>
        <Th>{t("colEmployee")}</Th>
        <Th>{t("colRole")}</Th>
        <Th>{t("colBranch")}</Th>
        <Th className="text-end">{t("colWage")}</Th>
        <Th>{t("colContract")}</Th>
        <Th>{t("colHired")}</Th>
        <Th>{t("colStatutory")}</Th>
        <Th className="text-end">{""}</Th>
      </THead>
      <TBody>
        {rows.map((row) => {
          const locked = lockReason(row);
          // Both statutory identifiers, or the NOSI filing has a gap.
          // Reported per row rather than as a total, because the fix is
          // always on one person's record.
          const statutoryComplete = !!row.national_id && !!row.social_insurance_number;
          return (
            <Tr key={row.id}>
              <Td className="font-medium">{row.full_name}</Td>
              <Td className="text-[var(--color-text-muted)]">{t(`role_${row.role}`)}</Td>
              <Td className="text-[var(--color-text-muted)]">{row.branch_name ?? "—"}</Td>
              <Td className="text-end tabular-nums">
                {row.monthly_wage != null ? formatMoney(row.monthly_wage, locale) : "—"}
              </Td>
              <Td className="text-[var(--color-text-muted)]">
                {row.employment_type ? t(`contract_${row.employment_type}`) : "—"}
              </Td>
              <Td className="tabular-nums text-[var(--color-text-muted)]" dir="ltr">
                {row.hire_date ?? "—"}
              </Td>
              <Td>
                {statutoryComplete ? (
                  <span className="text-xs text-[var(--color-accent-green)]">
                    {t("statutoryComplete")}
                  </span>
                ) : (
                  <span className="text-xs text-[var(--color-accent-red)]">
                    {t("statutoryMissing")}
                  </span>
                )}
              </Td>
              <Td className="text-end">
                {locked ? (
                  <span
                    title={locked}
                    className="inline-flex items-center gap-1 text-xs text-[var(--color-text-faint)]"
                  >
                    <Lock size={12} />
                    {locked}
                  </span>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => onEdit(row)}>
                    {addMode ? <UserPlus size={12} /> : <Pencil size={12} />}
                    {addMode ? t("addToPayroll") : t("edit")}
                  </Button>
                )}
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

function PayrollDialog({ row, onClose }: { row: PayrollRow | null; onClose: () => void }) {
  const t = useTranslations("hr");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Keyed on the row id so opening a second person resets the fields —
  // without the key, React keeps the previous employee's wage in state
  // and HR saves it onto the wrong person.
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      {row && (
        <DialogContent title={t("payrollFor", { name: row.full_name })}>
          <PayrollForm
            key={row.id}
            row={row}
            pending={pending}
            error={error}
            onCancel={onClose}
            onSave={(values) => {
              setError(null);
              startTransition(async () => {
                const res = await updatePayroll({ profile_id: row.id, ...values });
                if ("error" in res) {
                  setError(res.error);
                  return;
                }
                onClose();
                router.refresh();
              });
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

interface PayrollValues {
  monthly_wage: string;
  employment_type: string;
  hire_date: string;
  national_id: string;
  social_insurance_number: string;
}

function PayrollForm({
  row,
  pending,
  error,
  onCancel,
  onSave,
}: {
  row: PayrollRow;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (values: PayrollValues) => void;
}) {
  const t = useTranslations("hr");
  const common = useTranslations("common");
  const [form, setForm] = useState<PayrollValues>({
    monthly_wage: row.monthly_wage != null ? String(row.monthly_wage) : "",
    employment_type: row.employment_type ?? "",
    hire_date: row.hire_date ?? "",
    national_id: row.national_id ?? "",
    social_insurance_number: row.social_insurance_number ?? "",
  });

  function set<K extends keyof PayrollValues>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // 14 digits exactly, matching profiles_national_id_check (0018).
  // Checked here so the message names the field instead of arriving as
  // a raw constraint violation.
  const nationalIdBad =
    form.national_id.trim().length > 0 && !/^\d{14}$/.test(form.national_id.trim());

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("fieldWage")}</Label>
          <Input
            type="number"
            dir="ltr"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder={t("fieldWagePlaceholder")}
            value={form.monthly_wage}
            onChange={(e) => set("monthly_wage", e.target.value)}
          />
        </div>
        <div>
          <Label>{t("fieldContract")}</Label>
          <Select
            value={form.employment_type}
            onChange={(e) => set("employment_type", e.target.value)}
          >
            <option value="">{t("fieldUnset")}</option>
            <option value="full_time">{t("contract_full_time")}</option>
            <option value="part_time">{t("contract_part_time")}</option>
          </Select>
        </div>
        <div>
          <Label>{t("fieldHired")}</Label>
          <Input
            type="date"
            dir="ltr"
            value={form.hire_date}
            onChange={(e) => set("hire_date", e.target.value)}
          />
        </div>
        <div>
          <Label>{t("fieldInsurance")}</Label>
          <Input
            dir="ltr"
            value={form.social_insurance_number}
            onChange={(e) => set("social_insurance_number", e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label>{t("fieldNationalId")}</Label>
          <Input
            dir="ltr"
            inputMode="numeric"
            maxLength={14}
            value={form.national_id}
            onChange={(e) => set("national_id", e.target.value)}
          />
          {nationalIdBad && (
            <p className="mt-1 text-xs text-[var(--color-accent-red)]">{t("nationalIdLength")}</p>
          )}
        </div>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">{t("payrollHint")}</p>

      {error && <p className="text-xs text-[var(--color-accent-red)]">{error}</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          {common("cancel")}
        </Button>
        <Button
          variant="accent"
          onClick={() => onSave(form)}
          disabled={pending || nationalIdBad}
        >
          {common("save")}
        </Button>
      </div>
    </div>
  );
}
