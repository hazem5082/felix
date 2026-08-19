import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { StageBar } from "@/components/ui/stage-bar";
import { StatButton } from "@/components/ui/stat-button";
import { Link } from "@/i18n/navigation";
import { Car, MessagesSquare, History as HistoryIcon } from "lucide-react";
import type { AuditLogRow, Lead, LeadComment, LeadVehicleInterest, Vehicle } from "@/lib/supabase/types";
import { interestLabel, vehicleLabel } from "@/lib/demand";
import { buildLeadHistory, vehicleIdsInHistory } from "@/lib/lead-history";
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
      .select("*, vehicles(id, year, make, model, trim, purchase_price, status)")
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
              <Row label={misc("income")} value={l.income ? `$${l.income.toLocaleString()}` : null} />
              <Row label={misc("address")} value={l.address} />
              <Row label={misc("contactTime")} value={l.contact_time_preference} />
            </dl>
            <NotePointsView heading={l.client_notes} points={l.client_note_points ?? []} />
          </Panel>

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
                          ? `$${Number(i.budget_amount).toLocaleString()}`
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
