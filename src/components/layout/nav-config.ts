import type { Role } from "@/lib/supabase/types";

export interface NavItem {
  href: string;
  key:
    | "ceoDashboard"
    | "inventory"
    | "crm"
    | "deals"
    | "accountant"
    | "investor"
    | "calendar"
    | "employees"
    | "support"
    | "account";
}

const ALL_NAV: NavItem[] = [
  { href: "/ceo", key: "ceoDashboard" },
  { href: "/inventory", key: "inventory" },
  { href: "/crm", key: "crm" },
  { href: "/deals", key: "deals" },
  { href: "/accountant", key: "accountant" },
  { href: "/investor", key: "investor" },
  { href: "/calendar", key: "calendar" },
  { href: "/employees", key: "employees" },
  { href: "/support", key: "support" },
  { href: "/account", key: "account" },
];

// The calendar is the one tab every role carries. Who may *schedule*
// into it is a separate question, settled in the database by
// create_meeting() (migration 0006) rather than by this list.
// Employees is the opposite extreme: CEO-only, and the page +
// every action behind it re-checks that server-side.
const NAV_BY_ROLE: Record<Role, NavItem["key"][]> = {
  ceo: ["ceoDashboard", "inventory", "crm", "deals", "accountant", "calendar", "employees", "support", "account"],
  branch_manager: ["inventory", "crm", "deals", "calendar", "support", "account"],
  accountant: ["accountant", "inventory", "deals", "calendar", "support", "account"],
  sales_exec: ["crm", "deals", "calendar", "support", "account"],
  investor: ["investor", "calendar", "support", "account"],
};

export function navForRole(role: Role): NavItem[] {
  const keys = NAV_BY_ROLE[role];
  return ALL_NAV.filter((item) => keys.includes(item.key));
}
