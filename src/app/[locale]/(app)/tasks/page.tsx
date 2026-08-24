import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getGrantedBranchIds, requireRole } from "@/lib/auth";
import { selectableBranches } from "@/lib/branch-authority";
import { PanelHeader } from "@/components/ui/panel";
import { dayKey } from "@/lib/attendance";
import { parseOffset } from "@/lib/report-window";
import type {
  Branch,
  DayReport,
  Profile,
  TaskRow,
  TaskTemplate,
} from "@/lib/supabase/types";
import { TzSync } from "./tz-sync";
import { MyBoard } from "./my-board";
import { EndDayCard } from "./end-day-card";
import { TeamBoard } from "./team-board";
import { TemplatesPanel } from "./templates-panel";
import { LeadSplitPanel } from "./lead-split-panel";

/**
 * One page, two audiences, in the order each one needs — the shape the
 * attendance page settled on, for the same reason.
 *
 * A salesperson opens this in the morning to see what they owe and in
 * the evening to close the day; everything below the first two cards is
 * somebody else's job. A manager opens it to see the floor, write the
 * standing instructions and deal the enquiries out. Splitting that into
 * two routes would put two entries in the sidebar for one subject.
 *
 * INVESTORS ARE NOT HERE. requireRole redirects them: they are outside
 * capital, not staff, and nobody assigns them a call list.
 *
 * THE BOARD IS MATERIALISED ON LOAD. This deployment has no scheduler
 * inside Postgres, so materialise_tasks() runs here, before the reads
 * below — the unique indexes make it a no-op on every load after the
 * first. See migration 0053's header.
 */
export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tz?: string }>;
}) {
  const { locale } = await params;
  const { tz } = await searchParams;
  const profile = await requireRole(locale, [
    "ceo",
    "branch_manager",
    "accountant",
    "sales_exec",
    "marketing",
    "hr",
  ]);
  const t = await getTranslations("tasks");

  // The viewer's UTC offset, as the report suite does it. Workers run in
  // UTC; without this a showroom that closes at 21:00 Cairo time files
  // three hours of every evening under tomorrow.
  const offsetMinutes = parseOffset(tz);
  const today = dayKey(new Date(), offsetMinutes);

  const isManager = profile.role === "ceo" || profile.role === "branch_manager";
  const supabase = await createClient();

  // Before the reads, deliberately. `error` ignored: a deployment still
  // on 0052 has no such function, and an empty board is a better answer
  // than a 500.
  await supabase.rpc("materialise_tasks", { p_day: today });

  const [
    { data: myTaskRows },
    { data: templateRows },
    { data: branchRows },
    { data: reportRow },
    grantedBranchIds,
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("*")
      .eq("assignee_id", profile.id)
      .eq("due_on", today)
      .order("created_at"),
    supabase.from("task_templates").select("*").order("title"),
    supabase.from("branches").select("*").order("name"),
    supabase
      .from("day_reports")
      .select("*")
      .eq("profile_id", profile.id)
      .eq("day", today)
      .maybeSingle(),
    getGrantedBranchIds(),
  ]);

  // `error` ignored throughout, on purpose and for the reason the
  // attendance page gives: supabase-js returns { data: null, error } for
  // a missing table, and a deployment where 0053 has not landed yet must
  // render an empty page rather than a 500.
  const myTasks = (myTaskRows as TaskRow[] | null) ?? [];
  const templates = (templateRows as TaskTemplate[] | null) ?? [];
  const branches = (branchRows as Branch[] | null) ?? [];
  const myReport = (reportRow as DayReport | null) ?? null;

  // The manager's two extra reads. Neither filters by branch: tasks_select
  // confines a manager to the branches they may read and profiles_select
  // to their own, so a filter here would restate a policy in a second
  // place where it could drift — and would silently narrow the CEO's view
  // to one branch.
  const [{ data: teamTaskRows }, { data: peopleRows }] = isManager
    ? await Promise.all([
        supabase.from("tasks").select("*").eq("due_on", today),
        supabase
          .from("profiles")
          .select("id, full_name, role, branch_id")
          .neq("role", "investor")
          .order("full_name"),
      ])
    : [{ data: null }, { data: null }];

  const teamTasks = (teamTaskRows as TaskRow[] | null) ?? [];
  const people =
    (peopleRows as Pick<Profile, "id" | "full_name" | "role" | "branch_id">[] | null) ?? [];

  const mine = selectableBranches(profile.role, profile.branch_id, grantedBranchIds, branches);
  const dayLabel = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${today}T00:00:00Z`));

  return (
    <div className="space-y-6">
      <TzSync />
      <PanelHeader title={t("title")} subtitle={t("subtitle", { day: dayLabel })} />

      <MyBoard tasks={myTasks} day={today} />

      <EndDayCard tasks={myTasks} day={today} report={myReport} />

      {isManager && (
        <>
          <TeamBoard tasks={teamTasks} people={people} branches={branches} />
          <LeadSplitPanel
            branches={mine}
            day={today}
            defaultBranchId={profile.branch_id ?? mine[0]?.id ?? null}
            people={people}
          />
          <TemplatesPanel
            templates={templates}
            branches={mine}
            people={people}
            isCeo={profile.role === "ceo"}
            day={today}
          />
        </>
      )}
    </div>
  );
}
