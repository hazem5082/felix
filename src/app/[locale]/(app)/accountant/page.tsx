import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import type { FinancingPartner, FinancingRequest, Branch, OverheadConfig, DealTicket, Vehicle } from "@/lib/supabase/types";
import { PartnerFormDialog } from "./partner-form";
import { OverheadRow } from "./overhead-row";

export default async function AccountantPage() {
  const t = await getTranslations("accountant");
  const supabase = await createClient();
  const profile = await getProfile();

  const [{ data: partners }, { data: requests }, { data: branches }, { data: overheads }] = await Promise.all([
    supabase.from("financing_partners").select("*").order("created_at", { ascending: false }),
    supabase
      .from("financing_requests")
      .select("*, deal_tickets(agreed_price, vehicles(year, make, model)), financing_partners(bank_name)")
      .order("created_at", { ascending: false }),
    supabase.from("branches").select("*"),
    supabase.from("overhead_config").select("*"),
  ]);

  const overheadByBranch = new Map(((overheads as OverheadConfig[]) ?? []).map((o) => [o.branch_id, o.monthly_opex_amount]));
  const isCeo = profile?.role === "ceo";

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} />

      <Panel>
        <PanelHeader title={t("financingPartners")} action={<PartnerFormDialog />} />
        <Table>
          <THead>
            <Th>{t("bankName")}</Th>
            <Th>{t("productName")}</Th>
            <Th>{t("rate")}</Th>
            <Th>{t("termMonths")}</Th>
            <Th>Status</Th>
          </THead>
          <TBody>
            {((partners as FinancingPartner[]) ?? []).map((p) => (
              <Tr key={p.id}>
                <Td>{p.bank_name}</Td>
                <Td>{p.product_name}</Td>
                <Td className="num">{p.rate ? `${p.rate}%` : "—"}</Td>
                <Td className="num">{p.term_months ?? "—"}</Td>
                <Td>
                  <StatusPill
                    label={p.status === "active" ? t("statusActive") : t("statusPendingUpload")}
                    tone={p.status === "active" ? "green" : "amber"}
                  />
                </Td>
              </Tr>
            ))}
            {!partners?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHeader title={t("financingRequests")} />
        <Table>
          <THead>
            <Th>Vehicle</Th>
            <Th>Partner</Th>
            <Th>Amount</Th>
            <Th>Status</Th>
          </THead>
          <TBody>
            {((requests as (FinancingRequest & { deal_tickets?: DealTicket & { vehicles?: Vehicle }; financing_partners?: FinancingPartner })[]) ?? []).map((r) => (
              <Tr key={r.id}>
                <Td>{r.deal_tickets?.vehicles ? `${r.deal_tickets.vehicles.year} ${r.deal_tickets.vehicles.make} ${r.deal_tickets.vehicles.model}` : "—"}</Td>
                <Td>{r.financing_partners?.bank_name ?? "—"}</Td>
                <Td className="num">{r.deal_tickets?.agreed_price ? `$${r.deal_tickets.agreed_price.toLocaleString()}` : "—"}</Td>
                <Td><StatusPill label={r.status.replace(/_/g, " ")} tone={r.status.includes("approved") ? "green" : r.status.includes("rejected") ? "red" : "amber"} /></Td>
              </Tr>
            ))}
            {!requests?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHeader title={t("overheadConfig")} subtitle={t("monthlyOpex")} />
        <div className="space-y-2">
          {((branches as Branch[]) ?? []).map((b) => (
            <OverheadRow
              key={b.id}
              branchId={b.id}
              branchName={b.name}
              initialAmount={overheadByBranch.get(b.id) ?? 0}
              editable={!!isCeo}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}
