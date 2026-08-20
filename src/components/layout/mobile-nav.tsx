"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { navForRole } from "./nav-config";
import type { Role } from "@/lib/supabase/types";
import {
  LayoutDashboard,
  Car,
  Users,
  FileCheck2,
  Calculator,
  Wallet,
  CalendarDays,
  UserCog,
  LifeBuoy,
  UserCircle2,
  Megaphone,
} from "lucide-react";

const ICONS = {
  ceoDashboard: LayoutDashboard,
  inventory: Car,
  crm: Users,
  deals: FileCheck2,
  marketing: Megaphone,
  accountant: Calculator,
  investor: Wallet,
  calendar: CalendarDays,
  employees: UserCog,
  support: LifeBuoy,
  account: UserCircle2,
};

/**
 * Bottom tab bar for phones. The sidebar is `hidden md:flex`, so
 * without this there was NO navigation at all below 768px — every role
 * landed on its default page and could not reach any other section
 * short of typing URLs. On a phone the product looked broken.
 *
 * Same `navForRole` source as the sidebar, so the two can never drift.
 */
export function MobileNav({ role }: { role: Role }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const items = navForRole(role);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-surface)] md:hidden">
      {items.map((item) => {
        const Icon = ICONS[item.key];
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium transition-colors",
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
