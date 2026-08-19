"use client";

import { usePathname, useRouter } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/[locale]/login/actions";
import type { Profile } from "@/lib/supabase/types";
import { Building2, Globe, LogOut } from "lucide-react";

export function Topbar({
  profile,
  showroomName,
}: {
  profile: Profile;
  showroomName: string;
}) {
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
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5">
      <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <span className="truncate font-semibold text-[var(--color-text)]">{profile.full_name}</span>
        <span className="shrink-0 rounded-md bg-black/[0.04] px-2.5 py-0.5 text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)]">
          {roles(profile.role)}
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 border-s border-[var(--color-border)] ps-2.5 text-xs sm:flex text-[var(--color-text-muted)]">
          <Building2 size={13} className="text-[var(--color-accent)]" />
          <span className="max-w-[18ch] truncate font-medium">{showroomName}</span>
        </span>
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

