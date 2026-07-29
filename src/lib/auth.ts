import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "@/i18n/navigation";
import type { Profile, Role } from "@/lib/supabase/types";

// Memoized per-request — safe to call from many Server Components
// without duplicating the round trip.
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return (data as Profile) ?? null;
});

export async function requireRole(locale: string, allowed: Role[]) {
  const profile = await getProfile();
  if (!profile) {
    redirect({ href: "/login", locale });
    throw new Error("unreachable");
  }
  if (!allowed.includes(profile.role)) {
    redirect({ href: "/", locale });
    throw new Error("unreachable");
  }
  return profile;
}

export function defaultRouteForRole(role: Role) {
  switch (role) {
    case "ceo":
      return "/ceo";
    case "branch_manager":
      return "/deals";
    case "accountant":
      return "/accountant";
    case "investor":
      return "/investor";
    case "sales_exec":
    default:
      return "/crm";
  }
}
