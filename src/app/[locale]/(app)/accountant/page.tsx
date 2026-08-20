import { getLocale, getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { getProfile, FINANCE_ROLES } from "@/lib/auth";
import { ReportsLauncher } from "./reports-launcher";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import type { FinancingPartner, FinancingRequest, Branch, OverheadConfig, DealTicket, Vehicle, ConsignmentPayout } from "@/lib/supabase/types";
import { PartnerFormDialog } from "./partner-form";
import { OverheadRow } from "./overhead-row";
import { RequestStatusControl } from "./request-status";
import { PartnerContractUpload } from "./partner-contract-upload";
import { PayoutSettleDialog } from "./payout-settle";
import { Link } from "@/i18n/navigation";

export default async function AccountantPage() {
  const t = await getTranslations("accountant");
  const tc = await getTranslations("common");
  const locale = await getLocale();
  const supabase = await createClient();
  const profile = await getProfile();

  const [
    { data: partners },
    { data: requests },
    { data: branches },
    { data: overheads },
    { data: payouts },
  ] = await Promise.all([
    supabase.from("financing_partners").select("*").order("created_at", { ascending: false }),
    supabase
      .from("financing_requests")
      .select("*, deal_tickets(agreed_price, vehicles(year, make, model)), financing_partners(bank_name)")
      .order("created_at", { ascending: false }),
    supabase.from("branches").select("*"),
    supabase.from("overhead_config").select("*"),
    // What the showroom owes the owners of consigned stock (0032). RLS
    // is accountant-or-above and org-wide with no branch predicate, so
    // this is the whole group's list — which is the point: paying the
    // consignors is one desk's job, and a list that stopped at a branch
    // boundary would be a list nobody could work from.
    supabase
      .from("consignment_payouts")
      .select("*, vehicles(id, year, make, model), deal_tickets(id)")
      .order("created_at", { ascending: true }),
  ]);

  const overheadByBranch = new Map(((overheads as OverheadConfig[]) ?? []).map((o) => [o.branch_id, o.monthly_opex_amount]));
  const isCeo = profile?.role === "ceo";

  // Split rather than two queries: the table is small (one row per
  // executed consignment sale, ever) and the page already holds all of
  // it. Due first, oldest first — that is the order the desk works in.
  const allPayouts = (payouts as (ConsignmentPayout & { vehicles?: Vehicle })[]) ?? [];
  const duePayouts = allPayouts.filter((p) => p.paid_at === null);
  const paidPayouts = allPayouts
    .filter((p) => p.paid_at !== null)
    .sort((a, b) => (a.paid_at! < b.paid_at! ? 1 : -1));
  const totalDue = duePayouts.reduce((s, p) => s + Number(p.amount_due), 0);

  const isFinance = !!profile && FINANCE_ROLES.includes(profile.role);

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} />

      {isFinance && <ReportsLauncher />}

      <Panel>
        <PanelHeader title={t("financingPartners")} action={<PartnerFormDialog />} />
        <Table>
          <THead>
            <Th>{t("bankName")}</Th>
            <Th>{t("productName")}</Th>
            <Th>{t("rate")}</Th>
            <Th>{t("termMonths")}</Th>
            <Th>{tc("status")}</Th>
          </THead>
          <TBody>
            {((partners as FinancingPartner[]) ?? []).map((p) => (
              <Tr key={p.id}>
                <Td>{p.bank_name}</Td>
                <Td>{p.product_name}</Td>
                <Td className="num">{p.rate ? `${p.rate}%` : "—"}</Td>
                <Td className="num">{p.term_months ?? "—"}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <StatusPill
                      label={p.status === "active" ? t("statusActive") : t("statusPendingUpload")}
                      tone={p.status === "active" ? "green" : "amber"}
                    />
                    {p.status !== "active" && isFinance && <PartnerContractUpload partnerId={p.id} />}
                  </div>
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
            <Th>{tc("vehicle")}</Th>
            <Th>{t("partner")}</Th>
            <Th>{tc("amount")}</Th>
            <Th>{tc("status")}</Th>
          </THead>
          <TBody>
            {((requests as (FinancingRequest & { deal_tickets?: DealTicket & { vehicles?: Vehicle }; financing_partners?: FinancingPartner })[]) ?? []).map((r) => (
              <Tr key={r.id}>
                <Td>{r.deal_tickets?.vehicles ? `${r.deal_tickets.vehicles.year} ${r.deal_tickets.vehicles.make} ${r.deal_tickets.vehicles.model}` : "—"}</Td>
                <Td>{r.financing_partners?.bank_name ?? "—"}</Td>
                <Td className="num">{r.deal_tickets?.agreed_price ? formatMoney(r.deal_tickets.agreed_price, locale) : "—"}</Td>
                <Td>
                  {isFinance ? (
                    <RequestStatusControl requestId={r.id} status={r.status} />
                  ) : (
                    <StatusPill
                      label={t(`requestStatus_${r.status}`)}
                      tone={r.status.includes("approved") ? "green" : r.status.includes("rejected") ? "red" : "amber"}
                    />
                  )}
                </Td>
              </Tr>
            ))}
            {!requests?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>

      {/* CONSIGNMENT PAYOUTS (0032). Money the showroom is holding that
          belongs to somebody else — deliberately not in ledger_entries,
          which is the house's own wallet, and therefore invisible on
          every other finance screen. This is the only place it appears,
          so it appears whether or not there is anything owed. */}
      <Panel>
        <PanelHeader
          title={t("consignmentPayouts")}
          subtitle={t("consignmentPayoutsHint")}
          action={
            duePayouts.length > 0 ? (
              <span className="num text-sm font-semibold text-[var(--color-accent-amber)]">
                {formatMoney(totalDue, locale)}
              </span>
            ) : undefined
          }
        />
        <Table>
          <THead>
            <Th>{t("consignor")}</Th>
            <Th>{tc("vehicle")}</Th>
            <Th>{t("commissionKept")}</Th>
            <Th>{t("amountDue")}</Th>
            <Th>{tc("status")}</Th>
          </THead>
          <TBody>
            {duePayouts.map((p) => (
              <Tr key={p.id} toneBar="var(--color-accent-amber)">
                <Td>{p.consignor_name}</Td>
                <Td>
                  {p.vehicles ? (
                    <Link href={`/inventory/${p.vehicles.id}`} className="hover:underline">
                      {p.vehicles.year} {p.vehicles.make} {p.vehicles.model}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  {formatMoney(Number(p.commission_amount), locale)}
                </Td>
                <Td className="num font-medium">{formatMoney(Number(p.amount_due), locale)}</Td>
                <Td>
                  {isFinance ? (
                    <PayoutSettleDialog
                      payoutId={p.id}
                      consignorName={p.consignor_name}
                      amountDue={Number(p.amount_due)}
                    />
                  ) : (
                    <StatusPill label={t("payoutDue")} tone="amber" />
                  )}
                </Td>
              </Tr>
            ))}
            {paidPayouts.map((p) => (
              <Tr key={p.id}>
                <Td className="text-[var(--color-text-muted)]">{p.consignor_name}</Td>
                <Td className="text-[var(--color-text-muted)]">
                  {p.vehicles ? (
                    <Link href={`/inventory/${p.vehicles.id}`} className="hover:underline">
                      {p.vehicles.year} {p.vehicles.make} {p.vehicles.model}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td className="num text-[var(--color-text-faint)]">
                  {formatMoney(Number(p.commission_amount), locale)}
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  {formatMoney(Number(p.amount_due), locale)}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <StatusPill label={t("payoutPaid")} tone="green" />
                    <span className="text-xs text-[var(--color-text-faint)]">
                      {new Date(p.paid_at as string).toLocaleDateString()}
                      {p.settlement_reference ? ` · ${p.settlement_reference}` : ""}
                    </span>
                  </div>
                </Td>
              </Tr>
            ))}
            {!allPayouts.length && (
              <Tr>
                <Td className="text-center text-[var(--color-text-faint)]">
                  {t("noConsignmentPayouts")}
                </Td>
              </Tr>
            )}
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
