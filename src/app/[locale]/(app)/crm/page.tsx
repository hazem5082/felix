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

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} action={<LeadFormDialog />} />

      {profile?.role === "sales_exec" && <ReferralLinkCard salespersonId={profile.id} />}

      <LeadsBrowser leads={(leads as Lead[]) ?? []} />
    </div>
  );
}
