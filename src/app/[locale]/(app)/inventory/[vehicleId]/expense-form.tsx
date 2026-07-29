"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Plus } from "lucide-react";
import { addExpense } from "../actions";

export function ExpenseFormDialog({ vehicleId, isCeo }: { vehicleId: string; isCeo: boolean }) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [override, setOverride] = useState(false);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await addExpense({
        vehicle_id: vehicleId,
        category,
        amount: parseFloat(amount),
        note,
        is_ceo_override: isCeo && override,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setCategory("");
      setAmount("");
      setNote("");
      setOverride(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Plus size={14} />{t("addExpense")}</Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addExpense")}>
          <div className="space-y-3">
            <div>
              <Label>{t("category")}</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Repair, detailing, transport…" />
            </div>
            <div>
              <Label>{t("amount")}</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <Label>{t("note")}</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {isCeo && (
              <label className="flex items-center gap-2 text-xs text-[var(--color-accent-amber)]">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                {t("ceoOverride")}
              </label>
            )}
          </div>
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button variant="accent" onClick={submit} disabled={pending || !category || !amount}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
