import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/ui/stat-card";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { InvestorChip } from "@/components/ui/investor-chip";
import { StatusPill } from "@/components/ui/status-pill";
import { Link } from "@/i18n/navigation";
import type {
  Vehicle,
  Branch,
  LedgerEntry,
  AuditLogRow,
  LeadVehicleInterest,
} from "@/lib/supabase/types";
import { buildDemand, type DemandLead } from "@/lib/demand";
import { LayoutDashboard, Car, Clock, Building2 } from "lucide-react";

/** Beyond this the panel stops being a list and becomes a report. */
const DEMAND_ROWS = 12;

export default async function CeoDashboardPage() {
  const t = await getTranslations("dashboard");
  const demandT = await getTranslations("demand");
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
    { data: interests },
    { data: leads },
  ] = await Promise.all([
    supabase.from("vehicles").select("*"),
    supabase.from("branches").select("*"),
    supabase.from("deal_tickets").select("id").eq("status", "submitted"),
    supabase.from("ledger_entries").select("*").eq("type", "sale_profit_share").gte("created_at", startOfMonth.toISOString()),
    supabase.from("ledger_entries").select("*").in("holder_type", ["investor", "ceo"]),
    supabase.from("investors").select("id, profiles(full_name)"),
    supabase.from("audit_log").select("*, profiles(full_name)").order("created_at", { ascending: false }).limit(10),
    supabase
      .from("lead_vehicle_interests")
      .select("*, vehicles(id, year, make, model, trim, purchase_price, status)"),
    // Only for buildDemand's car_interest fallback — see the note there.
    // Without it this panel is empty on every showroom until somebody
    // starts using the new form, including the ones whose pipeline is full.
    supabase.from("leads").select("id, car_interest, status"),
  ]);

  const demand = buildDemand(
    (interests as LeadVehicleInterest[]) ?? [],
    (leads as DemandLead[]) ?? []
  );

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
        <PanelHeader title={demandT("title")} subtitle={demandT("subtitle")} />
        <Table>
          <THead>
            <Th>{demandT("car")}</Th>
            <Th>{demandT("buyers")}</Th>
            <Th>{demandT("topBudget")}</Th>
            <Th>{demandT("range")}</Th>
            <Th>{demandT("held")}</Th>
          </THead>
          <TBody>
            {demand.slice(0, DEMAND_ROWS).map((d) => (
              <Tr key={d.key}>
                <Td>
                  {d.vehicleId ? (
                    <Link href={`/inventory/${d.vehicleId}`} className="hover:underline">
                      {d.label}
                    </Link>
                  ) : (
                    d.label
                  )}
                </Td>
                <Td className="num">
                  {d.requestedBy}
                  {/* Buyers a salesperson pointed at this car, kept apart from
                      the ones who asked for it. Adding them together is how a
                      showroom buys a second car nobody wanted the first of. */}
                  {d.suggestedTo > 0 && (
                    <span className="ms-1.5 text-xs text-[var(--color-text-faint)]">
                      +{d.suggestedTo} {demandT("suggested")}
                    </span>
                  )}
                </Td>
                <Td className="num">
                  {d.topBudget === null ? (
                    <span className="text-[var(--color-text-faint)]">—</span>
                  ) : (
                    `$${d.topBudget.toLocaleString()}`
                  )}
                </Td>
                <Td className="num text-[var(--color-text-muted)]">
                  {d.quoted === 0
                    ? demandT("noneQuoted")
                    : d.lowBudget === d.topBudget
                      ? demandT("quoted", { count: d.quoted })
                      : `$${d.lowBudget!.toLocaleString()} – $${d.topBudget!.toLocaleString()}`}
                </Td>
                {/* Three states, not two. A row that exists only because a
                    lead's car_interest is free text says nothing about
                    stock — calling it "not in stock" would report a
                    missing Civic while one sits on the floor. */}
                <Td>
                  {d.inStock ? (
                    <StatusPill
                      label={`$${(d.purchasePrice ?? 0).toLocaleString()}`}
                      tone={
                        d.topBudget !== null && d.purchasePrice !== null && d.topBudget < d.purchasePrice
                          ? "red"
                          : "green"
                      }
                    />
                  ) : d.linked ? (
                    <StatusPill label={demandT("notHeld")} tone="amber" />
                  ) : (
                    <StatusPill label={demandT("notLinked")} tone="neutral" />
                  )}
                </Td>
              </Tr>
            ))}
            {!demand.length && (
              <Tr>
                <Td className="text-center text-[var(--color-text-faint)]">{demandT("empty")}</Td>
              </Tr>
            )}
          </TBody>
        </Table>
        {demand.slice(0, DEMAND_ROWS).some((d) => !d.linked) && (
          <p className="mt-3 text-xs text-[var(--color-text-faint)]">
            {demandT("notLinkedHint")}
          </p>
        )}
        {demand.length > DEMAND_ROWS && (
          <p className="mt-1 text-xs text-[var(--color-text-faint)]">
            {demandT("more", { count: demand.length - DEMAND_ROWS })}
          </p>
        )}
      </Panel>

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
