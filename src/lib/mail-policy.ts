import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * May this showroom send mail OUT of FELIX?
 *
 * The switch lives in `public.tenant_mail_policy` in the shared "Agentic"
 * Supabase project, where the 508.world partners portal owns it (Mail
 * Policy tab) — see 508.world/supabase/migrations/
 * 20260822000000_tenant_mail_policy.sql. It is read here, per send, and
 * it governs ONLY mail addressed outside the tenant. Internal
 * FELIX-to-FELIX mail is delivered in the database and is never gated by
 * it: turning a showroom off stops it mailing the world, not its own
 * staff.
 *
 * WHY SERVICE-ROLE
 * `public` is not the caller's schema — every FELIX session is pinned to
 * its own t_<slug> (see supabase/server.ts) — and no tenant role is
 * granted anything in `public` besides. This is also policy about the
 * tenant rather than data belonging to it, which no FELIX user should be
 * able to read, write, or notice the shape of.
 *
 * FAILS OPEN, matching the table's own contract and demo_status before
 * it: a missing table, a missing row, or a read that errors all resolve
 * to "allowed", which is the behaviour FELIX has today. That is what lets
 * the migration land on the live project at any time, in any order
 * relative to this deploy, without being the thing that silently stops a
 * showroom's mail. Only an explicit external_mail_enabled = false blocks.
 * The trade is deliberate: an unreachable registry must not become an
 * outage, and the switch is a policy control, not a security boundary —
 * the boundary that does have to hold is cross-tenant addressing, which
 * is enforced separately and unconditionally in sendMail.
 */
export interface ExternalMailPolicy {
  allowed: boolean;
  /** Admin-written explanation to show instead of the generic refusal. */
  message: string | null;
}

const ALLOWED: ExternalMailPolicy = { allowed: true, message: null };

export async function externalMailPolicy(tenantSlug: string): Promise<ExternalMailPolicy> {
  try {
    // No schema argument: `public` is the default, and it is where the
    // portal's shared registry lives.
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("tenant_mail_policy")
      .select("external_mail_enabled, disabled_message")
      .eq("tenant_slug", tenantSlug)
      .maybeSingle();

    // Includes "relation does not exist" — the migration has not been
    // applied yet. Logged rather than swallowed silently, because a
    // policy read that keeps failing is worth noticing even though it
    // does not block anything.
    if (error) {
      console.error("[mail] external mail policy read failed", { tenantSlug, error });
      return ALLOWED;
    }
    if (!data) return ALLOWED;

    const row = data as { external_mail_enabled: boolean; disabled_message: string | null };
    return {
      allowed: row.external_mail_enabled,
      message: row.disabled_message?.trim() || null,
    };
  } catch (err) {
    console.error("[mail] external mail policy unreachable", { tenantSlug, err });
    return ALLOWED;
  }
}
