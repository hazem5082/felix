import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import { addMonths, monthKey, monthStart } from "@/lib/calendar";
import { CalendarMonthSchema } from "@/lib/validation";
import type { Branch } from "@/lib/supabase/types";
import { fetchCalendarMeetings, fetchInvitablePeople } from "./actions";
import { CalendarView } from "./calendar-view";
import { MeetingFormDialog } from "./meeting-form";

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { locale } = await params;
  const profile = await requireProfile(locale);
  const t = await getTranslations("calendar");

  // The visible month rides in the URL so paging re-fetches. It used to
  // be pure client state over a single today-relative fetch, which meant
  // any month outside that window drew a normal-looking grid with zero
  // meetings — indistinguishable from a genuinely empty month. A meeting
  // booked a year out simply vanished from the UI.
  const { month } = await searchParams;
  const cursor = monthStart(CalendarMonthSchema.parse(month));

  // A year around the cursor, so short hops are instant and only a long
  // jump costs a round trip. Inside calendar_meetings()' 400-day cap.
  const from = addMonths(cursor, -3);
  const to = addMonths(cursor, 9);

  const canSchedule = profile.role === "ceo" || profile.role === "branch_manager";

  const [meetings, invitees, branches] = await Promise.all([
    fetchCalendarMeetings(from.toISOString(), to.toISOString()),
    // Returns an empty list for anyone who may not schedule, so this is
    // safe to call for every role.
    canSchedule ? fetchInvitablePeople() : Promise.resolve([]),
    canSchedule && profile.role === "ceo"
      ? createClient().then((c) => c.from("branches").select("*").order("name"))
      : Promise.resolve({ data: [] }),
  ]);

  return (
    <div className="space-y-6">
      <PanelHeader
        title={t("title")}
        subtitle={canSchedule ? undefined : t("readOnlyNotice")}
        action={
          canSchedule ? (
            <MeetingFormDialog
              people={invitees}
              branches={((branches as { data: Branch[] | null }).data as Branch[]) ?? []}
              role={profile.role}
            />
          ) : undefined
        }
      />

      <CalendarView
        meetings={meetings}
        viewerId={profile.id}
        canSchedule={canSchedule}
        monthKey={monthKey(cursor)}
      />
    </div>
  );
}
