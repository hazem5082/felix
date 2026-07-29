import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/ui/stat-card";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { InvestorChip } from "@/components/ui/investor-chip";
import type { Vehicle, Branch, LedgerEntry, AuditLogRow } from "@/lib/supabase/types";
import { LayoutDashboard, Car, Clock, Building2 } from "lucide-react";

export default async function CeoDashboardPage() {
  const t = await getTranslations("dashboard");
  const misc = await getTranslations("misc");
  const supabase = await createClient();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [
    { data: vehicles },
    { data: branches },
    { data: pendingTickets },
    { data: mtdLedger },
    { data: investorLedger },
    { data: investorNamesData },
    { data: auditLog },
  ] = await Promise.all([
    supabase.from("vehicles").select("*"),
    supabase.from("branches").select("*"),
    supabase.from("deal_tickets").select("id").eq("status", "submitted"),
    supabase.from("ledger_entries").select("*").eq("type", "sale_profit_share").gte("created_at", startOfMonth.toISOString()),
    supabase.from("ledger_entries").select("*").in("holder_type", ["investor", "ceo"]),
    supabase.from("investors").select("id, profiles(full_name)"),
    supabase.from("audit_log").select("*, profiles(full_name)").order("created_at", { ascending: false }).limit(10),
  ]);

  const investorNames = new Map(
    ((investorNamesData as unknown as { id: string; profiles?: { full_name: string } }[]) ?? []).map((i) => [i.id, i.profiles?.full_name ?? "Investor"])
  );

  const activeInventoryValue = ((vehicles as Vehicle[]) ?? [])
    .filter((v) => v.status !== "sold")
    .reduce((s, v) => s + Number(v.purchase_price), 0);

  const mtdProfit = ((mtdLedger as LedgerEntry[]) ?? []).reduce((s, e) => s + Number(e.amount), 0);

  const walletBalances = new Map<string, number>();
  ((investorLedger as LedgerEntry[]) ?? []).forEach((e) => {
    const key = e.holder_type === "ceo" ? "ceo" : (e.holder_id ?? "unknown");
    walletBalances.set(key, (walletBalances.get(key) ?? 0) + Number(e.amount));
  });

  const branchRollup = ((branches as Branch[]) ?? []).map((b) => {
    const branchVehicles = ((vehicles as Vehicle[]) ?? []).filter((v) => v.branch_id === b.id);
    return {
      branch: b,
      vehicleCount: branchVehicles.length,
      activeValue: branchVehicles.filter((v) => v.status !== "sold").reduce((s, v) => s + Number(v.purchase_price), 0),
      soldCount: branchVehicles.filter((v) => v.status === "sold").length,
    };
  });

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("activeInventoryValue")} value={activeInventoryValue} prefix="$" icon={<Car size={16} />} />
        <StatCard label={t("mtdProfit")} value={mtdProfit} prefix="$" tone={mtdProfit >= 0 ? "green" : "red"} icon={<LayoutDashboard size={16} />} />
        <StatCard label={t("pendingApprovals")} value={pendingTickets?.length ?? 0} tone="amber" icon={<Clock size={16} />} />
        <StatCard label={t("activeBranches")} value={branches?.length ?? 0} icon={<Building2 size={16} />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title={t("branchRollup")} />
          <Table>
            <THead>
              <Th>{misc("branchCol")}</Th>
              <Th>{misc("inStockCol")}</Th>
              <Th>{misc("soldCol")}</Th>
              <Th>{misc("activeValueCol")}</Th>
            </THead>
            <TBody>
              {branchRollup.map((r) => (
                <Tr key={r.branch.id}>
                  <Td>{r.branch.name}</Td>
                  <Td className="num">{r.vehicleCount - r.soldCount}</Td>
                  <Td className="num">{r.soldCount}</Td>
                  <Td className="num">${r.activeValue.toLocaleString()}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Panel>

        <Panel>
          <PanelHeader title={t("investorLedger")} />
          <div className="space-y-2">
            {Array.from(walletBalances.entries()).map(([key, balance]) => (
              <div key={key} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-sm">
                {key === "ceo" ? <span>{misc("ceoWallet")}</span> : <InvestorChip id={key} name={investorNames.get(key) ?? "Investor"} />}
                <span className={`num ${balance >= 0 ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}`}>
                  ${balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
            ))}
            {!walletBalances.size && <p className="text-xs text-[var(--color-text-faint)]">{misc("noLedgerActivity")}</p>}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title={t("auditLog")} />
        <div className="space-y-1.5">
          {((auditLog as (AuditLogRow & { profiles?: { full_name: string } })[]) ?? []).map((a) => (
            <div key={a.id} className="flex items-center justify-between border-b border-[var(--color-border)] py-1.5 text-xs last:border-0">
              <span className="text-[var(--color-text-muted)]">
                <span className="text-[var(--color-text)]">{a.profiles?.full_name ?? misc("system")}</span> · {a.action}
              </span>
              <span className="text-[var(--color-text-faint)]">{new Date(a.created_at).toLocaleString()}</span>
            </div>
          ))}
          {!auditLog?.length && <p className="text-xs text-[var(--color-text-faint)]">{misc("noActivityRecorded")}</p>}
        </div>
      </Panel>
    </div>
  );
}
