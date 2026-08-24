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
        "relative flex items-center rounded-md py-2.5 text-sm font-medium transition-colors duration-150",
        collapsed ? "justify-center px-0" : "gap-3 px-3.5",
        // Nested rows sit in from the parent and read a shade quieter,
        // so the hub's heading stays the thing the eye lands on.
        !collapsed && nested && "ms-3 py-2 text-[13px]",
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
      <Icon size={nested && !collapsed ? 15 : 17} className="relative z-10 shrink-0" />
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
          "relative flex items-center rounded-md text-sm font-medium transition-colors duration-150",
          insideGroup
            ? "text-[var(--color-accent)]"
            : "text-[var(--color-text-muted)] hover:bg-black/[0.03] hover:text-[var(--color-text)]"
        )}
      >
        {isActive(pathname, entry.href) && (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 rounded-md bg-[var(--color-accent-dim)]"
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          />
        )}
        <Link href={entry.href} className="relative z-10 flex flex-1 items-center gap-3 px-3.5 py-2.5">
          <Icon size={17} className="shrink-0" />
          <span className="truncate tracking-wide">{label}</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={label}
          className="relative z-10 cursor-pointer rounded-md p-2 hover:bg-black/[0.04]"
        >
          <ChevronDown
            size={14}
            className={cn("transition-transform duration-150", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5">
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
