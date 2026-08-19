"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Select, Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import { BrandMark } from "@/components/ui/brand-mark";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { ViewToggle, type ViewMode } from "@/components/ui/view-toggle";
import { vehicleStatusTone } from "@/lib/status-tone";
import { colorLabel, colorSwatch } from "@/lib/vehicle-color";
import { Car, X } from "lucide-react";
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
}: {
  vehicles: Vehicle[];
  branches: Branch[];
}) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const colors = useTranslations("colors");

  const [view, setView] = useState<ViewMode>("grid");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [color, setColor] = useState("");
  const [branchId, setBranchId] = useState("");
  const [q, setQ] = useState("");

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
    return byStatus.filter((v) => {
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
  }, [byStatus, make, model, year, color, branchId, q]);

  const filtersActive = Boolean(make || model || year || color || branchId || q);

  function clearFilters() {
    setMake("");
    setModel("");
    setYear("");
    setColor("");
    setBranchId("");
    setQ("");
  }

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
              colorText={colorLabel(colors, v.color)}
            />
          ))}
        </div>
      ) : (
        <Table>
          <THead>
            <Th>{t("year")}</Th>
            <Th>{t("make")}</Th>
            <Th>{t("model")}</Th>
            <Th>{t("trim")}</Th>
            <Th>{t("purchasePrice")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {shown.map((v) => (
              <Tr key={v.id}>
                <Td className="num">{v.year}</Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <BrandMark make={v.make} size={14} />
                    <Link href={`/inventory/${v.id}`} className="hover:underline">
                      {v.make}
                    </Link>
                  </div>
                </Td>
                <Td>{v.model}</Td>
                <Td className="text-[var(--color-text-muted)]">{v.trim || "—"}</Td>
                <Td className="num">${v.purchase_price.toLocaleString()}</Td>
                <Td>
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
            ))}
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
  colorText,
}: {
  v: Vehicle;
  statusText: string;
  colorText: string | null;
}) {
  const swatch = v.color ? colorSwatch(v.color) : undefined;

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

      {/* Minimal details, revealed on hover/focus. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/92 via-black/70 to-transparent p-3 opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <div className="flex items-center gap-1.5">
          <BrandMark make={v.make} size={15} />
          <p className="truncate text-xs font-medium text-white">
            {v.year} {v.make} {v.model}
          </p>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="num text-xs text-cyan-200">
            ${v.purchase_price.toLocaleString()}
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
