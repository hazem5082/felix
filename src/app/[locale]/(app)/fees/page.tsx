import { getTranslations } from "next-intl/server";
import { requireRole } from "@/lib/auth";
import { PanelHeader, Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/server";
import type { Branch } from "@/lib/supabase/types";
import { fetchOverheadOverview } from "./actions";
import { FeesConsole } from "./fees-console";

/**
 * THE SHOWROOM FEE CONSOLE (migration 0050).
 *
 * What it costs to keep the doors open, what share of that each car in
 * stock is carrying, and the two levers over it: the branch policy and
 * the month-by-month calendar.
 *
 * WHO OPENS IT. The CEO, the accountant and a branch manager — the same
 * three overhead_overview() admits, which mirrors overhead_config_select.
 * A branch manager whose stock is being charged a fee should be able to
 * read what the fee is and where it came from. WRITING is the CEO's
 * alone, enforced in the actions and again in RLS; `canEdit` below only
 * decides whether the controls render.
 *
 * The sidebar carries this for the CEO only. That is a default, not a
 * boundary: 0048's feature grants can widen a sidebar and this page
 * re-checks the role either way.
 */
export default async function FeesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const me = await requireRole(locale, ["ceo", "accountant", "branch_manager"]);
  const t = await getTranslations("fees");

  const supabase = await createClient();
  const [overview, { data: branches }] = await Promise.all([
    fetchOverheadOverview(12),
    supabase.from("branches").select("*").order("name"),
  ]);

  // Null means the RPC is not there yet — the migration has not been
  // applied to this showroom's schema. Say so plainly rather than
  // rendering an empty console that looks like a showroom with no
  // branches.
  if (!overview) {
    return (
      <div className="space-y-6">
        <PanelHeader title={t("title")} subtitle={t("subtitle")} />
        <Panel>
          <p className="text-sm text-[var(--color-text-muted)]">{t("unavailable")}</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />
      <FeesConsole
        overview={overview}
        branches={(branches as Branch[]) ?? []}
        canEdit={me.role === "ceo"}
      />
    </div>
  );
}
