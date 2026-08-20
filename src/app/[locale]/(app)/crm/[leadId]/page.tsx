import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/currency";
import { createClient } from "@/lib/supabase/server";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { StageBar } from "@/components/ui/stage-bar";
import { StatButton } from "@/components/ui/stat-button";
import { Link } from "@/i18n/navigation";
import { Car, MessagesSquare, History as HistoryIcon } from "lucide-react";
import type {
  AuditLogRow,
  Customer,
  Lead,
  LeadComment,
  LeadVehicleInterest,
  Vehicle,
} from "@/lib/supabase/types";
import { interestLabel, vehicleLabel } from "@/lib/demand";
import { buildLeadHistory, vehicleIdsInHistory } from "@/lib/lead-history";
import { CustomerCard, type CustomerTicket } from "./customer-card";
import { CommentForm } from "./comment-form";
import { InterestEditDialog, InterestFormDialog } from "./interest-form";
import { InterestStatusSelect } from "./interest-status";
import { LeadEditFormDialog } from "./lead-edit-form";
import { LeadHistory } from "./lead-history";
import { NotePointsView } from "../note-points-editor";
import { DealTicketFormDialog } from "../deal-ticket-form";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const t = await getTranslations("crm");
  const interest = await getTranslations("interest");
  const dealsT = await getTranslations("deals");
  const misc = await getTranslations("misc");
  const common = await getTranslations("common");
  const history = await getTranslations("history");
  const locale = await getLocale();
  const supabase = await createClient();

  const [{ data: lead }, { data: comments }, { data: interests }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", leadId).maybeSingle(),
    supabase
      .from("lead_comments")
      .select("*, profiles(full_name)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
    supabase
      .from("lead_vehicle_interests")
      .select("*, vehicles(id, year, make, model, trim, asking_price, status)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
  ]);

  if (!lead) notFound();
  const l = lead as Lead;
  const wants = (interests as LeadVehicleInterest[]) ?? [];

  // The trail for this client and every car linked to them. Sequenced
  // after the queries above rather than beside them because the interest
  // ids are the filter — audit_log has no lead_id of its own, by design:
  // it outlives the rows it describes.
  //
  // Capped at 60 entries. A client worked for a year accumulates more
  // than anyone scrolls, and the panel is for "who changed the phone
  // number last week", not for forensics — the CEO's Audit Trail is
  // where the unbounded view belongs.
  //
  // Returns empty rather than failing for a caller whose role cannot read
  // the trail. Migration 0017 opens it to any staff member who can see
  // the lead, but a deployment still on 0016 simply shows no history
  // instead of erroring the whole page.
  const { data: auditRows } = await supabase
    .from("audit_log")
    .select("*, profiles(full_name)")
    .in("entity_type", ["leads", "lead_vehicle_interests"])
    .in("entity_id", [l.id, ...wants.map((i) => i.id)])
    .order("created_at", { ascending: false })
    .limit(60);

  const audit = (auditRows as AuditLogRow[]) ?? [];

  // Cars named anywhere in the trail, including ones an interest used to
  // point at and no longer does — those are exactly the rows the live
  // interests above cannot name.
  const historyVehicleIds = vehicleIdsInHistory(audit);
  const { data: historyVehicles } = historyVehicleIds.length
    ? await supabase
        .from("vehicles")
        .select("id, year, make, model, trim")
        .in("id", historyVehicleIds)
    : { data: [] };

  const vehicleLabels = Object.fromEntries(
    ((historyVehicles as Vehicle[]) ?? []).map((v) => [v.id, vehicleLabel(v)])
  );

  const entries = buildLeadHistory(audit, vehicleLabels);

  const commentsList = (comments as (LeadComment & { profiles?: { full_name: string } })[]) ?? [];

  // ── The customer behind this enquiry (0031) ────────────────
  //
  // Three sequenced queries rather than one embed, because each depends
  // on the previous one's ids and because every one of them must be able
  // to come back empty without taking the page with it: a deployment
  // still on 0030 has no customers table and no leads.customer_id, and
  // supabase-js hands back `{ data: null, error }` rather than throwing.
  // The card then renders its "not linked yet" state, which is also the
  // correct state for a referral lead nobody has opened yet.
  //
  // The scope of what comes back is the viewer's own. customers is
  // readable org-wide on purpose; the leads and tickets below are not,
  // and no attempt is made here to see past leads_select /
  // deal_tickets_select. What the salesperson sees is what they were
  // already entitled to see, gathered in one place.
  const customerId = l.customer_id ?? null;

  const { data: customerRow } = customerId
    ? await supabase.from("customers").select("*").eq("id", customerId).maybeSingle()
    : { data: null };
  const customer = (customerRow as Customer | null) ?? null;

  const { data: siblingRows } = customer
    ? await supabase
        .from("leads")
        .select("*")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(25)
    : { data: [] };

  const customerLeads = (siblingRows as Lead[]) ?? [];
  const otherLeads = customerLeads.filter((other) => other.id !== l.id);

  // Tickets are reached through the leads because a ticket names a lead,
  // not a customer — 0031 deliberately adds no second path to the same
  // fact. `l.id` is included so a deal raised on THIS enquiry appears in
  // the history too, marked as such.
  const ticketLeadIds = [l.id, ...otherLeads.map((other) => other.id)];
  const { data: ticketRows } = customer
    ? await supabase
        .from("deal_tickets")
        .select("id, lead_id, status, agreed_price, created_at, vehicles(year, make, model, trim)")
        .in("lead_id", ticketLeadIds)
        .order("created_at", { ascending: false })
        .limit(25)
    : { data: [] };

  const customerTickets = (ticketRows as unknown as CustomerTicket[]) ?? [];

  return (
    <div className="space-y-6">
      <PanelHeader
        title={l.client_name}
        subtitle={l.phone_number}
        action={
          <div className="flex items-center gap-2">
            <LeadEditFormDialog lead={l} />
            <DealTicketFormDialog
              leadId={l.id}
              trigger={
                <span className="inline-flex h-9 cursor-pointer items-center rounded-md bg-[var(--color-accent-blue)] px-4 text-sm font-medium text-white hover:brightness-110">
                  {dealsT("newTicket")}
                </span>
              }
            />
          </div>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <StageBar
          steps={[
            { key: "pending", label: misc("pendingStatus") },
            { key: "ticket_created", label: misc("ticketCreated") },
            { key: "closed", label: misc("closed") },
          ]}
          current={l.status}
        />
        <div className="flex flex-wrap gap-2">
          <StatButton count={wants.length} label={interest("title")} href="#interests" icon={<Car size={14} />} />
          <StatButton count={commentsList.length} label={t("followUps")} href="#followups" icon={<MessagesSquare size={14} />} />
          <StatButton count={entries.length} label={history("title")} href="#history" icon={<HistoryIcon size={14} />} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel>
            <PanelHeader title={misc("clientInfo")} />
            <dl className="space-y-1.5 text-sm">
              <Row label={t("carInterest")} value={l.car_interest} />
              <Row label={misc("company")} value={l.company_name} />
              <Row label={misc("jobTitle")} value={l.job_title} />
              <Row label={misc("income")} value={l.income ? formatMoney(l.income, locale) : null} />
              <Row label={misc("address")} value={l.address} />
              {/* Buyer identity (0020): mandatory on the e-invoice and the
                  ownership transfer, so the person closing the deal must be
                  able to see at a glance whether it has been captured. */}
              <Row label={misc("nationalId")} value={l.national_id} />
              <Row label={misc("nationality")} value={l.nationality} />
              <Row label={misc("contactTime")} value={l.contact_time_preference} />
            </dl>
            <NotePointsView heading={l.client_notes} points={l.client_note_points ?? []} />
          </Panel>

          {/* The person behind the enquiry (0031). Directly under Client
              Info because that panel is what this lead says about them and
              this one is what the whole group knows. */}
          <CustomerCard
            customer={customer}
            otherLeads={otherLeads}
            tickets={customerTickets}
            currentLeadId={l.id}
          />

          <Panel id="interests">
            <PanelHeader title={interest("title")} action={<InterestFormDialog leadId={l.id} />} />
            <div className="space-y-2">
              {wants.map((i) => (
                <div
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-black/[0.02] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {i.vehicles ? (
                        <Link href={`/inventory/${i.vehicles.id}`} className="text-sm hover:underline">
                          {interestLabel(i)}
                        </Link>
                      ) : (
                        <span className="text-sm">{interestLabel(i)}</span>
                      )}
                      <StatusPill
                        label={i.vehicles ? interest("inStock") : interest("notInStock")}
                        tone={i.vehicles ? "blue" : "amber"}
                      />
                      {i.origin === "suggested" && (
                        <StatusPill label={interest("originSuggestedShort")} tone="neutral" />
                      )}
                    </div>
                    {i.note && (
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{i.note}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-end">
                      <p className="num text-sm text-[var(--color-text)]">
                        {i.budget_amount !== null
                          ? formatMoney(Number(i.budget_amount), locale)
                          : interest("noBudget")}
                      </p>
                      <p className="text-[10px] text-[var(--color-text-faint)]">{interest("budget")}</p>
                    </div>
                    <InterestStatusSelect id={i.id} status={i.status} />
                    <InterestEditDialog interest={i} />
                  </div>
                </div>
              ))}
              {!wants.length && (
                <p className="text-xs text-[var(--color-text-faint)]">{interest("none")}</p>
              )}
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel id="followups">
            <PanelHeader title={t("followUps")} />
            <CommentForm leadId={l.id} />
            <div className="mt-4 space-y-3">
              {commentsList.map((c) => (
                <div key={c.id} className="border-b border-[var(--color-border)] pb-3 last:border-0">
                  <div className="flex items-center justify-between text-xs text-[var(--color-text-faint)]">
                    <span>{c.profiles?.full_name ?? "—"} · {c.contact_method}</span>
                    <span>{new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-text)]">{c.body}</p>
                </div>
              ))}
              {!commentsList.length && <p className="text-xs text-[var(--color-text-faint)]">{common("noFollowUps")}</p>}
            </div>
          </Panel>

          <Panel id="history">
            <PanelHeader title={history("title")} subtitle={history("subtitle")} />
            <LeadHistory entries={entries} />
          </Panel>
        </div>
      </div>
    </div>
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
