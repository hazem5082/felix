import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
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
        vehicles={(vehicles as Vehicle[]) ?? []}
        branches={(branches as Branch[]) ?? []}
      />
    </div>
  );
}
