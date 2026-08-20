import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import type { Lead } from "@/lib/supabase/types";
import { LeadFormDialog } from "./lead-form";
import { ReferralLinkCard } from "./referral-link";
import { LeadsBrowser } from "./leads-browser";

export default async function CrmPage() {
  const t = await getTranslations("crm");
  const supabase = await createClient();
  const profile = await getProfile();

  const { data: leads } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });

  const leadList = (leads as Lead[]) ?? [];

  // Most recent lead_comments.created_at per lead, for the "last contacted"
  // freshness dot. Comments are already scoped to visible leads by the same
  // RLS this page's own leads query relies on; ordering desc and keeping the
  // first hit per lead_id is cheaper than a per-lead query or a DB view.
  const { data: comments } = leadList.length
    ? await supabase
        .from("lead_comments")
        .select("lead_id, created_at")
        .in("lead_id", leadList.map((l) => l.id))
        .order("created_at", { ascending: false })
    : { data: [] };

  const lastContactByLead: Record<string, string> = {};
  for (const c of (comments as { lead_id: string; created_at: string }[]) ?? []) {
    if (!(c.lead_id in lastContactByLead)) lastContactByLead[c.lead_id] = c.created_at;
  }

  // ── Who on this list has bought from the group before (0031) ──
  //
  // ONE extra query for the whole page, not one per row. Executed tickets
  // across every visible lead come back in a single `in (…)`, and the
  // lead → customer map the page already holds turns them into a set of
  // customer ids. A row is marked when its customer has an executed
  // ticket that belongs to a DIFFERENT lead — a sale closed on this very
  // enquiry is not a returning customer, it is this enquiry.
  //
  // Scope is the viewer's own: deal_tickets_select confines a sales exec
  // to their own tickets and a manager to their branch, so this marks the
  // returns that this reader can see. It never widens anything, and a
  // missing dot is not a claim that the person has never bought a car.
  //
  // Degrades to no dots at all on a database still on 0030: customer_id
  // is simply absent from the rows and every lookup below misses.
  const { data: executed } = leadList.length
    ? await supabase
        .from("deal_tickets")
        .select("lead_id")
        .eq("status", "executed")
        .in("lead_id", leadList.map((l) => l.id))
    : { data: [] };

  const customerByLead = new Map(leadList.map((l) => [l.id, l.customer_id ?? null]));

  // customer id → the leads of theirs that produced an executed sale.
  const soldLeadsByCustomer = new Map<string, Set<string>>();
  for (const ticket of (executed as { lead_id: string | null }[]) ?? []) {
    if (!ticket.lead_id) continue;
    const customerId = customerByLead.get(ticket.lead_id);
    if (!customerId) continue;
    const seen = soldLeadsByCustomer.get(customerId) ?? new Set<string>();
    seen.add(ticket.lead_id);
    soldLeadsByCustomer.set(customerId, seen);
  }

  const returningLeadIds = leadList
    .filter((l) => {
      if (!l.customer_id) return false;
      const soldOn = soldLeadsByCustomer.get(l.customer_id);
      // "Somewhere other than here": a sale closed on this very enquiry
      // is this enquiry, not a previous visit.
      return !!soldOn && [...soldOn].some((leadId) => leadId !== l.id);
    })
    .map((l) => l.id);

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} action={<LeadFormDialog />} />

      {profile?.role === "sales_exec" && <ReferralLinkCard salespersonId={profile.id} />}

      <LeadsBrowser
        leads={leadList}
        lastContactByLead={lastContactByLead}
        returningLeadIds={returningLeadIds}
      />
    </div>
  );
}
