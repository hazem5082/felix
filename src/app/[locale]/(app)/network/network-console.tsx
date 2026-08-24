"use client";

import { useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import { cn, formatDate } from "@/lib/utils";
import { Globe2, Phone, Mail, Search, MapPin } from "lucide-react";
import type { NetworkSearchResult, NetworkStatus, WantedCar } from "@/lib/network";
import { searchNetwork, setNetworkParticipation } from "./actions";

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
            const overBudget = budget !== null && m.vehicle.askingPrice !== null && m.vehicle.askingPrice > budget;
            return (
              <Tr key={`${m.showroom.slug}:${m.vehicle.id}`}>
                <Td>
                  <span className="block text-sm font-medium text-[var(--color-text)]">
                    {[m.vehicle.year, m.vehicle.make, m.vehicle.model, m.vehicle.trim]
                      .filter(Boolean)
                      .join(" ")}
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
                  <div className="flex flex-col gap-0.5 text-xs">
                    {m.showroom.phone && (
                      <a
                        href={`tel:${m.showroom.phone}`}
                        className="flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                      >
                        <Phone className="h-3 w-3" />
                        {m.showroom.phone}
                      </a>
                    )}
                    {m.showroom.email && (
                      <a
                        href={`mailto:${m.showroom.email}`}
                        className="flex items-center gap-1 text-[var(--color-text-muted)] hover:underline"
                      >
                        <Mail className="h-3 w-3" />
                        {m.showroom.email}
                      </a>
                    )}
                    {!m.showroom.phone && !m.showroom.email && (
                      <span className="text-[var(--color-text-faint)]">{t("noContact")}</span>
                    )}
                  </div>
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
      </p>
    </div>
  );
}
