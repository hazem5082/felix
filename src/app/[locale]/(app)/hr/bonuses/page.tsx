import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireHr } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import { sortLadder } from "@/lib/bonus";
import type { BonusRule, Profile } from "@/lib/supabase/types";
import { BonusLadder } from "./bonus-ladder";

/**
 * The bonus ladder, and who is on which rung this month.
 *
 * THE MONTH IS THE SERVER'S, and that is a compromise worth naming.
 * Every other window in FELIX (the report suite, the attendance day) is
 * computed against a `tz` offset the browser supplies, because a punch
 * at 01:30 Cairo time must not file under yesterday. A bonus month is a
 * far blunter instrument — a deal executed within an hour of midnight on
 * the 1st is the only case where the two answers differ, and the
 * showroom's own accounting will already have decided which month that
 * deal belongs to. Adding an offset here would imply a precision the
 * scheme does not have.
 *
 * UNIT COUNTS COME FROM monthly_sales_units() (0049), never from a
 * query. HR sits outside is_staff() so deal_tickets_select shows them
 * nothing; the RPC is SECURITY DEFINER and returns a profile id and an
 * integer, no price and no vehicle. See the migration header.
 */
export default async function BonusesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requireHr(locale);
  const t = await getTranslations("hr");

  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const supabase = await createClient();
  const [{ data: ruleRows }, { data: profileRows }, { data: unitRows }] = await Promise.all([
    supabase.from("bonus_rules").select("*"),
    // The ladder is a SALES incentive, so the roster starts with the
    // people whose job is to execute tickets — sales and the branch
    // managers who also close. Anyone else who actually sold a car this
    // month is added below rather than filtered out: a scheme that pays
    // per car must not silently omit somebody because their job title
    // was not on a list.
    supabase
      .from("profiles")
      .select("id, full_name, role, branch_id")
      .neq("role", "investor")
      .order("full_name"),
    supabase.rpc("monthly_sales_units", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    }),
  ]);

  // `error` ignored on purpose: a deployment where 0049 has not landed
  // renders an empty ladder rather than a 500.
  const rules = sortLadder((ruleRows as BonusRule[] | null) ?? []);
  const people = (profileRows as Pick<Profile, "id" | "full_name" | "role" | "branch_id">[] | null) ?? [];
  const counts = new Map(
    ((unitRows as { profile_id: string; units: number }[] | null) ?? []).map((r) => [
      r.profile_id,
      Number(r.units),
    ])
  );

  const monthLabel = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(from);

  const SELLING_ROLES = ["sales_exec", "branch_manager"];
  const roster = people
    .filter((p) => SELLING_ROLES.includes(p.role) || (counts.get(p.id) ?? 0) > 0)
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      units: counts.get(p.id) ?? 0,
    }));

  return (
    <div className="space-y-6">
      <PanelHeader title={t("bonusesTitle")} subtitle={t("bonusesSubtitle")} />
      <BonusLadder rules={rules} monthLabel={monthLabel} roster={roster} />
    </div>
  );
}
