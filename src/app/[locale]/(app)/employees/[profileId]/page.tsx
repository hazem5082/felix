import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProfile, defaultRouteForRole } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
import { birthFromNationalId } from "@/lib/national-id";
import { formatMoney } from "@/lib/currency";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import type {
  Branch,
  EmployeeTarget,
  Profile,
  Role,
  TargetMetric,
} from "@/lib/supabase/types";
import { TargetsPanel } from "./targets-panel";
import { AvatarUploader } from "./avatar-uploader";
import { TabsPanel } from "./tabs-panel";
import { navFor } from "@/components/layout/nav-config";
import { resolveFeatures } from "@/lib/features";
import type { FeatureGrant, FeatureKey } from "@/lib/supabase/types";

const ROLE_TONE: Record<Role, SemanticTone> = {
  ceo: "blue",
  branch_manager: "green",
  accountant: "amber",
  sales_exec: "neutral",
  // 0047. Amber like the accountant: both are staff functions that
  // report to the CEO and manage nobody.
  hr: "amber",
  marketing: "blue",
  investor: "red",
};

const METRICS: TargetMetric[] = ["calls", "new_leads", "deals_closed"];

/** YYYY-MM-01 for the month `offset` months before the current one. */
function monthStart(offset: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  return d.toISOString().slice(0, 10);
}

function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

