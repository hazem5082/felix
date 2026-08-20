"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { setVehiclePrices } from "./actions";

/**
 * The "Set prices" button + dialog on the vehicle page. Only rendered
 * for CEO/branch manager; the action and the column-limited grant
 * (0028) re-check that server-side.
 */
export function PricingDialog({
  vehicleId,
  askingPrice,
  minPrice,
}: {
  vehicleId: string;
  askingPrice: number | null;
  minPrice: number | null;
}) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(askingPrice != null ? String(askingPrice) : "");
  const [min, setMin] = useState(minPrice != null ? String(minPrice) : "");

  const askingNum = asking.trim() ? Number(asking) : null;
  const minNum = min.trim() ? Number(min) : null;
  const invalid =
    (askingNum !== null && (!Number.isFinite(askingNum) || askingNum <= 0)) ||
    (minNum !== null && (!Number.isFinite(minNum) || minNum <= 0)) ||
    (askingNum !== null && minNum !== null && minNum > askingNum);

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await setVehiclePrices({
        vehicle_id: vehicleId,
        asking_price: askingNum,
        min_price: minNum,
      });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Tag size={12} />
        {t("setPrices")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title={t("setPrices")}>
            <p className="mb-4 text-xs text-[var(--color-text-muted)]">{t("pricesHint")}</p>
            <div className="space-y-3">
              <div>
                <Label>{t("stickerPrice")}</Label>
                <Input
                  type="number"
                  dir="ltr"
                  min={1}
                  placeholder={t("notPriced")}
                  value={asking}
                  onChange={(e) => setAsking(e.target.value)}
                />
              </div>
              <div>
                <Label>{t("lowestOffer")}</Label>
                <Input
                  type="number"
                  dir="ltr"
                  min={1}
                  placeholder={t("notPriced")}
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                />
              </div>
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                {common("cancel")}
              </Button>
              <Button variant="accent" onClick={save} disabled={pending || invalid}>
                {common("save")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
