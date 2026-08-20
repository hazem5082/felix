import { getTranslations } from "next-intl/server";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/table";
import { dayStatus, dayTone, formatDuration, localTime, type DaySummary } from "@/lib/attendance";
import { formatDistance } from "@/lib/geo";

/**
 * The last fortnight of a person's own attendance.
 *
 * ABSENT DAYS ARE ROWS, not gaps. `summariseRange` emits every day in
 * the window including the ones with no punches, because an attendance
 * history whose absences are invisible is not an attendance history —
 * and because the employee should see the same thing their manager
 * sees before a conversation about it, not after.
 */
export async function MyHistory({
  days,
  offsetMinutes,
}: {
  days: DaySummary[];
  offsetMinutes: number;
}) {
  const t = await getTranslations("attendance");

  return (
    <Panel>
      <PanelHeader title={t("historyTitle")} subtitle={t("historySubtitle")} />
      <Table>
        <THead>
          <Th>{t("date")}</Th>
          <Th>{t("arrived")}</Th>
          <Th>{t("left")}</Th>
          <Th>{t("worked")}</Th>
          <Th>{t("onBreak")}</Th>
          <Th>{t("status")}</Th>
        </THead>
        <TBody>
          {days.map((day) => {
            const status = dayStatus(day);
            const flagged = day.events.filter((e) => e.within_geofence === false);
            return (
              <Tr key={day.date}>
                <Td>{day.date}</Td>
                <Td>{day.firstIn ? localTime(day.firstIn, offsetMinutes) : "—"}</Td>
                <Td>{day.lastOut ? localTime(day.lastOut, offsetMinutes) : "—"}</Td>
                <Td>{formatDuration(day.workedMinutes)}</Td>
                <Td>
                  {formatDuration(day.breakMinutes)}
                  {day.breaks > 1 && (
                    <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                      ×{day.breaks}
                    </span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill label={t(`status_${status}`)} tone={dayTone(status)} />
                    {flagged.length > 0 && (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {formatDistance(flagged[0].distance_m)}
                      </span>
                    )}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </Panel>
  );
}
