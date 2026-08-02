import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AccountForms } from "./account-forms";

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

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />

      <Panel>
        <PanelHeader title={t("identityTitle")} />
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--color-text-muted)]">{t("fullName")}</dt>
            <dd className="mt-0.5 text-sm text-white">{profile.full_name}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-muted)]">{t("role")}</dt>
            <dd className="mt-0.5 text-sm text-white">{tRoles(profile.role)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-muted)]">{t("signInEmail")}</dt>
            <dd className="mt-0.5 text-sm text-white">{user?.email ?? "—"}</dd>
          </div>
        </dl>
      </Panel>

      <AccountForms
        notificationEmail={profile.notification_email}
        whatsappNumber={profile.whatsapp_number}
      />
    </div>
  );
}
