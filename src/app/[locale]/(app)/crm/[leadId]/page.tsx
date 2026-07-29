import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { Lead, LeadComment } from "@/lib/supabase/types";
import { CommentForm } from "./comment-form";
import { DealTicketFormDialog } from "../deal-ticket-form";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const t = await getTranslations("crm");
  const dealsT = await getTranslations("deals");
  const misc = await getTranslations("misc");
  const supabase = await createClient();

  const [{ data: lead }, { data: comments }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", leadId).single(),
    supabase
      .from("lead_comments")
      .select("*, profiles(full_name)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
  ]);

  if (!lead) notFound();
  const l = lead as Lead;

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
            {!comments?.length && <p className="text-xs text-[var(--color-text-faint)]">No follow-ups logged yet.</p>}
          </div>
        </Panel>
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
