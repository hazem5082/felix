"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Lock, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { formatMoney } from "@/lib/currency";
import type { OverheadSource, TicketWaterfall } from "@/lib/supabase/types";
import { setTicketOverhead } from "../actions";

/**
 * THE SHOWROOM FEE ON ONE SALE (migration 0050) — where it came from,
 * and the CEO's ability to change it.
 *
 * Three states, and the badge says which:
 *
 *   auto     — the ticket is open, so the fee is still accruing month by
 *              month and will keep moving until the sale settles.
 *   snapshot — settled. This is the figure the ledger was built from,
 *              and no change to the branch's rate can move it.
 *   override — the CEO edited this one sale deliberately.
 *
 * The footnote appears only when the fee CHARGED differs from what the
 * calendar would charge today. On a settled sale that gap is the whole
 * point of the freeze: it is how you see that the branch's rate has
 * moved since without this sale moving with it.
 */

const SOURCE_TONE: Record<OverheadSource, SemanticTone> = {
  auto: "neutral",
  snapshot: "blue",
  override: "amber",
};

export function FeeSourceBadge({ waterfall }: { waterfall: TicketWaterfall }) {
  const t = useTranslations("fees");
  return (
    <StatusPill
      label={t(`ticketSource_${waterfall.overhead_source}`)}
      tone={SOURCE_TONE[waterfall.overhead_source]}
    />
  );
}

export function FeeFootnote({ waterfall }: { waterfall: TicketWaterfall }) {
  const t = useTranslations("fees");
  const locale = useLocale();

  const gap = Number(waterfall.overhead_auto) - Number(waterfall.overhead_total);
  const hasGap = Math.abs(gap) >= 0.01;
  const reason = waterfall.overhead_override_reason;

  if (!hasGap && !reason) return null;

  return (
    <div className="border-b border-[var(--color-border)] pb-2 pt-1 text-[11px] leading-relaxed text-[var(--color-text-faint)]">
      {hasGap && (
        <p>
          {t("feeGap", {
            charged: formatMoney(Number(waterfall.overhead_total), locale),
            calendar: formatMoney(Number(waterfall.overhead_auto), locale),
          })}
        </p>
      )}
      {reason && <p className="mt-0.5 italic">{t("overrideReason", { reason })}</p>}
    </div>
  );
}

/**
 * The CEO's edit. Present on every non-consignment ticket, open or
 * settled — but it means something different on each, and the dialog
 * says so:
 *
 *   OPEN     — the figure is stored and will be the fee the sale settles
 *              at. No money has moved yet, so nothing is adjusted.
 *   SETTLED  — the database posts adjustment rows per equity holder for
 *              their share of the difference. The rows already written
 *              are not touched; the ledger reads as a sale followed by a
 *              correction, both attributable.
 */
export function FeeOverrideDialog({
  ticketId,
  waterfall,
}: {
  ticketId: string;
  waterfall: TicketWaterfall;
}) {
  const t = useTranslations("fees");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fee, setFee] = useState(String(waterfall.overhead_total));
  const [reason, setReason] = useState("");

  const isOverridden = waterfall.overhead_source === "override";
  const settled = waterfall.overhead_locked;

  function submit(clear: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setTicketOverhead({
        ticket_id: ticketId,
        overhead: clear ? null : Number(fee || "0"),
        reason: clear ? null : reason.trim() || null,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil size={13} />
        {t("editFee")}
      </Button>

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent title={t("editFee")}>
            <div className="space-y-3">
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  settled
                    ? "border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 text-[var(--color-accent-amber)]"
                    : "border-[var(--color-border)] bg-black/[0.02] text-[var(--color-text-muted)]"
                }`}
              >
                {settled && <Lock size={13} className="mt-px shrink-0" />}
                <span>{settled ? t("editFeeSettledHint") : t("editFeeOpenHint")}</span>
              </div>

              <div>
                <Label>{t("feeCharged")}</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">
                  {t("calendarWouldCharge", {
                    amount: formatMoney(Number(waterfall.overhead_auto), locale),
                  })}
                </p>
              </div>

              <div>
                <Label>{t("reason")}</Label>
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("reasonPlaceholder")}
                />
              </div>
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

            <div className="mt-5 flex items-center justify-between gap-2">
              {/* Clearing is its own action rather than "type the old
                  number back in": on a settled sale it restores the exact
                  snapshot, which nobody can retype from memory. */}
              {isOverridden ? (
                <Button variant="ghost" size="sm" onClick={() => submit(true)} disabled={pending}>
                  <RotateCcw size={13} />
                  {t("clearOverride")}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {common("cancel")}
                </Button>
                <Button
                  variant="accent"
                  onClick={() => submit(false)}
                  disabled={pending || !reason.trim()}
                >
                  {common("save")}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
