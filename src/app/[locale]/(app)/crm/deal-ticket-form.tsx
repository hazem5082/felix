"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Plus } from "lucide-react";
import { createDealTicket, fetchActiveVehicles, fetchActiveFinancingPartners } from "./actions";

type VehicleOption = { id: string; year: number; make: string; model: string; trim: string | null; purchase_price: number };
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

  useEffect(() => {
    if (open) {
      fetchActiveVehicles().then((v) => {
        const list = v as VehicleOption[];
        setVehicles(list);
        if (preselectedVehicleId) {
          const preselected = list.find((x) => x.id === preselectedVehicleId);
          if (preselected) setAgreedPrice(String(preselected.purchase_price));
        }
      });
      fetchActiveFinancingPartners().then((p) => setPartners(p as PartnerOption[]));
    }
  }, [open, preselectedVehicleId]);

  function selectVehicle(id: string) {
    setVehicleId(id);
    const v = vehicles.find((x) => x.id === id);
    if (v && !agreedPrice) setAgreedPrice(String(v.purchase_price));
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
                    {v.year} {v.make} {v.model} {v.trim ?? ""} — ${v.purchase_price.toLocaleString()}
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
          </div>
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button variant="accent" onClick={submit} disabled={pending || !vehicleId || !agreedPrice}>
              {common("submit")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
