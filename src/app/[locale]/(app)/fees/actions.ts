"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, FINANCE_ROLES } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  ClearOverheadMonthSchema,
  OverheadMonthSchema,
  OverheadPolicySchema,
  ShowroomExpenseSchema,
  VoidShowroomExpenseSchema,
  parseInput,
} from "@/lib/validation";
import type { OverheadOverview, ShowroomExpense } from "@/lib/supabase/types";

// Migration 0047. Every export here is a public HTTP endpoint: the props
// that hide a control in the UI do nothing for a hand-crafted POST, so
// each action re-checks the role before it writes — and the RLS behind
// it re-checks again, which is the layer that actually holds.
//
// TWO DIFFERENT AUTHORITIES, deliberately, and they match the policies:
//   * recording a bill is the ACCOUNTANT's job (is_accountant_or_above);
//   * changing what a month COSTS is the CEO's, because those rows change
//     what every equity holder in the branch is paid.
//
// No assertBranch anywhere. overhead_config, overhead_months and
// showroom_expenses are all group-level books with no branch predicate in
// their policies — the same shape as the consignment payout desk — and a
// branch filter here would only disagree with the database.

const CEO_ONLY = ["ceo"] as const;

function revalidateFees() {
  revalidatePath("/[locale]/(app)/fees", "page");
  revalidatePath("/[locale]/(app)/accountant", "page");
  // The fee comes off the profit before the cap table divides it, so
  // changing one moves what these three screens report.
  revalidatePath("/[locale]/(app)/ceo", "page");
  revalidatePath("/[locale]/(app)/investor", "page");
  revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");
}

/**
 * The whole fee picture, in one round trip.
 *
 * An RPC rather than four PostgREST reads plus a TypeScript
 * reimplementation of the resolution order: that order is the product
 * rule, and a second copy of it in the browser is a second copy that
 * will eventually disagree with the money.
 *
 * Returns null rather than throwing when the migration has not been
 * applied yet — the page renders its empty state instead of a 500.
 */
export async function fetchOverheadOverview(months = 12): Promise<OverheadOverview | null> {
  const auth = await authorize(["ceo", "accountant", "branch_manager"]);
  if (!auth.ok) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("overhead_overview", {
    p_months: Number.isFinite(months) ? Math.trunc(months) : 12,
  });
  if (error) return null;
  return data as OverheadOverview;
}

/** The bills behind the rate, newest month first. */
export async function fetchShowroomExpenses(limit = 200): Promise<ShowroomExpense[]> {
  const auth = await authorize(["ceo", "accountant", "branch_manager"]);
  if (!auth.ok) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("showroom_expenses")
    .select("*, branches(id, name)")
    .order("period_month", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(Math.trunc(limit) || 200, 1), 500));

  if (error) return [];
  return (data as ShowroomExpense[]) ?? [];
}

/**
 * Record a bill. Accountant or CEO — showroom_expenses_insert is
 * is_accountant_or_above() and this mirrors it exactly.
 */
export async function createShowroomExpense(input: {
  branch_id: string;
  period_month: string;
  category: string;
  amount: number;
  note: string | null;
}) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(ShowroomExpenseSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("showroom_expenses").insert({
    branch_id: parsed.data.branch_id,
    period_month: parsed.data.period_month,
    category: parsed.data.category,
    amount: parsed.data.amount,
    note: parsed.data.note,
    // Set here rather than in a policy: a policy runs as the tenant
    // role, which has no USAGE on schema auth, so `created_by =
    // auth.uid()` in a WITH CHECK raises 42501 and breaks the write
    // outright (0045's lesson, restated by 0046).
    created_by: auth.profile.id,
  });
  if (error) return toUserError(error);

  revalidateFees();
  return { ok: true };
}

