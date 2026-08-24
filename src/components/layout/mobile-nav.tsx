"use client";

import { useMemo } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { flattenNav, navFor } from "./nav-config";
import { navIcon } from "./nav-icons";
import { resolveFeatures } from "@/lib/features";
import type { FeatureGrant, Role } from "@/lib/supabase/types";

/**
 * Bottom tab bar for phones. The sidebar is `hidden md:flex`, so
 * without this there was NO navigation at all below 768px — every role
 * landed on its default page and could not reach any other section
 * short of typing URLs. On a phone the product looked broken.
 *
 * Same `navFor` source as the sidebar, so the two can never drift —
 * including which hubs a CEO has granted this person (0048).
 *
 * Groups are FLATTENED rather than rendered as a hub. There is no room
 * for a disclosure control in a tab bar, and hiding three HR pages
 * behind one tap on the device HR is most likely to be holding while
 * walking the floor would be the wrong trade. The row scrolls
 * horizontally when it has to.
 */
export function MobileNav({
  role,
  grants = [],
}: {
  role: Role;
  grants?: FeatureGrant[];
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const items = useMemo(
    () => flattenNav(navFor(role, resolveFeatures(grants))),
    [role, grants]
  );

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] md:hidden">
      {items.map((item) => {
        const Icon = navIcon(item.key);
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-w-[4.5rem] flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium transition-colors",
              active ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"
            )}
          >
            <Icon size={18} />
            <span className="w-full truncate text-center leading-tight">{t(item.key)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
