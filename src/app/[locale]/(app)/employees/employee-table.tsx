"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/currency";
import { KeyRound, Pencil } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { Branch, EmploymentType, Role } from "@/lib/supabase/types";
import { resetEmployeePassword, updateEmployee } from "./actions";
import { CredentialsNote } from "./credentials-note";
import { nationalIdInvalid } from "./employee-form";

export interface EmployeeRow {
  id: string;
  full_name: string;
  role: Role;
  branch_id: string | null;
  branch_name: string | null;
  phone: string | null;
  email: string | null;
  // Statutory NOSI data (0018). Rendered only here — this page is
  // already CEO-only, and national ID / insurance number must not leak
  // onto any other surface.
  national_id: string | null;
  social_insurance_number: string | null;
  hire_date: string | null;
  monthly_wage: number | null;
  employment_type: EmploymentType | null;
  created_at: string;
  is_me: boolean;
}

const ROLE_TONE: Record<Role, SemanticTone> = {
  ceo: "blue",
  branch_manager: "green",
  accountant: "amber",
  sales_exec: "neutral",
  marketing: "blue",
  investor: "red",
};

const ROLES: Role[] = ["sales_exec", "marketing", "branch_manager", "accountant", "investor", "ceo"];
const ORG_WIDE: Role[] = ["ceo", "investor", "marketing"];

