import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Link } from "@/i18n/navigation";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { vehicleStatusTone } from "@/lib/status-tone";
import type { Vehicle, Branch } from "@/lib/supabase/types";
import { VehicleFormDialog } from "./vehicle-form";

export default async function InventoryPage() {
  const t = await getTranslations("inventory");
  const common = await getTranslations("common");
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

      <Panel>
        <Table>
          <THead>
            <Th>{t("year")}</Th>
            <Th>{t("make")} / {t("model")}</Th>
            <Th>{t("vin")}</Th>
            <Th>{t("purchasePrice")}</Th>
            <Th>{t("branch")}</Th>
            <Th>{common("status")}</Th>
          </THead>
          <TBody>
            {((vehicles as Vehicle[]) ?? []).map((v) => (
              <Tr key={v.id}>
                <Td>
                  <Link href={`/inventory/${v.id}`} className="hover:underline">
                    {v.year}
                  </Link>
                </Td>
                <Td>
                  <Link href={`/inventory/${v.id}`} className="hover:underline">
                    {v.make} {v.model} {v.trim ? `· ${v.trim}` : ""}
                  </Link>
                </Td>
                <Td className="text-[var(--color-text-faint)]">{v.vin || "—"}</Td>
                <Td className="num">${v.purchase_price.toLocaleString()}</Td>
                <Td>{(branches as Branch[] | null)?.find((b) => b.id === v.branch_id)?.name ?? "—"}</Td>
                <Td>
                  <StatusPill
                    label={
                      v.status === "sold"
                        ? t("statusSold")
                        : v.status === "reserved"
                          ? t("statusReserved")
                          : t("statusInStock")
                    }
                    tone={vehicleStatusTone(v.status)}
                  />
                </Td>
              </Tr>
            ))}
            {!vehicles?.length && (
              <Tr>
                <Td className="text-center text-[var(--color-text-faint)]" >
                  {common("noResults")}
                </Td>
              </Tr>
            )}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
