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

      <Panel>
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-md bg-[var(--color-accent-dim)]">
            <LifeBuoy size={26} className="text-[var(--color-accent)]" />
          </div>

          <p className="max-w-lg text-lg font-semibold text-[var(--color-text)]">{t("tagline")}</p>

          <p className="num text-2xl font-black tracking-wide text-[var(--color-text)]" dir="ltr">
            {EMERGENCY_PHONE_DISPLAY}
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <a
              href={`tel:${EMERGENCY_PHONE_TEL}`}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent-blue)] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:brightness-110"
            >
              <Phone size={15} />
              {t("callNow")}
            </a>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2.5 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-black/[0.04]"
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
            <p className="text-sm font-medium text-[var(--color-text)]">{t("aboutTitle")}</p>
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
