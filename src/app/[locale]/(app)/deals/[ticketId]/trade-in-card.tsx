import { getLocale, getTranslations } from "next-intl/server";
import { formatMoney } from "@/lib/currency";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Link } from "@/i18n/navigation";
import { consignmentSplit, netToPay } from "@/lib/acquisition";
import type { DealTicket, Vehicle } from "@/lib/supabase/types";

/**
 * The two sides of migration 0032, shown on the ticket that produced
 * them.
 *
 * Kept in its own file and rendered from single insertion points rather
 * than folded into ticket-panel.tsx: that panel is a Client Component
 * carrying the review checklist, the contract vault and the waterfall,
 * and it is under concurrent edit. Everything here is read-only, so it
 * stays a Server Component and the joined vehicle row — which carries
 * the confidential purchase price — never crosses to the browser.
 */

/** The vehicle execution minted for a trade-in, as far as this viewer can see it. */
export type CreatedTradeInVehicle = Pick<Vehicle, "id" | "year" | "make" | "model">;

/**
 * The trade-in leg — تبديل. Rendered whenever the ticket carries an
 * allowance, before and after execution.
 *
 * After execution there is a real `vehicles` row for the car the buyer
 * handed over. The lookup is done by the CALLER, under the same RLS as
 * the rest of the page.
 */
export async function TradeInCard({
  ticket,
  createdVehicle,
}: {
  ticket: DealTicket;
  createdVehicle: CreatedTradeInVehicle | null;
}) {
  if (ticket.trade_in_allowance == null) return null;

  const t = await getTranslations("deals");
  const locale = await getLocale();

  const net = netToPay({
    agreedPrice: ticket.agreed_price,
    discount: ticket.discount_amount,
    tradeInAllowance: ticket.trade_in_allowance,
  });

  const described = [ticket.trade_in_year, ticket.trade_in_make, ticket.trade_in_model]
    .filter(Boolean)
    .join(" ");

  return (
    <Panel>
      <PanelHeader title={t("tradeInSection")} subtitle={described || undefined} />

      <div className="space-y-2">
        <Row label={t("tradeInAllowance")} value={formatMoney(ticket.trade_in_allowance, locale)} />
        {ticket.trade_in_color && <Row label={t("tradeInColor")} value={ticket.trade_in_color} />}
        {ticket.trade_in_vin && <Row label={t("tradeInVin")} value={ticket.trade_in_vin} mono />}
        {ticket.trade_in_odometer_km != null && (
          <Row
            label={t("tradeInOdometer")}
            value={new Intl.NumberFormat(locale).format(ticket.trade_in_odometer_km)}
          />
        )}
        {/* The settlement, restated. The waterfall in the panel above is
            computed on the FULL agreed price — the allowance changed how
            the buyer paid, not what the car sold for (0032) — and
            showing both numbers together is what stops that reading as
            an error. */}
        <div className="mt-3 flex items-baseline justify-between gap-4 border-t border-[var(--color-border)] pt-3 text-sm">
          <span className="text-[var(--color-text-secondary)]">{t("netToPay")}</span>
          <span className="num font-semibold">{formatMoney(net, locale)}</span>
        </div>
      </div>

      {ticket.trade_in_notes && (
        <p className="mt-3 whitespace-pre-wrap text-xs text-[var(--color-text-muted)]">
          {ticket.trade_in_notes}
        </p>
      )}

      {ticket.trade_in_photos?.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto">
          {ticket.trade_in_photos.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p} src={p} alt="" loading="lazy" className="h-16 w-20 shrink-0 rounded-md object-cover" />
          ))}
        </div>
      )}

      {ticket.status === "executed" && (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          {createdVehicle ? (
            <Link
              href={`/inventory/${createdVehicle.id}`}
              className="text-xs font-medium text-[var(--color-accent-blue)] hover:underline"
            >
              {t("tradeInEnteredStock", {
                vehicle: `${createdVehicle.year} ${createdVehicle.make} ${createdVehicle.model}`,
              })}
            </Link>
          ) : (
            // The row exists — execute_vehicle_sale() creates it in the
            // same transaction as the sale — but this viewer's RLS may
            // not reach it, or the identifiers may not be enough to pick
            // it out. Say so rather than implying it was never made.
            <p className="text-xs text-[var(--color-text-faint)]">{t("tradeInStockNotFound")}</p>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * A consigned sale has no cap table and no waterfall, so this replaces
 * the profit block: who owns the car, what the house keeps, what is owed
 * back.
 *
 * The figures are derived from the terms recorded on the VEHICLE, which
 * is where they were agreed. Once the sale executes the authoritative
 * row is the consignment_payouts one on the accountant's screen — that
 * is the one that says whether the money has actually moved.
 */
export async function ConsignmentBanner({
  vehicle,
  ticket,
}: {
  vehicle: Vehicle;
  ticket: DealTicket;
}) {
  const t = await getTranslations("deals");
  const locale = await getLocale();

  const settled = Math.max(0, ticket.agreed_price - ticket.discount_amount);
  const { commission, amountDue } = consignmentSplit({
    salePrice: settled,
    commissionType: vehicle.consignment_commission_type,
    commissionValue: vehicle.consignment_commission_value,
  });

  return (
    <Panel className="border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/[0.05]">
      <PanelHeader
        title={t("consignmentBanner", {
          consignor: vehicle.consignor_name ?? t("consignorUnknown"),
        })}
        subtitle={t("consignmentBannerHint")}
      />

      <div className="space-y-2">
        <Row label={t("salePrice")} value={formatMoney(settled, locale)} />
        <Row
          label={
            vehicle.consignment_commission_type === "percent"
              ? t("houseCommissionPercent", { pct: vehicle.consignment_commission_value ?? 0 })
              : t("houseCommission")
          }
          value={formatMoney(commission, locale)}
        />
        <div className="flex items-baseline justify-between gap-4 border-t border-[var(--color-border)] pt-2 text-sm">
          <span className="text-[var(--color-text-secondary)]">{t("owedToConsignor")}</span>
          <span className="num font-semibold">{formatMoney(amountDue, locale)}</span>
        </div>
      </div>

      {vehicle.consignment_commission_type === null && (
        // A car taken in before 0032's intake rule existed. The SQL pays
        // the consignor everything rather than inventing a fee, and the
        // screen has to say so or the zero reads as a bug.
        <p className="mt-3 text-xs text-[var(--color-accent-amber)]">{t("consignmentNoTerms")}</p>
      )}
    </Panel>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-[var(--color-text-secondary)]">{label}</span>
      <span className={mono ? "font-mono text-xs" : "num font-medium"} dir={mono ? "ltr" : undefined}>
        {value}
      </span>
    </div>
  );
}
