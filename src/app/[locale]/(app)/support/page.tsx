import { getTranslations } from "next-intl/server";
import { requireProfile } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { LifeBuoy, MessageCircle, Phone, ShieldCheck } from "lucide-react";

// The emergency line — the CEO & developer directly, by design.
const EMERGENCY_PHONE_DISPLAY = "+20 101 178 2780";
const EMERGENCY_PHONE_TEL = "+201011782780";
const WHATSAPP_URL = "https://wa.me/201011782780";

export default async function SupportPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requireProfile(locale);
  const t = await getTranslations("support");

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />

      <Panel className="glass-shine">
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.06] ring-1 ring-inset ring-white/15">
            <LifeBuoy size={26} className="text-white" />
          </div>

          <p className="max-w-lg text-lg font-semibold text-white">{t("tagline")}</p>

          <p className="num text-2xl font-black tracking-wide text-white" dir="ltr">
            {EMERGENCY_PHONE_DISPLAY}
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <a
              href={`tel:${EMERGENCY_PHONE_TEL}`}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-[0_4px_16px_rgba(59,130,246,0.35)] transition-all hover:from-blue-400 hover:to-blue-500"
            >
              <Phone size={15} />
              {t("callNow")}
            </a>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/[0.05] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              <MessageCircle size={15} />
              {t("whatsapp")}
            </a>
          </div>

          <p className="max-w-md text-xs text-[var(--color-text-muted)]">{t("emergencyNote")}</p>
        </div>
      </Panel>

      <Panel>
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
          <div>
            <p className="text-sm font-medium text-white">{t("aboutTitle")}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {t("aboutBody")}
            </p>
            <p className="mt-3 text-xs font-medium text-[var(--color-text-faint)]">
              {t("provenance")}
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
