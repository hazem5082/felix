"use client";

import { usePathname, useRouter } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/[locale]/login/actions";
import type { Profile } from "@/lib/supabase/types";
import { Globe, LogOut } from "lucide-react";

export function Topbar({ profile }: { profile: Profile }) {
  const t = useTranslations("common");
  const roles = useTranslations("roles");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  function toggleLocale() {
    const next = locale === "en" ? "ar" : "en";
    router.replace(pathname, { locale: next });
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)]/60 px-5">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text)]">{profile.full_name}</span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs">{roles(profile.role)}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={toggleLocale}>
          <Globe size={14} />
          {locale === "en" ? "العربية" : "English"}
        </Button>
        <form action={logout.bind(null, locale)}>
          <Button variant="ghost" size="sm" type="submit">
            <LogOut size={14} />
            {t("signOut")}
          </Button>
        </form>
      </div>
    </header>
  );
}
