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
} from "lucide-react";

const ICONS = {
  ceoDashboard: LayoutDashboard,
  inventory: Car,
  crm: Users,
  deals: FileCheck2,
  accountant: Calculator,
  investor: Wallet,
  calendar: CalendarDays,
  employees: UserCog,
  support: LifeBuoy,
  account: UserCircle2,
};

export function Sidebar({ role }: { role: Role }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const items = navForRole(role);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-e border-white/10 bg-black/40 backdrop-blur-2xl p-4 md:flex shadow-[4px_0_30px_rgba(0,0,0,0.25)]">
      <div className="mb-6 flex items-center px-2 pt-1">
        <Image src="/brand/felix-logo.png" alt="FELIX" width={420} height={140} className="h-7 w-auto drop-shadow-[0_0_12px_rgba(255,255,255,0.2)]" priority />
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
                "relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all duration-200",
                active
                  ? "text-white"
                  : "text-[var(--color-text-muted)] hover:bg-white/[0.06] hover:text-white"
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-white/[0.14] to-white/[0.04] ring-1 ring-inset ring-white/20 shadow-[0_4px_16px_rgba(0,0,0,0.3),inset_0_1px_1px_rgba(255,255,255,0.2)]"
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

