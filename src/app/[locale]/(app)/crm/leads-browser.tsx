"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Panel } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { TimeAgoDot, type TimeBand } from "@/components/ui/time-ago-dot";
import { Input, Select } from "@/components/ui/input";
import type { Lead, LeadStatus } from "@/lib/supabase/types";

type SourceFilter = "all" | "link" | "manual";
type StatusFilter = "all" | "pending" | "ticket_created" | "closed";

// Same hex values as the `--color-accent-*` tokens in globals.css — Tr's
// toneBar takes a literal color, not a CSS var, since it's an inline style.
const STATUS_TONE_HEX: Record<LeadStatus, string> = {
  pending: "#b45309",
  ticket_created: "#1d4ed8",
  closed: "#15803d",
};

// Freshness: green same-day, amber up to 3 days, red beyond — a lead going
// quiet past a few days is exactly what this column exists to surface.
const LAST_CONTACT_BANDS: TimeBand[] = [
  { maxHours: 24, tone: "green" },
  { maxHours: 72, tone: "amber" },
  { tone: "red" },
];

// Age in the system: still fresh under a week, worth a look after that,
// and past a month unconverted is a lead that's stalling.
const LEAD_AGE_BANDS: TimeBand[] = [
  { maxHours: 24 * 7, tone: "green" },
  { maxHours: 24 * 30, tone: "amber" },
  { tone: "red" },
];

/**
 * Client-side search + filters over the leads already fetched by the page —
 * same "narrow what's on screen, no round trip" pattern as the inventory
 * browser, since a showroom's lead list is hundreds of rows, not millions.
 */
export function LeadsBrowser({
  leads,
  lastContactByLead,
}: {
  leads: Lead[];
  lastContactByLead: Record<string, string>;
}) {
  const t = useTranslations("crm");
  const misc = useTranslations("misc");
  const common = useTranslations("common");

  const [q, setQ] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (source !== "all" && l.source !== source) return false;
      if (status !== "all" && l.status !== status) return false;
      if (needle) {
        const hay = `${l.client_name} ${l.phone_number} ${l.car_interest ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [leads, q, source, status]);

  function statusLabel(l: Lead) {
    return l.status === "ticket_created"
      ? misc("ticketCreated")
      : l.status === "closed"
        ? misc("closed")
        : misc("pendingStatus");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={common("search")}
          className="col-span-2"
        />
        <Select value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} aria-label={misc("source")}>
          <option value="all">{misc("source")} · {misc("filterAll")}</option>
          <option value="link">{misc("referral")}</option>
          <option value="manual">{misc("manual")}</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label={common("status")}>
          <option value="all">{common("status")} · {misc("filterAll")}</option>
          <option value="pending">{misc("pendingStatus")}</option>
          <option value="ticket_created">{misc("ticketCreated")}</option>
          <option value="closed">{misc("closed")}</option>
        </Select>
      </div>

      <Panel>
        <Table>
          <THead>
            <Th>{t("lastContact")}</Th>
            <Th>{t("clientName")}</Th>
            <Th>{t("phone")}</Th>
            <Th>{t("carInterest")}</Th>
            <Th>{misc("source")}</Th>
            <Th>{common("status")}</Th>
            <Th>{t("inSystem")}</Th>
          </THead>
          <TBody>
            {shown.map((l) => (
              <Tr key={l.id} toneBar={STATUS_TONE_HEX[l.status]}>
                <Td>
                  <TimeAgoDot since={lastContactByLead[l.id] ?? null} bands={LAST_CONTACT_BANDS} emptyLabel={t("noContactYet")} />
                </Td>
                <Td>
                  <Link href={`/crm/${l.id}`} className="hover:underline">{l.client_name}</Link>
                </Td>
                <Td className="num text-[var(--color-text-muted)]">{l.phone_number}</Td>
                <Td className="text-[var(--color-text-muted)]">{l.car_interest || "—"}</Td>
                <Td>
                  <StatusPill label={l.source === "link" ? misc("referral") : misc("manual")} tone={l.source === "link" ? "blue" : "neutral"} />
                </Td>
                <Td>
                  <StatusPill
                    label={statusLabel(l)}
                    tone={l.status === "ticket_created" ? "blue" : l.status === "closed" ? "green" : "amber"}
                  />
                </Td>
                <Td>
                  <TimeAgoDot since={l.created_at} bands={LEAD_AGE_BANDS} emptyLabel="—" />
                </Td>
              </Tr>
            ))}
            {!shown.length && <Tr><Td colSpan={7} className="text-center text-[var(--color-text-faint)]">{common("noResults")}</Td></Tr>}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
