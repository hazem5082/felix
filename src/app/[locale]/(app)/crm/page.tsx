import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Link } from "@/i18n/navigation";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import type { Lead } from "@/lib/supabase/types";
import { LeadFormDialog } from "./lead-form";
import { ReferralLinkCard } from "./referral-link";

export default async function CrmPage() {
  const t = await getTranslations("crm");
  const misc = await getTranslations("misc");
  const common = await getTranslations("common");
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

      <Panel>
        <Table>
          <THead>
            <Th>{t("clientName")}</Th>
            <Th>{t("phone")}</Th>
            <Th>{t("carInterest")}</Th>
            <Th>{misc("source")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {((leads as Lead[]) ?? []).map((l) => (
              <Tr key={l.id}>
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
                    label={l.status === "ticket_created" ? misc("ticketCreated") : l.status === "closed" ? misc("closed") : misc("pendingStatus")}
                    tone={l.status === "ticket_created" ? "blue" : l.status === "closed" ? "green" : "amber"}
                  />
                </Td>
              </Tr>
            ))}
            {!leads?.length && <Tr><Td className="text-center text-[var(--color-text-faint)]">—</Td></Tr>}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
