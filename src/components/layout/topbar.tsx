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
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-black/40 backdrop-blur-2xl px-5 shadow-[0_4px_20px_rgba(0,0,0,0.2)]">
      <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <span className="truncate font-semibold text-white">{profile.full_name}</span>
        <span className="shrink-0 rounded-full bg-white/[0.08] backdrop-blur-md px-2.5 py-0.5 text-xs font-medium border border-white/10 text-white/90">
          {roles(profile.role)}
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 border-s border-white/10 ps-2.5 text-xs sm:flex text-white/80">
          <Building2 size={13} className="text-cyan-400" />
          <span className="max-w-[18ch] truncate font-medium">{showroomName}</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={toggleLocale} className="hover:bg-white/10 hover:text-white transition-all">
          <Globe size={14} />
          {locale === "en" ? "العربية" : "English"}
        </Button>
        <form action={logout.bind(null, locale)}>
          <Button variant="ghost" size="sm" type="submit" className="hover:bg-white/10 hover:text-white transition-all">
            <LogOut size={14} />
            {t("signOut")}
          </Button>
        </form>
      </div>
    </header>
  );
}

