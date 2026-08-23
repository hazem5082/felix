"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/currency";
import { Select, Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import { BrandMark } from "@/components/ui/brand-mark";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { ViewToggle, type ViewMode } from "@/components/ui/view-toggle";
import { vehicleStatusTone } from "@/lib/status-tone";
import { colorLabel, colorSwatch } from "@/lib/vehicle-color";
import { ageBucket, ageTone, daysInStock, formatOdometer, type AgeBucket } from "@/lib/stock-age";
import { Car, X, ArrowDownWideNarrow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Vehicle, Branch, VehicleStatus } from "@/lib/supabase/types";

type StatusFilter = "all" | VehicleStatus;

const STATUS_TABS: StatusFilter[] = ["all", "in_stock", "reserved", "sold"];

/**
 * The inventory floor: photo first, detail on demand.
 *
 * Filtering is client-side on purpose. A showroom's stock is hundreds of rows,
 * not millions — the page already has every one of them — so narrowing is
 * instant and costs no round trip. If a tenant's inventory ever outgrows that,
 * this is the seam to push down into PostgREST.
 *
 * The filter options are derived from the vehicles actually on screen and
 * cascade (models are the models OF the chosen make), so it is not possible to
 * select a combination that returns nothing and leaves you wondering whether
 * the page is broken.
 */
export function InventoryBrowser({
  vehicles,
  branches,
  showCost,
  viewerBranchId,
}: {
  vehicles: Vehicle[];
  branches: Branch[];
  /**
   * Whether the viewer may see what a car COST the showroom. Sales and
   * marketing get the sticker price only (0028); the server page decides
   * from the profile role, so a crafted client cannot flip it into
   * anything the RLS-fetched rows don't already carry.
   */
  showCost: boolean;
  /**
   * The viewer's own home branch (0043) — null for an org-wide role
   * (CEO, accountant, marketing, investor), which has no "home" to
   * contrast against. Sales now reads every branch's stock, not just
   * their own; this is what lets the browser colour-code a car at
   * another branch instead of presenting the whole floor as one
   * undifferentiated list.
   */
  viewerBranchId: string | null;
}) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const colors = useTranslations("colors");
  const locale = useLocale();

  const [view, setView] = useState<ViewMode>("grid");
  // Opens on what's actually on the floor — a sold car is history, not
  // something most visits to this page are about — while "All" and
  // "Sold" stay one tap away in the status tabs.
  const [status, setStatus] = useState<StatusFilter>("in_stock");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [color, setColor] = useState("");
  const [branchId, setBranchId] = useState("");
  const [q, setQ] = useState("");
  // Ageing (0036). No sorting idiom exists elsewhere in this browser to
  // extend, so this is the one toggle rather than a generic column-sort
  // framework — it reorders the CURRENT filtered set, oldest-in-stock
  // first, and leaves everything else (default creation order) alone.
  const [staleFirst, setStaleFirst] = useState(false);
  const now = useMemo(() => new Date(), []);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: vehicles.length };
    for (const v of vehicles) counts[v.status] = (counts[v.status] ?? 0) + 1;
    return counts;
  }, [vehicles]);

  // Everything except the status tab, so the tab counts above stay stable
  // while the dropdowns narrow what is shown.
  const byStatus = useMemo(
    () => (status === "all" ? vehicles : vehicles.filter((v) => v.status === status)),
    [vehicles, status]
  );

  const makes = useMemo(
    () => [...new Set(byStatus.map((v) => v.make).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [byStatus]
  );
  const models = useMemo(
    () =>
      [
        ...new Set(
          byStatus.filter((v) => !make || v.make === make).map((v) => v.model).filter(Boolean)
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [byStatus, make]
  );
  const years = useMemo(
    () => [...new Set(byStatus.map((v) => v.year))].sort((a, b) => b - a),
    [byStatus]
  );
  const colorList = useMemo(
    () =>
      [...new Set(byStatus.map((v) => v.color).filter((c): c is string => !!c))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [byStatus]
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = byStatus.filter((v) => {
      if (make && v.make !== make) return false;
      if (model && v.model !== model) return false;
      if (year && String(v.year) !== year) return false;
      if (color && v.color !== color) return false;
      if (branchId && v.branch_id !== branchId) return false;
      if (needle) {
        const hay = `${v.year} ${v.make} ${v.model} ${v.trim ?? ""} ${v.vin ?? ""} ${v.color ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    if (!staleFirst) return rows;
    // A copy, not an in-place sort: `rows` is itself a filter of `byStatus`
    // (which may be the `vehicles` prop array), and mutating it would
    // reorder those too on the next render that skips this branch.
    return [...rows].sort(
      (a, b) =>
        daysInStock(b.created_at, b.sold_at, now) - daysInStock(a.created_at, a.sold_at, now)
    );
  }, [byStatus, make, model, year, color, branchId, q, staleFirst, now]);

  // The ageing summary strip (0036): count and total purchase value per
  // bucket, for the vehicles CURRENTLY shown and still in stock — a sold
  // or reserved car is no longer part of "what's sitting on the floor".
  // Client-side over rows already loaded, so it costs no extra query and
  // narrows exactly as the filters above do.
  const agingSummary = useMemo(() => {
    const buckets: Record<AgeBucket, { count: number; value: number }> = {
      fresh: { count: 0, value: 0 },
      aging: { count: 0, value: 0 },
      stale: { count: 0, value: 0 },
      dead: { count: 0, value: 0 },
    };
    for (const v of shown) {
      if (v.status !== "in_stock") continue;
      const bucket = ageBucket(daysInStock(v.created_at, v.sold_at, now));
      buckets[bucket].count += 1;
      // Redacted to 0 server-side for a viewer who may not see cost
      // (inventory/page.tsx), and a consigned car's cost basis is
      // genuinely 0 — either way there is nothing to double-guess here.
      buckets[bucket].value += Number(v.purchase_price) || 0;
    }
    return buckets;
  }, [shown, now]);

  const filtersActive = Boolean(make || model || year || color || branchId || q);

  function clearFilters() {
    setMake("");
    setModel("");
    setYear("");
    setColor("");
    setBranchId("");
    setQ("");
  }

  // Cross-branch colour coding (0043). Only meaningful for a
  // branch-scoped viewer — an org-wide role has no "home" branch to
  // contrast against, so every car reads the same to them regardless.
  const branchNameById = useMemo(
    () => new Map(branches.map((b) => [b.id, b.name])),
    [branches]
  );
  function isOtherBranch(v: Vehicle): boolean {
    return viewerBranchId != null && v.branch_id !== viewerBranchId;
  }

  // How the showroom came to have a car (0032). Null for a purchase:
  // that is the ordinary case and labelling it would put a chip on every
  // tile, which is the same as putting one on none.
  function acquisitionLabel(v: Vehicle): string | null {
    if (v.acquisition_type === "consignment") return t("acquisitionConsignment");
    if (v.acquisition_type === "trade_in") return t("acquisitionTradeIn");
    return null;
  }

  const bucketLabels: Record<AgeBucket, string> = {
    fresh: t("ageFresh"),
    aging: t("ageAging"),
    stale: t("ageStale"),
    dead: t("ageDead"),
  };

  function statusLabel(s: StatusFilter) {
    if (s === "all") return misc("filterAll");
    if (s === "sold") return t("statusSold");
    if (s === "reserved") return t("statusReserved");
    return t("statusInStock");
  }

  return (
    <div className="space-y-4">
      {/* Sold vs in stock — the primary split. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatus(s);
                // A make that only exists among sold cars would otherwise stay
                // selected and silently empty the in-stock view.
                setMake("");
                setModel("");
                setColor("");
                setYear("");
              }}
              className={cn(
                "inline-flex items-center gap-2 rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors",
                status === s
                  ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
              )}
            >
              {statusLabel(s)}
              <span className="num rounded-md bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                {statusCounts[s] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <ViewToggle value={view} onChange={setView} gridLabel={t("viewGrid")} listLabel={t("viewList")} />
      </div>

      {/* Attribute filters */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={misc("searchVehicles")}
          className="col-span-2 md:col-span-2"
        />
        <Select
          value={make}
          onChange={(e) => {
            setMake(e.target.value);
            setModel("");
          }}
          aria-label={t("make")}
        >
          <option value="">{t("make")} · {misc("filterAll")}</option>
          {makes.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </Select>
        <Select value={model} onChange={(e) => setModel(e.target.value)} aria-label={t("model")}>
          <option value="">{t("model")} · {misc("filterAll")}</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </Select>
        <Select value={year} onChange={(e) => setYear(e.target.value)} aria-label={t("year")}>
          <option value="">{t("year")} · {misc("filterAll")}</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>{y}</option>
          ))}
        </Select>
        <Select value={color} onChange={(e) => setColor(e.target.value)} aria-label={t("color")}>
          <option value="">{t("color")} · {misc("filterAll")}</option>
          {colorList.map((c) => (
            <option key={c} value={c}>{colorLabel(colors, c)}</option>
          ))}
        </Select>
        {branches.length > 1 && (
          <Select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            aria-label={t("branch")}
            className="col-span-2 md:col-span-1"
          >
            <option value="">{t("branch")} · {misc("filterAll")}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span className="num">{misc("showingCount", { count: shown.length })}</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setStaleFirst((s) => !s)}
            aria-pressed={staleFirst}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
              staleFirst
                ? "bg-[var(--color-accent-orange-dim)] text-[var(--color-accent-orange)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            )}
          >
            <ArrowDownWideNarrow size={12} />
            {t("staleFirst")}
          </button>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <X size={12} />
              {misc("clearFilters")}
            </button>
          )}
        </div>
      </div>

      {/* Ageing summary strip (0036) — count and, where cost is visible,
          total purchase value per bucket, for the in-stock cars in the
          CURRENT filter. Purely a read of `shown`; no extra query. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["fresh", "aging", "stale", "dead"] as const).map((bucket) => (
          <div
            key={bucket}
            className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          >
            <span className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <StatusPill label={bucketLabels[bucket]} tone={ageTone(bucket)} />
            </span>
            <span className="text-end">
              <span className="num block text-sm font-semibold text-[var(--color-text)]">
                {agingSummary[bucket].count}
              </span>
              {showCost && (
                <span className="num block text-[10px] text-[var(--color-text-faint)]">
                  {formatMoney(agingSummary[bucket].value, locale)}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--color-text-faint)]">
          {common("noResults")}
        </p>
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((v) => (
            <VehicleCard
              key={v.id}
              v={v}
              statusText={
                v.status === "sold"
                  ? t("statusSold")
                  : v.status === "reserved"
                    ? t("statusReserved")
                    : t("statusInStock")
              }
              acquisitionText={acquisitionLabel(v)}
              colorText={colorLabel(colors, v.color)}
              showCost={showCost}
              branchName={branchNameById.get(v.branch_id) ?? null}
              isOtherBranch={isOtherBranch(v)}
            />
          ))}
        </div>
      ) : (
        <Table className="text-xs md:text-sm">
          <THead>
            <Th className="px-2 md:px-4">{t("year")}</Th>
            <Th className="px-2 md:px-4">{t("make")}</Th>
            <Th className="px-2 md:px-4">{t("model")}</Th>
            {/* Trim, odometer, and cost are one tap away on the detail page —
                hidden below md purely to keep the mobile table from needing
                a 2×-width horizontal scroll to reach price/status. */}
            <Th className="hidden px-2 md:table-cell md:px-4">{t("trim")}</Th>
            {/* Only worth a column once there is more than one branch to
                tell apart (0043) — same condition the branch FILTER
                dropdown above already uses. */}
            {branches.length > 1 && <Th className="px-2 md:px-4">{t("branch")}</Th>}
            <Th className="hidden px-2 md:table-cell md:px-4">{t("odometer")}</Th>
            {showCost && <Th className="hidden px-2 md:table-cell md:px-4">{t("purchasePrice")}</Th>}
            <Th className="px-2 md:px-4">{t("stickerPrice")}</Th>
            <Th className="px-2 md:px-4">{t("daysInStock")}</Th>
            <Th className="px-2 md:px-4">{common("status")}</Th>
          </THead>
          <TBody>
            {shown.map((v) => {
              const days = daysInStock(v.created_at, v.sold_at, now);
              const bucket = ageBucket(days);
              return (
              <Tr key={v.id}>
                <Td className="num px-2 md:px-4">{v.year}</Td>
                <Td className="px-2 md:px-4">
                  <div className="flex items-center gap-1.5">
                    <BrandMark make={v.make} size={14} />
                    <Link href={`/inventory/${v.id}`} className="hover:underline">
                      {v.make}
                    </Link>
                  </div>
                </Td>
                <Td className="px-2 md:px-4">
                  <div className="flex items-center gap-1.5">
                    {v.model}
                    {/* 0032: the chip the grid shows in the corner of the
                        tile, inline here beside the model. */}
                    {acquisitionLabel(v) && (
                      <StatusPill
                        label={acquisitionLabel(v) as string}
                        tone={v.acquisition_type === "consignment" ? "amber" : "blue"}
                      />
                    )}
                  </div>
                </Td>
                <Td className="hidden px-2 text-[var(--color-text-muted)] md:table-cell md:px-4">{v.trim || "—"}</Td>
                {branches.length > 1 && (
                  <Td className="px-2 md:px-4">
                    {/* Plain text for the viewer's own branch (the
                        unremarkable case) — a pill only for a car sitting
                        somewhere else, the one worth a salesperson's
                        second look before promising it to a walk-in. */}
                    {isOtherBranch(v) ? (
                      <StatusPill label={branchNameById.get(v.branch_id) ?? "—"} tone="amber" />
                    ) : (
                      <span className="text-[var(--color-text-muted)]">
                        {branchNameById.get(v.branch_id) ?? "—"}
                      </span>
                    )}
                  </Td>
                )}
                <Td className="num hidden px-2 text-[var(--color-text-muted)] md:table-cell md:px-4">{formatOdometer(v.odometer_km, locale)}</Td>
                {showCost && (
                  <Td className="num hidden px-2 md:table-cell md:px-4">
                    {v.acquisition_type === "consignment" ? (
                      // No capital was deployed, so there is no cost to
                      // read. A confident 0 in a money column is worse
                      // than an em dash.
                      <span className="text-[var(--color-text-faint)]">—</span>
                    ) : (
                      formatMoney(v.purchase_price, locale)
                    )}
                  </Td>
                )}
                <Td className="num px-2 md:px-4">
                  {v.asking_price != null ? (
                    formatMoney(v.asking_price, locale)
                  ) : (
                    <span className="text-[var(--color-text-faint)]">{t("notPriced")}</span>
                  )}
                </Td>
                <Td className="num px-2 md:px-4">
                  {/* Coloured only for in-stock cars (0036) — a sold or
                      reserved car's day count is history, not something
                      to act on, so it reads as plain muted text. */}
                  {v.status === "in_stock" ? (
                    <StatusPill label={misc("daysInStockValue", { days })} tone={ageTone(bucket)} />
                  ) : (
                    <span className="text-[var(--color-text-faint)]">{misc("daysInStockValue", { days })}</span>
                  )}
                </Td>
                <Td className="px-2 md:px-4">
                  <StatusPill
                    label={
                      v.status === "sold"
                        ? t("statusSold")
                        : v.status === "reserved"
                          ? t("statusReserved")
                          : t("statusInStock")
                    }
                    tone={vehicleStatusTone(v.status)}
                  />
                </Td>
              </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}

/**
 * Photo only until you ask for more. The detail overlay is driven by
 * :hover AND :focus-within — without the latter the card would be a dead end
 * for keyboard users, who can reach the link but never see what it points at.
 */
function VehicleCard({
  v,
  statusText,
  acquisitionText,
  colorText,
  showCost,
  branchName,
  isOtherBranch,
}: {
  v: Vehicle;
  statusText: string;
  /** "Consignment" / "Trade-in" (0032), or null for an ordinary purchase. */
  acquisitionText: string | null;
  colorText: string | null;
  showCost: boolean;
  /** This car's branch name, for the cross-branch badge below (0043). */
  branchName: string | null;
  /** True when this car is NOT at the viewer's own home branch. */
  isOtherBranch: boolean;
}) {
  const locale = useLocale();
  const swatch = v.color ? colorSwatch(v.color) : undefined;
  // Management reads the cost off the card; everyone else the sticker.
  // A consigned car cost nothing — showing a confident 0 where a price
  // belongs reads as a data error, so the sticker stands in (0032).
  const cardPrice =
    showCost && v.acquisition_type !== "consignment" ? v.purchase_price : v.asking_price;

  return (
    <Link
      href={`/inventory/${v.id}`}
      className="group relative block aspect-4/3 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] transition-all duration-200 hover:border-[var(--color-accent)]/40 hover:shadow-[0_14px_32px_rgba(23,26,33,0.18)] focus:outline-none focus-visible:border-[var(--color-accent)]/60"
    >
      <Cover
        src={v.photos?.[0]}
        alt={`${v.year} ${v.make} ${v.model}`}
        make={v.make}
      />

      {/* Always visible: which half of the floor this car is on. */}
      <span className="absolute start-2 top-2 z-10">
        <StatusPill label={statusText} tone={vehicleStatusTone(v.status)} />
      </span>

      {/* And, when it is not an ordinary purchase, how it got here
          (0032). Opposite corner from the status pill so the two never
          fight for the same space, and absent for a purchase — which is
          almost every car, and does not need saying. */}
      {acquisitionText && (
        <span className="absolute end-2 top-2 z-10">
          <StatusPill
            label={acquisitionText}
            tone={v.acquisition_type === "consignment" ? "amber" : "blue"}
          />
        </span>
      )}

      {/* Always visible on touch (below md there is no :hover to reveal
          it), revealed on hover/focus once there is a pointer for that. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-0 bg-gradient-to-t from-black/92 via-black/70 to-transparent p-3 opacity-100 transition-all duration-200 md:translate-y-2 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100 md:group-focus-within:translate-y-0 md:group-focus-within:opacity-100">
        {/* Cross-branch colour coding (0043) — only ever rendered for a
            car sitting somewhere other than the viewer's own branch, so
            the ordinary case (your own floor) stays uncluttered. */}
        {isOtherBranch && branchName && (
          <div className="mb-1.5">
            <StatusPill label={branchName} tone="amber" />
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <BrandMark make={v.make} size={15} />
          <p className="truncate text-xs font-medium text-white">
            {v.year} {v.make} {v.model}
          </p>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="num text-xs text-cyan-200">
            {cardPrice != null ? formatMoney(cardPrice, locale) : "—"}
          </span>
          {colorText && (
            <span className="flex items-center gap-1 truncate text-[11px] text-white/70">
              {swatch && (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full border border-white/30"
                  style={{ backgroundColor: swatch }}
                />
              )}
              {colorText}
            </span>
          )}
        </div>
        {v.trim && <p className="truncate text-[11px] text-white/50">{v.trim}</p>}
      </div>
    </Link>
  );
}

/**
 * The card is a photograph, so a photograph that fails to load takes the whole
 * card with it — an R2 object that was deleted, or a row seeded with a
 * placeholder URL, would otherwise render as a broken-image glyph filling the
 * tile. Falling back to the marque placeholder keeps the grid readable.
 *
 * The onError handler alone is not enough: the image is server-rendered, so
 * the request can fail before React hydrates and binds it.
 */
function Cover({ src, alt, make }: { src?: string; alt: string; make: string }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, [src]);

  if (!src || failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[var(--color-text-faint)]">
        <BrandMark make={make} size={34} />
        <Car size={20} />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
    />
  );
}
