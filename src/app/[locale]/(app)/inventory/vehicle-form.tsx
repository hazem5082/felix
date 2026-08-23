"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Plus, Trash2, Upload, FolderUp, X, Sparkles } from "lucide-react";
import { YEARS, fetchMakes, fetchModels, COMMON_TRIMS, COMMON_COLORS } from "@/lib/nhtsa";
import { decodeVin } from "@/lib/vin-decode";
import { uploadFile } from "@/lib/upload-client";
import { colorSwatch } from "@/lib/vehicle-color";
import { COMMON_ORIGINS, originKey } from "@/lib/vehicle-origin";
import { flagForOrigin } from "@/lib/country-flag";
import { BrandMark } from "@/components/ui/brand-mark";
import { createVehicle, fetchInvestorsForPicker } from "./actions";
import type { Branch } from "@/lib/supabase/types";

interface SplitRow {
  holder_type: "ceo" | "investor";
  holder_id: string;
  percentage: string;
}

export function VehicleFormDialog({ branches }: { branches: Branch[] }) {
  const locale = useLocale();
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  // Colours are stored in vehicles.color as canonical English (see
  // COMMON_COLORS) and rendered through this namespace, so the Arabic UI
  // shows Arabic names without the database holding two spellings.
  const colors = useTranslations("colors");
  // Origins follow the same canonical-English-plus-translation scheme —
  // see vehicle-origin.ts.
  const origins = useTranslations("origins");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [make, setMake] = useState("");
  const [decodedMake, setDecodedMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [color, setColor] = useState("");
  // Recorded at intake, updatable afterwards (0036). Both optional.
  const [odometerKm, setOdometerKm] = useState("");
  const [acquisitionSource, setAcquisitionSource] = useState("");
  const [vin, setVin] = useState("");
  const [engineNumber, setEngineNumber] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [origin, setOrigin] = useState("");
  // VIN-decoded details (migration 0040) — filled by handleDecodeVin(),
  // never typed directly. See lib/vin-decode.ts for why colour and top
  // speed are not among them: neither is encoded in a VIN.
  const [decoding, setDecoding] = useState(false);
  const [decodeNote, setDecodeNote] = useState<{ kind: "ok" | "warn" | "empty"; message: string } | null>(null);
  const [bodyType, setBodyType] = useState("");
  const [engineInfo, setEngineInfo] = useState("");
  const [driveType, setDriveType] = useState("");
  const [doors, setDoors] = useState<number | null>(null);
  const [plantCountry, setPlantCountry] = useState("");
  const [features, setFeatures] = useState<string[]>([]);
  const [itemCode, setItemCode] = useState("");
  // How the showroom is taking this car in (0032). 'trade_in' is
  // deliberately not on offer — those rows are minted inside
  // execute_vehicle_sale() against the ticket that valued them.
  const [mode, setMode] = useState<"purchase" | "consignment">("purchase");
  const [consignorName, setConsignorName] = useState("");
  const [consignorPhone, setConsignorPhone] = useState("");
  const [consignorNationalId, setConsignorNationalId] = useState("");
  const [commissionType, setCommissionType] = useState<"" | "fixed" | "percent">("percent");
  const [commissionValue, setCommissionValue] = useState("");
  const [price, setPrice] = useState("");
  const [askingPrice, setAskingPrice] = useState("");
  const [minPrice, setMinPrice] = useState("");
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
  const isConsignment = mode === "consignment";

  // Standard VIN alphabet: 17 chars, uppercase alphanumerics excluding
  // I/O/Q. Blank stays fine — used stock sometimes has no readable VIN.
  // Mirrors VinSchema in lib/validation.ts and the DB CHECK from 0021.
  const vinInvalid = vin.trim() !== "" && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin.trim());

  // Decodes the VIN via NHTSA's free vPIC API (lib/vin-decode.ts) and
  // fills make/model/year/trim/origin plus the read-only decoded-details
  // block. An explicit button, not an on-blur auto-trigger: the user
  // asked for this once, on purpose, rather than firing a network call
  // on every keystroke that happens to land on 17 characters.
  async function handleDecodeVin() {
    const v = vin.trim();
    if (!v || vinInvalid) return;
    setDecoding(true);
    setDecodeNote(null);
    try {
      const result = await decodeVin(v);
      if (!result || !result.decoded) {
        setDecodeNote({ kind: "empty", message: t("vinDecodeEmpty") });
        return;
      }
      if (result.year) setYear(result.year);
      if (result.make) {
        setMake(result.make);
        setDecodedMake(result.make);
      }
      if (result.model) setModel(result.model);
      if (result.trim) setTrim(result.trim);
      if (result.countryOfOrigin) setOrigin(result.countryOfOrigin);
      setBodyType(result.bodyType ?? "");
      setEngineInfo(result.engineInfo ?? "");
      setDriveType(result.driveType ?? "");
      setDoors(result.doors);
      setPlantCountry(result.countryOfOrigin ?? "");
      setDecodeNote(
        result.checksumOk
          ? { kind: "ok", message: t("vinDecodeApplied") }
          : { kind: "warn", message: t("vinChecksumWarning") }
      );
    } finally {
      setDecoding(false);
    }
  }

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
  const originOptions: ComboboxOption[] = COMMON_ORIGINS.map((o) => {
    const key = originKey(o);
    const flag = flagForOrigin(o);
    return {
      value: o,
      label: key ? origins(key) : o,
      icon: flag ? <span aria-hidden>{flag}</span> : undefined,
    };
  });

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
    // A consigned car has no cap table to sum — the showroom never
    // funded it. Running this check anyway would make the mode
    // unreachable, since the splits editor is not even rendered.
    if (isConsignment) {
      if (!consignorName.trim()) {
        setError(t("consignorNameRequired"));
        return;
      }
      if (!commissionType || !commissionValue.trim()) {
        setError(t("commissionRequired"));
        return;
      }
    } else if (Math.abs(totalPct - 100) > 0.5) {
      setError(t("splitMustSum"));
      return;
    }
    // A blank VIN is a legitimate intake; a malformed one would only
    // bounce off the server schema and the DB CHECK with an untranslated
    // message, so say it here instead.
    if (vinInvalid) {
      setError(t("vinInvalid"));
      return;
    }
    startTransition(async () => {
      const res = await createVehicle({
        branch_id: branchId,
        vin: vin.trim(),
        year: parseInt(year, 10),
        make,
        model,
        trim,
        color,
        odometer_km: odometerKm.trim() ? parseFloat(odometerKm) : null,
        acquisition_source: acquisitionSource,
        description,
        inspection_photos: inspection,
        engine_number: engineNumber,
        plate_number: plateNumber,
        country_of_origin: origin,
        body_type: bodyType,
        engine_info: engineInfo,
        drive_type: driveType,
        doors,
        plant_country: plantCountry,
        decoded_make: decodedMake,
        locale,
        features,
        item_code: itemCode,
        acquisition_type: mode,
        consignor_name: isConsignment ? consignorName : "",
        consignor_phone: isConsignment ? consignorPhone : "",
        consignor_national_id: isConsignment ? consignorNationalId : "",
        consignment_commission_type: isConsignment ? commissionType : "",
        consignment_commission_value:
          isConsignment && commissionValue.trim() ? parseFloat(commissionValue) : null,
        // A consigned car deploys no capital, so its cost basis is
        // exactly zero — the DB CHECK and the RPC both insist on it.
        purchase_price: isConsignment ? 0 : parseFloat(price),
        asking_price: askingPrice.trim() ? parseFloat(askingPrice) : null,
        min_price: minPrice.trim() ? parseFloat(minPrice) : null,
        photos,
        splits: isConsignment
          ? []
          : splits.map((s) => ({
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
          {/* How the car is being taken in (0032). It sits above every
              other field because it decides which of them apply: a
              consignment has a consignor and a commission and no cost
              and no cap table, and asking for all four anyway is how a
              form teaches people to type zeros into things. */}
          <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-black/[0.02] p-3">
            <Label>{t("acquisitionType")}</Label>
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as "purchase" | "consignment")}
            >
              <option value="purchase">{t("acquisitionPurchase")}</option>
              <option value="consignment">{t("acquisitionConsignment")}</option>
            </Select>
            <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">
              {isConsignment ? t("consignmentHint") : t("purchaseHint")}
            </p>
          </div>

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
              <Input
                value={vin}
                onChange={(e) => setVin(e.target.value.toUpperCase())}
                placeholder={common("optional")}
                maxLength={17}
              />
              {vinInvalid && (
                <p className="mt-1 text-[11px] text-[var(--color-accent-amber)]">{t("vinInvalid")}</p>
              )}
              {!vinInvalid && vin.trim() !== "" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1.5"
                  onClick={handleDecodeVin}
                  disabled={decoding}
                >
                  <Sparkles size={13} />
                  {decoding ? common("loading") : t("decodeVin")}
                </Button>
              )}
              {decodeNote && (
                <p
                  className={`mt-1 text-[11px] ${
                    decodeNote.kind === "warn"
                      ? "text-[var(--color-accent-amber)]"
                      : decodeNote.kind === "empty"
                        ? "text-[var(--color-text-faint)]"
                        : "text-[var(--color-accent-green)]"
                  }`}
                >
                  {decodeNote.message}
                </p>
              )}
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
            {/* Recorded at intake, updatable afterwards (0036) — the
                second question every used-car buyer asks, and where the
                car came from. Both optional: stock is taken in before
                either is always known. */}
            <div>
              <Label>{t("odometer")}</Label>
              <div className="relative">
                <Input
                  type="number"
                  min={0}
                  value={odometerKm}
                  onChange={(e) => setOdometerKm(e.target.value)}
                  placeholder={common("optional")}
                  className="pe-9"
                />
                <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-[var(--color-text-faint)]" dir="ltr">
                  km
                </span>
              </div>
            </div>
            <div>
              <Label>{t("acquisitionSource")}</Label>
              <Input
                value={acquisitionSource}
                onChange={(e) => setAcquisitionSource(e.target.value)}
                placeholder={t("acquisitionSourcePlaceholder")}
                maxLength={200}
              />
            </div>
            <div>
              <Label>{t("engineNumber")}</Label>
              <Input
                value={engineNumber}
                onChange={(e) => setEngineNumber(e.target.value)}
                placeholder={common("optional")}
                maxLength={60}
              />
            </div>
            <div>
              <Label>{t("plateNumber")}</Label>
              <Input
                value={plateNumber}
                onChange={(e) => setPlateNumber(e.target.value)}
                placeholder={common("optional")}
                maxLength={20}
              />
            </div>
            <div>
              <Label>{t("countryOfOrigin")}</Label>
              <Combobox
                value={origin}
                onChange={setOrigin}
                options={originOptions}
                placeholder={misc("searchOrType")}
                emptyLabel={misc("noMatches")}
              />
            </div>
            <div>
              <Label>{t("itemCode")}</Label>
              {/* ETA e-invoicing product code (0026). dir=ltr: EGS/GS1
                  codes are Latin technical strings even in the Arabic
                  UI, like the VIN. */}
              <Input
                value={itemCode}
                onChange={(e) => setItemCode(e.target.value)}
                placeholder={common("optional")}
                maxLength={60}
                dir="ltr"
              />
              <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">{t("itemCodeHint")}</p>
            </div>
            {/* Cost is management's number for a car the showroom
                bought. A consigned car has none — it deploys no capital
                — so the field is absent rather than zeroed. */}
            {!isConsignment && (
              <div>
                <Label>{t("purchasePrice")}</Label>
                <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
            )}
            {/* The sales floor's numbers (0028). Optional — a car can be
                taken in first and priced from its page later. */}
            <div>
              <Label>{t("stickerPrice")}</Label>
              <Input type="number" value={askingPrice} onChange={(e) => setAskingPrice(e.target.value)} />
            </div>
            <div>
              <Label>{t("lowestOffer")}</Label>
              <Input type="number" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
            </div>
          </div>

          {/* What the VIN decode found (0040) — read-only, never typed
              directly. Shown only once there is something to show, since
              most of this showroom's stock is outside vPIC's US-centric
              coverage and an empty panel would just be noise. */}
          {(bodyType || engineInfo || driveType || doors !== null) && (
            <div className="mt-4 rounded-lg border border-[var(--color-accent-green)]/30 bg-[var(--color-accent-green-dim)] p-3 text-xs">
              <p className="mb-2 font-medium text-[var(--color-text)]">{t("vinDecodedDetails")}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[var(--color-text-muted)]">
                {bodyType && (
                  <div className="flex justify-between gap-2"><span>{t("bodyType")}</span><span className="font-medium text-[var(--color-text)]">{bodyType}</span></div>
                )}
                {engineInfo && (
                  <div className="flex justify-between gap-2"><span>{t("engineInfo")}</span><span className="font-medium text-[var(--color-text)]">{engineInfo}</span></div>
                )}
                {driveType && (
                  <div className="flex justify-between gap-2"><span>{t("driveType")}</span><span className="font-medium text-[var(--color-text)]">{driveType}</span></div>
                )}
                {doors !== null && (
                  <div className="flex justify-between gap-2"><span>{t("doors")}</span><span className="font-medium text-[var(--color-text)]">{doors}</span></div>
                )}
              </div>
            </div>
          )}

          {/* The consignor and the terms (0032). These ARE the deal:
              without them execute_vehicle_sale() has nothing to pay the
              house and nothing to owe the owner, which is why the RPC
              and the zod schema both refuse a consignment without
              them. */}
          {isConsignment && (
            <div className="mt-4 rounded-lg border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/[0.06] p-3">
              <Label className="mb-2">{t("consignorSection")}</Label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t("consignorName")}</Label>
                  <Input
                    value={consignorName}
                    onChange={(e) => setConsignorName(e.target.value)}
                    maxLength={120}
                  />
                </div>
                <div>
                  <Label>{t("consignorPhone")}</Label>
                  <Input
                    value={consignorPhone}
                    onChange={(e) => setConsignorPhone(e.target.value)}
                    placeholder={common("optional")}
                    maxLength={32}
                  />
                </div>
                <div>
                  <Label>{t("consignorNationalId")}</Label>
                  {/* dir=ltr like every other digit-string identifier on
                      this form: a national ID is read off a card. */}
                  <Input
                    value={consignorNationalId}
                    onChange={(e) => setConsignorNationalId(e.target.value)}
                    placeholder={common("optional")}
                    maxLength={14}
                    dir="ltr"
                  />
                </div>
                <div>
                  <Label>{t("commissionType")}</Label>
                  <Select
                    value={commissionType}
                    onChange={(e) => setCommissionType(e.target.value as typeof commissionType)}
                  >
                    <option value="percent">{t("commissionPercent")}</option>
                    <option value="fixed">{t("commissionFixed")}</option>
                  </Select>
                </div>
                <div>
                  <Label>
                    {commissionType === "percent" ? t("commissionValuePercent") : t("commissionValueFixed")}
                  </Label>
                  <Input
                    type="number"
                    value={commissionValue}
                    onChange={(e) => setCommissionValue(e.target.value)}
                    min={0}
                    max={commissionType === "percent" ? 100 : undefined}
                  />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                {t("commissionHint")}
              </p>
            </div>
          )}

          <div className="mt-4">
            <Label>{t("description")}</Label>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={misc("descriptionPlaceholder")}
            />
          </div>

          {/* The CPA Decision 115/2021 amenities list — one input per
              feature, the NotePointsEditor pattern: rows are added,
              reworded and removed one at a time, and blank rows are
              dropped by the server schema rather than policed here. */}
          <div className="mt-4">
            <Label>{t("features")}</Label>
            <p className="mb-2 text-xs text-[var(--color-text-faint)]">{t("featuresHint")}</p>
            <div className="space-y-2">
              {features.map((feature, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span aria-hidden className="text-[var(--color-text-faint)]">•</span>
                  <Input
                    value={feature}
                    placeholder={t("featurePlaceholder")}
                    onChange={(e) =>
                      setFeatures((f) => f.map((p, i) => (i === index ? e.target.value : p)))
                    }
                  />
                  <button
                    type="button"
                    aria-label={t("removeFeature")}
                    onClick={() => setFeatures((f) => f.filter((_, i) => i !== index))}
                    className="cursor-pointer rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--color-text)]"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setFeatures((f) => [...f, ""])}
            >
              <Plus size={13} />
              {t("addFeature")}
            </Button>
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

          {/* HIDDEN ENTIRELY for a consignment, not disabled: the
              showroom does not own this car, so there is no cap table to
              edit and a greyed-out one would suggest there could be.
              trg_no_splits_on_consignment (0032) refuses the write
              besides. */}
          {!isConsignment && (
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
          )}

          {error && (
            <p className="mt-3 rounded-lg bg-[var(--color-accent-red-dim)] px-3 py-2 text-xs text-[var(--color-accent-red)]">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            {/* A consignment has no cost to type, so the price cannot be
                what gates the button; the consignor's name is the field
                without which the row means nothing. */}
            <Button
              variant="accent"
              onClick={submit}
              disabled={
                pending || !make || !model || (isConsignment ? !consignorName.trim() : !price)
              }
            >
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