export default async function EmployeeProfilePage({
  params,
}: {
  params: Promise<{ locale: string; profileId: string }>;
}) {
  const { locale, profileId } = await params;
  const me = await requireProfile(locale);

  // Managers and the CEO review their people; everyone else may open
  // exactly one profile — their own. RLS enforces the same boundary on
  // every query below (profiles_select confines a manager to their own
  // branch), so this guard exists for the readable redirect, not the
  // security.
  const canReview = me.role === "ceo" || me.role === "branch_manager";
  if (!canReview && me.id !== profileId) {
    redirect({ href: defaultRouteForRole(me.role), locale });
  }

  const t = await getTranslations("employees");
  const roles = await getTranslations("roles");
  const supabase = await createClient();

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle();
  const profile = profileRow as Profile | null;

  // Out-of-branch, out-of-tenant and mistyped ids all land here as zero
  // rows — RLS makes them indistinguishable on purpose.
  if (!profile) {
    redirect({ href: me.role === "ceo" ? "/employees" : defaultRouteForRole(me.role), locale });
    throw new Error("unreachable");
  }

  const since = monthStart(5); // this month + 5 back
  const thisMonth = monthStart(0);

  const [
    { data: branchRow },
    { data: targetRows },
    { data: callRows },
    { data: leadRows },
    { data: dealRows },
  ] = await Promise.all([
    profile.branch_id
      ? supabase.from("branches").select("*").eq("id", profile.branch_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("employee_targets")
      .select("*")
      .eq("profile_id", profileId)
      .gte("period_month", since),
    supabase
      .from("lead_comments")
      .select("created_at")
      .eq("author_id", profileId)
      .gte("created_at", since),
    supabase
      .from("leads")
      .select("created_at")
      .eq("salesperson_id", profileId)
      .gte("created_at", since),
    supabase
      .from("deal_tickets")
      .select("created_at, executed_at, status, agreed_price")
      .eq("salesperson_id", profileId)
      .or(`created_at.gte.${since},executed_at.gte.${since}`),
  ]);

  // 0048. This person's live navigation grants, for the CEO-only panel
  // at the bottom of the page. feature_grants_select admits the CEO to
  // every row and everyone else to their own, so a manager viewing one
  // of their staff gets an empty list — which is correct, since the
  // panel is not rendered for them either.
  const { data: featureRows } = await supabase
    .from("feature_grants")
    .select("*")
    .eq("profile_id", profileId)
    .is("revoked_at", null);
  const features = resolveFeatures((featureRows as FeatureGrant[] | null) ?? []);

  // Email lives in auth.users; looked up only after RLS proved the
  // profile visible — same pattern as the employees list.
  let email: string | null = null;
  try {
    const { data } = await createAdminClient().auth.admin.getUserById(profileId);
    email = data?.user?.email ?? null;
  } catch {
    // A profile whose auth account is gone still renders.
  }

  // ── Bucket activity per month ─────────────────────────────
  const months: string[] = Array.from({ length: 6 }, (_, i) => monthKeyOf(monthStart(5 - i)));
  const zero = () => Object.fromEntries(months.map((m) => [m, 0])) as Record<string, number>;
  const calls = zero();
  const newLeads = zero();
  const dealsClosed = zero();
  const revenue = zero();

  for (const r of callRows ?? []) {
    const k = monthKeyOf(String(r.created_at));
    if (k in calls) calls[k] += 1;
  }
  for (const r of leadRows ?? []) {
    const k = monthKeyOf(String(r.created_at));
    if (k in newLeads) newLeads[k] += 1;
  }
  for (const r of dealRows ?? []) {
    if (r.status !== "executed" || !r.executed_at) continue;
    const k = monthKeyOf(String(r.executed_at));
    if (k in dealsClosed) {
      dealsClosed[k] += 1;
      revenue[k] += Number(r.agreed_price) || 0;
    }
  }

  const nowKey = monthKeyOf(thisMonth);
  const actualsNow: Record<TargetMetric, number> = {
    calls: calls[nowKey],
    new_leads: newLeads[nowKey],
    deals_closed: dealsClosed[nowKey],
  };

  const targets = (targetRows ?? []) as EmployeeTarget[];
  const targetsNow: Partial<Record<TargetMetric, number>> = {};
  for (const row of targets) {
    if (monthKeyOf(row.period_month) === nowKey) targetsNow[row.metric] = row.target_value;
  }
  const targetFor = (metric: TargetMetric, mk: string): number | null =>
    targets.find((row) => row.metric === metric && monthKeyOf(row.period_month) === mk)
      ?.target_value ?? null;

  // ── Identity facts ────────────────────────────────────────
  const birth = birthFromNationalId(profile.national_id);
  const displayLocale = locale === "ar" ? "ar-EG" : locale;
  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(displayLocale, { dateStyle: "medium" }).format(new Date(iso));
  const fmtMonth = (mk: string) =>
    new Intl.DateTimeFormat(displayLocale, { month: "short", year: "numeric" }).format(
      new Date(`${mk}-01T00:00:00Z`)
    );

  const canEditTargets = canReview;
  const canEditPhoto = me.id === profile.id || me.role === "ceo";
  // Wage and insurance number are payroll facts; the manager needs the
  // performance half of this page, not the payroll half.
  const showPayroll = me.role === "ceo" || me.id === profile.id;

  const branch = branchRow as Branch | null;
  const initials = profile.full_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

  const metricLabel: Record<TargetMetric, string> = {
    calls: t("metricCalls"),
    new_leads: t("metricNewLeads"),
    deals_closed: t("metricDealsClosed"),
  };

  // The tabs this person's ROLE carries, before any grant or hide — the
  // set the "hidden tabs" control is allowed to address. Derived from
  // navFor() with NO features so it reflects the role default rather
  // than the current, already-edited answer; otherwise hiding a tab
  // would remove it from the list of tabs you can un-hide.
  const roleDefaultKeys = navFor(profile.role).map((e) => e.key) as FeatureKey[];

  return (
    <div className="space-y-6">
      {/* ── Header: photo + identity ─────────────────────── */}
      <Panel>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center gap-2">
            {profile.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.avatar_url}
                alt={profile.full_name}
                className="h-24 w-24 rounded-full border border-[var(--color-border)] object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-2xl font-bold text-[var(--color-text-muted)]">
                {initials || "?"}
              </div>
            )}
            {canEditPhoto && (
              <AvatarUploader profileId={profile.id} hasPhoto={!!profile.avatar_url} />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-[var(--color-text)]">
                {profile.full_name}
              </h2>
              <StatusPill label={roles(profile.role)} tone={ROLE_TONE[profile.role]} />
              {me.id === profile.id && (
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                  {t("you")}
                </span>
              )}
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <ProfileFact label={t("branch")} value={branch?.name ?? "—"} />
              <ProfileFact label={t("phone")} value={profile.phone ?? "—"} ltr />
              <ProfileFact label={t("email")} value={email ?? "—"} ltr />
              <ProfileFact label={t("nationalId")} value={profile.national_id ?? "—"} ltr />
              <ProfileFact
                label={t("age")}
                value={
                  birth
                    ? t("ageYears", { age: birth.age })
                    : profile.national_id
                      ? t("ageUnreadable")
                      : "—"
                }
                hint={birth ? fmtDate(birth.birthDate) : undefined}
              />
              <ProfileFact
                label={t("hireDate")}
                value={profile.hire_date ? fmtDate(profile.hire_date) : "—"}
              />
              <ProfileFact
                label={t("employmentType")}
                value={
                  profile.employment_type
                    ? t(profile.employment_type === "full_time" ? "fullTime" : "partTime")
                    : "—"
                }
              />
              {showPayroll && (
                <>
                  <ProfileFact
                    label={t("monthlyWage")}
                    value={
                      profile.monthly_wage != null
                        ? formatMoney(profile.monthly_wage, locale)
                        : "—"
                    }
                  />
                  <ProfileFact
                    label={t("insuranceNumber")}
                    value={profile.social_insurance_number ?? "—"}
                    ltr
                  />
                </>
              )}
            </dl>
          </div>
        </div>
      </Panel>

      {/* ── This month vs target ─────────────────────────── */}
      <div>
        <PanelHeader
          title={t("performance")}
          subtitle={t("performanceSubtitle", { month: fmtMonth(nowKey) })}
          action={
            canEditTargets ? (
              <TargetsPanel
                profileId={profile.id}
                periodMonth={thisMonth}
                monthLabel={fmtMonth(nowKey)}
                current={targetsNow}
              />
            ) : undefined
          }
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {METRICS.map((metric) => {
            const target = targetsNow[metric] ?? null;
            const actual = actualsNow[metric];
            const pct = target ? Math.min(100, Math.round((actual / target) * 100)) : null;
            const tone =
              pct === null
                ? "var(--color-text-faint)"
                : pct >= 100
                  ? "var(--color-accent-green)"
                  : pct >= 60
                    ? "var(--color-accent-amber)"
                    : "var(--color-accent-red)";
            return (
              <Panel key={metric}>
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {metricLabel[metric]}
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="num text-2xl font-bold tabular-nums text-[var(--color-text)]">
                    {actual.toLocaleString(displayLocale)}
                  </span>
                  {target !== null && (
                    <span className="num text-sm text-[var(--color-text-muted)]">
                      / {target.toLocaleString(displayLocale)}
                    </span>
                  )}
                </div>
                {target !== null ? (
                  <div className="mt-3">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: tone }}
                      />
                    </div>
                    <p className="num mt-1 text-xs tabular-nums" style={{ color: tone }}>
                      {pct}%
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[var(--color-text-faint)]">{t("noTarget")}</p>
                )}
              </Panel>
            );
          })}
        </div>
      </div>

      {/* ── Tabs & access (CEO only) ─────────────────────── */}
      {me.role === "ceo" && (
        <TabsPanel
          profileId={profile.id}
          granted={[...features.granted]}
          hidden={[...features.hidden]}
          roleDefaults={roleDefaultKeys}
        />
      )}

      {/* ── Six-month record ─────────────────────────────── */}
      <Panel>
        <PanelHeader title={t("history")} subtitle={t("historySubtitle")} />
        <Table>
          <THead>
            <Th>{t("month")}</Th>
            <Th>{t("metricCalls")}</Th>
            <Th>{t("metricNewLeads")}</Th>
            <Th>{t("metricDealsClosed")}</Th>
            <Th>{t("revenue")}</Th>
          </THead>
          <TBody>
            {[...months].reverse().map((mk) => (
              <Tr key={mk}>
                <Td className="font-medium text-[var(--color-text)]">{fmtMonth(mk)}</Td>
                <MetricCell actual={calls[mk]} target={targetFor("calls", mk)} locale={displayLocale} />
                <MetricCell actual={newLeads[mk]} target={targetFor("new_leads", mk)} locale={displayLocale} />
                <MetricCell actual={dealsClosed[mk]} target={targetFor("deals_closed", mk)} locale={displayLocale} />
                <Td className="num text-[var(--color-text-muted)]">
                  {revenue[mk] ? formatMoney(revenue[mk], locale) : "—"}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}

function ProfileFact({
  label,
  value,
  hint,
  ltr,
}: {
  label: string;
  value: string;
  hint?: string;
  ltr?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-[var(--color-text)]">
        {ltr ? <span dir="ltr">{value}</span> : value}
        {hint && (
          <span className="ms-2 text-xs text-[var(--color-text-faint)]">
            <span dir="ltr">{hint}</span>
          </span>
        )}
      </dd>
    </div>
  );
}

function MetricCell({
  actual,
  target,
  locale,
}: {
  actual: number;
  target: number | null;
  locale: string;
}) {
  const hit = target !== null && actual >= target;
  return (
    <Td className="num tabular-nums">
      <span className={hit ? "text-[var(--color-accent-green)]" : "text-[var(--color-text)]"}>
        {actual.toLocaleString(locale)}
      </span>
      {target !== null && (
        <span className="text-[var(--color-text-faint)]"> / {target.toLocaleString(locale)}</span>
      )}
    </Td>
  );
}
