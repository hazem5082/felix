import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/currency";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { dealStatusTone } from "@/lib/status-tone";
import type { DealTicket, Vehicle, Contract, VehicleEquitySplit } from "@/lib/supabase/types";
import { TicketPanel } from "./ticket-panel";
import { canSeeCost } from "@/lib/auth";
import { EtaInvoicePanel } from "./eta-invoice-panel";
import { ConsignmentBanner, TradeInCard, type CreatedTradeInVehicle } from "./trade-in-card";

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  const t = await getTranslations("deals");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const supabase = await createClient();
  const profile = await getProfile();

  const { data: ticket } = await supabase
    .from("deal_tickets")
    .select("*, vehicles(*), financing_partners(bank_name, product_name, rate)")
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) notFound();
  const dt = ticket as DealTicket & { vehicles?: Vehicle };

  const [{ data: contract }, { data: splits }] = await Promise.all([
    supabase.from("contracts").select("*").eq("deal_ticket_id", ticketId).maybeSingle(),
    supabase
      .from("vehicle_equity_splits")
      .select("holder_id, investors(profiles(full_name))")
      .eq("vehicle_id", dt.vehicle_id),
  ]);

  const investorNames: Record<string, string> = {};
  ((splits as unknown as (VehicleEquitySplit & { investors?: { profiles?: { full_name: string } } })[]) ?? []).forEach((s) => {
    if (s.holder_id) investorNames[s.holder_id] = s.investors?.profiles?.full_name ?? "Investor";
  });

  // ── 0032: the two acquisition legs ──────────────────────────
  //
  // The car a trade-in created, once the sale has executed. There is no
  // FK from the ticket to it — adding one would mean a second path to a
  // fact `vehicles` already holds, and the two would eventually disagree
  // (0031's reasoning about deal_tickets → customers, applied here).
  //
  // So it is found by what execute_vehicle_sale() actually wrote. The
  // DESCRIPTION is tried first, because the note it always ends with
  // names this ticket by id — whereas the VIN is dropped whenever
  // another vehicle already holds it, which is precisely the case where
  // a VIN lookup would find the WRONG car. The VIN is the fallback for
  // rows written before that note existed.
  //
  // Both queries run under the viewer's own RLS, so a manager at another
  // branch simply sees the "not found" line.
  const isConsignment = dt.vehicles?.acquisition_type === "consignment";
  let tradeInVehicle: CreatedTradeInVehicle | null = null;
  if (dt.trade_in_allowance != null && dt.status === "executed") {
    const { data: byNote } = await supabase
      .from("vehicles")
      .select("id, year, make, model")
      .eq("acquisition_type", "trade_in")
      .ilike("description", `%${ticketId}%`)
      .maybeSingle();
    tradeInVehicle = (byNote as CreatedTradeInVehicle | null) ?? null;

    if (!tradeInVehicle && dt.trade_in_vin) {
      const { data: byVin } = await supabase
        .from("vehicles")
        .select("id, year, make, model")
        .eq("acquisition_type", "trade_in")
        .eq("vin", dt.trade_in_vin)
        .maybeSingle();
      tradeInVehicle = (byVin as CreatedTradeInVehicle | null) ?? null;
    }
  }

  const canReview = profile && ["ceo", "branch_manager"].includes(profile.role);
  const canExecute = canReview;

  return (
    <div className="space-y-6">
      <PanelHeader
        title={dt.vehicles ? `${dt.vehicles.year} ${dt.vehicles.make} ${dt.vehicles.model}`  : common("dealTicket")}
        subtitle={`${formatMoney(dt.agreed_price, locale)} · ${dt.financing_type === "cash" ? t("cash") : t("installments")}`}
        action={
          <StatusPill
            label={
              dt.status === "approved" ? t("statusApproved")
              : dt.status === "rejected" ? t("statusRejected")
              : dt.status === "executed" ? t("statusExecuted")
              : t("statusSubmitted")
            }
            tone={dealStatusTone(dt.status)}
          />
        }
      />

      {dt.status === "rejected" && dt.rejection_reason && (
        <Panel className="border-[var(--color-accent-red)]/30">
          <p className="text-sm text-[var(--color-accent-red)]">{dt.rejection_reason}</p>
        </Panel>
      )}

      {/* 0032, insertion point 1 of 2. A consigned sale has no cap table
          and no waterfall: compute_sale_waterfall() would divide a
          consignor's money among the house and its investors, and
          execute_vehicle_sale() skips it entirely. The banner replaces
          the profit block rather than sitting beside it — see
          `isConsignment` on TicketPanel below. */}
      {isConsignment && dt.vehicles && <ConsignmentBanner vehicle={dt.vehicles} ticket={dt} />}

      <TicketPanel
        // Without the join: TicketPanel is a Client Component, and the
        // joined vehicle row carries purchase_price — serialized props
        // reach the browser whether or not they are rendered (0028).
        ticket={{ ...dt, vehicles: undefined }}
        canReview={!!canReview}
        canExecute={!!canExecute}
        canSeeCost={canSeeCost(profile)}
        isConsignment={isConsignment}
        investorNames={investorNames}
        contractSerial={(contract as Contract | null)?.serial ?? null}
      />

      {/* 0032, insertion point 2 of 2. Renders nothing when the ticket
          carries no allowance, which is almost every ticket. */}
      <TradeInCard ticket={dt} createdVehicle={tradeInVehicle} />

      <EtaInvoicePanel contract={(contract as Contract | null) ?? null} canEdit={!!profile && ["ceo", "accountant"].includes(profile.role)} ticketId={ticketId} />
    </div>
  );
}
