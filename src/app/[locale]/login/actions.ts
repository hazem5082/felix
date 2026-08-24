"use server";

import { createClient, createClientForSchema } from "@/lib/supabase/server";
import { redirect } from "@/i18n/navigation";
import { defaultRouteForRole } from "@/lib/auth";
import { clientIp, consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import { getTenant } from "@/lib/tenant";
import { getDemoStatus, isFlagshipDemo } from "@/lib/demo";
import { tenantClaimFromToken } from "@/lib/tenant-claim";
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
  // failClosed: see rate-limit.ts — an outage must not disable the only
  // defence between a botnet and the CEO's password.
  const [byIp, byEmail] = await Promise.all([
    consume(`login:ip:${ip}`, { ...LIMITS.login, failClosed: true }),
    consume(`login:email:${email}`, { ...LIMITS.loginByEmail, failClosed: true }),
  ]);

  if (!byIp.allowed || !byEmail.allowed) {
    const retryAfter = Math.max(byIp.retryAfter, byEmail.retryAfter);
    return { error: "throttled", message: await retryMessage(retryAfter) };
  }

  // The flagship demo's kill switch. The login page already replaces this
  // form with a notice when the demo is off, but a Server Action is a
  // public HTTP endpoint — the form's absence stops nobody from POSTing
  // to it, and "the demo is off" has to mean no new sessions rather than
  // no visible button.
  //
  // Refused before the credential check so a switched-off demo does not
  // quietly stay a working password oracle. Licensed showrooms never
  // reach getDemoStatus() at all.
  const tenant = await getTenant();
  if (isFlagshipDemo(tenant) && !(await getDemoStatus()).enabled) {
    return { error: "demoOff" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return { error: "invalid" };
  }

  // This account belongs to one showroom, and this hostname belongs to
  // one showroom. If they disagree, end the session here.
  //
  // The account's showroom comes from the token that was just issued —
  // migration 0010's hook derives it from platform.tenant_users. It used
  // to come from profiles.tenant_id, which 0011 removed; the schema a
  // profile row lives in is now the fact that column used to record.
  //
  // A token with no claim at all means the access token hook is not
  // registered in Supabase. Treated as "wrong showroom" rather than
  // waved through: without the claim the session has no tenant role and
  // would see an empty app anyway, and guessing from the hostname is
  // exactly the trust the schema split exists to remove.
  const claim = tenantClaimFromToken(data.session?.access_token);

  if (!tenant || !claim || claim.slug !== tenant.slug || claim.schema !== tenant.schema_name) {
    await supabase.auth.signOut();
    return { error: "wrongTenant" };
  }

  if (tenant.status === "suspended") {
    await supabase.auth.signOut();
    return { error: "tenantSuspended" };
  }

  // Read through a client pinned to the claim's schema. `supabase` above
  // was built before the session existed, so it carries no schema and is
  // memoized — querying profiles with it would hit `public`.
  const scoped = await createClientForSchema(claim.schema);
  const { data: profile } = await scoped
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  const role = ((profile as { role?: Role } | null)?.role as Role) || "sales_exec";
  // redirect() throws NEXT_REDIRECT — it must stay outside any try/catch.
  redirect({ href: defaultRouteForRole(role), locale });
}

export async function logout(locale: string) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect({ href: "/login", locale });
}
