"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "@/i18n/navigation";
import { defaultRouteForRole } from "@/lib/auth";
import type { Role } from "@/lib/supabase/types";

export type LoginState = { error?: string } | undefined;

export async function login(
  locale: string,
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") || "");
  const password = String(formData.get("password") || "");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return { error: "invalid" };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .single();

  const role = (profile?.role as Role) || "sales_exec";
  redirect({ href: defaultRouteForRole(role), locale });
}

export async function logout(locale: string) {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect({ href: "/login", locale });
}
