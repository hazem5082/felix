"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { motion } from "framer-motion";
import Image from "next/image";
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
  CalendarCheck,
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
  attendance: CalendarCheck,
  support: LifeBuoy,
  account: UserCircle2,
};

export function Sidebar({ role }: { role: Role }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const items = navForRole(role);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-e border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:flex">
      <div className="mb-6 flex items-center px-2 pt-1">
        <Image src="/brand/felix-logo.png" alt="FELIX" width={420} height={140} className="h-7 w-auto" priority />
      </div>

      <nav className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = ICONS[item.key];
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-3 rounded-md px-3.5 py-2.5 text-sm font-medium transition-colors duration-150",
                active
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-black/[0.03] hover:text-[var(--color-text)]"
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-md bg-[var(--color-accent-dim)]"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Icon size={17} className="relative z-10" />
              <span className="relative z-10 tracking-wide">{t(item.key)}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

