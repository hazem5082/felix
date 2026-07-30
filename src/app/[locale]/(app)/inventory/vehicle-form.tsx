"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Plus, Trash2, Upload } from "lucide-react";
import { YEARS, fetchMakes, fetchModels, COMMON_TRIMS } from "@/lib/nhtsa";
import { uploadFile } from "@/lib/upload-client";
import { createVehicle, fetchInvestorsForPicker } from "./actions";
import type { Branch } from "@/lib/supabase/types";

interface SplitRow {
  holder_type: "ceo" | "investor";
  holder_id: string;
  percentage: string;
}

export function VehicleFormDialog({ branches }: { branches: Branch[] }) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [vin, setVin] = useState("");
  const [price, setPrice] = useState("");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");

  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const [investors, setInvestors] = useState<{ id: string; profiles?: { full_name: string } }[]>([]);
  const [splits, setSplits] = useState<SplitRow[]>([{ holder_type: "ceo", holder_id: "", percentage: "100" }]);

  useEffect(() => {
    if (open) {
      fetchMakes().then(setMakes);
      fetchInvestorsForPicker().then((rows) => setInvestors(rows as never));
    }
  }, [open]);

  useEffect(() => {
    if (make && year) fetchModels(make, year).then(setModels);
  }, [make, year]);

  const totalPct = splits.reduce((s, r) => s + (parseFloat(r.percentage) || 0), 0);

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setUploading(true);
    try {
      const urls = await Promise.all(files.map((f) => uploadFile(f, "vehicles")));
      setPhotos((p) => [...p, ...urls]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    setError(null);
    if (Math.abs(totalPct - 100) > 0.5) {
      setError(t("splitMustSum"));
      return;
    }
    startTransition(async () => {
      const res = await createVehicle({
        branch_id: branchId,
        vin,
        year: parseInt(year, 10),
        make,
        model,
        trim,
        purchase_price: parseFloat(price),
        photos,
        splits: splits.map((s) => ({
          holder_type: s.holder_type,
          holder_id: s.holder_type === "ceo" ? null : s.holder_id,
          amount_invested: (parseFloat(price || "0") * (parseFloat(s.percentage) || 0)) / 100,
          percentage: parseFloat(s.percentage) || 0,
        })),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm">
          <Plus size={14} />
          {t("addVehicle")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addVehicle")} className="max-w-2xl">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t("branch")}</Label>
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("vin")}</Label>
              <Input value={vin} onChange={(e) => setVin(e.target.value)} placeholder={common("optional")} />
            </div>
            <div>
              <Label>{t("year")}</Label>
              <Select value={year} onChange={(e) => setYear(e.target.value)}>
                {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </div>
            <div>
              <Label>{t("make")}</Label>
              <Select value={make} onChange={(e) => { setMake(e.target.value); setModel(""); }}>
                <option value="">—</option>
                {makes.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </div>
            <div>
              <Label>{t("model")}</Label>
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">—</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
                {model && !models.includes(model) && <option value={model}>{model}</option>}
              </Select>
              <Input
                className="mt-1.5"
                placeholder={misc("customModel")}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("trim")}</Label>
              <Select value={trim} onChange={(e) => setTrim(e.target.value)}>
                <option value="">—</option>
                {COMMON_TRIMS.map((tr) => <option key={tr} value={tr}>{tr}</option>)}
              </Select>
            </div>
            <div>
              <Label>{t("purchasePrice")}</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
          </div>

          <div className="mt-4">
            <Label>{t("photos")}</Label>
            <label className="flex h-20 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent-blue)]/50">
              <Upload size={14} />
              {uploading ? common("uploading") : common("upload")}
              <input type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoUpload} />
            </label>
            {photos.length > 0 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {photos.map((p) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={p} src={p} alt="" className="h-14 w-14 rounded-md object-cover" />
                ))}
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-[var(--color-border)] pt-4">
            <div className="mb-2 flex items-center justify-between">
              <Label className="mb-0">{t("equitySplit")}</Label>
              <span className={`num text-xs ${Math.abs(totalPct - 100) > 0.5 ? "text-[var(--color-accent-red)]" : "text-[var(--color-accent-green)]"}`}>
                {totalPct.toFixed(1)}%
              </span>
            </div>
            <div className="space-y-2">
              {splits.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    value={row.holder_type}
                    onChange={(e) => {
                      const v = e.target.value as "ceo" | "investor";
                      setSplits((s) => s.map((r, idx) => (idx === i ? { ...r, holder_type: v, holder_id: "" } : r)));
                    }}
                    className="w-32"
                  >
                    <option value="ceo">{t("ceoShare")}</option>
                    <option value="investor">{t("investorShare")}</option>
                  </Select>
                  {row.holder_type === "investor" && (
                    <Select
                      value={row.holder_id}
                      onChange={(e) => setSplits((s) => s.map((r, idx) => (idx === i ? { ...r, holder_id: e.target.value } : r)))}
                    >
                      <option value="">—</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>{inv.profiles?.full_name ?? inv.id}</option>
                      ))}
                    </Select>
                  )}
                  <Input
                    type="number"
                    value={row.percentage}
                    onChange={(e) => setSplits((s) => s.map((r, idx) => (idx === i ? { ...r, percentage: e.target.value } : r)))}
                    className="w-24"
                    placeholder="%"
                  />
                  {splits.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSplits((s) => s.filter((_, idx) => idx !== i))}
                      className="text-[var(--color-text-faint)] hover:text-[var(--color-accent-red)]"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setSplits((s) => [...s, { holder_type: "investor", holder_id: "", percentage: "" }])}
            >
              <Plus size={12} /> {t("addInvestorRow")}
            </Button>
          </div>

          {error && (
            <p className="mt-3 rounded-lg bg-[var(--color-accent-red-dim)] px-3 py-2 text-xs text-[var(--color-accent-red)]">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button variant="accent" onClick={submit} disabled={pending || !make || !model || !price}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
