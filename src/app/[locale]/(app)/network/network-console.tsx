"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { BrandMark } from "@/components/ui/brand-mark";
import { formatMoney } from "@/lib/currency";
import { cn, formatDate } from "@/lib/utils";
import { Globe2, Phone, Mail, Search, MapPin } from "lucide-react";
import { sanitisePhotos } from "@/lib/network";
import type {
  NetworkMatch,
  NetworkSearchResult,
  NetworkShowroom,
  NetworkStatus,
  NetworkVehicleResult,
  WantedCar,
} from "@/lib/network";
import { fetchNetworkVehicle, searchNetwork, setNetworkParticipation } from "./actions";

/**
 * The screen. Two panels that are really one workflow: the left is what
 * this showroom could not sell, the right is who else might have it.
 *
 * Clicking an unfilled ask fills the search box and runs it. That is the
 * whole point of putting the two lists on one page — a manager should
 * never have to retype "2022 Toyota Hilux" from a lead's record into a
 * search box, because the version they retype is the one with the typo
 * that finds nothing.
 *
 * SEARCH IS A SERVER ACTION, not a filter over preloaded rows. Every
 * other browser in this app (leads, inventory) narrows a list the page
 * already fetched, which is right for a few hundred of your own rows and
 * wrong here: the network's stock is other people's, it is not this
 * showroom's to hold in a page payload, and it changes under you.
 */

const ORIGIN_TONE: Record<WantedCar["origin"], SemanticTone> = {
  requested: "blue",
  suggested: "neutral",
  note: "amber",
};