export function EmployeeTable({ rows, branches }: { rows: EmployeeRow[]; branches: Branch[] }) {
  const t = useTranslations("employees");
  const roles = useTranslations("roles");
  const common = useTranslations("common");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  const [creds, setCreds] = useState<{ email: string; password: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: "",
    role: "sales_exec" as Role,
    branch_id: "",
    phone: "",
    national_id: "",
    social_insurance_number: "",
    hire_date: "",
    monthly_wage: "",
    employment_type: "",
  });

  function beginEdit(row: EmployeeRow) {
    setEditing(row);
    setEditForm({
      full_name: row.full_name,
      role: row.role,
      branch_id: row.branch_id ?? "",
      phone: row.phone ?? "",
      national_id: row.national_id ?? "",
      social_insurance_number: row.social_insurance_number ?? "",
      hire_date: row.hire_date ?? "",
      monthly_wage: row.monthly_wage != null ? String(row.monthly_wage) : "",
      employment_type: row.employment_type ?? "",
    });
    setError(null);
  }

  function reset(row: EmployeeRow) {
    if (!window.confirm(t("confirmReset", { name: row.full_name }))) return;
    setError(null);
    startTransition(async () => {
      const res = await resetEmployeePassword({ profile_id: row.id });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setCreds({ email: res.email, password: res.temporary_password, name: row.full_name });
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError(null);
    const needsBranch = !ORG_WIDE.includes(editForm.role);
    startTransition(async () => {
      const res = await updateEmployee({
        id: editing.id,
        full_name: editForm.full_name,
        role: editForm.role,
        branch_id: needsBranch ? editForm.branch_id || null : null,
        phone: editForm.phone,
        national_id: editForm.national_id,
        social_insurance_number: editForm.social_insurance_number,
        hire_date: editForm.hire_date,
        monthly_wage: editForm.monthly_wage,
        employment_type: editForm.employment_type,
      });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      setEditing(null);
    });
  }

  const needsBranch = !ORG_WIDE.includes(editForm.role);

  return (
    <>
      <Panel>
        <Table>
          <THead>
            <Th>{t("fullName")}</Th>
            <Th>{t("email")}</Th>
            <Th>{t("role")}</Th>
            <Th>{t("branch")}</Th>
            <Th>{t("phone")}</Th>
            {/* Statutory NOSI columns — CEO-only page, sensitive data stays here. */}
            <Th>{t("nationalId")}</Th>
            <Th>{t("insuranceNumber")}</Th>
            <Th>{t("hireDate")}</Th>
            <Th>{t("monthlyWage")}</Th>
            <Th>{t("employmentType")}</Th>
            <Th>{common("actions")}</Th>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <Link
                    href={`/employees/${r.id}`}
                    className="font-medium text-[var(--color-text)] hover:underline"
                  >
                    {r.full_name}
                  </Link>
                  {r.is_me && (
                    <span className="ms-2 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                      {t("you")}
                    </span>
                  )}
                </Td>
                <Td className="text-[var(--color-text-muted)]">
                  <span dir="ltr">{r.email ?? "—"}</span>
                </Td>
                <Td>
                  <StatusPill label={roles(r.role)} tone={ROLE_TONE[r.role]} />
                </Td>
                <Td className="text-[var(--color-text-muted)]">{r.branch_name ?? "—"}</Td>
                <Td className="num text-[var(--color-text-muted)]">
                  <span dir="ltr">{r.phone ?? "—"}</span>
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  <span dir="ltr">{r.national_id ?? "—"}</span>
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  <span dir="ltr">{r.social_insurance_number ?? "—"}</span>
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  <span dir="ltr">{r.hire_date ?? "—"}</span>
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  {r.monthly_wage != null ? formatMoney(r.monthly_wage, locale) : <span dir="ltr">—</span>}
                </Td>
                <Td className="text-[var(--color-text-muted)]">
                  {r.employment_type ? t(r.employment_type === "full_time" ? "fullTime" : "partTime") : "—"}
                </Td>
                <Td>
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => beginEdit(r)} disabled={pending}>
                      <Pencil size={12} />
                      {common("edit")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => reset(r)} disabled={pending}>
                      <KeyRound size={12} />
                      {t("resetPassword")}
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
            {!rows.length && (
              <Tr>
                <Td className="text-center text-[var(--color-text-faint)]">—</Td>
              </Tr>
            )}
          </TBody>
        </Table>
        {error && !editing && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
      </Panel>

      {/* One-time credentials after a reset */}
      <Dialog open={!!creds} onOpenChange={(next) => !next && setCreds(null)}>
        {creds && (
          <DialogContent title={t("passwordResetFor", { name: creds.name })}>
            <CredentialsNote email={creds.email} password={creds.password} />
            <div className="mt-5 flex justify-end">
              <Button variant="primary" onClick={() => setCreds(null)}>
                {common("close")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* Edit role / branch / contact */}
      <Dialog open={!!editing} onOpenChange={(next) => !next && setEditing(null)}>
        {editing && (
          <DialogContent title={t("editEmployee", { name: editing.full_name })}>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>{t("fullName")}</Label>
                <Input
                  value={editForm.full_name}
                  onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))}
                />
              </div>
              <div>
                <Label>{t("role")}</Label>
                <Select
                  value={editForm.role}
                  onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as Role }))}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roles(r)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{needsBranch ? t("branch") : t("phone")}</Label>
                {needsBranch ? (
                  <Select
                    value={editForm.branch_id}
                    onChange={(e) => setEditForm((f) => ({ ...f, branch_id: e.target.value }))}
                  >
                    <option value="">{t("selectBranch")}</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    dir="ltr"
                    value={editForm.phone}
                    onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                  />
                )}
              </div>
              {needsBranch && (
                <div className="col-span-2">
                  <Label>{t("phone")}</Label>
                  <Input
                    dir="ltr"
                    value={editForm.phone}
                    onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                  />
                </div>
              )}

              {/* Statutory data for the monthly NOSI filing — optional. */}
              <div className="col-span-2 mt-1 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                {t("statutorySection")}
              </div>
              <div>
                <Label>{t("nationalId")}</Label>
                <Input
                  dir="ltr"
                  maxLength={14}
                  inputMode="numeric"
                  value={editForm.national_id}
                  onChange={(e) => setEditForm((f) => ({ ...f, national_id: e.target.value }))}
                />
                {nationalIdInvalid(editForm.national_id) && (
                  <p className="mt-1 text-xs text-[var(--color-accent-red)]">{t("nationalIdInvalid")}</p>
                )}
              </div>
              <div>
                <Label>{t("insuranceNumber")}</Label>
                <Input
                  dir="ltr"
                  value={editForm.social_insurance_number}
                  onChange={(e) => setEditForm((f) => ({ ...f, social_insurance_number: e.target.value }))}
                />
              </div>
              <div>
                <Label>{t("hireDate")}</Label>
                <Input
                  type="date"
                  dir="ltr"
                  value={editForm.hire_date}
                  onChange={(e) => setEditForm((f) => ({ ...f, hire_date: e.target.value }))}
                />
              </div>
              <div>
                <Label>{t("monthlyWage")}</Label>
                <Input
                  type="number"
                  dir="ltr"
                  min={0}
                  value={editForm.monthly_wage}
                  onChange={(e) => setEditForm((f) => ({ ...f, monthly_wage: e.target.value }))}
                />
              </div>
              <div className="col-span-2">
                <Label>{t("employmentType")}</Label>
                <Select
                  value={editForm.employment_type}
                  onChange={(e) => setEditForm((f) => ({ ...f, employment_type: e.target.value }))}
                >
                  <option value="">{t("employmentTypeUnset")}</option>
                  <option value="full_time">{t("fullTime")}</option>
                  <option value="part_time">{t("partTime")}</option>
                </Select>
              </div>
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {common("cancel")}
              </Button>
              <Button
                variant="accent"
                onClick={saveEdit}
                disabled={
                  pending ||
                  !editForm.full_name.trim() ||
                  (needsBranch && !editForm.branch_id) ||
                  nationalIdInvalid(editForm.national_id)
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
