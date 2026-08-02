import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { vehicleStatusTone } from "@/lib/status-tone";
import { InvestorChip } from "@/components/ui/investor-chip";
import { Link } from "@/i18n/navigation";
import type {
  Vehicle,
  VehicleEquitySplit,
  VehicleExpense,
  Branch,
} from "@/lib/supabase/types";
import { ExpenseFormDialog } from "./expense-form";

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ vehicleId: string; locale: string }>;
}) {
  const { vehicleId } = await params;
  const t = await getTranslations("inventory");
  const dealsT = await getTranslations("deals");
  const common = await getTranslations("common");
  const supabase = await createClient();
  const profile = await getProfile();

  const [{ data: vehicle }, { data: splits }, { data: expenses }, { data: branch }] =
    await Promise.all([
      supabase.from("vehicles").select("*").eq("id", vehicleId).maybeSingle(),
      supabase
        .from("vehicle_equity_splits")
        .select("*, investors(id, profiles(full_name))")
        .eq("vehicle_id", vehicleId),
      supabase
        .from("vehicle_expenses")
        .select("*")
        .eq("vehicle_id", vehicleId)
        .order("created_at", { ascending: false }),
      supabase.from("vehicles").select("branch_id").eq("id", vehicleId).maybeSingle(),
    ]);

  if (!vehicle) notFound();

  const v = vehicle as Vehicle;
  const { data: branchRow } = branch
    ? await supabase.from("branches").select("*").eq("id", (branch as { branch_id: string }).branch_id).maybeSingle()
    : { data: null };

  const canManageExpenses = profile && ["ceo", "accountant", "branch_manager"].includes(profile.role);
  const isCeo = profile?.role === "ceo";

  const totalExpenses = ((expenses as VehicleExpense[]) ?? []).reduce((s, e) => s + Number(e.amount), 0);

  return (
    <div className="space-y-6">
      <PanelHeader
        title={`${v.year} ${v.make} ${v.model} ${v.trim ?? ""}`}
        subtitle={v.vin ? `VIN ${v.vin}` : undefined}
        action={
          v.status === "in_stock" ? (
            <Link href={`/crm?newTicketVehicle=${v.id}`}>
              <span className="inline-flex h-9 items-center rounded-lg bg-[var(--color-accent-blue)] px-4 text-sm font-medium text-white hover:brightness-110">
                {dealsT("newTicket")}
              </span>
            </Link>
          ) : (
            <StatusPill
            label={v.status === "reserved" ? t("statusReserved") : t("statusSold")}
            tone={vehicleStatusTone(v.status)}
          />
          )
        }
      />

      <div className="grid gap-6 md:grid-cols-3">
        <Panel className="md:col-span-2">
          <PanelHeader title={t("equitySplit")} />
          <div className="space-y-2">
            {((splits as VehicleEquitySplit[]) ?? []).map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-sm">
                {s.holder_type === "ceo" ? (
                  <span>{t("ceoShare")}</span>
                ) : (
                  <InvestorChip id={s.holder_id ?? s.id} name={s.investors?.profiles?.full_name ?? "Investor"} />
                )}
                <span className="num text-[var(--color-text-muted)]">
                  {s.percentage}% · ${s.amount_invested.toLocaleString()}
                </span>
              </div>
            ))}
          </div>

          {v.photos?.length > 0 && (
            <div className="mt-4 flex gap-2 overflow-x-auto">
              {v.photos.map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p} src={p} alt="" className="h-24 w-32 shrink-0 rounded-lg object-cover" />
              ))}
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title={t("purchasePrice")} />
          <p className="num text-2xl font-semibold">${v.purchase_price.toLocaleString()}</p>
          <div className="mt-3 space-y-1 text-xs text-[var(--color-text-muted)]">
            <div className="flex justify-between"><span>{t("branch")}</span><span>{(branchRow as Branch | null)?.name ?? "—"}</span></div>
            <div className="flex justify-between"><span>{t("expenses")}</span><span className="num">${totalExpenses.toLocaleString()}</span></div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title={t("expenses")}
          action={canManageExpenses ? <ExpenseFormDialog vehicleId={v.id} isCeo={!!isCeo} /> : undefined}
        />
        <Table>
          <THead>
            <Th>{t("category")}</Th>
            <Th>{t("amount")}</Th>
            <Th>{t("note")}</Th>
            <Th>{common("created")}</Th>
          </THead>
          <TBody>
            {((expenses as VehicleExpense[]) ?? []).map((e) => (
              <Tr key={e.id} toneBar={e.is_ceo_override ? "var(--color-accent-amber)" : undefined}>
                <Td>{e.category}</Td>
                <Td className="num">${Number(e.amount).toLocaleString()}</Td>
                <Td className="text-[var(--color-text-muted)]">{e.note || "—"}</Td>
                <Td className="text-[var(--color-text-faint)]">
                  {e.is_ceo_override && (
                    <span className="me-2 rounded bg-[var(--color-accent-amber-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent-amber)]">
                      {t("ceoOverride")}
                    </span>
                  )}
                  {new Date(e.created_at).toLocaleDateString()}
                </Td>
              </Tr>
            ))}
            {!expenses?.length && (
              <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>
            )}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
