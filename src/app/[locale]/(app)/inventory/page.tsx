import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile, canSeeCost } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import type { Vehicle, Branch } from "@/lib/supabase/types";
import { VehicleFormDialog } from "./vehicle-form";
import { InventoryBrowser } from "./inventory-browser";

export default async function InventoryPage() {
  const t = await getTranslations("inventory");
  const supabase = await createClient();
  const profile = await getProfile();

  const [{ data: vehicles }, { data: branches }] = await Promise.all([
    supabase.from("vehicles").select("*").order("created_at", { ascending: false }),
    supabase.from("branches").select("*"),
  ]);

  const canAdd = profile && ["ceo", "branch_manager"].includes(profile.role);
  const showCost = canSeeCost(profile);

  // The browser is a Client Component: its props are serialized into the
  // page payload whether or not a column renders them. For the sales
  // floor the cost is REDACTED here, not merely hidden (0028).
  const rows = ((vehicles as Vehicle[]) ?? []).map((v) =>
    showCost ? v : { ...v, purchase_price: 0 }
  );

  return (
    <div className="space-y-6">
      <PanelHeader
        title={t("title")}
        action={canAdd ? <VehicleFormDialog branches={(branches as Branch[]) ?? []} /> : undefined}
      />

      {/* Rows are filtered in the browser rather than re-queried: RLS has
          already decided which vehicles this profile may see, so the set here
          is the complete set they are entitled to. */}
      <InventoryBrowser
        vehicles={rows}
        branches={(branches as Branch[]) ?? []}
        showCost={showCost}
      />
    </div>
  );
}
