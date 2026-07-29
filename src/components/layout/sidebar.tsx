"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { motion } from "framer-motion";
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
} from "lucide-react";

const ICONS = {
  ceoDashboard: LayoutDashboard,
  inventory: Car,
  crm: Users,
  deals: FileCheck2,
  accountant: Calculator,
  investor: Wallet,
};

export function Sidebar({ role }: { role: Role }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const items = navForRole(role);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-e border-[var(--color-border)] bg-[var(--color-surface)]/60 p-4 md:flex">
      <div className="mb-6 flex items-center gap-2 px-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-gradient-to-b from-[#3a3f47] to-[#1c1e22] text-xs font-bold text-white shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset]">
          FX
        </div>
        <span className="text-sm font-semibold tracking-wide">FILEX</span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {items.map((item) => {
          const Icon = ICONS[item.key];
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-lg bg-white/[0.06] ring-1 ring-inset ring-white/10"
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              <Icon size={16} className="relative z-10" />
              <span className="relative z-10">{t(item.key)}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
