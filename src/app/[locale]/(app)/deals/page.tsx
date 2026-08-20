import { getLocale, getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { Link } from "@/i18n/navigation";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { dealStatusTone } from "@/lib/status-tone";
import type { DealTicket, Vehicle, Profile } from "@/lib/supabase/types";

export default async function DealsPage() {
  const t = await getTranslations("deals");
  const common = await getTranslations("common");
  const misc = await getTranslations("misc");
  const locale = await getLocale();
  const supabase = await createClient();

  const { data: tickets } = await supabase
    .from("deal_tickets")
    .select("*, vehicles(year, make, model, trim), profiles!deal_tickets_salesperson_id_fkey(full_name)")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} />
      <Panel>
        <Table>
          <THead>
            <Th>{t("vehicle")}</Th>
            <Th>{t("agreedPrice")}</Th>
            <Th>{t("financingType")}</Th>
            <Th>{misc("salesperson")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {((tickets as (DealTicket & { vehicles?: Vehicle; profiles?: Profile })[]) ?? []).map((ticket) => (
              <Tr key={ticket.id}>
                <Td>
                  <Link href={`/deals/${ticket.id}`} className="hover:underline">
                    {ticket.vehicles ? `${ticket.vehicles.year} ${ticket.vehicles.make} ${ticket.vehicles.model}` : "—"}
                  </Link>
                </Td>
                <Td className="num">{formatMoney(ticket.agreed_price, locale)}</Td>
                <Td>{ticket.financing_type === "cash" ? t("cash") : t("installments")}</Td>
                <Td className="text-[var(--color-text-muted)]">{ticket.profiles?.full_name ?? "—"}</Td>
                <Td>
                  <StatusPill
                    label={
                      ticket.status === "approved" ? t("statusApproved")
                      : ticket.status === "rejected" ? t("statusRejected")
                      : ticket.status === "executed" ? t("statusExecuted")
                      : t("statusSubmitted")
                    }
                    tone={dealStatusTone(ticket.status)}
                  />
                </Td>
              </Tr>
            ))}
            {!tickets?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
