import {
  BadgePercent,
  Banknote,
  CalendarCheck,
  Circle,
  CalendarDays,
  Calculator,
  Car,
  Receipt,
  FileCheck2,
  LayoutDashboard,
  ListChecks,
  LifeBuoy,
  Mail,
  Megaphone,
  Network,
  UserCircle2,
  UserCog,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { NavKey } from "./nav-config";

/**
 * The icon a nav key falls back to when nobody gave it one.
 *
 * NAV_ICONS is a total Record, so tsc already refuses a NavKey with no
 * entry — but three sessions adding nav keys in parallel means the
 * unfinished intermediate state is real, and its symptom was the whole
 * application rendering "Element type is invalid ... got: undefined"
 * from a bare `<Icon />`. A missing icon should look like a missing
 * icon, not like an outage.
 */
export const FALLBACK_NAV_ICON: LucideIcon = Circle;

/** Never returns undefined. Use this rather than indexing NAV_ICONS. */
export function navIcon(key: NavKey): LucideIcon {
  return NAV_ICONS[key] ?? FALLBACK_NAV_ICON;
}

/**
 * One icon table, imported by both the sidebar and the phone tab bar.
 *
 * It used to be declared twice, identically, in those two files. That
 * survived six navigation entries; it would not survive a group whose
 * children each need one, and the failure mode of a drifted copy is a
 * tab bar that crashes on an undefined component rather than one that
 * merely looks wrong.
 */
export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  ceoDashboard: LayoutDashboard,
  inventory: Car,
  crm: Users,
  deals: FileCheck2,
  marketing: Megaphone,
  accountant: Calculator,
  // The showroom fee console (0050). A receipt rather than another
  // calculator or coin: what this screen is really about is the pile
  // of bills behind the fee, and the accountant already has the
  // calculator.
  fees: Receipt,
  // The FELIX Network (0054). A node graph rather than a globe or a
  // handshake: what the screen shows is this showroom joined to the
  // other licensed ones, and the globe would read as `the internet`.
  network: Network,
  // The task board (0053). A ticked list, which is literally what the
  // page is — and it collides with nothing: FileCheck2 is a deal ticket
  // and CalendarCheck is a punch card.
  tasks: ListChecks,
  investor: Wallet,
  calendar: CalendarDays,
  employees: UserCog,
  attendance: CalendarCheck,
  mail: Mail,
  support: LifeBuoy,
  account: UserCircle2,
  // The HR hub and its pages (0047–0049). UsersRound for the hub reads
  // as "people" without colliding with CRM's Users (customers) or
  // employees' UserCog (staff administration); Wallet is already the
  // investor's, so payroll takes the banknote and the ladder takes the
  // percentage badge.
  hr: UsersRound,
  hrPayroll: Banknote,
  hrBonuses: BadgePercent,
};

