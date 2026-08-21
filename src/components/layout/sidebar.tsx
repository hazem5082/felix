"use client";

import { useEffect, useState } from "react";
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
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
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
  mail: Mail,
  support: LifeBuoy,
  account: UserCircle2,
};

const STORAGE_KEY = "felix.sidebar.collapsed";

export function Sidebar({ role }: { role: Role }) {
  const t = useTranslations("nav");
  const common = useTranslations("common");
  const pathname = usePathname();
  const items = navForRole(role);

  // Starts expanded on both server and first client paint, then adopts
  // the stored preference in an effect — reading localStorage during
  // render would make the server HTML and the hydrated tree disagree.
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    setReady(true);
  }, []);

  function toggle() {
    setCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-e border-[var(--color-border)] bg-[var(--color-surface)] py-4 md:flex",
        // No horizontal padding on the <aside> itself: the logo below is
        // meant to span the rail edge to edge, so the inset lives on the
        // nav rows instead.
        collapsed ? "w-[4.5rem]" : "w-60",
        // Skipped until the stored preference has been read, so a rail
        // that should start collapsed doesn't visibly slide shut on load.
        ready && "transition-[width] duration-200 ease-out"
      )}
    >
      {/* Centered logo, sized to 1/2 width to reduce height by another 1/4 */}
      <div className="mb-3 flex items-center justify-center">
        <Image
          src="/brand/felix-logo.png"
          alt="FELIX"
          width={677}
          height={369}
          className="h-auto w-1/2"
          priority
        />
      </div>

      <nav className={cn("flex flex-col gap-1", collapsed ? "px-2" : "px-4")}>
        {items.map((item) => {
          const Icon = ICONS[item.key];
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const label = t(item.key);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? label : undefined}
              aria-label={collapsed ? label : undefined}
              className={cn(
                "relative flex items-center rounded-md py-2.5 text-sm font-medium transition-colors duration-150",
                collapsed ? "justify-center px-0" : "gap-3 px-3.5",
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
              <Icon size={17} className="relative z-10 shrink-0" />
              {!collapsed && <span className="relative z-10 truncate tracking-wide">{label}</span>}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={toggle}
        title={collapsed ? common("expandNav") : common("collapseNav")}
        aria-label={collapsed ? common("expandNav") : common("collapseNav")}
        aria-expanded={!collapsed}
        className={cn(
          "mt-auto flex cursor-pointer items-center rounded-md py-2.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:bg-black/[0.03] hover:text-[var(--color-text)]",
          collapsed ? "mx-2 justify-center" : "mx-4 gap-3 px-3.5"
        )}
      >
        {collapsed ? (
          <PanelLeftOpen size={17} className="shrink-0 rtl:-scale-x-100" />
        ) : (
          <PanelLeftClose size={17} className="shrink-0 rtl:-scale-x-100" />
        )}
        {!collapsed && <span className="truncate">{common("collapseNav")}</span>}
      </button>
    </aside>
  );
}
