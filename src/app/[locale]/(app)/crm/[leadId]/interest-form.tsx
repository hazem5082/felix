"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Pencil, Plus } from "lucide-react";
import type { LeadInterestStatus, LeadVehicleInterest } from "@/lib/supabase/types";
import { addLeadInterest, fetchActiveVehicles, updateLeadInterest } from "../actions";

type VehicleOption = {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  purchase_price: number;
};

interface InterestForm {
  vehicle_id: string;
  wanted_make: string;
  wanted_model: string;
  wanted_year: string;
  budget_amount: string;
  origin: "requested" | "suggested";
  status: LeadInterestStatus;
  note: string;
}

const EMPTY: InterestForm = {
  vehicle_id: "",
  wanted_make: "",
  wanted_model: "",
  wanted_year: "",
  budget_amount: "",
  origin: "requested",
  status: "open",
  note: "",
};

function vehicleOptionLabel(v: VehicleOption) {
  return `${v.year} ${v.make} ${v.model} ${v.trim ?? ""} — $${v.purchase_price.toLocaleString()}`;
}

/**
 * The fields of one interest, shared by the add and edit dialogs.
 *
 * Split out rather than duplicated because the two must not drift: the
 * mode switch below clears the other half of the form, and a copy that
 * forgot to would submit a row naming both a vehicle and a wanted make —
 * which the server accepts and which then counts the buyer twice in the
 * CEO's demand report, once against the car and once against the text.
 */
function InterestFields({
  form,
  setForm,
  vehicles,
  inStock,
  setInStock,
  showStatus,
}: {
  form: InterestForm;
  setForm: (next: InterestForm) => void;
  vehicles: VehicleOption[];
  inStock: boolean;
  setInStock: (next: boolean) => void;
  showStatus: boolean;
}) {
  const t = useTranslations("interest");
  const common = useTranslations("common");

  function set<K extends keyof InterestForm>(key: K, value: InterestForm[K]) {
    setForm({ ...form, [key]: value });
  }

  function switchMode(next: boolean) {
    setInStock(next);
    // Clearing the other side matters: the server refuses a row that names
    // no car, and it would silently accept one that names two.
    setForm(
      next
        ? { ...form, wanted_make: "", wanted_model: "", wanted_year: "" }
        : { ...form, vehicle_id: "", origin: "requested" }
    );
  }

  return (
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
                  {vehicleOptionLabel(v)}
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
              onChange={(e) => set("origin", e.target.value as InterestForm["origin"])}
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
            <Input
              value={form.wanted_model}
              onChange={(e) => set("wanted_model", e.target.value)}
            />
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

      {showStatus && (
        <div>
          <Label>{t("status")}</Label>
          <Select
            value={form.status}
            onChange={(e) => set("status", e.target.value as LeadInterestStatus)}
          >
            <option value="open">{t("statusOpen")}</option>
            <option value="shown">{t("statusShown")}</option>
            <option value="declined">{t("statusDeclined")}</option>
          </Select>
        </div>
      )}

      <div>
        <Label>{common("note")}</Label>
        <Textarea rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} />
      </div>
    </div>
  );
}

/**
 * Loads the cars a buyer can be pointed at, keeping one already named by
 * this interest in the list even after it leaves the floor.
 *
 * `fetchActiveVehicles` returns `status = 'in_stock'` only, which is
 * right for the picker — you cannot point a new buyer at a sold car. But
 * on the EDIT dialog it is how a linked interest silently loses its car:
 * the select finds no option matching `vehicle_id`, renders the blank
 * one, and the next save writes that blank back. Prepending the current
 * vehicle keeps the field showing what the row actually says.
 */
function useVehicleOptions(open: boolean, current: VehicleOption | null) {
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);

  useEffect(() => {
    if (open) fetchActiveVehicles().then((v) => setVehicles(v as VehicleOption[]));
  }, [open]);

  if (current && !vehicles.some((v) => v.id === current.id)) {
    return [current, ...vehicles];
  }
  return vehicles;
}

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
  const [inStock, setInStock] = useState(true);
  const [form, setForm] = useState<InterestForm>(EMPTY);
  const vehicles = useVehicleOptions(open, null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await addLeadInterest({ lead_id: leadId, ...form });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setForm(EMPTY);
      setInStock(true);
    });
  }

  const ready = inStock ? !!form.vehicle_id : !!form.wanted_make.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm">
          <Plus size={14} />
          {t("add")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("add")}>
          <InterestFields
            form={form}
            setForm={setForm}
            vehicles={vehicles}
            inStock={inStock}
            setInStock={setInStock}
            showStatus={false}
          />
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="accent" onClick={submit} disabled={pending || !ready}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * Revises an interest that is already recorded.
 *
 * A buyer raises their budget, or means the Sport trim rather than the
 * base, or the Hilux they wanted arrives on the floor and the row should
 * name the actual car. Adding a second row for any of those would count
 * them twice in the demand report — `buildDemand()` counts distinct
 * leads per car — so one buyer stays one row and the row is edited.
 */
export function InterestEditDialog({ interest }: { interest: LeadVehicleInterest }) {
  const t = useTranslations("interest");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const current: VehicleOption | null = interest.vehicles
    ? {
        id: interest.vehicles.id,
        year: interest.vehicles.year,
        make: interest.vehicles.make,
        model: interest.vehicles.model,
        trim: interest.vehicles.trim,
        purchase_price: interest.vehicles.purchase_price,
      }
    : null;

  const initial: InterestForm = {
    vehicle_id: interest.vehicle_id ?? "",
    wanted_make: interest.wanted_make ?? "",
    wanted_model: interest.wanted_model ?? "",
    wanted_year: interest.wanted_year !== null ? String(interest.wanted_year) : "",
    budget_amount: interest.budget_amount !== null ? String(interest.budget_amount) : "",
    origin: interest.origin,
    status: interest.status,
    note: interest.note ?? "",
  };

  const [form, setForm] = useState<InterestForm>(initial);
  const [inStock, setInStock] = useState(interest.vehicle_id !== null);
  const vehicles = useVehicleOptions(open, current);

  // Re-seeded on open, for the same reason as the client edit form: the
  // fields outlive a Cancel, and a stale draft resubmitted later would
  // quietly undo whatever landed in between.
  function change(next: boolean) {
    if (next) {
      setForm(initial);
      setInStock(interest.vehicle_id !== null);
      setError(null);
    }
    setOpen(next);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await updateLeadInterest({ id: interest.id, ...form });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
    });
  }

  const ready = inStock ? !!form.vehicle_id : !!form.wanted_make.trim();

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t("edit")}
          className="cursor-pointer rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--color-text)]"
        >
          <Pencil size={14} />
        </button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("edit")}>
          <InterestFields
            form={form}
            setForm={setForm}
            vehicles={vehicles}
            inStock={inStock}
            setInStock={setInStock}
            showStatus
          />
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => change(false)}>
              {common("cancel")}
            </Button>
            <Button variant="accent" onClick={submit} disabled={pending || !ready}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
