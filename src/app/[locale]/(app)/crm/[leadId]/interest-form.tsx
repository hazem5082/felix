"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Plus } from "lucide-react";
import { addLeadInterest, fetchActiveVehicles } from "../actions";

type VehicleOption = {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  purchase_price: number;
};

const EMPTY = {
  vehicle_id: "",
  wanted_make: "",
  wanted_model: "",
  wanted_year: "",
  budget_amount: "",
  origin: "requested" as "requested" | "suggested",
  note: "",
};

/**
 * Links this buyer to a car and records what they will pay for it.
 *
 * The two modes are not a convenience — they are the two halves of the
 * brief. "On the floor" points the buyer at stock the showroom is holding;
 * "not in stock" is the row that records a sale about to be lost for want
 * of the car, which is the entry the CEO's demand report exists to surface
 * and which nothing in the schema could hold before.
 */
export function InterestFormDialog({ leadId }: { leadId: string }) {
  const t = useTranslations("interest");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [inStock, setInStock] = useState(true);
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (open) fetchActiveVehicles().then((v) => setVehicles(v as VehicleOption[]));
  }, [open]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function switchMode(next: boolean) {
    setInStock(next);
    // Clearing the other side matters: the server refuses a row that names
    // no car, and it would silently accept one that names two.
    setForm((f) =>
      next
        ? { ...f, wanted_make: "", wanted_model: "", wanted_year: "" }
        : { ...f, vehicle_id: "", origin: "requested" }
    );
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await addLeadInterest({ lead_id: leadId, ...form });
      if ("error" in res) { setError(res.error); return; }
      setOpen(false);
      setForm(EMPTY);
      setInStock(true);
    });
  }

  const ready = inStock ? !!form.vehicle_id : !!form.wanted_make.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm"><Plus size={14} />{t("add")}</Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("add")}>
          <div className="space-y-3">
            <div>
              <Label>{t("whatTheyWant")}</Label>
              <Select
                value={inStock ? "stock" : "wanted"}
                onChange={(e) => switchMode(e.target.value === "stock")}
              >
                <option value="stock">{t("modeInStock")}</option>
                <option value="wanted">{t("modeNotInStock")}</option>
              </Select>
            </div>

            {inStock ? (
              <>
                <div>
                  <Label>{common("vehicle")}</Label>
                  <Select value={form.vehicle_id} onChange={(e) => set("vehicle_id", e.target.value)}>
                    <option value="">—</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.year} {v.make} {v.model} {v.trim ?? ""} — ${v.purchase_price.toLocaleString()}
                      </option>
                    ))}
                  </Select>
                  {!vehicles.length && (
                    <p className="mt-1 text-xs text-[var(--color-accent-amber)]">{t("noStock")}</p>
                  )}
                </div>
                <div>
                  <Label>{t("origin")}</Label>
                  <Select
                    value={form.origin}
                    onChange={(e) => set("origin", e.target.value as typeof form.origin)}
                  >
                    <option value="requested">{t("originRequested")}</option>
                    <option value="suggested">{t("originSuggested")}</option>
                  </Select>
                  <p className="mt-1 text-xs text-[var(--color-text-faint)]">{t("originHint")}</p>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <Label>{t("wantedMake")}</Label>
                  <Input value={form.wanted_make} onChange={(e) => set("wanted_make", e.target.value)} />
                </div>
                <div className="col-span-1">
                  <Label>{t("wantedModel")}</Label>
                  <Input value={form.wanted_model} onChange={(e) => set("wanted_model", e.target.value)} />
                </div>
                <div className="col-span-1">
                  <Label>{t("wantedYear")}</Label>
                  <Input
                    type="number"
                    value={form.wanted_year}
                    onChange={(e) => set("wanted_year", e.target.value)}
                  />
                </div>
              </div>
            )}

            <div>
              <Label>{t("budget")}</Label>
              <Input
                type="number"
                value={form.budget_amount}
                onChange={(e) => set("budget_amount", e.target.value)}
                placeholder={t("budgetPlaceholder")}
              />
              <p className="mt-1 text-xs text-[var(--color-text-faint)]">{t("budgetHint")}</p>
            </div>

            <div>
              <Label>{common("note")}</Label>
              <Textarea rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} />
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button variant="accent" onClick={submit} disabled={pending || !ready}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
