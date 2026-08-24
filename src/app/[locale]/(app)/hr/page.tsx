import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { BadgePercent, Banknote, CalendarCheck, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireHr } from "@/lib/auth";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { formatMoney } from "@/lib/currency";
import { sortLadder } from "@/lib/bonus";
import type { BonusRule, Profile } from "@/lib/supabase/types";

/**
 * The HR hub's landing page.
 *
 * Deliberately thin: three cards, each a door, each carrying the one
 * number that tells HR whether it needs opening today. Everything real
 * happens on the pages below it, and a hub that tried to be a dashboard
 * would duplicate all three and drift from them.
 *
 * requireHr() rather than requireRole(): since 0048 the CEO can hand
 * this hub to somebody whose role is 'accountant', and a role list
 * cannot say that. The guard is the same predicate the sidebar used to
 * decide whether to render the tab, so the two can never disagree.
 */
export default async function HrHubPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requireHr(locale);
  const t = await getTranslations("hr");

  const supabase = await createClient();
  const [{ data: profileRows }, { data: ruleRows }] = await Promise.all([
    // profiles_select gained an is_hr() arm in 0047, so this is the
    // whole showroom rather than one branch. No filter here for the
    // reason the attendance page gives: restating a policy in a second
    // place is how the two drift.
    supabase.from("profiles").select("id, role, monthly_wage").neq("role", "investor"),
    supabase.from("bonus_rules").select("*"),
  ]);

  // `error` ignored on purpose throughout: a deployment where 0047–0049
  // have not landed yet must render an empty hub rather than a 500 —
  // supabase-js returns { data: null, error } for a missing table.
  const people = (profileRows as Pick<Profile, "id" | "role" | "monthly_wage">[] | null) ?? [];
  const rules = sortLadder((ruleRows as BonusRule[] | null) ?? []);

  // "On the payroll" is exactly "has a wage recorded" — there is no
  // second enrolment flag, and hr/actions.ts explains why there must not
  // be one.
  const onPayroll = people.filter((p) => p.monthly_wage != null).length;
  const missing = people.length - onPayroll;
  const activeRungs = rules.filter((r) => r.active);
  const topRung = activeRungs.length > 0 ? activeRungs[activeRungs.length - 1] : null;

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-4 md:grid-cols-3">
        <HubCard
          href="/hr/payroll"
          icon={<Banknote size={18} />}
          title={t("payrollTitle")}
          body={t("payrollBody")}
          stat={t("onPayrollCount", { on: onPayroll, total: people.length })}
          // The only alarming number on the page, and only when it is
          // non-zero: somebody employed with no wage on file is a
          // missing NOSI line, not a styling opportunity.
          warn={missing > 0 ? t("missingWage", { count: missing }) : null}
        />
        <HubCard
          href="/hr/bonuses"
          icon={<BadgePercent size={18} />}
          title={t("bonusesTitle")}
          body={t("bonusesBody")}
          stat={
            activeRungs.length === 0
              ? t("noLadder")
              : t("ladderRungs", { count: activeRungs.length })
          }
          warn={null}
          footnote={
            topRung
              ? t("topRung", {
                  units: topRung.min_units,
                  amount: formatMoney(topRung.bonus_amount, locale),
                })
              : null
          }
        />
        <HubCard
          href="/attendance"
          icon={<CalendarCheck size={18} />}
          title={t("attendanceTitle")}
          body={t("attendanceBody")}
          stat={t("headcount", { count: people.length })}
          warn={null}
        />
      </div>
    </div>
  );
}

function HubCard({
  href,
  icon,
  title,
  body,
  stat,
  warn,
  footnote,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  stat: string;
  warn: string | null;
  footnote?: string | null;
}) {
  return (
    <Link href={href} className="group block">
      <Panel className="h-full transition-colors group-hover:border-[var(--color-accent)]/40">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-[var(--color-accent)]">
            {icon}
            <h3 className="text-sm font-medium tracking-wide text-[var(--color-text)]">
              {title}
            </h3>
          </div>
          <ChevronRight
            size={16}
            className="mt-0.5 shrink-0 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100"
          />
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{body}</p>
        <p className="mt-4 text-lg font-semibold tabular-nums">{stat}</p>
        {footnote && (
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{footnote}</p>
        )}
        {warn && (
          <p className="mt-2 text-xs font-medium text-[var(--color-accent-red)]">{warn}</p>
        )}
      </Panel>
    </Link>
  );
}
