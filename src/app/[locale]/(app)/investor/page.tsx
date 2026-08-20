import { getLocale, getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { getProfile } from "@/lib/auth";
import { StatCard } from "@/components/ui/stat-card";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { vehicleStatusTone } from "@/lib/status-tone";
import type { VehicleEquitySplit, Vehicle, LedgerEntry } from "@/lib/supabase/types";
import { Wallet, Car, TrendingUp } from "lucide-react";

export default async function InvestorPortalPage() {
  const t = await getTranslations("investorPortal");
  const misc = await getTranslations("misc");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const supabase = await createClient();
  const profile = await getProfile();
  if (!profile) return null;

  const [{ data: splits }, { data: ledger }] = await Promise.all([
    supabase.from("vehicle_equity_splits").select("*, vehicles(*)").eq("holder_id", profile.id),
    supabase.from("ledger_entries").select("*").eq("holder_type", "investor").eq("holder_id", profile.id).order("created_at", { ascending: false }),
  ]);

  const walletBalance = ((ledger as LedgerEntry[]) ?? []).reduce((s, e) => s + Number(e.amount), 0);
  const totalInvested = ((splits as VehicleEquitySplit[]) ?? []).reduce((s, r) => s + Number(r.amount_invested), 0);
  const activeVehicles = ((splits as (VehicleEquitySplit & { vehicles?: Vehicle })[]) ?? []).filter((s) => s.vehicles?.status !== "sold").length;

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t("walletBalance")} value={walletBalance} currency tone={walletBalance >= 0 ? "green" : "red"} icon={<Wallet size={16} />} />
        <StatCard label={misc("totalInvested")} value={totalInvested} currency icon={<TrendingUp size={16} />} />
        <StatCard label={t("fundedVehicles")} value={activeVehicles} icon={<Car size={16} />} />
      </div>

      <Panel>
        <PanelHeader title={t("fundedVehicles")} />
        <Table>
          <THead>
            <Th>{common("vehicle")}</Th>
            <Th>{t("ownership")}</Th>
            <Th>{common("invested")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {((splits as (VehicleEquitySplit & { vehicles?: Vehicle })[]) ?? []).map((s) => (
              <Tr key={s.id}>
                <Td>{s.vehicles ? `${s.vehicles.year} ${s.vehicles.make} ${s.vehicles.model}` : "—"}</Td>
                <Td className="num">{s.percentage}%</Td>
                <Td className="num">{formatMoney(s.amount_invested, locale)}</Td>
                <Td>
                  {s.vehicles && (
                    <StatusPill
                      label={s.vehicles.status === "sold" ? misc("soldCol") : s.vehicles.status === "reserved" ? misc("reserved") : misc("inStockCol")}
                      tone={vehicleStatusTone(s.vehicles.status)}
                    />
                  )}
                </Td>
              </Tr>
            ))}
            {!splits?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHeader title={t("ledgerHistory")} />
        <Table>
          <THead>
            <Th>{misc("type")}</Th>
            <Th>{common("amount")}</Th>
            <Th>{common("note")}</Th>
            <Th>{misc("date")}</Th>
          </THead>
          <TBody>
            {((ledger as LedgerEntry[]) ?? []).map((e) => (
              <Tr key={e.id} toneBar={e.amount >= 0 ? "var(--color-accent-green)" : "var(--color-accent-red)"}>
                <Td className="capitalize">{e.type.replace(/_/g, " ")}</Td>
                <Td className={`num ${e.amount >= 0 ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}`}>
                  {e.amount >= 0 ? "+" : ""}{formatMoney(e.amount, locale)}
                </Td>
                <Td className="text-[var(--color-text-muted)]">{e.note ?? "—"}</Td>
                <Td className="text-[var(--color-text-faint)]">{new Date(e.created_at).toLocaleDateString()}</Td>
              </Tr>
            ))}
            {!ledger?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
