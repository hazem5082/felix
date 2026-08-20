import { createClient } from "@/lib/supabase/server";
import { authorizeActiveTenant } from "@/lib/auth";
import { parseOffset, resolveWindow } from "@/lib/report-window";
import { dayKey, liveEvents, localTime, type AttendanceEvent } from "@/lib/attendance";
import type { Branch, Profile } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/attendance?from=&to=&tz= — the punch stream as CSV.
 *
 * ONE ROW PER PUNCH, not one per day. The printable report already
 * gives the rolled-up timesheet; what a payroll clerk or an HR system
 * needs from an export is the raw events, so they can do their own
 * arithmetic and audit ours. Rolling up here would throw away the one
 * thing the file is for.
 *
 * Rows come through the CALLER'S OWN SESSION, so RLS scopes the export
 * exactly as it scopes the page that links here: a branch manager gets
 * their branch, the CEO and accountant get the showroom. There is no
 * branch parameter and there must not be one.
 *
 * A route handler never renders the (app) layout, so the licence and
 * tenant-host checks are made explicitly — the same reason the ledger
 * export does it.
 */
export async function GET(request: Request) {
  // Branch managers included: attendance is an HR document, and the
  // manager running the floor is its main reader. They still cannot
  // reach any of the financial exports.
  const auth = await authorizeActiveTenant(["ceo", "accountant", "branch_manager"]);
  if (!auth.ok) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const offset = parseOffset(url.searchParams.get("tz") ?? undefined);
  const { from, to } = resolveWindow(
    url.searchParams.get("from") ?? undefined,
    url.searchParams.get("to") ?? undefined,
    new Date(),
    offset
  );

  const supabase = await createClient();
  const [{ data: eventRows, error }, { data: staffRows }, { data: branchRows }] = await Promise.all([
    supabase
      .from("attendance_events")
      .select("*")
      .gte("occurred_at", from.toISOString())
      .lt("occurred_at", to.toISOString())
      .order("occurred_at", { ascending: true })
      .limit(20_000),
    supabase.from("profiles").select("id, full_name"),
    supabase.from("branches").select("id, name"),
  ]);

  if (error) return new Response(`Export failed: ${error.message}`, { status: 500 });

  const names = new Map(
    ((staffRows as Pick<Profile, "id" | "full_name">[] | null) ?? []).map((p) => [p.id, p.full_name])
  );
  const branches = new Map(
    ((branchRows as Pick<Branch, "id" | "name">[] | null) ?? []).map((b) => [b.id, b.name])
  );

  // Same guard as the ledger export: a field that could contain a
  // quote, comma or newline gets quoted, and free text starting with
  // =,+,-,@ gets a leading apostrophe so a hostile reason cannot become
  // a formula when the file is opened in Excel. Numbers are exempt —
  // quoting them turned negative ledger amounts into text once already.
  const cell = (v: unknown): string => {
    if (typeof v === "number") return String(v);
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = [
    "date",
    "local_time",
    "occurred_at_utc",
    "employee",
    "branch",
    "kind",
    "source",
    "within_geofence",
    "distance_m",
    "accuracy_m",
    "latitude",
    "longitude",
    "recorded_by",
    "reason",
    "voided",
    "void_reason",
  ];

  // VOIDED ROWS ARE INCLUDED, flagged rather than dropped. An export is
  // an audit artefact: somebody reconciling it against the printed
  // report needs to see that a punch was struck and why, and a file
  // that silently omits corrections cannot be reconciled at all. Every
  // consumer should filter on `voided` — as the report itself does via
  // liveEvents().
  const all = (eventRows as AttendanceEvent[] | null) ?? [];
  const live = new Set(liveEvents(all).map((e) => e.id));

  const lines = [
    header.join(","),
    ...all.map((e) =>
      [
        dayKey(e.occurred_at, offset),
        localTime(e.occurred_at, offset),
        e.occurred_at,
        names.get(e.profile_id) ?? e.profile_id,
        branches.get(e.branch_id) ?? e.branch_id,
        e.kind,
        e.source,
        // Three-valued, and written out rather than reduced to a
        // boolean: "not assessed" (an unpinned branch, or a punch with
        // no position) is not the same claim as "outside", and a
        // spreadsheet that conflates them accuses people.
        e.within_geofence === null ? "not_assessed" : e.within_geofence ? "inside" : "outside",
        e.distance_m === null ? "" : Number(e.distance_m),
        e.accuracy_m === null ? "" : Number(e.accuracy_m),
        e.latitude === null ? "" : Number(e.latitude),
        e.longitude === null ? "" : Number(e.longitude),
        e.recorded_by ? (names.get(e.recorded_by) ?? e.recorded_by) : "",
        e.reason,
        live.has(e.id) ? "" : "voided",
        (e as AttendanceEvent & { void_reason?: string | null }).void_reason ?? "",
      ]
        .map(cell)
        .join(",")
    ),
  ];

  const stamp = dayKey(from, offset);
  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
