import { getLocale, getTranslations } from "next-intl/server";
import { formatMoney } from "@/lib/currency";
import { Link } from "@/i18n/navigation";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { dealStatusTone } from "@/lib/status-tone";
import { vehicleLabel } from "@/lib/demand";
import type { Customer, DealStatus, Lead, Vehicle } from "@/lib/supabase/types";

/** Only the columns the card reads — the page's query selects exactly these. */
export interface CustomerTicket {
  id: string;
  lead_id: string | null;
  status: DealStatus;
  agreed_price: number;
  created_at: string;
  vehicles?: Pick<Vehicle, "year" | "make" | "model" | "trim"> | null;
}

const DEAL_STATUS_KEY: Record<DealStatus, string> = {
  submitted: "statusSubmitted",
  approved: "statusApproved",
  rejected: "statusRejected",
  executed: "statusExecuted",
};

/**
 * Who this enquiry is actually from, and what else the group knows about
 * them (migration 0031).
 *
 * EVERYTHING HERE IS WHAT THE VIEWER'S OWN RLS RETURNED. The customer row
 * is org-wide — customers_select is `is_staff()` with no branch predicate,
 * because dedupe that stops at a branch boundary dedupes nothing — but
 * the leads and tickets hanging off it are not: leads_select and
 * deal_tickets_select still confine a sales exec to their own pipeline
 * and a manager to their branch. A salesperson in Maadi therefore sees
 * that this man is known to the group, and of his history only the parts
 * they were already entitled to read.
 *
 * Nothing here tries to widen that, and the footnote says so on the page
 * rather than letting an empty list read as "he has never bought a car".
 *
 * A plain server component fed by the page's own queries, so the lead
 * page stays a Server Component and this file stays a template.
 */
export async function CustomerCard({
  customer,
  otherLeads,
  tickets,
  currentLeadId,
}: {
  customer: Customer | null;
  otherLeads: Lead[];
  tickets: CustomerTicket[];
  currentLeadId: string;
}) {
  const t = await getTranslations("customer");
  const misc = await getTranslations("misc");
  const dealsT = await getTranslations("deals");
  const locale = await getLocale();

  if (!customer) {
    return (
      <Panel id="customer">
        <PanelHeader title={t("title")} />
        <p className="text-xs text-[var(--color-text-faint)]">{t("notLinked")}</p>
      </Panel>
    );
  }

  // "Returning" means the identity is older than this enquiry — another
  // lead exists under it. A ticket raised on THIS lead is not a return
  // visit, which is why the test is on the leads and not the tickets.
  const returning = otherLeads.length > 0;

  return (
    <Panel id="customer">
      <PanelHeader
        title={t("title")}
        action={returning ? <StatusPill label={t("returning")} tone="blue" /> : undefined}
      />

      <dl className="space-y-1.5 text-sm">
        <Row label={misc("fullName")} value={customer.full_name} />
        <Row label={misc("nationalId")} value={customer.national_id} />
        <Row label={misc("nationality")} value={customer.nationality} />
        <Row label={misc("address")} value={customer.address} />
      </dl>

      <div className="mt-3">
        <p className="text-xs text-[var(--color-text-muted)]">{t("phones")}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {(customer.phone_numbers ?? []).map((p) => (
            <span
              key={p}
              dir="ltr"
              className="num rounded-md bg-black/[0.04] px-2 py-1 text-xs text-[var(--color-text)]"
            >
              {p}
            </span>
          ))}
          {!(customer.phone_numbers ?? []).length && (
            <span className="text-xs text-[var(--color-text-faint)]">—</span>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs text-[var(--color-text-muted)]">{t("otherEnquiries")}</p>
          <div className="mt-1.5 space-y-1.5">
            {otherLeads.map((other) => (
              <Link
                key={other.id}
                href={`/crm/${other.id}`}
                className="flex items-center justify-between gap-2 rounded-md bg-black/[0.02] px-2.5 py-1.5 text-xs hover:bg-black/[0.04]"
              >
                <span className="min-w-0 truncate text-[var(--color-text)]">
                  {other.car_interest || other.client_name}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">
                  {new Date(other.created_at).toLocaleDateString()}
                </span>
              </Link>
            ))}
            {!otherLeads.length && (
              <p className="text-xs text-[var(--color-text-faint)]">{t("noOtherEnquiries")}</p>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs text-[var(--color-text-muted)]">{t("deals")}</p>
          <div className="mt-1.5 space-y-1.5">
            {tickets.map((ticket) => (
              <Link
                key={ticket.id}
                href={`/deals/${ticket.id}`}
                className="flex items-center justify-between gap-2 rounded-md bg-black/[0.02] px-2.5 py-1.5 text-xs hover:bg-black/[0.04]"
              >
                <span className="min-w-0 truncate text-[var(--color-text)]">
                  {ticket.vehicles ? vehicleLabel(ticket.vehicles) : "—"}
                  {ticket.lead_id === currentLeadId && (
                    <span className="ms-1 text-[10px] text-[var(--color-text-faint)]">
                      · {t("thisEnquiry")}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="num text-[var(--color-text-muted)]">
                    {formatMoney(Number(ticket.agreed_price), locale)}
                  </span>
                  <StatusPill
                    label={dealsT(DEAL_STATUS_KEY[ticket.status] ?? "statusSubmitted")}
                    tone={dealStatusTone(ticket.status)}
                  />
                </span>
              </Link>
            ))}
            {!tickets.length && (
              <p className="text-xs text-[var(--color-text-faint)]">{t("noDeals")}</p>
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 text-[10px] text-[var(--color-text-faint)]">{t("scopeNote")}</p>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-end text-[var(--color-text)]">{value || "—"}</dd>
    </div>
  );
}