/**
 * Void a bill keyed against the wrong month or the wrong branch.
 *
 * Not a delete: the tenant role holds no DELETE privilege on any table
 * (create_tenant_schema asserts that before it will provision a
 * showroom), and a fee an investor was charged should stay auditable
 * even once it is withdrawn. A voided row is excluded from every average
 * and still visible in the book.
 */
export async function voidShowroomExpense(expenseId: string) {
  const auth = await authorize(FINANCE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(VoidShowroomExpenseSchema, { expense_id: expenseId });
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("showroom_expenses")
    .update({ voided_at: new Date().toISOString(), voided_by: auth.profile.id })
    .eq("id", parsed.data.expense_id)
    // Re-voiding would rewrite the date and the attribution on a bill
    // that was already withdrawn.
    .is("voided_at", null)
    .select("id")
    .maybeSingle();

  if (error) return toUserError(error);
  if (!data) return { error: "That expense is not available, or has already been voided." };

  revalidateFees();
  return { ok: true };
}

/**
 * The branch-level fee policy: the switch, where the rate comes from,
 * and how far back the average looks.
 *
 * CEO only, matching overhead_config_write. This changes what every
 * unsold car in the branch will be charged when it sells — but NOT what
 * an already-settled sale was charged, which is the freeze migration
 * 0047 exists to install.
 */
export async function setOverheadPolicy(input: {
  branch_id: string;
  fees_enabled: boolean;
  basis: "manual" | "average";
  monthly_opex_amount: number;
  average_window_months: number;
}) {
  const auth = await authorize([...CEO_ONLY]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(OverheadPolicySchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("overhead_config").upsert({
    branch_id: parsed.data.branch_id,
    fees_enabled: parsed.data.fees_enabled,
    basis: parsed.data.basis,
    monthly_opex_amount: parsed.data.monthly_opex_amount,
    average_window_months: parsed.data.average_window_months,
    updated_at: new Date().toISOString(),
    updated_by: auth.profile.id,
  });
  if (error) return toUserError(error);

  revalidateFees();
  return { ok: true };
}

/**
 * What ONE month costs in ONE branch — the CEO's calendar.
 *
 * The rate is stored even when `enabled` is false, so switching the
 * month back on restores the figure that was last typed rather than a
 * zero. Rows here are the exception; most months have none.
 */
export async function setOverheadMonth(input: {
  branch_id: string;
  period_month: string;
  rate_amount: number;
  enabled: boolean;
  note: string | null;
}) {
  const auth = await authorize([...CEO_ONLY]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(OverheadMonthSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("overhead_months").upsert(
    {
      branch_id: parsed.data.branch_id,
      period_month: parsed.data.period_month,
      rate_amount: parsed.data.rate_amount,
      enabled: parsed.data.enabled,
      note: parsed.data.note,
      updated_at: new Date().toISOString(),
      updated_by: auth.profile.id,
    },
    { onConflict: "branch_id,period_month" }
  );
  if (error) return toUserError(error);

  revalidateFees();
  return { ok: true };
}

/**
 * Drop a month override so the month falls back to the branch policy.
 *
 * The only place in this feature that deletes a row, and it is allowed
 * to: overhead_months carries no history worth keeping — it is a
 * setting, not a record of anything that happened — and clearing it is
 * how a CEO says "treat this month like any other".
 *
 * It still goes through PostgREST under overhead_months' own policies,
 * so it is refused for anyone but a CEO regardless of this check. If the
 * tenant role turns out to hold no DELETE (create_tenant_schema grants
 * none by design), the error surfaces here rather than silently doing
 * nothing — and disabling the month is the documented fallback.
 */
export async function clearOverheadMonth(input: { branch_id: string; period_month: string }) {
  const auth = await authorize([...CEO_ONLY]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(ClearOverheadMonthSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase
    .from("overhead_months")
    .delete()
    .eq("branch_id", parsed.data.branch_id)
    .eq("period_month", parsed.data.period_month);
  if (error) return toUserError(error);

  revalidateFees();
  return { ok: true };
}
