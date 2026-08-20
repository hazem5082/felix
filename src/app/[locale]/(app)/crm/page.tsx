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

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} action={<LeadFormDialog />} />

      {profile?.role === "sales_exec" && <ReferralLinkCard salespersonId={profile.id} />}

      <LeadsBrowser leads={leadList} lastContactByLead={lastContactByLead} />
    </div>
  );
}
