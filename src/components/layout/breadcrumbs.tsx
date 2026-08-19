"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { ALL_NAV } from "./nav-config";

/**
 * A generic "where am I" trail: the top-level section (from nav-config,
 * translated the same way the sidebar is) plus a trailing "Details" crumb
 * when a record id follows it. No per-page wiring — every route under the
 * (app) layout gets one automatically from its own path.
 */
export function Breadcrumbs() {
  const t = useTranslations("nav");
  const common = useTranslations("common");
  const pathname = usePathname();

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const section = ALL_NAV.find((item) => item.href === `/${segments[0]}`);
  const hasDetail = segments.length > 1;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 text-xs text-[var(--color-text-muted)]"
    >
      {section ? (
        hasDetail ? (
          <Link href={section.href} className="hover:text-[var(--color-text)] hover:underline">
            {t(section.key)}
          </Link>
        ) : (
          <span className="font-medium text-[var(--color-text)]">{t(section.key)}</span>
        )
      ) : (
        <span className="font-medium text-[var(--color-text)]">{segments[0]}</span>
      )}
      {hasDetail && (
        <>
          <ChevronRight size={12} className="shrink-0 text-[var(--color-text-faint)]" />
          <span className="font-medium text-[var(--color-text)]">{common("details")}</span>
        </>
      )}
    </nav>
  );
}
