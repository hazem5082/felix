import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { Link } from "@/i18n/navigation";
import type { Lead, LeadComment, LeadVehicleInterest } from "@/lib/supabase/types";
import { interestLabel } from "@/lib/demand";
import { CommentForm } from "./comment-form";
import { InterestFormDialog } from "./interest-form";
import { InterestStatusSelect } from "./interest-status";
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

  return (
    <div className="space-y-6">
      <PanelHeader
        title={l.client_name}
        subtitle={l.phone_number}
        action={<DealTicketFormDialog leadId={l.id} trigger={<span className="inline-flex h-9 cursor-pointer items-center rounded-lg bg-[var(--color-accent-blue)] px-4 text-sm font-medium text-white hover:brightness-110">{dealsT("newTicket")}</span>} />}
      />

      <div className="grid gap-6 md:grid-cols-3">
        <Panel>
          <PanelHeader title={misc("clientInfo")} />
          <dl className="space-y-1.5 text-sm">
            <Row label={t("carInterest")} value={l.car_interest} />
            <Row label={misc("company")} value={l.company_name} />
            <Row label={misc("jobTitle")} value={l.job_title} />
            <Row label={misc("income")} value={l.income ? `$${l.income.toLocaleString()}` : null} />
            <Row label={misc("address")} value={l.address} />
          </dl>
          {l.client_notes && (
            <p className="mt-3 rounded-lg bg-white/[0.03] p-3 text-xs text-[var(--color-text-muted)]">{l.client_notes}</p>
          )}
        </Panel>

        <Panel className="md:col-span-2">
          <PanelHeader title={t("followUps")} />
          <CommentForm leadId={l.id} />
          <div className="mt-4 space-y-3">
            {((comments as (LeadComment & { profiles?: { full_name: string } })[]) ?? []).map((c) => (
              <div key={c.id} className="border-b border-[var(--color-border)] pb-3 last:border-0">
                <div className="flex items-center justify-between text-xs text-[var(--color-text-faint)]">
                  <span>{c.profiles?.full_name ?? "—"} · {c.contact_method}</span>
                  <span>{new Date(c.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm text-[var(--color-text)]">{c.body}</p>
              </div>
            ))}
            {!comments?.length && <p className="text-xs text-[var(--color-text-faint)]">{common("noFollowUps")}</p>}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title={interest("title")} action={<InterestFormDialog leadId={l.id} />} />
        <div className="space-y-2">
          {wants.map((i) => (
            <div
              key={i.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2.5"
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

              <div className="flex items-center gap-4">
                <div className="text-end">
                  <p className="num text-sm text-[var(--color-text)]">
                    {i.budget_amount !== null
                      ? `$${Number(i.budget_amount).toLocaleString()}`
                      : interest("noBudget")}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-faint)]">{interest("budget")}</p>
                </div>
                <InterestStatusSelect id={i.id} status={i.status} />
              </div>
            </div>
          ))}
          {!wants.length && (
            <p className="text-xs text-[var(--color-text-faint)]">{interest("none")}</p>
          )}
        </div>
      </Panel>
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
