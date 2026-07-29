import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { dealStatusTone } from "@/lib/status-tone";
import type { DealTicket, Vehicle, Contract, VehicleEquitySplit } from "@/lib/supabase/types";
import { TicketPanel } from "./ticket-panel";

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  const t = await getTranslations("deals");
  const supabase = await createClient();
  const profile = await getProfile();

  const { data: ticket } = await supabase
    .from("deal_tickets")
    .select("*, vehicles(*), financing_partners(bank_name, product_name, rate)")
    .eq("id", ticketId)
    .single();

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

  const canReview = profile && ["ceo", "branch_manager"].includes(profile.role);
  const canExecute = canReview;

  return (
    <div className="space-y-6">
      <PanelHeader
        title={dt.vehicles ? `${dt.vehicles.year} ${dt.vehicles.make} ${dt.vehicles.model}` : "Deal Ticket"}
        subtitle={`$${dt.agreed_price.toLocaleString()} · ${dt.financing_type === "cash" ? t("cash") : t("installments")}`}
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

      <TicketPanel
        ticket={dt}
        canReview={!!canReview}
        canExecute={!!canExecute}
        investorNames={investorNames}
        contractSerial={(contract as Contract | null)?.serial ?? null}
      />
    </div>
  );
}