export function NetworkConsole({
  wanted,
  salespeople,
  status,
  canToggle,
}: {
  wanted: WantedCar[];
  /** profile id → name, for the "who is waiting on this" column. */
  salespeople: Record<string, string>;
  status: NetworkStatus;
  /** The CEO alone may publish or withdraw the showroom's stock. */
  canToggle: boolean;
}) {
  const t = useTranslations("network");
  const common = useTranslations("common");
  const locale = useLocale();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WantedCar | null>(null);
  const [result, setResult] = useState<NetworkSearchResult | null>(null);
  const [pending, startSearch] = useTransition();

  const [participating, setParticipating] = useState(status.participating);
  const [toggling, startToggle] = useTransition();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [wantedFilter, setWantedFilter] = useState("");

  const shownWanted = useMemo(() => {
    const needle = wantedFilter.trim().toLowerCase();
    if (!needle) return wanted;
    return wanted.filter((w) =>
      `${w.label} ${w.clientName} ${w.phone}`.toLowerCase().includes(needle)
    );
  }, [wanted, wantedFilter]);

  function run(text: string, from: WantedCar | null) {
    const q = text.trim();
    setQuery(text);
    setSelected(from);
    if (!q) {
      setResult(null);
      return;
    }
    startSearch(async () => {
      setResult(await searchNetwork(q));
    });
  }

  function toggleParticipation() {
    const next = !participating;
    setToggleError(null);
    startToggle(async () => {
      const res = await setNetworkParticipation({ enabled: next });
      if ("error" in res) {
        setToggleError(res.error);
        return;
      }
      setParticipating(next);
    });
  }

  return (
    <div className="space-y-6">
      {/* ── Where this showroom stands ─────────────────────── */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-text-faint)]" />
            <div>
              <p className="text-sm font-medium text-[var(--color-text)]">
                {status.available
                  ? status.peers > 0
                    ? t("peers", { count: status.peers })
                    : t("peersNone")
                  : (status.reason ?? t("errors.unavailable"))}
              </p>
              {/* Only when the answer is known. A network that could not
                  be read tells us nothing about what this showroom is
                  publishing, and "your stock is hidden" would be a
                  confident statement made out of a failed query. */}
              {status.available && (
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  {participating ? t("publishingOn") : t("publishingOff")}
                </p>
              )}
            </div>
          </div>

          {canToggle && status.available && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant={participating ? "outline" : "primary"}
                size="sm"
                onClick={toggleParticipation}
                disabled={toggling}
              >
                {participating ? t("leave") : t("join")}
              </Button>
              {toggleError && (
                <p className="text-xs text-[var(--color-accent-red)]">{toggleError}</p>
              )}
            </div>
          )}
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* ── What we could not sell ───────────────────────── */}
        <div className="lg:col-span-5">
          <Panel>
            <PanelHeader title={t("wantedTitle")} subtitle={t("wantedSubtitle")} />

            {wanted.length > 8 && (
              <Input
                value={wantedFilter}
                onChange={(e) => setWantedFilter(e.target.value)}
                placeholder={common("search")}
                className="mb-3"
              />
            )}

            {shownWanted.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">
                {wanted.length === 0 ? t("noWanted") : t("noWantedMatch")}
              </p>
            ) : (
              <ul className="max-h-[32rem] space-y-1.5 overflow-y-auto pe-1">
                {shownWanted.map((w) => (
                  // The enquiry link sits OUTSIDE the button rather than
                  // inside it — an <a> nested in a <button> is invalid
                  // markup and behaves differently in every browser — and
                  // only on the selected row, so a list of thirty asks
                  // stays a list rather than a stack of cards.
                  <li
                    key={w.key}
                    className={cn(
                      "rounded-lg border transition-colors",
                      selected?.key === w.key
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.06]"
                        : "border-[var(--color-border)] hover:bg-black/[0.02]"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => run(w.query || String(w.year ?? ""), w)}
                      className="w-full p-3 text-start"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-[var(--color-text)]">
                          {w.label}
                        </span>
                        <StatusPill label={t(`origin_${w.origin}`)} tone={ORIGIN_TONE[w.origin]} />
                      </div>
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                        {w.clientName} · {w.phone}
                        {w.salespersonId && salespeople[w.salespersonId]
                          ? ` · ${salespeople[w.salespersonId]}`
                          : ""}
                      </p>
                      {(w.budget || w.note) && (
                        <p className="mt-1 text-xs text-[var(--color-text-faint)]">
                          {w.budget ? t("budget", { amount: formatMoney(w.budget, locale) }) : null}
                          {w.budget && w.note ? " · " : null}
                          {w.note}
                        </p>
                      )}
                    </button>
                    {selected?.key === w.key && (
                      <div className="px-3 pb-2.5">
                        <Link
                          href={`/crm/${w.leadId}`}
                          className="text-xs text-[var(--color-accent)] hover:underline"
                        >
                          {t("openEnquiry")}
                        </Link>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* ── Who else has it ──────────────────────────────── */}
        <div className="lg:col-span-7">
          <Panel>
            <PanelHeader title={t("searchTitle")} subtitle={t("searchSubtitle")} />

            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(query, selected);
              }}
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchTitle")}
              />
              <Button type="submit" disabled={pending || !query.trim()} className="shrink-0">
                <Search className="h-4 w-4" />
                {pending ? t("searching") : common("search")}
              </Button>
            </form>

            {selected && (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                {t("searchingFor", { client: selected.clientName, car: selected.label })}
              </p>
            )}

            <div className="mt-4">
              <Results result={result} pending={pending} budget={selected?.budget ?? null} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Results({
  result,
  pending,
  budget,
}: {
  result: NetworkSearchResult | null;
  pending: boolean;
  /** The selected buyer's ceiling, when the search came from an ask. */
  budget: number | null;
}) {
  const t = useTranslations("network");
  const locale = useLocale();

  /**
   * The car whose dialog is open, and what came back for it.
   *
   * `token` is not decoration. A manager comparing candidates clicks the
   * second one before the first has answered, and a Server Action gives
   * no guarantee about which response lands first — without it, opening
   * A then B can leave B's dialog showing A's photographs, which on this
   * screen means ringing the wrong showroom about the wrong car. Every
   * open takes the next number, and only the current number may write.
   */
  const [opened, setOpened] = useState<NetworkMatch | null>(null);
  const [detail, setDetail] = useState<NetworkVehicleResult | null>(null);
  const [loadingDetail, startDetail] = useTransition();
  const token = useRef(0);

  function open(m: NetworkMatch) {
    const mine = ++token.current;
    setOpened(m);
    setDetail(null);
    startDetail(async () => {
      const res = await fetchNetworkVehicle({
        slug: m.showroom.slug,
        vehicleId: m.vehicle.id,
      });
      if (token.current === mine) setDetail(res);
    });
  }

  function close() {
    // Bumped on close too, so a response still in flight for the dialog
    // the manager just dismissed cannot repopulate it.
    token.current += 1;
    setOpened(null);
    setDetail(null);
  }

  if (pending) {
    return <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">{t("searching")}</p>;
  }

  if (!result) {
    return <p className="py-8 text-center text-sm text-[var(--color-text-faint)]">{t("startHint")}</p>;
  }

  if (result.error) {
    return (
      <p className="rounded-lg border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] p-3 text-sm text-[var(--color-accent-red)]">
        {result.error}
      </p>
    );
  }

  if (result.matches.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--color-text-muted)]">{t("noResults")}</p>
        <p className="mt-1 text-xs text-[var(--color-text-faint)]">
          {t("searchedCount", { count: result.searched })}
          {result.unreachable > 0 ? ` · ${t("unreachableCount", { count: result.unreachable })}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Table>
        <THead>
          <Th>{t("car")}</Th>
          <Th>{t("showroom")}</Th>
          <Th className="text-end">{t("price")}</Th>
          <Th>{t("contact")}</Th>
        </THead>
        <TBody>
          {result.matches.map((m) => {
            const overBudget =
              budget !== null && m.vehicle.askingPrice !== null && m.vehicle.askingPrice > budget;
            return (
              <Tr key={`${m.showroom.slug}:${m.vehicle.id}`}>
                <Td className="ps-2">
                  {/* The photograph and the name are ONE control, rather
                      than the whole row being clickable: the row also
                      carries `tel:` and `mailto:` links, and a click
                      target wrapped around those swallows the tap a
                      manager meant for the phone number. */}
                  <button
                    type="button"
                    onClick={() => open(m)}
                    className="group flex w-full items-center gap-3 rounded-md p-1.5 text-start transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
                  >
                    <Thumb src={m.vehicle.thumbnail} make={m.vehicle.make} alt={carLabel(m.vehicle)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-[var(--color-text)] group-hover:text-[var(--color-accent)]">
                        {carLabel(m.vehicle)}
                      </span>
                      <span className="mt-0.5 block text-xs text-[var(--color-text-faint)]">
                        {[
                          m.vehicle.color,
                          m.vehicle.odometerKm !== null
                            ? t("odometer", { km: m.vehicle.odometerKm.toLocaleString() })
                            : null,
                          t("inStockSince", { date: formatDate(m.vehicle.createdAt, locale) }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </button>
                </Td>
                <Td>
                  <span className="block text-sm text-[var(--color-text)]">{m.showroom.name}</span>
                  {m.vehicle.branchName && (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-[var(--color-text-faint)]">
                      <MapPin className="h-3 w-3" />
                      {m.vehicle.branchName}
                    </span>
                  )}
                </Td>
                <Td className="text-end">
                  {m.vehicle.askingPrice === null ? (
                    <span className="text-xs text-[var(--color-text-faint)]">{t("notPriced")}</span>
                  ) : (
                    <span
                      className={cn(
                        "text-sm font-medium tabular-nums",
                        overBudget ? "text-[var(--color-accent-amber)]" : "text-[var(--color-text)]"
                      )}
                      title={overBudget ? t("overBudget") : undefined}
                    >
                      {formatMoney(m.vehicle.askingPrice, locale)}
                    </span>
                  )}
                </Td>
                <Td>
                  <Contact showroom={m.showroom} />
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>

      <p className="text-xs text-[var(--color-text-faint)]">
        {t("searchedCount", { count: result.searched })}
        {result.unreachable > 0 ? ` · ${t("unreachableCount", { count: result.unreachable })}` : ""}
        {result.truncated ? ` · ${t("truncated")}` : ""}
        {` · ${t("detailsHint")}`}
      </p>

      {/* Mounted only while a car is open. A <DialogContent> left in the
          tree with `open={false}` paints a permanently-visible modal —
          it force-mounts its own portal and animates to opacity 1 with
          nothing keyed on the open state. */}
      {opened && (
        <Dialog open onOpenChange={(next) => !next && close()}>
          <DialogContent title={carLabel(opened.vehicle)} className="max-w-2xl">
            <VehicleDetail fallback={opened} detail={detail} loading={loadingDetail} budget={budget} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** "2022 Toyota Hilux Double Cab" — the name in the row, the dialog and the alt text. */
function carLabel(v: { year: number; make: string; model: string; trim: string | null }): string {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
}

/**
 * A result row's photograph.
 *
 * Mirrors `Cover` in inventory-browser.tsx, including why it is a plain
 * `<img>`: these URLs point at another showroom's uploads, and `onError`
 * degrading to the marque monogram is what keeps a photograph that has
 * since been deleted looking like "no photograph" rather than a broken
 * tile in the middle of a search result.
 */
function Thumb({ src, make, alt }: { src: string | null; make: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-black/[0.02]">
        <BrandMark make={make} size={20} />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-12 w-16 shrink-0 rounded-md border border-[var(--color-border)] object-cover"
    />
  );
}

function Contact({ showroom }: { showroom: NetworkShowroom }) {
  const t = useTranslations("network");
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {showroom.phone && (
        <a
          href={`tel:${showroom.phone}`}
          className="flex items-center gap-1 text-[var(--color-accent)] hover:underline"
        >
          <Phone className="h-3 w-3" />
          {showroom.phone}
        </a>
      )}
      {showroom.email && (
        <a
          href={`mailto:${showroom.email}`}
          className="flex items-center gap-1 text-[var(--color-text-muted)] hover:underline"
        >
          <Mail className="h-3 w-3" />
          {showroom.email}
        </a>
      )}
      {!showroom.phone && !showroom.email && (
        <span className="text-[var(--color-text-faint)]">{t("noContact")}</span>
      )}
    </div>
  );
}

/**
 * One car, opened.
 *
 * `fallback` is the row that was clicked, and it is rendered
 * immediately; the fetched detail replaces it field by field as it
 * arrives. So the dialog opens with the car's name, price and
 * photograph already in it rather than with a spinner — and a fetch
 * that fails leaves the manager looking at the car they picked, with
 * the reason underneath, instead of an empty box.
 */
function VehicleDetail({
  fallback,
  detail,
  loading,
  budget,
}: {
  fallback: NetworkMatch;
  detail: NetworkVehicleResult | null;
  loading: boolean;
  budget: number | null;
}) {
  const t = useTranslations("network");
  const locale = useLocale();
  const [shown, setShown] = useState(0);

  const loaded = detail && !("error" in detail) ? detail : null;
  const vehicle = loaded?.vehicle ?? fallback.vehicle;
  const showroom = loaded?.showroom ?? fallback.showroom;
  const error = detail && "error" in detail ? detail.error : null;
  // Before the detail lands there is exactly one photograph to show: the
  // thumbnail the row already had. Run through the same filter as the
  // gallery so one code path decides what may be rendered.
  const photos = loaded ? loaded.vehicle.photos : sanitisePhotos([vehicle.thumbnail]);

  const overBudget = budget !== null && vehicle.askingPrice !== null && vehicle.askingPrice > budget;

  // The gallery this dialog is showing may be shorter than the one whose
  // fourth thumbnail was last selected.
  const index = Math.min(shown, Math.max(photos.length - 1, 0));

  const spec: [string, string][] = [
    [t("specColour"), vehicle.color ?? ""],
    [
      t("specMileage"),
      vehicle.odometerKm !== null ? t("odometer", { km: vehicle.odometerKm.toLocaleString() }) : "",
    ],
    [t("specBody"), loaded?.vehicle.bodyType ?? ""],
    [t("specEngine"), loaded?.vehicle.engineInfo ?? ""],
    [t("specDrive"), loaded?.vehicle.driveType ?? ""],
    [t("specDoors"), loaded?.vehicle.doors ? String(loaded.vehicle.doors) : ""],
    [t("specOrigin"), loaded?.vehicle.countryOfOrigin ?? ""],
    [t("specBranch"), vehicle.branchName ?? ""],
    [t("specListed"), formatDate(vehicle.createdAt, locale)],
  ];

  return (
    <div className="space-y-4">
      {/* ── The gallery ──────────────────────────────────── */}
      {photos.length > 0 ? (
        <div className="space-y-2">
          <div className="aspect-4/3 w-full overflow-hidden rounded-lg border border-[var(--color-border)] bg-black/[0.02]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photos[index]}
              alt={t("photoAlt", { car: carLabel(vehicle), n: index + 1, total: photos.length })}
              className="h-full w-full object-cover"
            />
          </div>
          {photos.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {photos.map((p, n) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setShown(n)}
                  className={cn(
                    "h-12 w-16 overflow-hidden rounded-md border transition-colors",
                    n === index
                      ? "border-[var(--color-accent)]"
                      : "border-[var(--color-border)] hover:border-[var(--color-accent)]/50"
                  )}
                >
                  {/* Decorative: the main image below is labelled, and
                      nine more "photograph 3 of 9" labels in a row are
                      noise to a screen reader. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex aspect-4/3 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-faint)]">
          <BrandMark make={vehicle.make} size={34} />
          <span className="text-xs">{loading ? t("loadingDetail") : t("noPhotos")}</span>
        </div>
      )}

      {/* ── The sticker ──────────────────────────────────── */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-border)] pb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            {t("specPrice")}
          </p>
          {vehicle.askingPrice === null ? (
            <p className="text-sm text-[var(--color-text-faint)]">{t("notPriced")}</p>
          ) : (
            <p
              className={cn(
                "text-lg font-semibold tabular-nums",
                overBudget ? "text-[var(--color-accent-amber)]" : "text-[var(--color-text)]"
              )}
            >
              {formatMoney(vehicle.askingPrice, locale)}
            </p>
          )}
          {overBudget && <p className="text-xs text-[var(--color-accent-amber)]">{t("overBudget")}</p>}
        </div>
        <p className="max-w-xs text-xs text-[var(--color-text-faint)]">{t("confidentialNote")}</p>
      </div>

      {error && (
        <p className="rounded-lg border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] p-3 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      {/* ── The spec ─────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {spec
          .filter(([, value]) => value !== "")
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
              <dd className="text-sm text-[var(--color-text)]">{value}</dd>
            </div>
          ))}
      </dl>

      {loaded && loaded.vehicle.features.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            {t("featuresTitle")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {loaded.vehicle.features.map((f) => (
              <span
                key={f}
                className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {loaded?.vehicle.description && (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            {t("sellerNotes")}
          </p>
          <p className="whitespace-pre-line text-sm text-[var(--color-text-muted)]">
            {loaded.vehicle.description}
          </p>
        </div>
      )}

      {/* ── Who to ring ──────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--color-border)] bg-black/[0.015] p-3">
        <p className="mb-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          {t("contactTitle")}
        </p>
        <p className="text-sm font-medium text-[var(--color-text)]">{showroom.name}</p>
        {vehicle.branchName && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--color-text-faint)]">
            <MapPin className="h-3 w-3" />
            {[vehicle.branchName, vehicle.branchAddress].filter(Boolean).join(" · ")}
          </p>
        )}
        <div className="mt-2">
          <Contact showroom={showroom} />
        </div>
      </div>
    </div>
  );
}
