"use client";

import { useEffect, useMemo, useState } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { motion } from "framer-motion";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { navFor, type NavEntry, type NavKey } from "./nav-config";
import { navIcon } from "./nav-icons";
import type { FeatureGrant, Role } from "@/lib/supabase/types";
import { resolveFeatures } from "@/lib/features";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";

const STORAGE_KEY = "felix.sidebar.collapsed";

export function Sidebar({
  role,
  grants = [],
}: {
  role: Role;
  /**
   * This session's live feature_grants (0048). Defaults to none, which
   * reproduces the pre-0048 rail exactly — so a render path that has
   * not loaded them degrades to the role default rather than to an
   * empty sidebar.
   */
  grants?: FeatureGrant[];
}) {
  const t = useTranslations("nav");
  const common = useTranslations("common");
  const pathname = usePathname();
  const items = useMemo(() => navFor(role, resolveFeatures(grants)), [role, grants]);

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
        "hidden h-full min-h-0 shrink-0 flex-col border-e border-[var(--color-border)] bg-[var(--color-surface)] py-3 md:flex",
        // No horizontal padding on the <aside> itself: the logo below is
        // meant to span the rail edge to edge, so the inset lives on the
        // nav rows instead.
        collapsed ? "w-[4.5rem]" : "w-60",
        // Skipped until the stored preference has been read, so a rail
        // that should start collapsed doesn't visibly slide shut on load.
        ready && "transition-[width] duration-200 ease-out"
      )}
    >
      {/* Centered logo with clean bounded height */}
      <div className="mb-2 shrink-0 flex items-center justify-center px-4">
        <Image
          src="/brand/felix-logo.png"
          alt="FELIX"
          width={420}
          height={140}
          className="h-7 w-auto max-w-[110px] object-contain"
          priority
        />
      </div>

      <nav
        className={cn(
          "flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden [scrollbar-width:thin]",
          collapsed ? "px-2" : "px-3"
        )}
      >
        {items.map((entry) =>
          entry.kind === "group" ? (
            <NavGroupRow
              key={entry.href}
              entry={entry}
              collapsed={collapsed}
              pathname={pathname}
              t={t}
            />
          ) : (
            <NavRow
              key={entry.href}
              navKey={entry.key}
              href={entry.href}
              label={t(entry.key)}
              active={isActive(pathname, entry.href)}
              collapsed={collapsed}
            />
          )
        )}
      </nav>

      <div className={cn("shrink-0 pt-1 border-t border-[var(--color-border)]/40 mt-1", collapsed ? "px-2" : "px-3")}>
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? common("expandNav") : common("collapseNav")}
          aria-label={collapsed ? common("expandNav") : common("collapseNav")}
          aria-expanded={!collapsed}
          className={cn(
            "flex w-full cursor-pointer items-center rounded-md py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:bg-black/[0.03] hover:text-[var(--color-text)]",
            collapsed ? "justify-center px-0" : "gap-2.5 px-3"
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={15} className="shrink-0 rtl:-scale-x-100" />
          ) : (
            <PanelLeftClose size={15} className="shrink-0 rtl:-scale-x-100" />
          )}
          {!collapsed && <span className="truncate">{common("collapseNav")}</span>}
        </button>
      </div>
    </aside>
  );
}

/** `/hr` must not light up for `/hrsomething`, hence the trailing slash. */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

function NavRow({
  navKey,
  href,
  label,
  active,
  collapsed,
  nested = false,
}: {
  navKey: NavKey;
  href: string;
  label: string;
  active: boolean;
  collapsed: boolean;
  nested?: boolean;
}) {
  const Icon = navIcon(navKey);
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "relative flex items-center rounded-md text-[13px] font-medium transition-colors duration-150",
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-3 py-1.5",
        // Nested rows sit in from the parent and read a shade quieter
        !collapsed && nested && "py-1 text-xs text-[var(--color-text-muted)]",
        active
          ? "text-[var(--color-accent)] font-semibold"
          : "text-[var(--color-text-muted)] hover:bg-black/[0.03] hover:text-[var(--color-text)]"
      )}
    >
      {active && (
        <motion.span
          layoutId={nested ? undefined : "sidebar-active"}
          className="absolute inset-0 rounded-md bg-[var(--color-accent-dim)]"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
        />
      )}
      <Icon size={nested && !collapsed ? 14 : 16} className="relative z-10 shrink-0" />
      {!collapsed && <span className="relative z-10 truncate tracking-wide">{label}</span>}
    </Link>
  );
}

/**
 * A hub: a heading that is itself a link, plus its pages.
 *
 * Open by default whenever the current route is inside it, so landing
 * on /hr/payroll from a bookmark shows you where you are rather than a
 * shut drawer. Collapsing the whole rail collapses the group with it —
 * there is no room for nested labels at 4.5rem, and the children stay
 * reachable through the hub's own landing page.
 */
function NavGroupRow({
  entry,
  collapsed,
  pathname,
  t,
}: {
  entry: Extract<NavEntry, { kind: "group" }>;
  collapsed: boolean;
  pathname: string;
  t: (key: string) => string;
}) {
  const insideGroup =
    isActive(pathname, entry.href) ||
    entry.children.some((child) => isActive(pathname, child.href));

  const [open, setOpen] = useState(insideGroup);
  // Navigating into the hub opens it; navigating away leaves whatever
  // the user last chose, which is why this only ever opens.
  useEffect(() => {
    if (insideGroup) setOpen(true);
  }, [insideGroup]);

  const Icon = navIcon(entry.key);
  const label = t(entry.key);

  if (collapsed) {
    return (
      <NavRow
        navKey={entry.key}
        href={entry.href}
        label={label}
        active={insideGroup}
        collapsed
      />
    );
  }

  return (
    <div>
      <div
        className={cn(
          "relative flex items-center rounded-md text-[13px] font-medium transition-colors duration-150",
          insideGroup
            ? "text-[var(--color-accent)] font-semibold"
            : "text-[var(--color-text-muted)] hover:bg-black/[0.03] hover:text-[var(--color-text)]"
        )}
      >
        {pathname === entry.href && (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 rounded-md bg-[var(--color-accent-dim)]"
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          />
        )}
        <Link href={entry.href} className="relative z-10 flex flex-1 items-center gap-2.5 px-3 py-1.5">
          <Icon size={16} className="shrink-0" />
          <span className="truncate tracking-wide">{label}</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={label}
          className="relative z-10 cursor-pointer rounded-md p-1.5 me-1 text-[var(--color-text-muted)] hover:bg-black/[0.04] hover:text-[var(--color-text)]"
        >
          <ChevronDown
            size={13}
            className={cn("transition-transform duration-150", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5 ps-2 border-s border-[var(--color-border)]/70 ms-3.5 my-0.5">
          {entry.children.map((child) => (
            <NavRow
              key={child.href}
              navKey={child.key}
              href={child.href}
              label={t(child.key)}
              active={isActive(pathname, child.href)}
              collapsed={false}
              nested
            />
          ))}
        </div>
      )}
    </div>
  );
}
