"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  BarChart3,
  CalendarCheck,
  FileSpreadsheet,
  HandCoins,
  Landmark,
  PiggyBank,
  Receipt,
} from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Select, Label, Input } from "@/components/ui/input";

type Preset = "thisMonth" | "lastMonth" | "thisQuarter" | "thisYear" | "lastYear" | "custom";

/** Local YYYY-MM-DD — the shape resolveWindow() parses on the server. */
function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function presetRange(preset: Preset, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3) * 3;
  switch (preset) {
    case "thisMonth":
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    case "lastMonth":
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "thisQuarter":
      return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) };
    case "thisYear":
      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) };
    case "lastYear":
      return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) };
    case "custom":
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  }
}

const REPORTS = [
  { kind: "operating", icon: BarChart3, roles: ["ceo", "accountant"] },
  { kind: "investors", icon: PiggyBank, roles: ["ceo", "accountant"] },
  { kind: "expenses", icon: Receipt, roles: ["ceo", "accountant"] },
  { kind: "salaries", icon: HandCoins, roles: ["ceo", "accountant"] },
  { kind: "vat", icon: Landmark, roles: ["ceo", "accountant"] },
  // Attendance (0038) is the first non-financial report in the suite,
  // and the first a branch manager may open — see REPORT_ROLES in
  // lib/report-window.ts for why the gate had to become per-kind. The
  // list below is only what gets RENDERED; the print route re-checks.
  {
    kind: "attendance",
    icon: CalendarCheck,
    roles: ["ceo", "accountant", "branch_manager"],
  },
] as const;

/**
 * The launch pad for every printable report: pick a period once, then
 * open any document over that window in its own branded print tab —
 * the same flow as the microloans PDF viewer. The window travels in
 * the URL, so any report can be re-opened or shared internally as a
 * link and it renders the same numbers.
 */
export function ReportsLauncher({ role = "accountant" }: { role?: string }) {
  const t = useTranslations("accountant");
  const locale = useLocale();
  const [preset, setPreset] = useState<Preset>("thisMonth");
  const [custom, setCustom] = useState(() => presetRange("thisMonth"));

  const range = useMemo(
    () => (preset === "custom" ? custom : presetRange(preset)),
    [preset, custom]
  );

  // Minutes east of UTC. The server runs on Workers (always UTC), so
  // without this a "July" report would be cut on UTC midnights and a
  // sale closed at 01:30 local on the 1st would land in June.
  const tz = useMemo(() => -new Date().getTimezoneOffset(), []);

  const href = (kind: string) =>
    `/${locale}/print/reports/${kind}?from=${range.from}&to=${range.to}&tz=${tz}`;

  return (
    <Panel>
      <PanelHeader title={t("reports")} subtitle={t("reportsHint")} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Label>{t("period")}</Label>
          <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {(["thisMonth", "lastMonth", "thisQuarter", "thisYear", "lastYear", "custom"] as Preset[]).map(
              (p) => (
                <option key={p} value={p}>
                  {t(`period_${p}`)}
                </option>
              )
            )}
          </Select>
        </div>

        {preset === "custom" && (
          <>
            <div>
              <Label>{t("fromDate")}</Label>
              <Input
                type="date"
                value={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t("toDate")}</Label>
              <Input
                type="date"
                value={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              />
            </div>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {REPORTS.filter((r) => (r.roles as readonly string[]).includes(role)).map(({ kind, icon: Icon }) => (
          <a
            key={kind}
            href={href(kind)}
            target="_blank"
            rel="noopener"
            className="flex items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-text)] transition-all hover:border-[var(--color-border-strong)] hover:bg-black/[0.03]"
          >
            <Icon size={15} className="text-[var(--color-text-muted)]" />
            {t(`report_${kind}`)}
          </a>
        ))}
        {/* The attendance CSV carries the SAME window as the report
            above it, so a manager who exports what they just printed
            gets the same days. The ledger export below is deliberately
            window-less: it is the whole book. */}
        {(role === "ceo" || role === "accountant" || role === "branch_manager") && (
          <a
            href={`/api/export/attendance?from=${range.from}&to=${range.to}&tz=${tz}`}
            download
            className="flex items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-text)] transition-all hover:border-[var(--color-border-strong)] hover:bg-black/[0.03]"
          >
            <FileSpreadsheet size={15} className="text-[var(--color-text-muted)]" />
            {t("exportAttendance")}
          </a>
        )}

        {/* A file download from a route handler, not a page navigation —
            <Link/> would try to client-route a CSV. */}
        {(role === "ceo" || role === "accountant") && (
        <a
          href="/api/export/ledger"
          download
          className="flex items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-text)] transition-all hover:border-[var(--color-border-strong)] hover:bg-black/[0.03]"
        >
          <FileSpreadsheet size={15} className="text-[var(--color-text-muted)]" />
          {t("exportLedger")}
        </a>
        )}
      </div>
    </Panel>
  );
}
