import type { Role } from "@/lib/supabase/types";

export interface NavItem {
  href: string;
  key: "ceoDashboard" | "inventory" | "crm" | "deals" | "accountant" | "investor";
}

const ALL_NAV: NavItem[] = [
  { href: "/ceo", key: "ceoDashboard" },
  { href: "/inventory", key: "inventory" },
  { href: "/crm", key: "crm" },
  { href: "/deals", key: "deals" },
  { href: "/accountant", key: "accountant" },
  { href: "/investor", key: "investor" },
];

const NAV_BY_ROLE: Record<Role, NavItem["key"][]> = {
  ceo: ["ceoDashboard", "inventory", "crm", "deals", "accountant"],
  branch_manager: ["inventory", "crm", "deals"],
  accountant: ["accountant", "inventory", "deals"],
  sales_exec: ["crm", "deals"],
  investor: ["investor"],
};

export function navForRole(role: Role): NavItem[] {
  const keys = NAV_BY_ROLE[role];
  return ALL_NAV.filter((item) => keys.includes(item.key));
}
