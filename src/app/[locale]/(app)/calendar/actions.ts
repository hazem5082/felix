"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authenticate, authorize } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  CancelMeetingSchema,
  CreateMeetingSchema,
  MeetingResponseSchema,
  parseInput,
} from "@/lib/validation";
import type { CalendarMeeting, InvitablePerson } from "@/lib/supabase/types";

/** Roles allowed to put something in someone else's day. */
const SCHEDULER_ROLES = ["ceo", "branch_manager"] as const;

function revalidateCalendar() {
  revalidatePath("/[locale]/(app)/calendar", "page");
}

/**
 * Best-effort ping to the 508.world router Worker so invitees get an
 * email/WhatsApp the moment a meeting is created or cancelled, rather
 * than waiting for the next cron tick. Deliberately not awaited: this
 * request crosses to another origin, and a slow or unreachable Worker
 * must never hold up the person who just clicked "Create" / "Cancel".
 * The reminder cron (every 10 minutes, worker/src/index.js) is the safety
 * net if this never lands — it re-derives who needs telling from the
 * `meetings` table itself, so a dropped notify call loses only the
 * "instant" part, never the notification. In the Workers runtime a
 * fire-and-forget promise can be cancelled once the response is sent;
 * that's an accepted loss here, not a bug.
 */
function notifyMeetingEvent(type: "meeting_created" | "meeting_cancelled", meetingId: string) {
  const url = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (!url || !secret) return;

  void fetch(`${url}/api/notify/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ type, meeting_id: meetingId }),
  }).catch(() => {});
}

export async function createMeeting(input: {
  title: string;
  agenda: string;
  location: string;
  starts_at: string;
  ends_at: string;
  branch_id: string | null;
  invitee_ids: string[];
}) {
  // Three checks, and only the last one counts. This one keeps a
  // salesperson's hand-crafted POST from reaching the database at all;
  // the form's hidden button is cosmetic; `create_meeting()` in
  // migration 0006 is the boundary that actually holds, because it is
  // the only thing a caller cannot route around.
  const auth = await authorize([...SCHEDULER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateMeetingSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_meeting", {
    p_title: parsed.data.title,
    p_agenda: parsed.data.agenda,
    p_location: parsed.data.location,
    p_starts_at: parsed.data.starts_at,
    p_ends_at: parsed.data.ends_at,
    // Sent for the CEO's sake; a branch manager's value is discarded
    // server-side in favour of their own branch.
    p_branch_id: parsed.data.branch_id,
    p_invitees: parsed.data.invitee_ids,
  });

  if (error) return toUserError(error);

  revalidateCalendar();
  notifyMeetingEvent("meeting_created", data as string);
  return { id: data as string };
}

export async function respondToMeeting(input: { meeting_id: string; response: string }) {
  // Answering an invitation is the one calendar write every role gets,
  // so this is authenticate-not-authorize on purpose. RLS narrows it to
  // the caller's own invitation row.
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = parseInput(MeetingResponseSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("meeting_invitees")
    .update({ response: parsed.data.response })
    .eq("meeting_id", parsed.data.meeting_id)
    .eq("profile_id", auth.profile.id)
    .select("meeting_id");

  if (error) return toUserError(error);
  // RLS turns "not your invitation" into zero updated rows rather than
  // an error, so an empty result is a denial, not a success.
  if (!data?.length) return { error: "You are not invited to that meeting." };

  revalidateCalendar();
  return { ok: true };
}

export async function cancelMeeting(input: { meeting_id: string }) {
  const auth = await authorize([...SCHEDULER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CancelMeetingSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  // The row is never deleted: people rearranged their day around it, so
  // it stays visible with a cancelled badge. `meetings_update` limits
  // this to the organizer and the CEO.
  const { data, error } = await supabase
    .from("meetings")
    .update({ status: "cancelled" })
    .eq("id", parsed.data.meeting_id)
    .select("id");

  if (error) return toUserError(error);
  if (!data?.length) return { error: "That meeting is not yours to cancel." };

  revalidateCalendar();
  notifyMeetingEvent("meeting_cancelled", parsed.data.meeting_id);
  return { ok: true };
}

/**
 * The meetings visible to the caller in a window. Reads go through the
 * RPC rather than a table select because `profiles_select` hides other
 * staff from a salesperson — see migration 0006 §5.
 */
export async function fetchCalendarMeetings(from: string, to: string): Promise<CalendarMeeting[]> {
  const auth = await authenticate();
  if (!auth.ok) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("calendar_meetings", {
    p_from: from,
    p_to: to,
  });

  if (error) {
    console.error("calendar_meetings failed", error.message);
    return [];
  }
  return (data as CalendarMeeting[]) ?? [];
}

/**
 * Exactly who this caller may invite — empty for anyone who may not
 * schedule at all, so the form cannot offer a choice the RPC rejects.
 */
export async function fetchInvitablePeople(): Promise<InvitablePerson[]> {
  const auth = await authenticate();
  if (!auth.ok) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("calendar_invitable_people");

  if (error) {
    console.error("calendar_invitable_people failed", error.message);
    return [];
  }
  return (data as InvitablePerson[]) ?? [];
}
