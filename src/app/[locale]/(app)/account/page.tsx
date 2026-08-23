import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AccountForms } from "./account-forms";
import type { CompanySettings } from "@/lib/supabase/types";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const profile = await requireProfile(locale);
  const t = await getTranslations("account");
  const tRoles = await getTranslations("roles");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The company letterhead (0046). Read for the CEO only, because only
  // the CEO gets the panel that edits it — everyone else has no use for
  // the row on this page. maybeSingle() and a null result are the
  // ORDINARY case, not an error: the tenant template is pure DDL and
  // cannot seed the row, so it does not exist until a CEO first saves.
  const isCeo = profile.role === "ceo";
  const { data: companyRow } = isCeo
    ? await supabase.from("company_settings").select("*").maybeSingle()
    : { data: null };
  const company = companyRow as CompanySettings | null;

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />

      <Panel>
        <PanelHeader title={t("identityTitle")} />
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--color-text-muted)]">{t("fullName")}</dt>
            <dd className="mt-0.5 text-sm text-[var(--color-text)]">{profile.full_name}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-muted)]">{t("role")}</dt>
            <dd className="mt-0.5 text-sm text-[var(--color-text)]">{tRoles(profile.role)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-muted)]">{t("signInEmail")}</dt>
            <dd className="mt-0.5 text-sm text-[var(--color-text)]">{user?.email ?? "—"}</dd>
          </div>
        </dl>
      </Panel>

      <AccountForms
        profileId={profile.id}
        signInEmail={user?.email ?? ""}
        notificationEmail={profile.notification_email}
        whatsappNumber={profile.whatsapp_number}
        isCeo={isCeo}
        company={company}
      />
    </div>
  );
}
