"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Plus, Trash2, Upload, FolderUp } from "lucide-react";
import { YEARS, fetchMakes, fetchModels, COMMON_TRIMS, COMMON_COLORS } from "@/lib/nhtsa";
import { uploadFile } from "@/lib/upload-client";
import { colorSwatch } from "@/lib/vehicle-color";
import { BrandMark } from "@/components/ui/brand-mark";
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
  // Colours are stored in vehicles.color as canonical English (see
  // COMMON_COLORS) and rendered through this namespace, so the Arabic UI
  // shows Arabic names without the database holding two spellings.
  const colors = useTranslations("colors");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [color, setColor] = useState("");
  const [vin, setVin] = useState("");
  const [price, setPrice] = useState("");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");

  const [makes, setMakes] = useState<string[]>([]);
  const [makesLoading, setMakesLoading] = useState(false);
  const [makesDegraded, setMakesDegraded] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [description, setDescription] = useState("");
  const [inspection, setInspection] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState(false);

  const [investors, setInvestors] = useState<{ id: string; profiles?: { full_name: string } }[]>([]);
  const [splits, setSplits] = useState<SplitRow[]>([{ holder_type: "ceo", holder_id: "", percentage: "100" }]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setMakesLoading(true);
    fetchMakes()
      .then(({ makes: list, degraded }) => {
        if (!live) return;
        setMakes(list);
        setMakesDegraded(degraded);
      })
      .finally(() => {
        if (live) setMakesLoading(false);
      });
    fetchInvestorsForPicker().then((rows) => {
      if (live) setInvestors(rows as never);
    });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!make || !year) {
      setModels([]);
      return;
    }
    // Without this guard a slow response for the previously selected make can
    // land after a faster one for the current make and overwrite it.
    let live = true;
    setModelsLoading(true);
    fetchModels(make, year)
      .then((list) => {
        if (live) setModels(list);
      })
      .finally(() => {
        if (live) setModelsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [make, year]);

  const totalPct = splits.reduce((s, r) => s + (parseFloat(r.percentage) || 0), 0);

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setUploading(true);
    try {
      const urls = await Promise.all(files.map((f) => uploadFile(f, "vehicles")));
      setPhotos((p) => [...p, ...urls]);
    } catch (err) {
      setError(err instanceof Error ? err.message : common("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  const makeOptions: ComboboxOption[] = makes.map((m) => ({
    value: m,
    label: m,
    icon: <BrandMark make={m} size={16} />,
  }));
  const modelOptions: ComboboxOption[] = models.map((m) => ({ value: m, label: m }));
  const trimOptions: ComboboxOption[] = COMMON_TRIMS.map((tr) => ({ value: tr, label: tr }));
  const colorOptions: ComboboxOption[] = COMMON_COLORS.map((c) => ({
    value: c,
    label: colors(c.toLowerCase()),
    swatch: colorSwatch(c),
  }));

  async function handleInspectionUpload(e: React.ChangeEvent<HTMLInputElement>) {
    // A folder pick hands back everything inside it — thumbs.db, a stray PDF,
    // the odd .DS_Store. Presigning those would 400 on content type, so the
    // non-images are dropped here rather than failing the whole batch.
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    // Let the same folder be picked twice, or re-picked after a failure.
    e.target.value = "";
    if (files.length === 0) return;
    setInspecting(true);
    try {
      const urls = await Promise.all(files.map((f) => uploadFile(f, "vehicles")));
      setInspection((p) => [...p, ...urls]);
    } catch (err) {
      setError(err instanceof Error ? err.message : common("uploadFailed"));
    } finally {
      setInspecting(false);
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
        color,
        description,
        inspection_photos: inspection,
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
              <Combobox
                value={make}
                onChange={(v) => { setMake(v); setModel(""); }}
                options={makeOptions}
                loading={makesLoading}
                placeholder={makesLoading ? common("loading") : misc("searchOrType")}
                emptyLabel={misc("noMatches")}
              />
              {makesDegraded && (
                <p className="mt-1 text-[11px] text-[var(--color-accent-amber)]">{misc("makesOffline")}</p>
              )}
            </div>
            <div>
              <Label>{t("model")}</Label>
              <Combobox
                value={model}
                onChange={setModel}
                options={modelOptions}
                loading={modelsLoading}
                placeholder={modelsLoading ? common("loading") : misc("searchOrType")}
                emptyLabel={misc("noMatches")}
              />
              {!modelsLoading && make && models.length === 0 && (
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{misc("noModelsFound")}</p>
              )}
            </div>
            <div>
              <Label>{t("trim")}</Label>
              <Combobox
                value={trim}
                onChange={setTrim}
                options={trimOptions}
                placeholder={misc("searchOrType")}
                emptyLabel={misc("noMatches")}
              />
            </div>
            <div>
              <Label>{t("color")}</Label>
              <Combobox
                value={color}
                onChange={setColor}
                options={colorOptions}
                placeholder={misc("searchOrType")}
                emptyLabel={misc("noMatches")}
              />
            </div>
            <div>
              <Label>{t("purchasePrice")}</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
          </div>

          <div className="mt-4">
            <Label>{t("description")}</Label>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={misc("descriptionPlaceholder")}
            />
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

          <div className="mt-4">
            <Label>
              {t("inspectionPhotos")}{" "}
              <span className="font-normal text-[var(--color-text-faint)]">({common("optional")})</span>
            </Label>
            <div className="flex gap-2">
              <label className="flex h-16 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent-blue)]/50">
                <Upload size={14} />
                {inspecting ? common("uploading") : misc("selectImages")}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleInspectionUpload}
                />
              </label>
              <label className="flex h-16 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent-blue)]/50">
                <FolderUp size={14} />
                {inspecting ? common("uploading") : misc("selectFolder")}
                {/* webkitdirectory is non-standard and has no React prop, so it
                    is spread in. Supported in Chrome/Edge/Safari/Firefox; where
                    it is not, the input degrades to an ordinary multi-file pick. */}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleInspectionUpload}
                  {...{ webkitdirectory: "", directory: "" }}
                />
              </label>
            </div>
            {inspection.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <span className="num text-xs text-[var(--color-text-muted)]">
                  {misc("imagesAttached", { count: inspection.length })}
                </span>
                <button
                  type="button"
                  onClick={() => setInspection([])}
                  className="text-[var(--color-text-faint)] hover:text-[var(--color-accent-red)]"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
            {inspection.length > 0 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {inspection.map((p) => (
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
