import type { AuditLogRow } from "@/lib/supabase/types";

/**
 * What changed on a client, in the order it happened.
 *
 * The trail itself is not new — `record_audit()` has been writing a full
 * before/after pair for every lead mutation since 0003 §8, and for every
 * interest since 0016. What was missing was anyone able to read it
 * (migration 0017 adds the lead-scoped policy) and anything able to turn
 * `{"phone_number": "0501234567"}` into a sentence. This is the second
 * half.
 *
 * Pure and server-safe, so the lead page stays a Server Component and
 * the diffing is testable without a database.
 */

export interface LeadHistoryChange {
  /**
   * The column name, not a label. Translation happens at the edge — the
   * component looks this up in `history.fields.*` — so this module can
   * be tested without a locale and reused by the Arabic build unchanged.
   */
  field: string;
  from: string | null;
  to: string | null;
}

export interface LeadHistoryEntry {
  id: string;
  at: string;
  /** Null for a row written by a script or by the service role. */
  actorName: string | null;
  entity: "lead" | "interest";
  action: "insert" | "update" | "delete";
  /**
   * Which car an interest entry is about. Null on lead entries, where
   * the subject is the client the page is already showing.
   */
  subject: string | null;
  changes: LeadHistoryChange[];
}

/**
 * The columns worth showing, and the order they are shown in.
 *
 * An allowlist rather than "every key that differs" for two reasons.
 * `before_data`/`after_data` carry the whole row, so a diff would print
 * `id`, `branch_id` and `salesperson_id` as opaque uuids on the one
 * entry where they are set; and a column added later would start
 * appearing in the history of every showroom with no label and no
 * thought given to whether it belongs there.
 */
const LEAD_FIELDS = [
  "client_name",
  "phone_number",
  "address",
  "company_name",
  "job_title",
  "income",
  "car_interest",
  "contact_time_preference",
  "client_notes",
  "client_note_points",
  "status",
] as const;

const INTEREST_FIELDS = [
  "vehicle_id",
  "wanted_make",
  "wanted_model",
  "wanted_year",
  "budget_amount",
  "origin",
  "status",
  "note",
] as const;

/** Rendered with thousands separators; everything else is left alone. */
const MONEY_FIELDS = new Set(["income", "budget_amount"]);

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

/**
 * One column's value as a string, or null when there is nothing there.
 *
 * Null and "" collapse deliberately: a note cleared to an empty string
 * and a note set back to NULL are the same event to the person reading
 * the history, and treating them as different would emit a change entry
 * saying "— → —".
 */
export function formatValue(
  field: string,
  value: unknown,
  vehicleLabels: Record<string, string> = {}
): string | null {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    const points = value.map((v) => String(v).trim()).filter(Boolean);
    return points.length ? points.join(" • ") : null;
  }

  if (field === "vehicle_id") {
    const id = String(value);
    return vehicleLabels[id] ?? id;
  }

  if (MONEY_FIELDS.has(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : String(value);
  }

  const text = String(value).trim();
  return text === "" ? null : text;
}

/** How the car an interest names should read in the history. */
function interestSubject(row: Row | null, vehicleLabels: Record<string, string>): string | null {
  if (!row) return null;
  const vehicleId = row.vehicle_id;
  if (typeof vehicleId === "string" && vehicleId) {
    return vehicleLabels[vehicleId] ?? vehicleId;
  }
  const parts = [row.wanted_year, row.wanted_make, row.wanted_model]
    .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
    .filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function diff(
  fields: readonly string[],
  before: Row | null,
  after: Row | null,
  vehicleLabels: Record<string, string>
): LeadHistoryChange[] {
  const changes: LeadHistoryChange[] = [];
  for (const field of fields) {
    const from = formatValue(field, before?.[field], vehicleLabels);
    const to = formatValue(field, after?.[field], vehicleLabels);
    if (from === to) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

/**
 * Turns raw audit rows into the entries the History panel renders.
 *
 * @param rows          audit_log rows for this lead and its interests,
 *                      newest first, with `profiles(full_name)` embedded.
 * @param vehicleLabels vehicle id → "2023 Toyota Hilux SR5", so a
 *                      relinked interest reads as a car rather than as a
 *                      uuid. Ids missing from the map fall through to
 *                      the raw value rather than being dropped — an
 *                      entry that says something opaque is still better
 *                      evidence than one that silently omits the change.
 *
 * Updates that moved nothing on the allowlist are dropped. They exist —
 * an `update ... set status = status` from a retried action writes an
 * audit row like any other — and rendering them as an empty entry would
 * put "Sara changed nothing" in the middle of a client's history.
 */
export function buildLeadHistory(
  rows: (AuditLogRow & { profiles?: { full_name: string } | null })[],
  vehicleLabels: Record<string, string> = {}
): LeadHistoryEntry[] {
  const entries: LeadHistoryEntry[] = [];

  for (const row of rows) {
    const entity =
      row.entity_type === "leads"
        ? "lead"
        : row.entity_type === "lead_vehicle_interests"
          ? "interest"
          : null;
    if (!entity) continue;

    const action =
      row.action === "insert" || row.action === "update" || row.action === "delete"
        ? row.action
        : null;
    if (!action) continue;

    const before = asRow(row.before_data);
    const after = asRow(row.after_data);
    const fields = entity === "lead" ? LEAD_FIELDS : INTEREST_FIELDS;

    // An insert lists no diff: every field would render as "— → value",
    // which is the create form printed back at the reader. A delete lists
    // none either — what matters is that the row is gone, and `subject`
    // already says which one.
    const changes = action === "update" ? diff(fields, before, after, vehicleLabels) : [];
    if (action === "update" && changes.length === 0) continue;

    entries.push({
      id: row.id,
      at: row.created_at,
      actorName: row.profiles?.full_name ?? null,
      entity,
      action,
      subject: entity === "interest" ? interestSubject(after ?? before, vehicleLabels) : null,
      changes,
    });
  }

  return entries;
}

/**
 * Every vehicle id named anywhere in a set of audit rows.
 *
 * The page uses this to fetch labels in one round trip. It reads both
 * sides of the pair on purpose: a relinked interest's OLD car is exactly
 * the one no longer present in the lead's current interests, so taking
 * ids from the live rows alone would leave the "from" half of the one
 * change worth reading as a uuid.
 */
export function vehicleIdsInHistory(rows: AuditLogRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.entity_type !== "lead_vehicle_interests") continue;
    for (const side of [asRow(row.before_data), asRow(row.after_data)]) {
      const id = side?.vehicle_id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}
