import { getTranslations } from "next-intl/server";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PanelHeader } from "@/components/ui/panel";
import { buildWantedList } from "@/lib/network";
import type { Lead, LeadVehicleInterest, Profile } from "@/lib/supabase/types";
import { fetchNetworkStatus } from "./actions";
import { NetworkConsole } from "./network-console";

/**
 * THE FELIX NETWORK.
 *
 * A buyer walks in wanting a car this showroom does not have. Today
 * that enquiry is written down — as an interest row with no vehicle
 * behind it (0016), or as a line in the enquiry note — and then it
 * quietly dies, because there is nothing anyone can do with it. Down
 * the road another licensed FELIX showroom has that exact car sitting
 * on its floor, and neither showroom can see the other.
 *
 * This page is both halves of that: the asks this showroom could not
 * fill, and a search across every other participating showroom's
 * in-stock cars. Clicking an ask searches for it.
 *
 * WHO OPENS IT. The CEO and branch managers. Not the sales floor —
 * sourcing a car from another business is a negotiation between two
 * managements, with a margin, a transport cost and a relationship
 * behind it, and a salesperson ringing a competitor directly is not
 * the workflow anybody wants. The role check is re-made in every
 * action, because a Server Action is reachable without this page.
 *
 * WHAT CROSSES A SHOWROOM BOUNDARY is defined by NetworkVehicle in
 * lib/network.ts and enforced by the explicit select in actions.ts:
 * the windscreen, never the cost, never the papers, never a customer.
 *
 * The wanted list below is read with the SESSION's client, so RLS
 * scopes it the same way the CRM does — a branch manager sees their
 * branches' enquiries, the CEO sees the group's. Only the cross-
 * showroom half uses the service-role client, and only in actions.ts.
 */
export default async function NetworkPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const me = await requireRole(locale, ["ceo", "branch_manager"]);
  const t = await getTranslations("network");

  const supabase = await createClient();

  // Both halves of "what did we fail to sell": the structured interest
  // rows, and the leads that never got one. buildWantedList() decides
  // which of them count — see its header.
  const [{ data: interests }, { data: leads }, status] = await Promise.all([
    supabase
      .from("lead_vehicle_interests")
      .select("*")
      .is("vehicle_id", null)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("leads")
      .select("id, client_name, phone_number, car_interest, branch_id, salesperson_id, created_at, status")
      .order("created_at", { ascending: false })
      .limit(500),
    fetchNetworkStatus(),
  ]);

  const leadRows = (leads as Lead[]) ?? [];
  const wanted = buildWantedList({
    interests: (interests as LeadVehicleInterest[]) ?? [],
    leads: leadRows,
  });

  // Who to chase, on the rows this reader can act on. One query for the
  // whole page rather than one per row — the CRM list's pattern.
  const salespeopleIds = [...new Set(wanted.map((w) => w.salespersonId).filter(Boolean))] as string[];
  const { data: staff } = salespeopleIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", salespeopleIds)
    : { data: [] };

  const salespeople: Record<string, string> = {};
  for (const p of (staff as Pick<Profile, "id" | "full_name">[]) ?? []) {
    salespeople[p.id] = p.full_name;
  }

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />
      <NetworkConsole
        wanted={wanted}
        salespeople={salespeople}
        status={status}
        canToggle={me.role === "ceo"}
      />
    </div>
  );
}
