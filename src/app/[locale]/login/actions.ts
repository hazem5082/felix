"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "@/i18n/navigation";
import { defaultRouteForRole } from "@/lib/auth";
import { clientIp, consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import type { Role } from "@/lib/supabase/types";

export type LoginState = { error?: string; message?: string } | undefined;

export async function login(
  locale: string,
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) return { error: "invalid" };

  // A Server Action is reachable by direct POST regardless of the rendered
  // form, so the throttle has to live here rather than in the UI. Two
  // buckets: per-IP stops one host grinding through accounts, per-email
  // stops a distributed attack concentrating on one account (the CEO login
  // satisfies every is_ceo() branch in the RLS policy set).
  const ip = await clientIp();
  const [byIp, byEmail] = await Promise.all([
    consume(`login:ip:${ip}`, LIMITS.login),
    consume(`login:email:${email}`, LIMITS.loginByEmail),
  ]);

  if (!byIp.allowed || !byEmail.allowed) {
    const retryAfter = Math.max(byIp.retryAfter, byEmail.retryAfter);
    return { error: "throttled", message: retryMessage(retryAfter) };
  }

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
  // redirect() throws NEXT_REDIRECT — it must stay outside any try/catch.
  redirect({ href: defaultRouteForRole(role), locale });
}

export async function logout(locale: string) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect({ href: "/login", locale });
}
