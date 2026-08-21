import type { Role } from "@/lib/supabase/types";

export interface NavItem {
  href: string;
  key:
    | "ceoDashboard"
    | "inventory"
    | "crm"
    | "deals"
    | "marketing"
    | "accountant"
    | "investor"
    | "calendar"
    | "employees"
    | "attendance"
    | "mail"
    | "support"
    | "account";
}

export const ALL_NAV: NavItem[] = [
  { href: "/ceo", key: "ceoDashboard" },
  { href: "/inventory", key: "inventory" },
  { href: "/crm", key: "crm" },
  { href: "/deals", key: "deals" },
  { href: "/marketing", key: "marketing" },
  { href: "/accountant", key: "accountant" },
  { href: "/investor", key: "investor" },
  { href: "/calendar", key: "calendar" },
  { href: "/employees", key: "employees" },
  { href: "/attendance", key: "attendance" },
  { href: "/mail", key: "mail" },
  { href: "/support", key: "support" },
  { href: "/account", key: "account" },
];

// The calendar is the one tab every role carries. Who may *schedule*
// into it is a separate question, settled in the database by
// create_meeting() (migration 0006) rather than by this list.
// Employees is the opposite extreme: CEO-only, and the page +
// every action behind it re-checks that server-side.
//
// Attendance (0038) is carried by everyone who can owe or oversee a
// day: the four staff roles plus marketing. Investors are excluded —
// they are outside capital, not staff, and there is no sense in which
// one attends. The tab still renders for a REMOTE profile: it is where
// they see their own history and their trusted phones, and the page
// tells them plainly that no punch is expected of them, which is a
// better answer than a tab that silently vanishes.
// Mail (0039) is carried by every role, investors included — unlike
// attendance, it is generic correspondence rather than a staff
// obligation, and an investor's own felixmail address is exactly as
// real as anyone else's.
const NAV_BY_ROLE: Record<Role, NavItem["key"][]> = {
  ceo: ["ceoDashboard", "inventory", "crm", "deals", "marketing", "accountant", "calendar", "employees", "attendance", "mail", "support", "account"],
  branch_manager: ["inventory", "crm", "deals", "calendar", "attendance", "mail", "support", "account"],
  accountant: ["accountant", "inventory", "deals", "calendar", "attendance", "mail", "support", "account"],
  sales_exec: ["crm", "deals", "calendar", "attendance", "mail", "support", "account"],
  investor: ["investor", "calendar", "mail", "support", "account"],
  // Marketing lists stock across channels: their workspace, the inventory
  // they advertise (cost hidden — 0028), and the tabs everyone carries.
  marketing: ["marketing", "inventory", "calendar", "attendance", "mail", "support", "account"],
};

export function navForRole(role: Role): NavItem[] {
  const keys = NAV_BY_ROLE[role];
  return ALL_NAV.filter((item) => keys.includes(item.key));
}
