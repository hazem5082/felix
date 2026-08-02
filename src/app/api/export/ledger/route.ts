import { createClient } from "@/lib/supabase/server";
import { authorizeActiveTenant, FINANCE_ROLES } from "@/lib/auth";
import type { LedgerEntry } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/ledger — the tenant's ledger as CSV, for Excel or a
 * real accounting package. Finance roles only; rows come through the
 * caller's own session so RLS scopes the export to their showroom
 * exactly as it scopes the page that links here.
 *
 * A route handler never renders the (app) layout, so the licence check
 * has to be made here explicitly — otherwise this is the widest data
 * export in the product and the one surface a suspended showroom could
 * still reach.
 */
export async function GET() {
  const auth = await authorizeActiveTenant(FINANCE_ROLES);
  if (!auth.ok) return new Response("Forbidden", { status: 403 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ledger_entries")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(10_000);

  if (error) return new Response(`Export failed: ${error.message}`, { status: 500 });

  // A field that could contain a quote, comma or newline gets quoted;
  // free text starting with =,+,-,@ gets a leading apostrophe so a
  // hostile note can't become a formula when opened in Excel.
  //
  // Numbers are exempt from that guard. Applying it to `amount` turned
  // every negative entry into the TEXT '-500 — and since a withdrawal
  // is required to be negative, SUM() over the column silently dropped
  // every withdrawal and the reconciliation total came out wrong in
  // exactly the export that exists to be reconciled.
  const cell = (v: unknown): string => {
    if (typeof v === "number") return String(v);
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ["created_at", "type", "holder_type", "holder_id", "amount", "note", "ref_deal_ticket_id", "ref_vehicle_id"];
  const lines = [
    header.join(","),
    ...((data as LedgerEntry[]) ?? []).map((e) =>
      [e.created_at, e.type, e.holder_type, e.holder_id, e.amount, e.note, e.ref_deal_ticket_id, e.ref_vehicle_id]
        .map(cell)
        .join(",")
    ),
  ];

  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
