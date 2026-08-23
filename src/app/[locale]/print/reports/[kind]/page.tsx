import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveTenant } from "@/lib/auth";
import { getTenant } from "@/lib/tenant";
import { resolveWindow, isReportKind, parseOffset, REPORT_ROLES } from "@/lib/report-window";
import { formatMoney } from "@/lib/currency";
import type {
  Branch,
  Role,
  DealTicket,
  Investor,
  LedgerEntry,
  Profile,
  Vehicle,
  VehicleEquitySplit,
  VehicleExpense,
} from "@/lib/supabase/types";
import {
  formatDuration,
  localTime,
  summariseRange,
  type AttendanceEvent,
} from "@/lib/attendance";
import { PrintToolbar } from "../../print-toolbar";
import { DocFooter, DocHeader, getCompanySettings } from "../../doc-chrome";

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
 *   vat        — VAT Return Prep (Form 10): output tax on executed
 *                sales, input tax on vehicle expenses, net position.
 *                A worksheet for the accountant, not the filed return.
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
  // Per-kind since 0038, not per-suite: attendance is an HR document
  // and the branch manager who needs it must still never reach a P&L.
  // See REPORT_ROLES in lib/report-window.ts.
  const profile = await requireActiveTenant(locale, [...REPORT_ROLES[kind]] as Role[]);

  const t = await getTranslations("reportDoc");
  const fmt = await getFormatter();
  const supabase = await createClient();
  const tenant = await getTenant();
  // The showroom's own letterhead (0046) — null until a CEO saves one,
  // in which case DocHeader falls back to the tenant name as before.
  const company = await getCompanySettings();

  const sp = await searchParams;
  // The launcher sends the viewer's UTC offset so a "July" report means
  // July where the showroom is, not July in the Worker's UTC clock.
  const offset = parseOffset(sp.tz);
  const { from, to } = resolveWindow(sp.from, sp.to, new Date(), offset);
  const toInclusive = new Date(to.getTime() - 1);

  const money = (n: number) => formatMoney(n, locale);
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
      company={company}
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
                {[t("date"), t("vehicle"), t("branch"), t("payment"), t("settlement"), t("finalPrice")].map((h) => (
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
                  <td className={td}>
                    {d.settlement_method ? t(`settlement_${d.settlement_method}`) : "—"}
                  </td>
                  <td className={`${td} font-semibold`}>
                    {money(Number(d.agreed_price) - Number(d.discount_amount))}
                  </td>
                </tr>
              ))}
              {!executed.length && (
                <tr><td colSpan={6} className="py-3 text-center text-black/50">{t("noSales")}</td></tr>
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
  // ── attendance ────────────────────────────────────────────
  //
  // The first report in the suite that is not a financial document, and
  // the only one a branch manager can open. It deliberately reads
  // WITHOUT a branch filter: `attendance_events_select` already confines
  // a manager to their own branch and shows the CEO everyone, so a
  // filter here would restate the rule somewhere it could drift — and
  // would silently narrow the CEO.
  //
  // Every day in the window appears for every on-site person, INCLUDING
  // the days they did not turn up. A report whose absences are invisible
  // is not an attendance report, and "no row at all" is exactly what
  // somebody who never punched would otherwise produce.
  if (kind === "attendance") {
    const [{ data: eventRows }, { data: staffRows }, { data: branchRows }] = await Promise.all([
      supabase
        .from("attendance_events")
        .select("*")
        .gte("occurred_at", from.toISOString())
        .lt("occurred_at", to.toISOString())
        .order("occurred_at"),
      supabase
        .from("profiles")
        .select("id, full_name, role, branch_id, work_mode")
        .neq("role", "investor")
        .order("full_name"),
      supabase.from("branches").select("*").order("name"),
    ]);

    const events = (eventRows as AttendanceEvent[] | null) ?? [];
    const staff =
      (staffRows as
        | { id: string; full_name: string; role: string; branch_id: string | null; work_mode: string }[]
        | null) ?? [];
    const branches = (branchRows as Branch[]) ?? [];
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    // Remote staff are named with their mode rather than dropped: "who
    // is remote" is part of the answer to "who was not here", and
    // omitting them makes the headcount at the top of the page wrong.
    const onSite = staff.filter((p) => p.work_mode === "on_site");
    const remote = staff.filter((p) => p.work_mode === "remote");

    const perPerson = onSite.map((person) => {
      const days = summariseRange(events, {
        profileId: person.id,
        from,
        to,
        offsetMinutes: offset,
        now: new Date(),
      });
      return {
        person,
        days,
        worked: days.reduce((sum, d) => sum + d.workedMinutes, 0),
        breaks: days.reduce((sum, d) => sum + d.breakMinutes, 0),
        present: days.filter((d) => d.events.length > 0).length,
        absent: days.filter((d) => d.events.length === 0).length,
        flagged: days.reduce((sum, d) => sum + d.outsideFence, 0),
        adjusted: days.filter((d) => d.adjusted).length,
      };
    });

    const totalFlagged = perPerson.reduce((sum, p) => sum + p.flagged, 0);
    const totalAdjusted = perPerson.reduce((sum, p) => sum + p.adjusted, 0);

    return chrome(
      <>
        <section className="mt-6">
          <h2 className={sectionTitle}>{t("attendanceSummary")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[
                  t("person"),
                  t("branch"),
                  t("daysPresent"),
                  t("daysAbsent"),
                  t("hoursWorked"),
                  t("breakTime"),
                  t("flagged"),
                  t("adjusted"),
                ].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {perPerson.map(({ person, worked, breaks, present, absent, flagged, adjusted }) => (
                <tr key={person.id} className="border-b border-black/10">
                  <td className={td}>{person.full_name}</td>
                  <td className={`${td} text-black/60`}>
                    {person.branch_id ? (branchName.get(person.branch_id) ?? "—") : "—"}
                  </td>
                  <td className={td}>{present}</td>
                  <td className={td}>{absent}</td>
                  <td className={`${td} font-semibold`}>{formatDuration(worked)}</td>
                  <td className={td}>{formatDuration(breaks)}</td>
                  {/* Zeroes print as an em dash so the eye lands only on
                      the numbers that need looking at. */}
                  <td className={td}>{flagged || "—"}</td>
                  <td className={td}>{adjusted || "—"}</td>
                </tr>
              ))}
              {perPerson.length === 0 && (
                <tr>
                  <td className={`${td} text-black/50`} colSpan={8}>
                    {t("noAttendance")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {(totalFlagged > 0 || totalAdjusted > 0) && (
          <p className="mt-4 text-[12px] text-black/70">
            {t("attendanceCaveat", { flagged: totalFlagged, adjusted: totalAdjusted })}
          </p>
        )}

        {remote.length > 0 && (
          <section className="mt-8">
            <h2 className={sectionTitle}>{t("remoteStaff")}</h2>
            <p className="mt-2 text-[12px] text-black/60">
              {remote.map((p) => p.full_name).join(", ")}
            </p>
          </section>
        )}

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("attendanceDetail")}</h2>
          {perPerson.map(({ person, days }) => {
            const worked = days.filter((d) => d.events.length > 0);
            if (worked.length === 0) return null;
            return (
              <div key={person.id} className="mt-4 break-inside-avoid">
                <p className="text-[12px] font-bold text-black">{person.full_name}</p>
                <table className="mt-1 w-full border-collapse">
                  <thead>
                    <tr className="border-b border-black">
                      {[
                        t("date"),
                        t("arrived"),
                        t("left"),
                        t("hoursWorked"),
                        t("breakTime"),
                        t("note"),
                      ].map((h) => (
                        <th key={h} className={th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {worked.map((d) => (
                      <tr key={d.date} className="border-b border-black/10">
                        <td className={td}>{d.date}</td>
                        <td className={td}>{d.firstIn ? localTime(d.firstIn, offset) : "—"}</td>
                        <td className={td}>{d.lastOut ? localTime(d.lastOut, offset) : "—"}</td>
                        <td className={td}>{formatDuration(d.workedMinutes)}</td>
                        <td className={td}>{formatDuration(d.breakMinutes)}</td>
                        <td className={`${td} text-black/60`}>
                          {[
                            d.outsideFence > 0 ? t("outsideCount", { count: d.outsideFence }) : null,
                            d.adjusted ? t("adjustedNote") : null,
                            d.open ? t("stillIn") : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      </>,
      t("footerInternal")
    );
  }

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

  // ── vat ───────────────────────────────────────────────────
  if (kind === "vat") {
    const [{ data: executedRows }, { data: expenseRows }, { data: branchRows }] = await Promise.all([
      supabase
        .from("deal_tickets")
        .select("*, vehicles(*)")
        .eq("status", "executed")
        .gte("executed_at", from.toISOString())
        .lt("executed_at", to.toISOString())
        .order("executed_at"),
      supabase
        .from("vehicle_expenses")
        .select("*, vehicles(*)")
        .gte("created_at", from.toISOString())
        .lt("created_at", to.toISOString())
        .order("created_at"),
      supabase.from("branches").select("*").order("name"),
    ]);

    const executed = (executedRows as (DealTicket & { vehicles?: Vehicle })[]) ?? [];
    const expenses = (expenseRows as (VehicleExpense & { vehicles?: Vehicle })[]) ?? [];
    const branches = (branchRows as Branch[]) ?? [];

    // Rows predating migration 0022 carry null VAT columns. They are
    // shown as "—" but EXCLUDED from every total — summing unknowns as
    // zero would print a confident, wrong return. The counts below tell
    // the accountant exactly how incomplete the worksheet is.
    const salesMissingVat = executed.filter((d) => d.vat_amount == null).length;
    const outputVat = executed.reduce(
      (s, d) => (d.vat_amount == null ? s : s + Number(d.vat_amount)),
      0
    );

    const vatExpenses = expenses.filter((e) => e.vat_amount != null);
    const expensesMissingVat = expenses.length - vatExpenses.length;
    const inputVat = vatExpenses.reduce((s, e) => s + Number(e.vat_amount), 0);
    const netVat = outputVat - inputVat;

    const registered = branches.filter((b) => b.tax_registration_no);
    const vehicleLabel = (v?: Vehicle) => (v ? `${v.year} ${v.make} ${v.model}` : "—");
    const warn =
      "mt-2 rounded-md border border-black/40 bg-black/5 px-3 py-1.5 text-[12px] font-semibold";

    return chrome(
      <>
        <section className="mt-5 rounded-lg border-2 border-black p-3 text-[12px] font-semibold leading-snug">
          {t("vatDisclaimer")}
        </section>

        <section className="mt-4 text-[12px]">
          <span className="font-bold">{t("vatRegistration")}: </span>
          {registered.length ? (
            registered.map((b) => `${b.name} — ${b.tax_registration_no}`).join(" · ")
          ) : (
            <span className="text-black/60">{t("vatRegistrationMissing")}</span>
          )}
        </section>

        <section className="mt-6 grid grid-cols-3 gap-4">
          {[
            [t("totalOutputVat"), money(outputVat)],
            [t("totalInputVat"), money(inputVat)],
            [t("netVat"), money(netVat)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-black/15 p-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-black/50">{k}</p>
              <p className="mt-1 text-lg font-black">{v}</p>
            </div>
          ))}
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("outputTax")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[
                  t("date"), t("vehicle"), t("branch"), t("finalPrice"),
                  t("vatRate"), t("vatAmount"), t("priceIncludesVat"), t("settlement"),
                ].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {executed.map((d) => (
                <tr key={d.id} className="border-b border-black/10">
                  <td className={td}>{d.executed_at ? day(d.executed_at) : "—"}</td>
                  <td className={td}>{vehicleLabel(d.vehicles)}</td>
                  <td className={td}>{branches.find((b) => b.id === d.branch_id)?.name ?? "—"}</td>
                  <td className={td}>{money(Number(d.agreed_price) - Number(d.discount_amount))}</td>
                  <td className={td}>{d.vat_rate == null ? "—" : `${Number(d.vat_rate)}%`}</td>
                  <td className={`${td} font-semibold`}>
                    {d.vat_amount == null ? "—" : money(Number(d.vat_amount))}
                  </td>
                  <td className={td}>
                    {d.price_includes_vat == null
                      ? "—"
                      : d.price_includes_vat
                        ? t("vatInclusive")
                        : t("vatExclusive")}
                  </td>
                  <td className={td}>
                    {d.settlement_method ? t(`settlement_${d.settlement_method}`) : "—"}
                  </td>
                </tr>
              ))}
              {!executed.length && (
                <tr><td colSpan={8} className="py-3 text-center text-black/50">{t("noSales")}</td></tr>
              )}
              <tr>
                <td colSpan={5} className="py-2 font-bold">{t("totalOutputVat")}</td>
                <td colSpan={3} className="py-2 text-base font-black">{money(outputVat)}</td>
              </tr>
            </tbody>
          </table>
          {salesMissingVat > 0 && (
            <p className={warn}>{t("vatSalesMissing", { count: salesMissingVat })}</p>
          )}
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("inputTax")}</h2>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                {[
                  t("date"), t("vehicle"), t("category"), t("supplierTaxId"),
                  t("supplierInvoiceNo"), t("amount"), t("vatAmount"),
                ].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vatExpenses.map((e) => (
                <tr key={e.id} className="border-b border-black/10">
                  <td className={td}>{day(e.created_at)}</td>
                  <td className={td}>{vehicleLabel(e.vehicles)}</td>
                  <td className={td}>{e.category}</td>
                  <td className={td}>{e.supplier_tax_id ?? "—"}</td>
                  <td className={td}>{e.supplier_invoice_no ?? "—"}</td>
                  <td className={td}>{money(Number(e.amount))}</td>
                  <td className={`${td} font-semibold`}>{money(Number(e.vat_amount))}</td>
                </tr>
              ))}
              {!vatExpenses.length && (
                <tr><td colSpan={7} className="py-3 text-center text-black/50">{t("noVatExpenses")}</td></tr>
              )}
              <tr>
                <td colSpan={6} className="py-2 font-bold">{t("totalInputVat")}</td>
                <td className="py-2 text-base font-black">{money(inputVat)}</td>
              </tr>
            </tbody>
          </table>
          {expensesMissingVat > 0 && (
            <p className={warn}>{t("vatExpensesMissing", { count: expensesMissingVat })}</p>
          )}
        </section>

        <section className="mt-8">
          <h2 className={sectionTitle}>{t("netVat")}</h2>
          <table className="mt-2 w-full border-collapse">
            <tbody>
              <tr className="border-b border-black/10">
                <td className={`${td} w-64 font-medium text-black/60`}>{t("totalOutputVat")}</td>
                <td className={`${td} font-semibold`}>{money(outputVat)}</td>
              </tr>
              <tr className="border-b border-black/10">
                <td className={`${td} w-64 font-medium text-black/60`}>{t("totalInputVat")}</td>
                <td className={`${td} font-semibold`}>{money(inputVat)}</td>
              </tr>
              <tr>
                <td className="py-2 font-bold">
                  {netVat >= 0 ? t("netVatPayable") : t("netVatCredit")}
                </td>
                <td className="py-2 text-base font-black">{money(netVat)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-black/60">{t("netVatHint")}</p>
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
