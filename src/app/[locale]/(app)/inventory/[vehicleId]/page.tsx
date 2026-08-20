import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/currency";
import { createClient } from "@/lib/supabase/server";
import { getProfile, canSeeCost } from "@/lib/auth";
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
  LeadVehicleInterest,
} from "@/lib/supabase/types";
import { ExpenseFormDialog } from "./expense-form";
import { PricingDialog } from "../pricing-form";
import { colorLabel } from "@/lib/vehicle-color";
import { originLabel } from "@/lib/vehicle-origin";
import { Printer } from "lucide-react";

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ vehicleId: string; locale: string }>;
}) {
  const { vehicleId } = await params;
  const t = await getTranslations("inventory");
  const dealsT = await getTranslations("deals");
  const crm = await getTranslations("crm");
  const interest = await getTranslations("interest");
  const common = await getTranslations("common");
  const colors = await getTranslations("colors");
  const origins = await getTranslations("origins");
  const locale = await getLocale();
  const supabase = await createClient();
  const profile = await getProfile();

  const [
    { data: vehicle },
    { data: splits },
    { data: expenses },
    { data: branch },
    { data: interests },
  ] = await Promise.all([
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
    // RLS scopes this to leads the viewer may read, so a sales exec sees
    // the buyers they are working and a manager sees the branch's. Nobody
    // gets another salesperson's customer list by opening a car.
    supabase
      .from("lead_vehicle_interests")
      .select("*, leads(id, client_name, phone_number, status)")
      .eq("vehicle_id", vehicleId)
      .neq("status", "declined")
      .order("budget_amount", { ascending: false, nullsFirst: false }),
  ]);

  if (!vehicle) notFound();

  const v = vehicle as Vehicle;
  const { data: branchRow } = branch
    ? await supabase.from("branches").select("*").eq("id", (branch as { branch_id: string }).branch_id).maybeSingle()
    : { data: null };

  const canManageExpenses = profile && ["ceo", "accountant", "branch_manager"].includes(profile.role);
  const isCeo = profile?.role === "ceo";
  // Cost, expenses and the funding structure are management's numbers
  // (0028): sales and marketing see the sticker price and lowest offer.
  const showCost = canSeeCost(profile);
  const canPrice = profile && ["ceo", "branch_manager"].includes(profile.role);

  const totalExpenses = ((expenses as VehicleExpense[]) ?? []).reduce((s, e) => s + Number(e.amount), 0);
  const buyers = (interests as LeadVehicleInterest[]) ?? [];

  return (
    <div className="space-y-6">
      <PanelHeader
        title={`${v.year} ${v.make} ${v.model} ${v.trim ?? ""}`}
        subtitle={[colorLabel(colors, v.color), v.vin ? `VIN ${v.vin}` : null].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex items-center gap-2">
            {/* The CPA Decision 115/2021 windshield sticker — a print
                page, so a plain anchor into a new tab like the contract
                link, not an i18n <Link>. */}
            <a
              href={`/${locale}/print/sticker/${v.id}`}
              target="_blank"
              rel="noopener"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-black/[0.04]"
            >
              <Printer size={14} />
              {t("printSticker")}
            </a>
            {v.status === "in_stock" ? (
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
            )}
          </div>
        }
      />

      <div className="grid gap-6 md:grid-cols-3">
        <Panel className="md:col-span-2">
          {/* The funding structure is confidential to management — for the
              sales floor this panel opens straight onto the car itself. */}
          {showCost ? (
            <>
              <PanelHeader title={t("equitySplit")} />
              <div className="space-y-2">
                {((splits as VehicleEquitySplit[]) ?? []).map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-lg bg-black/[0.02] px-3 py-2 text-sm">
                    {s.holder_type === "ceo" ? (
                      <span>{t("ceoShare")}</span>
                    ) : (
                      <InvestorChip id={s.holder_id ?? s.id} name={s.investors?.profiles?.full_name ?? "Investor"} />
                    )}
                    <span className="num text-[var(--color-text-muted)]">
                      {s.percentage}% · {formatMoney(s.amount_invested, locale)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <PanelHeader title={t("vehicleDetails")} />
          )}

          {v.description && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <p className="mb-1 text-xs font-medium text-[var(--color-text-muted)]">{t("description")}</p>
              <p className="whitespace-pre-wrap text-sm text-[var(--color-text)]">{v.description}</p>
            </div>
          )}

          {/* The CPA sticker's amenities list (0025) — shown wherever the
              car is inspected on screen, so the printed sticker never
              says something the page does not. */}
          {v.features?.length > 0 && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <p className="mb-1 text-xs font-medium text-[var(--color-text-muted)]">{t("features")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {v.features.map((feature) => (
                  <li
                    key={feature}
                    className="rounded-full bg-black/[0.04] px-2.5 py-1 text-xs text-[var(--color-text)]"
                  >
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {v.photos?.length > 0 && (
            <div className="mt-4 flex gap-2 overflow-x-auto">
              {v.photos.map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p} src={p} alt="" className="h-24 w-32 shrink-0 rounded-lg object-cover" />
              ))}
            </div>
          )}

          {v.inspection_photos?.length > 0 && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
                {t("inspectionPhotos")}
              </p>
              <div className="flex gap-2 overflow-x-auto">
                {v.inspection_photos.map((p) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={p} src={p} alt="" className="h-20 w-28 shrink-0 rounded-lg object-cover" />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title={t("pricing")}
            action={
              canPrice ? (
                <PricingDialog vehicleId={v.id} askingPrice={v.asking_price} minPrice={v.min_price} />
              ) : undefined
            }
          />
          {/* The sticker price is the headline for everyone — it is the
              number a car is sold against. */}
          <p className="num text-2xl font-semibold">
            {v.asking_price != null ? (
              formatMoney(v.asking_price, locale)
            ) : (
              <span className="text-[var(--color-text-faint)]">{t("notPriced")}</span>
            )}
          </p>
          <div className="mt-3 space-y-1 text-xs text-[var(--color-text-muted)]">
            <div className="flex justify-between">
              <span>{t("lowestOffer")}</span>
              <span className="num">{v.min_price != null ? formatMoney(v.min_price, locale) : "—"}</span>
            </div>
            {showCost && (
              <>
                <div className="flex justify-between"><span>{t("purchasePrice")}</span><span className="num">{formatMoney(v.purchase_price, locale)}</span></div>
                <div className="flex justify-between"><span>{t("expenses")}</span><span className="num">{formatMoney(totalExpenses, locale)}</span></div>
              </>
            )}
            <div className="flex justify-between"><span>{t("branch")}</span><span>{(branchRow as Branch | null)?.name ?? "—"}</span></div>
            <div className="flex justify-between"><span>{t("countryOfOrigin")}</span><span>{originLabel(origins, v.country_of_origin) ?? "—"}</span></div>
          </div>
          {/* The identifiers the traffic authority asks for at ownership
              transfer (0021) — kept together so the clerk reads them off
              one block. dir=ltr on VIN/engine: those are Latin technical
              codes even in the Arabic UI; the plate may be Arabic script,
              so it keeps the page direction. */}
          <div className="mt-3 space-y-1 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
            <div className="flex justify-between gap-3"><span>{t("vin")}</span><span className="num" dir="ltr">{v.vin ?? "—"}</span></div>
            <div className="flex justify-between gap-3"><span>{t("engineNumber")}</span><span className="num" dir="ltr">{v.engine_number ?? "—"}</span></div>
            <div className="flex justify-between gap-3"><span>{t("plateNumber")}</span><span className="num">{v.plate_number ?? "—"}</span></div>
            {/* The ETA e-invoice product code (0026) — monospaced and
                LTR: an EGS/GS1 code is a Latin technical string even in
                the Arabic UI, and the dashes matter when it is read off
                against the portal. */}
            <div className="flex justify-between gap-3"><span>{t("itemCode")}</span><span className="font-mono" dir="ltr">{v.item_code ?? "—"}</span></div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title={interest("buyersTitle")} subtitle={interest("buyersSubtitle")} />
        <Table>
          <THead>
            <Th>{crm("clientName")}</Th>
            <Th>{crm("phone")}</Th>
            <Th>{interest("budget")}</Th>
            <Th>{showCost ? interest("vsCost") : interest("vsAsking")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {buyers.map((i) => {
              const budget = i.budget_amount === null ? null : Number(i.budget_amount);
              // Management reads an offer against cost — the number that
              // decides whether it is worth taking. The sales floor reads
              // it against the sticker price, never the cost (0028).
              const baseline = showCost
                ? Number(v.purchase_price)
                : v.asking_price != null
                  ? Number(v.asking_price)
                  : null;
              const gap = budget === null || baseline === null ? null : budget - baseline;
              return (
                <Tr key={i.id}>
                  <Td>
                    {i.leads ? (
                      <Link href={`/crm/${i.leads.id}`} className="hover:underline">
                        {i.leads.client_name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="num text-[var(--color-text-muted)]">{i.leads?.phone_number ?? "—"}</Td>
                  <Td className="num">
                    {budget === null ? (
                      <span className="text-[var(--color-text-faint)]">{interest("noBudget")}</span>
                    ) : (
                      formatMoney(budget, locale)
                    )}
                  </Td>
                  <Td
                    className={`num ${
                      gap === null
                        ? ""
                        : gap >= 0
                          ? "text-[var(--color-accent-green)]"
                          : "text-[var(--color-accent-red)]"
                    }`}
                  >
                    {gap === null ? "—" : `${gap >= 0 ? "+" : "−"}${formatMoney(Math.abs(gap), locale)}`}
                  </Td>
                  <Td>
                    <StatusPill
                      label={i.status === "shown" ? interest("statusShown") : interest("statusOpen")}
                      tone={i.status === "shown" ? "blue" : "amber"}
                    />
                  </Td>
                </Tr>
              );
            })}
            {!buyers.length && (
              <Tr>
                <Td className="text-center text-[var(--color-text-faint)]">{interest("noBuyers")}</Td>
              </Tr>
            )}
          </TBody>
        </Table>
      </Panel>

      {showCost && (
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
                <Td className="num">{formatMoney(Number(e.amount), locale)}</Td>
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
      )}
    </div>
  );
}
