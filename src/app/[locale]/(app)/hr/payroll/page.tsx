import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireHr } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import type { Branch, Profile } from "@/lib/supabase/types";
import { PayrollRegister, type PayrollRow } from "./payroll-register";

/**
 * The payroll register: every employee, what they are paid, and whether
 * their statutory paperwork is complete.
 *
 * WHO IS ON IT. Everyone with a profile except investors, who are
 * outside capital rather than employed — the same exclusion the
 * attendance board makes, for the same reason. The list is org-wide
 * because profiles_select gained an is_hr() arm in 0047; there is no
 * branch filter here on purpose, since restating a policy in the query
 * is how the query and the policy drift.
 *
 * "ADDING A SALESMAN TO THE PAYROLL" is setting their monthly wage.
 * There is no enrolment flag and there must not be one — see
 * hr/actions.ts. The register renders the two groups apart so the
 * distinction is visible without inventing a column for it.
 */
export default async function PayrollPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const me = await requireHr(locale);
  const t = await getTranslations("hr");

  const supabase = await createClient();
  const [{ data: profileRows }, { data: branchRows }] = await Promise.all([
    supabase.from("profiles").select("*").neq("role", "investor").order("full_name"),
    supabase.from("branches").select("id, name").order("name"),
  ]);

  const branchNames = new Map(
    ((branchRows as Pick<Branch, "id" | "name">[] | null) ?? []).map((b) => [b.id, b.name])
  );

  const rows: PayrollRow[] = ((profileRows as Profile[] | null) ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    role: p.role,
    branch_name: p.branch_id ? (branchNames.get(p.branch_id) ?? "—") : null,
    national_id: p.national_id,
    social_insurance_number: p.social_insurance_number,
    hire_date: p.hire_date,
    monthly_wage: p.monthly_wage,
    employment_type: p.employment_type,
    // The row HR may not edit, and the reason is in 0047's header: a
    // payroll clerk who can set their own pay is a CEO with fewer tabs.
    // The CEO is exempt because the CEO is the person the separation
    // protects against, and has to be able to pay HR.
    is_self: p.id === me.id,
    // HR cannot touch a CEO's row at all (the CEO-row arm of the
    // privilege guard). Rendered as read-only rather than hidden — a
    // missing row in a payroll register reads as a bug.
    is_ceo_row: p.role === "ceo",
  }));

  const viewerIsCeo = me.role === "ceo";

  return (
    <div className="space-y-6">
      <PanelHeader title={t("payrollTitle")} subtitle={t("payrollSubtitle")} />
      <PayrollRegister rows={rows} viewerIsCeo={viewerIsCeo} />
    </div>
  );
}
