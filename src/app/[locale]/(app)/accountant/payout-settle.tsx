"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/currency";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { markPayoutPaid } from "./actions";

/**
 * Marking a consignment payout settled (migration 0032).
 *
 * The amounts are shown and not editable, deliberately: they were
 * computed inside execute_vehicle_sale() from a price a manager already
 * approved. What the accountant adds is how the money moved.
 *
 * The channel is required — the schema demands it too — because "paid,
 * somehow" is not a record anybody can reconcile against a bank
 * statement. A deal ticket's settlement fields are optional for the
 * opposite reason: a ticket is often raised before the money moves,
 * whereas this dialog is only ever opened at the moment it has.
 */
export function PayoutSettleDialog({
  payoutId,
  consignorName,
  amountDue,
}: {
  payoutId: string;
  consignorName: string;
  amountDue: number;
}) {
  const t = useTranslations("accountant");
  const deals = useTranslations("deals");
  const common = useTranslations("common");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<"bank_transfer" | "cheque" | "instapay" | "cash">(
    "bank_transfer"
  );
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await markPayoutPaid({
        payout_id: payoutId,
        settlement_method: method,
        settlement_reference: reference.trim() || null,
        note: note.trim() || null,
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
          {t("markPaid")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("settlePayout")}>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            {t("settlePayoutHint", {
              consignor: consignorName,
              amount: formatMoney(amountDue, locale),
            })}
          </p>

          <div className="space-y-3">
            <div>
              <Label>{deals("settlementMethod")}</Label>
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="bank_transfer">{deals("settlementBankTransfer")}</option>
                <option value="cheque">{deals("settlementCheque")}</option>
                <option value="instapay">{deals("settlementInstapay")}</option>
                <option value="cash">{deals("settlementCash")}</option>
              </Select>
            </div>
            <div>
              <Label>{deals("settlementReference")}</Label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={120}
                placeholder={common("optional")}
              />
            </div>
            <div>
              <Label>{t("payoutNote")}</Label>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="accent" onClick={submit} disabled={pending}>
              {common("confirm")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
