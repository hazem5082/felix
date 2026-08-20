"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Building2, KeyRound, Pencil, X } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { Branch, Role } from "@/lib/supabase/types";
import {
  grantBranchAccess,
  resetEmployeePassword,
  revokeBranchAccess,
  updateEmployee,
} from "./actions";
import { CredentialsNote } from "./credentials-note";

/** One branch granted on top of the home branch (migration 0030). */
export interface GrantedBranch {
  id: string;
  name: string;
  note: string | null;
}

export interface EmployeeRow {
  id: string;
  full_name: string;
  role: Role;
  branch_id: string | null;
  branch_name: string | null;
  /** Live grants only — a revoked one is history, not authority. */
  granted_branches: GrantedBranch[];
  /** False for the org-wide roles and for investors. */
  accepts_grants: boolean;
  phone: string | null;
  email: string | null;
  created_at: string;
  is_me: boolean;
}

const ROLE_TONE: Record<Role, SemanticTone> = {
  ceo: "blue",
  branch_manager: "green",
  accountant: "amber",
  sales_exec: "neutral",
  investor: "red",
};

const ROLES: Role[] = ["sales_exec", "branch_manager", "accountant", "investor", "ceo"];
const ORG_WIDE: Role[] = ["ceo", "investor"];

export function EmployeeTable({ rows, branches }: { rows: EmployeeRow[]; branches: Branch[] }) {
  const t = useTranslations("employees");
  const roles = useTranslations("roles");
  const common = useTranslations("common");
  const [pending, startTransition] = useTransition();

  const [creds, setCreds] = useState<{ email: string; password: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [editForm, setEditForm] = useState({ full_name: "", role: "sales_exec" as Role, branch_id: "", phone: "" });

  // Multi-branch authority. `scoping` is the row whose grants are open;
  // the error banner is shared with the edit dialog, so only one of the
  // two can be open at a time — which is already true, both are modals.
  const [scoping, setScoping] = useState<EmployeeRow | null>(null);
  const [grantForm, setGrantForm] = useState({ branch_id: "", note: "" });

  function beginEdit(row: EmployeeRow) {
    setEditing(row);
    setEditForm({
      full_name: row.full_name,
      role: row.role,
      branch_id: row.branch_id ?? "",
      phone: row.phone ?? "",
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
      });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      setEditing(null);
    });
  }

  function beginScope(row: EmployeeRow) {
    setScoping(row);
    setGrantForm({ branch_id: "", note: "" });
    setError(null);
  }

  function grant() {
    if (!scoping || !grantForm.branch_id) return;
    setError(null);
    startTransition(async () => {
      const res = await grantBranchAccess({
        profile_id: scoping.id,
        branch_id: grantForm.branch_id,
        note: grantForm.note,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // The dialog stays open so the CEO can add a second branch; the
      // page revalidates behind it and `scoping` is re-read from `rows`
      // on the next render.
      setGrantForm({ branch_id: "", note: "" });
    });
  }

  function revoke(row: EmployeeRow, branchId: string) {
    setError(null);
    startTransition(async () => {
      const res = await revokeBranchAccess({ profile_id: row.id, branch_id: branchId });
      if ("error" in res) setError(res.error);
    });
  }

  const needsBranch = !ORG_WIDE.includes(editForm.role);

  // Re-read from `rows` so the chips update after a revalidation rather
  // than showing the snapshot taken when the dialog opened.
  const scopingRow = scoping ? (rows.find((r) => r.id === scoping.id) ?? scoping) : null;

  // A branch already held — as home or as a live grant — is not offered
  // again. The server refuses both cases; this stops the CEO getting
  // there.
  const grantableBranches = scopingRow
    ? branches.filter(
        (b) =>
          b.id !== scopingRow.branch_id &&
          !scopingRow.granted_branches.some((g) => g.id === b.id)
      )
    : [];

  return (
    <>
      <Panel>
        <Table>
          <THead>
            <Th>{t("fullName")}</Th>
            <Th>{t("email")}</Th>
            <Th>{t("role")}</Th>
            <Th>{t("branches")}</Th>
            <Th>{t("phone")}</Th>
            <Th>{common("actions")}</Th>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  {r.full_name}
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
                {/* Home branch first, then whatever 0030 grants on top.
                    One cell, because "which branches does Tarek cover?"
                    is one question. */}
                <Td className="text-[var(--color-text-muted)]">
                  <div className="flex flex-wrap items-center gap-1">
                    <span>{r.branch_name ?? "—"}</span>
                    {r.granted_branches.map((g) => (
                      <span
                        key={g.id}
                        title={g.note ?? undefined}
                        className="inline-flex items-center rounded-md bg-[var(--color-accent-blue-dim)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent-blue)] ring-1 ring-inset ring-[var(--color-accent-blue)]/20"
                      >
                        +{g.name}
                      </span>
                    ))}
                    {r.accepts_grants && (
                      <button
                        type="button"
                        onClick={() => beginScope(r)}
                        disabled={pending}
                        title={t("manageBranches")}
                        aria-label={t("manageBranches")}
                        className="inline-flex items-center rounded-md p-1 text-[var(--color-text-faint)] transition-colors hover:bg-black/[0.04] hover:text-[var(--color-text-muted)] disabled:opacity-50"
                      >
                        <Building2 size={12} />
                      </button>
                    )}
                  </div>
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  <span dir="ltr">{r.phone ?? "—"}</span>
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
        {error && !editing && !scoping && (
          <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>
        )}
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

      {/* Multi-branch authority — home branch plus grants (0030).
          CEO-only, like the rest of this page; branch_grants' insert and
          update policies admit is_ceo() and nobody else, so a hand-rolled
          POST gets the same answer this dialog does. */}
      <Dialog open={!!scoping} onOpenChange={(next) => !next && setScoping(null)}>
        {scopingRow && (
          <DialogContent title={t("branchAccessFor", { name: scopingRow.full_name })}>
            <p className="text-xs text-[var(--color-text-muted)]">{t("branchAccessHelp")}</p>

            <div className="mt-4">
              <Label>{t("homeBranch")}</Label>
              <p className="text-sm">{scopingRow.branch_name ?? "—"}</p>
            </div>

            <div className="mt-4">
              <Label>{t("grantedBranches")}</Label>
              {scopingRow.granted_branches.length ? (
                <ul className="mt-1 space-y-1.5">
                  {scopingRow.granted_branches.map((g) => (
                    <li
                      key={g.id}
                      className="flex items-start justify-between gap-3 rounded-md bg-black/[0.03] px-2.5 py-1.5"
                    >
                      <span className="text-sm">
                        {g.name}
                        {g.note && (
                          <span className="ms-2 text-xs text-[var(--color-text-faint)]">{g.note}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => revoke(scopingRow, g.id)}
                        disabled={pending}
                        title={t("revokeBranch")}
                        aria-label={t("revokeBranch")}
                        className="mt-0.5 shrink-0 rounded-md p-0.5 text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-accent-red)] disabled:opacity-50"
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--color-text-faint)]">{t("noGrantedBranches")}</p>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <Label>{t("grantBranch")}</Label>
                <Select
                  value={grantForm.branch_id}
                  onChange={(e) => setGrantForm((f) => ({ ...f, branch_id: e.target.value }))}
                >
                  <option value="">{t("selectBranch")}</option>
                  {grantableBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t("grantNote")}</Label>
                <Input
                  value={grantForm.note}
                  onChange={(e) => setGrantForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder={t("grantNotePlaceholder")}
                />
              </div>
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setScoping(null)}>
                {common("close")}
              </Button>
              <Button
                variant="accent"
                onClick={grant}
                disabled={pending || !grantForm.branch_id}
              >
                {t("addBranchAccess")}
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
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {common("cancel")}
              </Button>
              <Button
                variant="accent"
                onClick={saveEdit}
                disabled={pending || !editForm.full_name.trim() || (needsBranch && !editForm.branch_id)}
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
