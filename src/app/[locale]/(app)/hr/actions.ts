"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorizeHr, getProfile } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  BonusRuleActiveSchema,
  BonusRuleSchema,
  UpdatePayrollSchema,
  parseInput,
  type ActionError,
} from "@/lib/validation";
import type { SalesUnitCount } from "@/lib/supabase/types";

/**
 * The HR hub's writes.
 *
 * Every one of them opens with authorizeHr(), which answers "does this
 * session hold HR authority" for BOTH the 'hr' role and a CEO-issued
 * grant (0048). A `Role[]` passed to authorize() could not express the
 * second, and the two must never diverge — the sidebar decides what to
 * render from exactly this predicate, so an action that checked a
 * narrower one would show a form that always fails.
 *
 * That check is not the boundary. Postgres is: the payroll arm of
 * guard_profile_privilege_columns() (0047) refuses the wage columns to
 * anyone but the CEO or HR, refuses HR their OWN wage, and refuses HR a
 * CEO's row entirely. This layer exists to produce a readable error
 * before the round trip, and to stop a caller who has bypassed the UI
 * from learning anything from the difference.
 */

/**
 * Set somebody's employment record: wage, hire date, contract type and
 * the two statutory identifiers Egypt's NOSI filing needs.
 *
 * "Adding a salesman to the payroll" IS this action. There is no
 * separate enrolment table and there should not be: a profile with a
 * monthly_wage is on the payroll and one without is not, so a second
 * boolean saying the same thing would be a second answer to the same
 * question, free to disagree with the first. The register page renders
 * the two groups apart.
 */
export async function updatePayroll(input: {
  profile_id: string;
  national_id: string;
  social_insurance_number: string;
  hire_date: string;
  monthly_wage: string;
  employment_type: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorizeHr();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(UpdatePayrollSchema, input);
  if (!parsed.ok) return parsed.error;
  const p = parsed.data;

  // Refused here as well as by the trigger, purely so the message says
  // what happened. The database's version of this rule is the one that
  // counts — see 0047's header on why a payroll clerk who can set their
  // own pay is a CEO with fewer tabs.
  if (p.profile_id === auth.profile.id && auth.profile.role !== "ceo") {
    return {
      error: "You cannot change your own pay. Ask the CEO to make this change.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({
      national_id: p.national_id,
      social_insurance_number: p.social_insurance_number,
      hire_date: p.hire_date,
      monthly_wage: p.monthly_wage,
      employment_type: p.employment_type,
    })
    .eq("id", p.profile_id)
    .select("id");

  if (error) return toUserError(error);
  // Zero rows means RLS did not show the caller that profile. Reported
  // rather than swallowed: "it saved" over an update that touched
  // nothing is the failure people discover at the end of the month.
  if (!data || data.length === 0) {
    return { error: "That employee record could not be updated." };
  }

  revalidatePath("/[locale]/(app)/hr/payroll", "page");
  revalidatePath("/[locale]/(app)/employees", "page");
  return { ok: true };
}

/**
 * Add or revise a rung of the bonus ladder.
 *
 * An upsert on min_units, because a rung IS its threshold: "three cars"
 * is one rung whatever it currently pays, and letting a second row
 * claim the same threshold would make bonusFor() depend on row order.
 * uniq_bonus_rule_units enforces that in Postgres; this names the
 * conflict target so a revision is a revision rather than an error.
 */
export async function setBonusRule(input: {
  min_units: number;
  bonus_amount: number;
  active: boolean;
  note: string;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorizeHr();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(BonusRuleSchema, input);
  if (!parsed.ok) return parsed.error;
  const r = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.from("bonus_rules").upsert(
    {
      min_units: r.min_units,
      bonus_amount: r.bonus_amount,
      active: r.active,
      note: r.note,
      updated_at: new Date().toISOString(),
      // Stamped from the authenticated session rather than pinned by a
      // policy predicate. 0046's header explains the ban: `updated_by =
      // auth.uid()` inside a WITH CHECK is evaluated as the tenant role,
      // which has no USAGE on schema auth, and raises 42501.
      updated_by: auth.profile.id,
    },
    { onConflict: "min_units" }
  );

  if (error) return toUserError(error);
  revalidatePath("/[locale]/(app)/hr/bonuses", "page");
  return { ok: true };
}

/**
 * Retire or restore a rung.
 *
 * Not a delete: the tenant role holds no DELETE grant on this table
 * (assertion (j) would refuse to provision a showroom where it did), and
 * a scheme revised in June still has to explain what May paid.
 */
export async function setBonusRuleActive(input: {
  id: string;
  active: boolean;
}): Promise<{ ok: true } | ActionError> {
  const auth = await authorizeHr();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(BonusRuleActiveSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bonus_rules")
    .update({
      active: parsed.data.active,
      updated_at: new Date().toISOString(),
      updated_by: auth.profile.id,
    })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return toUserError(error);
  if (!data || data.length === 0) return { error: "That bonus rung could not be updated." };

  revalidatePath("/[locale]/(app)/hr/bonuses", "page");
  return { ok: true };
}

/**
 * How many cars each salesperson executed in a window.
 *
 * A thin wrapper over migration 0049's monthly_sales_units(), which is
 * SECURITY DEFINER and gates ITSELF by role — CEO/HR/accountant see the
 * showroom, a branch manager sees their branches, everybody else sees
 * their own single row. That is why this function does NOT call
 * authorizeHr(): a salesperson is meant to be able to ask, and the RPC
 * will hand them exactly one row.
 *
 * The RPC returns a profile id and an integer and nothing else. HR is
 * outside is_staff() precisely so that price, discount and cost stay
 * invisible to payroll, and a plain query against deal_tickets would
 * have returned them nothing at all.
 */
export async function salesUnitsBetween(
  fromIso: string,
  toIso: string
): Promise<{ ok: true; units: SalesUnitCount[] } | ActionError> {
  if (!(await getProfile())) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("monthly_sales_units", {
    p_from: fromIso,
    p_to: toIso,
  });

  if (error) return toUserError(error);
  return {
    ok: true,
    units: ((data as { profile_id: string; units: number }[] | null) ?? []).map((r) => ({
      profile_id: r.profile_id,
      units: Number(r.units),
    })),
  };
}
