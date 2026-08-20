import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import { acceptsBranchGrants } from "@/lib/branch-authority";
import type { Branch, BranchGrant, Profile } from "@/lib/supabase/types";
import { EmployeeFormDialog } from "./employee-form";
import { EmployeeTable, type EmployeeRow } from "./employee-table";

export default async function EmployeesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // The page guard matches the action guard: everything below is
  // CEO-only, and RLS scopes every row to the CEO's own showroom.
  const me = await requireRole(locale, ["ceo"]);
  const t = await getTranslations("employees");

  const supabase = await createClient();
  // Live grants only. branch_grants_select admits the CEO to every row in
  // the showroom, so this one query covers the whole table; a revoked row
  // stays in the table (and in audit_log) but is not authority any more,
  // which is exactly what `revoked_at is null` means in the two SQL
  // predicates migration 0030 widened.
  const [{ data: profiles }, { data: branches }, { data: grants }] = await Promise.all([
    supabase.from("profiles").select("*").order("created_at"),
    supabase.from("branches").select("*").order("name"),
    supabase.from("branch_grants").select("*").is("revoked_at", null).order("created_at"),
  ]);

  // Emails live in auth.users, which PostgREST does not expose. Looked
  // up one by one through the admin API rather than listUsers(): the
  // list endpoint returns the whole project (every tenant), while
  // getUserById is only ever called with ids RLS just handed us — so
  // the service role never touches an account outside this showroom.
  const admin = createAdminClient();
  const emails = new Map<string, string>();
  await Promise.all(
    ((profiles as Profile[]) ?? []).map(async (p) => {
      try {
        const { data } = await admin.auth.admin.getUserById(p.id);
        if (data?.user?.email) emails.set(p.id, data.user.email);
      } catch {
        // A profile whose auth account is gone still renders — with a
        // dash where the email would be, not a crash.
      }
    })
  );

  const branchNames = new Map(((branches as Branch[]) ?? []).map((b) => [b.id, b.name]));

  // profile_id -> the branches granted on top of the home branch.
  const grantsByProfile = new Map<string, { id: string; name: string; note: string | null }[]>();
  for (const g of (grants as BranchGrant[]) ?? []) {
    const list = grantsByProfile.get(g.profile_id) ?? [];
    list.push({ id: g.branch_id, name: branchNames.get(g.branch_id) ?? "—", note: g.note });
    grantsByProfile.set(g.profile_id, list);
  }

  const rows: EmployeeRow[] = ((profiles as Profile[]) ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    role: p.role,
    branch_id: p.branch_id,
    branch_name: p.branch_id ? (branchNames.get(p.branch_id) ?? "—") : null,
    granted_branches: grantsByProfile.get(p.id) ?? [],
    // The two org-wide roles and the investor cannot hold grants — see
    // acceptsBranchGrants(). Deciding it here keeps the table dumb about
    // the rule and the rule in one place.
    accepts_grants: acceptsBranchGrants(p.role),
    phone: p.phone,
    email: emails.get(p.id) ?? null,
    // Statutory NOSI fields (0018) — surfaced only on this CEO-only page.
    national_id: p.national_id,
    social_insurance_number: p.social_insurance_number,
    hire_date: p.hire_date,
    monthly_wage: p.monthly_wage,
    employment_type: p.employment_type,
    created_at: p.created_at,
    is_me: p.id === me.id,
  }));

  return (
    <div className="space-y-6">
      <PanelHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={<EmployeeFormDialog branches={(branches as Branch[]) ?? []} />}
      />
      <EmployeeTable rows={rows} branches={(branches as Branch[]) ?? []} />
    </div>
  );
}
