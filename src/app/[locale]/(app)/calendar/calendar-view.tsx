"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, MapPin, Users } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import {
  addMonths,
  bucketByDay,
  dayKey,
  isSameMonth,
  monthGrid,
  monthKey as toMonthKey,
  monthStart,
} from "@/lib/calendar";
import type { CalendarMeeting, MeetingResponse } from "@/lib/supabase/types";
import { cancelMeeting, respondToMeeting } from "./actions";

const RESPONSE_TONE: Record<MeetingResponse, SemanticTone> = {
  accepted: "green",
  declined: "red",
  pending: "amber",
};

export function CalendarView({
  meetings,
  viewerId,
  canSchedule,
  monthKey,
}: {
  meetings: CalendarMeeting[];
  viewerId: string;
  canSchedule: boolean;
  /** `YYYY-MM` the server fetched for — the source of truth for the grid. */
  monthKey: string;
}) {
  const t = useTranslations("calendar");
  const locale = useLocale();
  const router = useRouter();

  /**
   * Dates are bucketed and formatted in the *viewer's* zone, which the
   * server does not know — it renders in UTC. Holding the meetings back
   * for one frame is what keeps a 09:00 meeting from being served as
   * 07:00 and then silently corrected on hydration. The grid itself is
   * built from year/month/day integers, so it round-trips identically
   * in any zone and renders server-side without shifting.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const today = useMemo(() => new Date(), []);
  // Derived from the server's month, never independent of it — that is
  // what guarantees the grid can only ever draw a month whose meetings
  // were actually fetched.
  const cursor = useMemo(() => monthStart(monthKey), [monthKey]);
  const [selected, setSelected] = useState<string | null>(null);

  // Arabic-market showrooms read a wall calendar that starts on
  // Saturday; a Sunday-first grid splits the Fri–Sat weekend across
  // opposite ends of the row.
  const weekStartsOn = locale.startsWith("ar") ? 6 : 0;

  const cells = useMemo(() => monthGrid(cursor, weekStartsOn), [cursor, weekStartsOn]);
  const buckets = useMemo(
    () => (mounted ? bucketByDay(meetings) : new Map<string, CalendarMeeting[]>()),
    [meetings, mounted]
  );

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(cursor),
    [locale, cursor]
  );

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 4 Jan 1970 was a Sunday — an arbitrary week to read names off,
    // rotated to match whichever day the grid starts on.
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(1970, 0, 4 + ((weekStartsOn + i) % 7)))
    );
  }, [locale, weekStartsOn]);

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  );
  const dayFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }),
    [locale]
  );

  // The list under the grid: a chosen day, or the whole visible month.
  const listed = useMemo(() => {
    if (!mounted) return [];
    if (selected) return buckets.get(selected) ?? [];
    return meetings
      .filter((m) => isSameMonth(new Date(m.starts_at), cursor))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [mounted, selected, buckets, meetings, cursor]);

  function goToMonth(delta: number) {
    setSelected(null);
    router.push(`?month=${toMonthKey(addMonths(cursor, delta))}`, { scroll: false });
  }

  function goToToday() {
    setSelected(null);
    router.push(`?month=${toMonthKey(monthStart(undefined))}`, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <Panel>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-wide text-[var(--color-text)]">
            {monthLabel}
          </h3>
          <div className="flex items-center gap-1.5">
            {/* rtl:-scale-x-100: lucide icons are static SVGs and do
                not mirror under dir=rtl, so without this the "back"
                arrow points the RTL "forward" way. */}
            <Button variant="ghost" size="sm" onClick={() => goToMonth(-1)} aria-label={t("prevMonth")}>
              <ChevronLeft size={15} className="rtl:-scale-x-100" />
            </Button>
            <Button variant="outline" size="sm" onClick={goToToday}>
              {t("today")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => goToMonth(1)} aria-label={t("nextMonth")}>
              <ChevronRight size={15} className="rtl:-scale-x-100" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-px text-center">
          {weekdayLabels.map((label, i) => (
            <div
              key={i}
              className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]"
            >
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1.5">
          {cells.map((day) => {
            const key = dayKey(day);
            const dayMeetings = buckets.get(key) ?? [];
            const outside = !isSameMonth(day, cursor);
            const isToday = key === dayKey(today);
            const isSelected = key === selected;

            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(isSelected ? null : key)}
                className={cn(
                  "min-h-20 rounded-md border p-1.5 text-start align-top transition-all duration-200",
                  outside
                    ? "border-[var(--color-border)] bg-black/[0.01] text-[var(--color-text-faint)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-black/[0.03]",
                  isSelected &&
                    "border-[var(--color-accent)]/60 bg-[var(--color-accent-dim)] ring-4 ring-[var(--color-accent)]/15"
                )}
              >
                <span
                  className={cn(
                    "num inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-semibold",
                    isToday && "bg-[var(--color-accent-blue)] text-white"
                  )}
                >
                  {day.getDate()}
                </span>

                <span className="mt-1 flex flex-col gap-1">
                  {dayMeetings.slice(0, 2).map((m) => (
                    <span
                      key={m.id}
                      title={m.title}
                      className={cn(
                        "truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                        m.status === "cancelled"
                          ? "bg-black/[0.04] text-[var(--color-text-faint)] line-through"
                          : "bg-[var(--color-accent-blue-dim)] text-[var(--color-accent-blue)]"
                      )}
                    >
                      {timeFmt.format(new Date(m.starts_at))} {m.title}
                    </span>
                  ))}
                  {dayMeetings.length > 2 && (
                    <span className="px-1.5 text-[10px] text-[var(--color-text-faint)]">
                      +{dayMeetings.length - 2}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title={selected ? dayFmt.format(new Date(`${selected}T00:00:00`)) : t("upcoming")}
          action={
            selected ? (
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                {t("clearAll")}
              </Button>
            ) : undefined
          }
        />

        <div className="space-y-3">
          {listed.map((m) => (
            <MeetingCard
              key={m.id}
              meeting={m}
              viewerId={viewerId}
              canSchedule={canSchedule}
              timeFmt={timeFmt}
              dayFmt={dayFmt}
            />
          ))}
          {mounted && !listed.length && (
            <p className="text-xs text-[var(--color-text-faint)]">
              {selected ? t("noMeetingsDay") : t("noMeetings")}
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}

function MeetingCard({
  meeting,
  viewerId,
  canSchedule,
  timeFmt,
  dayFmt,
}: {
  meeting: CalendarMeeting;
  viewerId: string;
  canSchedule: boolean;
  timeFmt: Intl.DateTimeFormat;
  dayFmt: Intl.DateTimeFormat;
}) {
  const t = useTranslations("calendar");
  const roles = useTranslations("roles");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const cancelled = meeting.status === "cancelled";
  const starts = new Date(meeting.starts_at);
  const ends = new Date(meeting.ends_at);
  // The organizer is never in their own invitee list, so "can I answer
  // this?" is exactly "do I have an invitation row".
  const canRespond = !cancelled && meeting.my_response !== null;
  const canCancel = !cancelled && canSchedule && meeting.is_organizer;

  function respond(response: "accepted" | "declined") {
    setError(null);
    startTransition(async () => {
      const res = await respondToMeeting({ meeting_id: meeting.id, response });
      if (res && "error" in res) setError(res.error);
    });
  }

  function cancel() {
    if (!window.confirm(t("confirmCancel"))) return;
    setError(null);
    startTransition(async () => {
      const res = await cancelMeeting({ meeting_id: meeting.id });
      if (res && "error" in res) setError(res.error);
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4",
        cancelled && "opacity-60"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold text-[var(--color-text)]", cancelled && "line-through")}>
            {meeting.title}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            <span className="num">
              {dayFmt.format(starts)} · {timeFmt.format(starts)} – {timeFmt.format(ends)}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
            {t("organizer")}:{" "}
            {meeting.is_organizer ? t("youOrganised") : meeting.organizer_name ?? "—"}
            {" · "}
            {meeting.branch_name ?? t("wholeShowroom")}
          </p>
          {meeting.location && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <MapPin size={12} /> {meeting.location}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {cancelled ? (
            <StatusPill label={t("cancelled")} tone="red" />
          ) : meeting.my_response ? (
            <StatusPill
              label={
                meeting.my_response === "accepted"
                  ? t("accepted")
                  : meeting.my_response === "declined"
                    ? t("declined")
                    : t("awaitingReply")
              }
              tone={RESPONSE_TONE[meeting.my_response]}
            />
          ) : null}
        </div>
      </div>

      {meeting.agenda && (
        <p className="mt-3 whitespace-pre-wrap text-xs text-[var(--color-text-muted)]">
          {meeting.agenda}
        </p>
      )}

      <div className="mt-3 flex items-start gap-2 text-xs text-[var(--color-text-faint)]">
        <Users size={13} className="mt-0.5 shrink-0" />
        <span className="flex flex-wrap gap-1.5">
          {meeting.attendees.map((a) => (
            <span
              key={a.id}
              className={cn(
                "rounded-md px-1.5 py-0.5",
                a.id === viewerId && "ring-1 ring-inset ring-[var(--color-border-strong)]",
                a.response === "accepted"
                  ? "bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)]"
                  : a.response === "declined"
                    ? "bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)] line-through"
                    : "bg-black/[0.04] text-[var(--color-text-muted)]"
              )}
              title={roles(a.role)}
            >
              {a.full_name}
            </span>
          ))}
          {!meeting.attendees.length && <span>—</span>}
        </span>
      </div>

      {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

      {(canRespond || canCancel) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canRespond && (
            <>
              <Button
                variant="success"
                size="sm"
                disabled={pending || meeting.my_response === "accepted"}
                onClick={() => respond("accepted")}
              >
                {t("accept")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={pending || meeting.my_response === "declined"}
                onClick={() => respond("declined")}
              >
                {t("decline")}
              </Button>
            </>
          )}
          {canCancel && (
            <Button variant="ghost" size="sm" disabled={pending} onClick={cancel}>
              {t("cancelMeeting")}
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}
