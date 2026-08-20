import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Megaphone, Car, Send, CircleAlert } from "lucide-react";
import type { VehicleListing } from "@/lib/supabase/types";
import { ListingsBoard, type ListingVehicle } from "./listings-board";

/**
 * The marketing workspace: every car the showroom wants seen, and where
 * it is (and is not) advertised — Dubizzle, Facebook, Instagram and the
 * rest, one chip per channel.
 *
 * Deliberately fetches only the shop-window columns: this page is the
 * marketing role's home, and purchase_price is not their number (0028).
 */
export default async function MarketingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requireRole(locale, ["ceo", "marketing"]);

  const t = await getTranslations("marketing");
  const supabase = await createClient();

  const [{ data: vehicles }, { data: listings }] = await Promise.all([
    supabase
      .from("vehicles")
      .select("id, year, make, model, trim, color, status, asking_price, photos, features, description")
      .in("status", ["in_stock", "reserved"])
      .order("created_at", { ascending: false }),
    supabase.from("vehicle_listings").select("*"),
  ]);

  const cars = (vehicles as ListingVehicle[]) ?? [];
  const rows = (listings as VehicleListing[]) ?? [];

  const postedByVehicle = new Set(
    rows.filter((l) => l.status === "posted").map((l) => l.vehicle_id)
  );
  const unadvertised = cars.filter((v) => !postedByVehicle.has(v.id)).length;
  const stale = rows.filter((l) => l.status === "needs_update").length;
  const unpriced = cars.filter((v) => v.asking_price === null).length;

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("statStock")} value={cars.length} icon={<Car size={16} />} />
        <StatCard
          label={t("statPosted")}
          value={rows.filter((l) => l.status === "posted").length}
          tone="green"
          icon={<Send size={16} />}
        />
        <StatCard
          label={t("statUnadvertised")}
          value={unadvertised}
          tone={unadvertised > 0 ? "amber" : "neutral"}
          icon={<Megaphone size={16} />}
        />
        <StatCard
          label={t("statNeedsUpdate")}
          value={stale}
          tone={stale > 0 ? "red" : "neutral"}
          hint={unpriced > 0 ? t("unpricedHint", { count: unpriced }) : undefined}
          icon={<CircleAlert size={16} />}
        />
      </div>

      <ListingsBoard vehicles={cars} listings={rows} />
    </div>
  );
}
