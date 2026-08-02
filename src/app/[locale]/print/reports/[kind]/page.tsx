import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveTenant, FINANCE_ROLES } from "@/lib/auth";
import { getTenant } from "@/lib/tenant";
import { resolveWindow, isReportKind, parseOffset } from "@/lib/report-window";
import type {
  Branch,
  DealTicket,
  Investor,
  LedgerEntry,
  Profile,
  Vehicle,
  VehicleEquitySplit,
  VehicleExpense,
} from "@/lib/supabase/types";
import { PrintToolbar } from "../../print-toolbar";
import { DocFooter, DocHeader } from "../../doc-chrome";

/**
 * The report suite: /print/reports/<kind>?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 *   operating  — the P&L sheet (units, revenue, ledger movement).
 *                Monthly, quarterly and yearly reports are this one
 *                document over different windows; the launcher picks
 *                the dates, the numbers are computed identically.
 *   investors  — capital deployed, wallet balances, distributions.
 *   expenses   — vehicle expenses, by category and by branch.
 *   salaries   — salary + commission payouts, by person.
 *
 * Finance roles only; every row arrives through the viewer's own RLS
 * session. Rendered as branded print pages — the browser's print-to-PDF
 * is the export path (the microloans pattern), because it's the only
 * PDF engine with full Arabic shaping that costs zero dependencies.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; kind: string }>;
  searchParams: Promise<{ from?: string; to?: string; tz?: string }>;
}) {
  const { locale, kind } = await params;
  if (!isReportKind(kind)) notFound();
  // Not requireRole: these pages sit outside the (app) layout, so they
  // must re-assert the tenant-host binding and the licence status the
  // layout would otherwise have enforced.
  const profile = await requireActiveTenant(locale, FINANCE_ROLES);

  const t = await getTranslations("reportDoc");
  const fmt = await getFormatter();
  const supabase = await createClient();
  const tenant = await getTenant();

  const sp = await searchParams;
  // The launcher sends the viewer's UTC offset so a "July" report means
  // July where the showroom is, not July in the Worker's UTC clock.
  const offset = parseOffset(sp.tz);
  const { from, to } = resolveWindow(sp.from, sp.to, new Date(), offset);
  const toInclusive = new Date(to.getTime() - 1);

  const money = (n: number) =>
    fmt.number(n, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  // Dates are shown in the same zone the window was cut in, so a row's
  // printed date can never contradict the range printed above it.
  const day = (d: Date | string) => {
    const at = typeof d === "string" ? new Date(d) : d;
    return fmt.dateTime(new Date(at.getTime() + offset * 60_000), {
      dateStyle: "medium",
      timeZone: "UTC",
    });
  };

  const rangeLabel = `${day(from)} – ${day(toInclusive)}`;

  const header = (
    <DocHeader
      showroomName={tenant?.name ?? "FELIX"}
      docTitle={t(`title_${kind}`)}
      meta={
        <>
          <p className="font-semibold text-black">{rangeLabel}</p>
          <p>
            {t("generatedBy", { name: profile.full_name })} —{" "}
            {fmt.dateTime(new Date(), { dateStyle: "medium" })}
          </p>
        </>
      }
    />
  );

  const chrome = (body: React.ReactNode, footerLine: string) => (
    <article className="text-[13px] leading-relaxed text-black">
      <PrintToolbar />
      {header}
      {body}
      <DocFooter line={footerLine} />
    </article>
  );

  const th = "py-1.5 text-start font-bold";
  const td = "py-1.5";
  const sectionTitle = "text-[11px] font-bold uppercase tracking-widest text-black/50";

  // ── operating ─────────────────────────────────────────────
  if (kind === "operating") {
    const [{ data: executedRows }, { data: ledgerRows }, { data: branchRows }] = await Promise.all([
      supabase
        .from("deal_tickets")
        .select("*, vehicles(*)")
        .eq("status", "executed")
        .gte("executed_at", from.toISOString())
        .lt("executed_at", to.toISOString())
        .order("executed_at"),
      supabase
        .from("ledger_entries")
        .select("*")
        .gte("created_at", from.toISOString())
        .lt("created_at", to.toISOString()),
      supabase.from("branches").select("*").order("name"),
    ]);

    const executed = (executedRows as (DealTicket & { vehicles?: Vehicle })[]) ?? [];
    const ledger = (ledgerRows as LedgerEntry[]) ?? [];
    const branches = (branchRows as Branch[]) ?? [];

    const grossRevenue = executed.reduce(
      (s, d) => s + Number(d.agreed_price) - Number(d.discount_amount),
      0
    );
    const acquisitionCost = executed.reduce(
      (s, d) => s + Number(d.vehicles?.purchase_price ?? 0),
      0
    );
    const byType = new Map<string, number>();
    for (const e of ledger) byType.set(e.type, (byType.get(e.type) ?? 0) + Number(e.amount));

    const LEDGER_TYPES: LedgerEntry["type"][] = [
      "sale_profit_share", "commission", "salary", "deposit", "withdrawal", "opex_offset",
    ];

    return chrome(
      <>
        <section className="mt-6 grid grid-cols-4 gap-4">
          {[
            [t("unitsSold"), String(executed.length)],
            [t("grossRevenue"), money(grossRevenue)],
            [t("acquisitionCost"), money(acquisitionCost)],
            [t("profitDistributed"), money(byType.get("sale_profit_share") ?? 0)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-black/15 p-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-black/50">{k}</p>
              <p className="mt-1 text-lg font-black">{v}</p>
            </div>
          ))}
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("salesDetail")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[t("date"), t("vehicle"), t("branch"), t("payment"), t("finalPrice")].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {executed.map((d) => (
                <tr key={d.id} className="border-b border-black/10">
                  <td className={td}>{d.executed_at ? day(d.executed_at) : "—"}</td>
                  <td className={td}>
                    {d.vehicles ? `${d.vehicles.year} ${d.vehicles.make} ${d.vehicles.model}` : "—"}
                  </td>
                  <td className={td}>{branches.find((b) => b.id === d.branch_id)?.name ?? "—"}</td>
                  <td className={td}>{d.financing_type === "cash" ? t("cash") : t("installments")}</td>
                  <td className={`${td} font-semibold`}>
                    {money(Number(d.agreed_price) - Number(d.discount_amount))}
                  </td>
                </tr>
              ))}
              {!executed.length && (
                <tr><td colSpan={5} className="py-3 text-center text-black/50">{t("noSales")}</td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("byBranch")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[t("branch"), t("unitsSold"), t("grossRevenue")].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => {
                const deals = executed.filter((d) => d.branch_id === b.id);
                return (
                  <tr key={b.id} className="border-b border-black/10">
                    <td className={td}>{b.name}</td>
                    <td className={td}>{deals.length}</td>
                    <td className={`${td} font-semibold`}>
                      {money(deals.reduce((s, d) => s + Number(d.agreed_price) - Number(d.discount_amount), 0))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("ledgerSummary")}</h2>
          <table className="mt-2 w-full border-collapse">
            <tbody>
              {LEDGER_TYPES.map((type) => (
                <tr key={type} className="border-b border-black/10">
                  <td className={`${td} w-64 font-medium text-black/60`}>{t(`ledger_${type}`)}</td>
                  <td className={`${td} font-semibold`}>{money(byType.get(type) ?? 0)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-2 font-bold">{t("netMovement")}</td>
                <td className="py-2 text-base font-black">
                  {money(ledger.reduce((s, e) => s + Number(e.amount), 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </>,
      t("footerInternal")
    );
  }

  // ── investors ─────────────────────────────────────────────
  if (kind === "investors") {
    const [{ data: investorRows }, { data: splitRows }, { data: ledgerRows }] = await Promise.all([
      supabase.from("investors").select("*, profiles(*)"),
      supabase.from("vehicle_equity_splits").select("*, vehicles(*)").eq("holder_type", "investor"),
      supabase.from("ledger_entries").select("*").eq("holder_type", "investor"),
    ]);

    const investors = (investorRows as (Investor & { profiles?: Profile })[]) ?? [];
    const splits = (splitRows as (VehicleEquitySplit & { vehicles?: Vehicle })[]) ?? [];
    const ledger = (ledgerRows as LedgerEntry[]) ?? [];

    const rows = investors.map((inv) => {
      const mySplits = splits.filter((s) => s.holder_id === inv.id);
      const active = mySplits.filter((s) => s.vehicles?.status !== "sold");
      const wallet = ledger
        .filter((e) => e.holder_id === inv.id)
        .reduce((s, e) => s + Number(e.amount), 0);
      const distributions = ledger
        .filter(
          (e) =>
            e.holder_id === inv.id &&
            e.type === "sale_profit_share" &&
            new Date(e.created_at) >= from &&
            new Date(e.created_at) < to
        )
        .reduce((s, e) => s + Number(e.amount), 0);
      return {
        id: inv.id,
        name: inv.profiles?.full_name ?? "Investor",
        activeCapital: active.reduce((s, x) => s + Number(x.amount_invested), 0),
        activeCars: active.length,
        totalCars: mySplits.length,
        wallet,
        distributions,
      };
    });

    return chrome(
      <>
        <section className="mt-6">
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[t("investor"), t("activeCapital"), t("activeVehicles"), t("distributionsInPeriod"), t("walletBalance")].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-black/10">
                  <td className={`${td} font-semibold`}>{r.name}</td>
                  <td className={td}>{money(r.activeCapital)}</td>
                  <td className={td}>{r.activeCars} / {r.totalCars}</td>
                  <td className={td}>{money(r.distributions)}</td>
                  <td className={`${td} font-semibold`}>{money(r.wallet)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={5} className="py-3 text-center text-black/50">{t("noInvestors")}</td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("activePositions")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[t("investor"), t("vehicle"), t("invested"), t("ownership")].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {splits
                .filter((s) => s.vehicles?.status !== "sold")
                .map((s) => (
                  <tr key={s.id} className="border-b border-black/10">
                    <td className={td}>
                      {investors.find((i) => i.id === s.holder_id)?.profiles?.full_name ?? "—"}
                    </td>
                    <td className={td}>
                      {s.vehicles ? `${s.vehicles.year} ${s.vehicles.make} ${s.vehicles.model}` : "—"}
                    </td>
                    <td className={td}>{money(Number(s.amount_invested))}</td>
                    <td className={td}>{Number(s.percentage)}%</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      </>,
      t("footerInternal")
    );
  }

  // ── expenses ──────────────────────────────────────────────
  if (kind === "expenses") {
    const { data: expenseRows } = await supabase
      .from("vehicle_expenses")
      .select("*, vehicles(*)")
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .order("created_at");

    const expenses = (expenseRows as (VehicleExpense & { vehicles?: Vehicle })[]) ?? [];
    const byCategory = new Map<string, number>();
    for (const e of expenses)
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + Number(e.amount));
    const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

    return chrome(
      <>
        <section className="mt-6 grid grid-cols-4 gap-4">
          <div className="rounded-lg border border-black/15 p-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-black/50">{t("totalExpenses")}</p>
            <p className="mt-1 text-lg font-black">{money(total)}</p>
          </div>
          <div className="rounded-lg border border-black/15 p-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-black/50">{t("entries")}</p>
            <p className="mt-1 text-lg font-black">{expenses.length}</p>
          </div>
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("byCategory")}</h2>
          <table className="mt-2 w-full border-collapse">
            <tbody>
              {[...byCategory.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([cat, amount]) => (
                  <tr key={cat} className="border-b border-black/10">
                    <td className={`${td} w-64 font-medium text-black/60`}>{cat}</td>
                    <td className={`${td} font-semibold`}>{money(amount)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("expenseDetail")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[t("date"), t("vehicle"), t("category"), t("note"), t("amount")].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-black/10">
                  <td className={td}>{day(e.created_at)}</td>
                  <td className={td}>
                    {e.vehicles ? `${e.vehicles.year} ${e.vehicles.make} ${e.vehicles.model}` : "—"}
                  </td>
                  <td className={td}>{e.category}</td>
                  <td className={`${td} text-black/60`}>{e.note ?? "—"}</td>
                  <td className={`${td} font-semibold`}>{money(Number(e.amount))}</td>
                </tr>
              ))}
              {!expenses.length && (
                <tr><td colSpan={5} className="py-3 text-center text-black/50">{t("noExpenses")}</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </>,
      t("footerInternal")
    );
  }

  // ── salaries ──────────────────────────────────────────────
  const [{ data: ledgerRows }, { data: profileRows }] = await Promise.all([
    supabase
      .from("ledger_entries")
      .select("*")
      .in("type", ["salary", "commission"])
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .order("created_at"),
    supabase.from("profiles").select("id, full_name"),
  ]);

  const entries = (ledgerRows as LedgerEntry[]) ?? [];
  const names = new Map(
    ((profileRows as Pick<Profile, "id" | "full_name">[]) ?? []).map((p) => [p.id, p.full_name])
  );
  const byPerson = new Map<string, { salary: number; commission: number }>();
  for (const e of entries) {
    const key = e.holder_id ?? "ceo";
    const row = byPerson.get(key) ?? { salary: 0, commission: 0 };
    if (e.type === "salary") row.salary += Number(e.amount);
    else row.commission += Number(e.amount);
    byPerson.set(key, row);
  }

  return chrome(
    <>
      <section className="mt-6">
        <table className="mt-2 w-full border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              {[t("person"), t("ledger_salary"), t("ledger_commission"), t("totalPaid")].map((h) => (
                <th key={h} className={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...byPerson.entries()].map(([id, row]) => (
              <tr key={id} className="border-b border-black/10">
                <td className={`${td} font-semibold`}>
                  {id === "ceo" ? t("ceoWallet") : (names.get(id) ?? "—")}
                </td>
                <td className={td}>{money(row.salary)}</td>
                <td className={td}>{money(row.commission)}</td>
                <td className={`${td} font-semibold`}>{money(row.salary + row.commission)}</td>
              </tr>
            ))}
            {!byPerson.size && (
              <tr><td colSpan={4} className="py-3 text-center text-black/50">{t("noPayouts")}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-8">
        <h2 className={sectionTitle}>{t("payoutDetail")}</h2>
        <table className="mt-2 w-full border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              {[t("date"), t("person"), t("type"), t("note"), t("amount")].map((h) => (
                <th key={h} className={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-black/10">
                <td className={td}>{day(e.created_at)}</td>
                <td className={td}>{e.holder_id ? (names.get(e.holder_id) ?? "—") : t("ceoWallet")}</td>
                <td className={td}>{e.type === "salary" ? t("ledger_salary") : t("ledger_commission")}</td>
                <td className={`${td} text-black/60`}>{e.note ?? "—"}</td>
                <td className={`${td} font-semibold`}>{money(Number(e.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>,
    t("footerInternal")
  );
}
