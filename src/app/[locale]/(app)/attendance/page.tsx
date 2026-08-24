import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getGrantedBranchIds, hasHrAccess, requireRole } from "@/lib/auth";
import { selectableBranches } from "@/lib/branch-authority";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { dayKey, summariseDay, summariseRange, stateAfter, type AttendanceEvent } from "@/lib/attendance";
import type { Branch, TrustedDevice } from "@/lib/supabase/types";
import { PunchCard } from "./punch-card";
import { DevicesPanel } from "./devices-panel";
import { MyHistory } from "./my-history";
import { TeamBoard } from "./team-board";
import { GeofencePanel } from "./geofence-panel";
import { ReportsLauncher } from "../accountant/reports-launcher";

/**
 * One page, three audiences, in the order each one needs.
 *
 * A salesperson opens this on a phone to punch, and everything below
 * the first card is history they will rarely scroll to. A manager opens
 * it on a desktop to see who is in and fix yesterday. The CEO opens it
 * to place a showroom on the map. Splitting that into three routes
 * would mean three navigation entries for one subject; the page orders
 * itself by role instead.
 *
 * Investors have no entry in the nav for this and would be redirected
 * by requireRole if they typed the URL: they are outside capital, not
 * staff, and there is no sense in which one attends.
 */
export default async function AttendancePage({
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
    // 0047. HR owns the attendance record: they read it org-wide, void
    // a bad punch and enter the adjustment that replaces it.
    "hr",
  ]);
  // ...as does anyone the CEO handed the HR hub to (0048). Same
  // predicate the database uses, so the board this unlocks is exactly
  // the board attendance_events_select will serve.
  const isHr = await hasHrAccess();
  const t = await getTranslations("attendance");

  // The viewer's UTC offset, as the report suite does it. Workers run in
  // UTC, so without this a punch at 01:30 Cairo time files under
  // yesterday. Defaults to UTC rather than guessing a zone.
  const offsetMinutes = parseOffset(tz);

  const supabase = await createClient();
  // TWO DIFFERENT QUESTIONS, and 0047 is where they stopped having the
  // same answer.
  //
  //   isManager  may reshape the SHOWROOM — the geofence panel writes to
  //              branches, which branches_geofence_update gates on
  //              is_manager_or_above(). HR is not that, and rendering
  //              the panel for them would be a control that fails on
  //              save.
  //   oversees   may look at other people's days. That is HR's whole
  //              job, and attendance_events_select now says so.
  const isManager = profile.role === "ceo" || profile.role === "branch_manager";
  const oversees = isManager || isHr;

  const [{ data: branchRows }, { data: myEvents }, { data: myDevices }, grantedBranchIds] =
    await Promise.all([
      supabase.from("branches").select("*").order("name"),
      // 30 days is what the personal history below shows, and it is a
      // cheap enough slice to fetch whole rather than paginate.
      supabase
        .from("attendance_events")
        .select("*")
        .eq("profile_id", profile.id)
        .gte("occurred_at", daysAgo(30))
        .order("occurred_at", { ascending: false }),
      supabase
        .from("trusted_devices")
        .select("*")
        .eq("profile_id", profile.id)
        .order("enrolled_at", { ascending: false }),
      getGrantedBranchIds(),
    ]);

  const branches = (branchRows as Branch[] | null) ?? [];
  // `error` is ignored throughout, on purpose: a deployment where 0038
  // has not been applied yet must render an empty page rather than a
  // 500 — supabase-js returns { data: null, error } for a missing table.
  const events = (myEvents as AttendanceEvent[] | null) ?? [];
  const devices = (myDevices as TrustedDevice[] | null) ?? [];

  const mine = selectableBranches(profile.role, profile.branch_id, grantedBranchIds, branches);
  const today = dayKey(new Date(), offsetMinutes);

  // The manager's board. Two reads rather than a join, because
  // attendance_events has no FK-shaped relationship to profiles that
  // PostgREST would embed under RLS without widening the select — and
  // because a manager's staff list is short.
  //
  // Neither query filters by branch. `profiles_select` already confines
  // a manager to their own branch and `attendance_events_select` to
  // branches they may read, so a filter here would restate the rule in
  // a second place where it could drift — and would silently narrow the
  // CEO, who is meant to see everyone.
  const [{ data: staffRows }, { data: teamRows }] = oversees
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, role, branch_id, work_mode")
          .neq("role", "investor")
          .order("full_name"),
        supabase
          .from("attendance_events")
          .select("*")
          .gte("occurred_at", daysAgo(2))
          .order("occurred_at", { ascending: false }),
      ])
    : [{ data: null }, { data: null }];

  const staff =
    (staffRows as
      | { id: string; full_name: string; role: string; branch_id: string | null; work_mode: string }[]
      | null) ?? [];
  const teamEvents = (teamRows as AttendanceEvent[] | null) ?? [];

  const board = staff.map((person) => ({
    profile: person,
    day: summariseDay(teamEvents.filter((e) => e.profile_id === person.id), {
      date: today,
      profileId: person.id,
      offsetMinutes,
    }),
  }));

  const todaySummary = summariseDay(events, {
    date: today,
    profileId: profile.id,
    offsetMinutes,
  });

  const history = summariseRange(events, {
    profileId: profile.id,
    from: new Date(Date.now() - 13 * 86_400_000),
    to: new Date(Date.now() + 86_400_000),
    offsetMinutes,
  })
    .slice()
    .reverse();

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />

      <PunchCard
        branches={mine.map((b) => ({
          id: b.id,
          name: b.name,
          latitude: b.latitude,
          longitude: b.longitude,
          geofence_radius_m: b.geofence_radius_m,
        }))}
        homeBranchId={profile.branch_id}
        state={stateAfter(events)}
        today={todaySummary}
        offsetMinutes={offsetMinutes}
        workMode={profile.work_mode}
      />

      {oversees && (
        <TeamBoard
          rows={board}
          // HR reads every branch (attendance_events_select), so the
          // filter must offer every branch — narrowing it to `mine`
          // would hide rows the query already returned.
          branches={(isHr ? branches : mine).map((b) => ({ id: b.id, name: b.name }))}
          offsetMinutes={offsetMinutes}
        />
      )}

      <MyHistory days={history} offsetMinutes={offsetMinutes} />

      <DevicesPanel devices={devices} />

      {/* The report and its CSV, over a window the manager picks. The
          same component the accountant page uses; it renders only the
          reports the given role may open, so a branch manager sees
          attendance and nothing financial. */}
      {oversees && <ReportsLauncher role={profile.role} />}

      {isManager && (
        <GeofencePanel
          branches={mine.map((b) => ({
            id: b.id,
            name: b.name,
            latitude: b.latitude,
            longitude: b.longitude,
            geofence_radius_m: b.geofence_radius_m,
          }))}
        />
      )}

      {mine.length === 0 && (
        <Panel>
          <PanelHeader title={t("noBranchTitle")} subtitle={t("noBranchBody")} />
        </Panel>
      )}
    </div>
  );
}

/** Mirrors parseOffset() in lib/report-window.ts. */
function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && Math.abs(n) <= 840 ? n : 0;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
