"use client";

import { useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/currency";
import { useRouter } from "@/i18n/navigation";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ChevronDown, ChevronRight, Plus, Upload } from "lucide-react";
import { netToPay, tradeInIsDescribed } from "@/lib/acquisition";
import { uploadFile } from "@/lib/upload-client";
import { createDealTicket, fetchActiveVehicles, fetchActiveFinancingPartners } from "./actions";

type VehicleOption = { id: string; year: number; make: string; model: string; trim: string | null; asking_price: number | null };
type PartnerOption = { id: string; bank_name: string; product_name: string; rate: number | null; term_months: number | null };

export function DealTicketFormDialog({
  leadId,
  preselectedVehicleId,
  trigger,
}: {
  leadId: string | null;
  preselectedVehicleId?: string;
  trigger?: React.ReactNode;
}) {
  const t = useTranslations("deals");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(!!preselectedVehicleId);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [partners, setPartners] = useState<PartnerOption[]>([]);
  const [vehicleId, setVehicleId] = useState(preselectedVehicleId ?? "");
  const [agreedPrice, setAgreedPrice] = useState("");
  const [financingType, setFinancingType] = useState<"cash" | "installments">("cash");
  const [partnerId, setPartnerId] = useState("");
  const [downPayment, setDownPayment] = useState("");
  const [discount, setDiscount] = useState("0");
  // Standard Egyptian VAT is 14%, but schedule-tax vehicles can differ, so
  // the rate is editable and travels with the ticket. Showroom quotes are
  // normally VAT-inclusive, hence the toggle's default.
  const [vatRate, setVatRate] = useState("14");
  const [priceIncludesVat, setPriceIncludesVat] = useState(true);
  // Settlement channel (0023). Egyptian payment rules push car sales
  // through bank channels; 'cash' stays selectable but draws a warning —
  // record it, don't forbid it.
  const [settlementMethod, setSettlementMethod] = useState<
    "" | "bank_transfer" | "cheque" | "instapay" | "cash"
  >("");
  const [settlementReference, setSettlementReference] = useState("");
  const [settlementBank, setSettlementBank] = useState("");
  // The trade-in leg (0032) — تبديل. Collapsed by default because most
  // tickets have none, and an always-open block of nine fields is how a
  // form gets scrolled past.
  const [tradeInOpen, setTradeInOpen] = useState(false);
  const [tiMake, setTiMake] = useState("");
  const [tiModel, setTiModel] = useState("");
  const [tiYear, setTiYear] = useState("");
  const [tiColor, setTiColor] = useState("");
  const [tiVin, setTiVin] = useState("");
  const [tiOdometer, setTiOdometer] = useState("");
  const [tiAllowance, setTiAllowance] = useState("");
  const [tiNotes, setTiNotes] = useState("");
  const [tiPhotos, setTiPhotos] = useState<string[]>([]);
  const [tiUploading, setTiUploading] = useState(false);

  // The implied VAT on the final price (agreed minus discount), extracted
  // when the price already includes it, added on top when it does not.
  //
  // NOTE the trade-in allowance is deliberately absent from this figure.
  // VAT is charged on what the car sold for, not on how the buyer
  // settled it — the same reasoning that keeps the allowance out of the
  // profit waterfall in execute_vehicle_sale() (0032).
  const finalPrice = Math.max(0, (parseFloat(agreedPrice) || 0) - (parseFloat(discount) || 0));
  const parsedRate = parseFloat(vatRate);
  const vatAmount =
    Number.isFinite(parsedRate) && parsedRate > 0 && finalPrice > 0
      ? priceIncludesVat
        ? (finalPrice * parsedRate) / (100 + parsedRate)
        : (finalPrice * parsedRate) / 100
      : null;

  // What the buyer actually hands over. Shown rather than computed in
  // the head, because "net to pay" is the number the customer asks about
  // at the counter and the one a salesperson is otherwise doing in their
  // head. Same arithmetic the SQL does — see lib/acquisition.ts.
  const allowanceNumber = tradeInOpen && tiAllowance.trim() ? parseFloat(tiAllowance) : null;
  const netToPayNow = netToPay({
    agreedPrice: parseFloat(agreedPrice) || 0,
    discount: parseFloat(discount) || 0,
    tradeInAllowance: allowanceNumber,
  });
  const tradeInComplete = tradeInIsDescribed({
    allowance: allowanceNumber,
    make: tiMake,
    model: tiModel,
  });

  async function handleTradeInUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (!files.length) return;
    setTiUploading(true);
    try {
      const urls = await Promise.all(files.map((f) => uploadFile(f, "vehicles")));
      setTiPhotos((p) => [...p, ...urls]);
    } catch (err) {
      setError(err instanceof Error ? err.message : common("uploadFailed"));
    } finally {
      setTiUploading(false);
    }
  }

  useEffect(() => {
    if (open) {
      fetchActiveVehicles().then((v) => {
        const list = v as VehicleOption[];
        setVehicles(list);
        if (preselectedVehicleId) {
          const preselected = list.find((x) => x.id === preselectedVehicleId);
          // Negotiations start at the sticker price, not the cost (0028).
          if (preselected?.asking_price != null) setAgreedPrice(String(preselected.asking_price));
        }
      });
      fetchActiveFinancingPartners().then((p) => setPartners(p as PartnerOption[]));
    }
  }, [open, preselectedVehicleId]);

  function selectVehicle(id: string) {
    setVehicleId(id);
    const v = vehicles.find((x) => x.id === id);
    if (v?.asking_price != null && !agreedPrice) setAgreedPrice(String(v.asking_price));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createDealTicket({
        lead_id: leadId,
        vehicle_id: vehicleId,
        agreed_price: parseFloat(agreedPrice),
        financing_type: financingType,
        financing_partner_id: financingType === "installments" ? partnerId || null : null,
        down_payment: downPayment ? parseFloat(downPayment) : null,
        discount_amount: parseFloat(discount || "0"),
        vat_rate: Number.isFinite(parsedRate) ? parsedRate : null,
        vat_amount: vatAmount !== null ? Math.round(vatAmount * 100) / 100 : null,
        price_includes_vat: Number.isFinite(parsedRate) ? priceIncludesVat : null,
        settlement_method: settlementMethod || null,
        settlement_reference: settlementMethod ? settlementReference || null : null,
        settlement_bank: settlementMethod ? settlementBank || null : null,
        // Everything about the trade-in is dropped when the section is
        // collapsed, so a half-filled block somebody opened and thought
        // better of cannot mint a vehicle at execution.
        trade_in_make: tradeInOpen ? tiMake.trim() || null : null,
        trade_in_model: tradeInOpen ? tiModel.trim() || null : null,
        trade_in_year: tradeInOpen && tiYear.trim() ? parseInt(tiYear, 10) : null,
        trade_in_color: tradeInOpen ? tiColor.trim() || null : null,
        trade_in_vin: tradeInOpen ? tiVin.trim() || null : null,
        trade_in_odometer_km: tradeInOpen && tiOdometer.trim() ? parseFloat(tiOdometer) : null,
        trade_in_allowance: tradeInOpen && tiAllowance.trim() ? parseFloat(tiAllowance) : null,
        trade_in_notes: tradeInOpen ? tiNotes.trim() || null : null,
        trade_in_photos: tradeInOpen ? tiPhotos : [],
      });
      if ("error" in res) { setError(res.error); return; }
      setOpen(false);
      router.push("/deals");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="accent" size="sm"><Plus size={14} />{t("newTicket")}</Button>}
      </DialogTrigger>
      {open && (
        <DialogContent title={t("newTicket")}>
          <div className="space-y-3">
            <div>
              <Label>{t("vehicle")}</Label>
              <Select value={vehicleId} onChange={(e) => selectVehicle(e.target.value)}>
                <option value="">—</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.year} {v.make} {v.model} {v.trim ?? ""}{v.asking_price != null ? ` — ${formatMoney(v.asking_price, locale)}` : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("agreedPrice")}</Label>
              <Input type="number" value={agreedPrice} onChange={(e) => setAgreedPrice(e.target.value)} />
            </div>
            <div>
              <Label>{t("discount")}</Label>
              <Input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </div>
            <div>
              <Label>{t("vatRate")}</Label>
              <Input type="number" min={0} max={100} value={vatRate} onChange={(e) => setVatRate(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={priceIncludesVat}
                onChange={(e) => setPriceIncludesVat(e.target.checked)}
              />
              {t("priceIncludesVat")}
            </label>
            {vatAmount !== null && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                {t("vatAmount")}: {formatMoney(vatAmount, locale)}
              </p>
            )}
            <div>
              <Label>{t("financingType")}</Label>
              <Select value={financingType} onChange={(e) => setFinancingType(e.target.value as "cash" | "installments")}>
                <option value="cash">{t("cash")}</option>
                <option value="installments">{t("installments")}</option>
              </Select>
            </div>
            {financingType === "installments" && (
              <>
                <div>
                  <Label>{t("financingPartner")}</Label>
                  <Select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                    <option value="">—</option>
                    {partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.bank_name} — {p.product_name} {p.rate ? `(${p.rate}%)` : ""}
                      </option>
                    ))}
                  </Select>
                  {!partners.length && (
                    <p className="mt-1 text-xs text-[var(--color-accent-amber)]">
                      {common("noActivePartners")}
                    </p>
                  )}
                </div>
                <div>
                  <Label>{t("downPayment")}</Label>
                  <Input type="number" value={downPayment} onChange={(e) => setDownPayment(e.target.value)} />
                </div>
              </>
            )}
            <div>
              <Label>{t("settlementMethod")}</Label>
              <Select
                value={settlementMethod}
                onChange={(e) => setSettlementMethod(e.target.value as typeof settlementMethod)}
              >
                <option value="">—</option>
                <option value="bank_transfer">{t("settlementBankTransfer")}</option>
                <option value="cheque">{t("settlementCheque")}</option>
                <option value="instapay">{t("settlementInstapay")}</option>
                <option value="cash">{t("settlementCash")}</option>
              </Select>
            </div>
            {settlementMethod === "cash" && (
              // Non-blocking on purpose: Egyptian payment rules restrict cash
              // settlement of car sales, but legacy/edge cases exist and the
              // compliance posture is the owner's call — record, don't forbid.
              <p className="rounded-lg border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 px-3 py-2 text-xs text-[var(--color-accent-amber)]">
                {t("cashSettlementWarning")}
              </p>
            )}
            {settlementMethod && (
              <>
                <div>
                  <Label>{t("settlementReference")}</Label>
                  <Input
                    value={settlementReference}
                    onChange={(e) => setSettlementReference(e.target.value)}
                    maxLength={120}
                  />
                </div>
                <div>
                  <Label>{t("settlementBank")}</Label>
                  <Input
                    value={settlementBank}
                    onChange={(e) => setSettlementBank(e.target.value)}
                    maxLength={120}
                  />
                </div>
              </>
            )}

            {/* THE TRADE-IN LEG (0032) — تبديل. Collapsed by default:
                most deals have none, and the nine fields inside are
                nine fields most salespeople should never see. */}
            <div className="rounded-lg border border-[var(--color-border)]">
              <button
                type="button"
                onClick={() => setTradeInOpen((v) => !v)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-[var(--color-text)]"
              >
                {tradeInOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t("tradeInSection")}
                {!tradeInOpen && (
                  <span className="ms-auto text-xs font-normal text-[var(--color-text-faint)]">
                    {t("tradeInOptional")}
                  </span>
                )}
              </button>

              {tradeInOpen && (
                <div className="space-y-3 border-t border-[var(--color-border)] p-3">
                  <p className="text-[11px] text-[var(--color-text-faint)]">{t("tradeInHint")}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>{t("tradeInMake")}</Label>
                      <Input value={tiMake} onChange={(e) => setTiMake(e.target.value)} maxLength={60} />
                    </div>
                    <div>
                      <Label>{t("tradeInModel")}</Label>
                      <Input value={tiModel} onChange={(e) => setTiModel(e.target.value)} maxLength={60} />
                    </div>
                    <div>
                      <Label>{t("tradeInYear")}</Label>
                      <Input type="number" value={tiYear} onChange={(e) => setTiYear(e.target.value)} />
                    </div>
                    <div>
                      <Label>{t("tradeInColor")}</Label>
                      <Input value={tiColor} onChange={(e) => setTiColor(e.target.value)} maxLength={40} />
                    </div>
                    <div>
                      <Label>{t("tradeInVin")}</Label>
                      {/* Not VinSchema-strict, on purpose: a car handed
                          over at the counter often has a chassis number
                          and no legible VIN, and a ticket that cannot be
                          raised is a sale that does not happen. */}
                      <Input value={tiVin} onChange={(e) => setTiVin(e.target.value.toUpperCase())} maxLength={64} dir="ltr" />
                    </div>
                    <div>
                      <Label>{t("tradeInOdometer")}</Label>
                      <Input type="number" value={tiOdometer} onChange={(e) => setTiOdometer(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <Label>{t("tradeInAllowance")}</Label>
                    <Input type="number" value={tiAllowance} onChange={(e) => setTiAllowance(e.target.value)} />
                  </div>
                  {!tradeInComplete && (
                    <p className="rounded-lg border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 px-3 py-2 text-xs text-[var(--color-accent-amber)]">
                      {t("tradeInNeedsCar")}
                    </p>
                  )}
                  <div>
                    <Label>{t("tradeInNotes")}</Label>
                    <Textarea rows={2} value={tiNotes} onChange={(e) => setTiNotes(e.target.value)} />
                  </div>
                  <div>
                    <Label>
                      {t("tradeInPhotos")}{" "}
                      <span className="font-normal text-[var(--color-text-faint)]">({common("optional")})</span>
                    </Label>
                    <label className="flex h-14 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent-blue)]/50">
                      <Upload size={14} />
                      {tiUploading ? common("uploading") : common("upload")}
                      <input type="file" accept="image/*" multiple className="hidden" onChange={handleTradeInUpload} />
                    </label>
                    {tiPhotos.length > 0 && (
                      <div className="mt-2 flex gap-2 overflow-x-auto">
                        {tiPhotos.map((p) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={p} src={p} alt="" className="h-14 w-14 rounded-md object-cover" />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* The number the customer asks about at the counter. Always
                shown, because "what do I actually pay" is the question
                even when there is no trade-in. */}
            <div className="flex items-baseline justify-between rounded-lg bg-black/[0.03] px-3 py-2">
              <span className="text-xs text-[var(--color-text-secondary)]">{t("netToPay")}</span>
              <span className="num text-sm font-semibold">{formatMoney(netToPayNow, locale)}</span>
            </div>
          </div>
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button
              variant="accent"
              onClick={submit}
              disabled={pending || !vehicleId || !agreedPrice || !tradeInComplete}
            >
              {common("submit")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
