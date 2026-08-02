"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { UserPlus } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { Branch, Role } from "@/lib/supabase/types";
import { createEmployee } from "./actions";
import { CredentialsNote } from "./credentials-note";

const ROLES: Role[] = ["sales_exec", "branch_manager", "accountant", "investor", "ceo"];
const ORG_WIDE: Role[] = ["ceo", "investor"];

const EMPTY = { full_name: "", email: "", role: "sales_exec" as Role, branch_id: "", phone: "" };

export function EmployeeFormDialog({ branches }: { branches: Branch[] }) {
  const t = useTranslations("employees");
  const roles = useTranslations("roles");
  const common = useTranslations("common");

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const [form, setForm] = useState(EMPTY);

  const needsBranch = !ORG_WIDE.includes(form.role);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createEmployee({
        email: form.email,
        full_name: form.full_name,
        role: form.role,
        branch_id: needsBranch ? form.branch_id || null : null,
        phone: form.phone,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Swap the form for the one-time credentials view. The dialog
      // stays open until the CEO closes it deliberately.
      setCreds({ email: res.email, password: res.temporary_password });
    });
  }

  function close() {
    setOpen(false);
    setForm(EMPTY);
    setCreds(null);
    setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm">
          <UserPlus size={14} />
          {t("addEmployee")}
        </Button>
      </DialogTrigger>

      {open && (
        <DialogContent title={creds ? t("accountCreated") : t("addEmployee")}>
          {creds ? (
            <>
              <CredentialsNote email={creds.email} password={creds.password} />
              <div className="mt-5 flex justify-end">
                <Button variant="primary" onClick={close}>
                  {common("close")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Label>{t("fullName")}</Label>
                  <Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} />
                </div>
                <div className="col-span-2">
                  <Label>{t("email")}</Label>
                  <Input
                    type="email"
                    dir="ltr"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                  />
                </div>
                <div>
                  <Label>{t("role")}</Label>
                  <Select value={form.role} onChange={(e) => set("role", e.target.value)}>
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
                    <Select value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)}>
                      <option value="">{t("selectBranch")}</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input dir="ltr" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
                  )}
                </div>
                {needsBranch && (
                  <div className="col-span-2">
                    <Label>{t("phone")}</Label>
                    <Input dir="ltr" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
                  </div>
                )}
              </div>

              {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  {common("cancel")}
                </Button>
                <Button
                  variant="accent"
                  onClick={submit}
                  disabled={
                    pending ||
                    !form.full_name.trim() ||
                    !form.email.trim() ||
                    (needsBranch && !form.branch_id)
                  }
                >
                  {t("createAccount")}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
