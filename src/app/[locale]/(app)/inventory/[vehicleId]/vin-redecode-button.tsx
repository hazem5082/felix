"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { decodeVin } from "@/lib/vin-decode";
import { saveVinDecodedDetails } from "../actions";

/**
 * Runs the VIN decode (lib/vin-decode.ts) against a vehicle ALREADY in
 * stock and saves the result via the column-limited grant 0041 opened.
 * createVehicle() only ever decodes at intake — every car taken in
 * before this feature existed has a VIN but no decoded details, and
 * without this button there is no screen where that gap could ever be
 * closed. Safe to press more than once: NHTSA coverage can improve, and
 * a first attempt that came back empty is worth retrying later.
 */
export function VinRedecodeButton({ vehicleId, vin }: { vehicleId: string; vin: string }) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ kind: "empty" | "error"; message: string } | null>(null);

  function handleClick() {
    setNote(null);
    startTransition(async () => {
      const result = await decodeVin(vin);
      if (!result || !result.decoded) {
        setNote({ kind: "empty", message: t("vinDecodeEmpty") });
        return;
      }
      const res = await saveVinDecodedDetails({
        vehicle_id: vehicleId,
        body_type: result.bodyType ?? "",
        engine_info: result.engineInfo ?? "",
        drive_type: result.driveType ?? "",
        doors: result.doors,
        plant_country: result.countryOfOrigin ?? "",
      });
      if ("error" in res) {
        setNote({ kind: "error", message: res.error });
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={pending}>
        <Sparkles size={13} />
        {pending ? common("loading") : t("decodeVin")}
      </Button>
      {note && (
        <p
          className={`mt-1.5 text-[11px] ${
            note.kind === "error" ? "text-[var(--color-accent-red)]" : "text-[var(--color-text-faint)]"
          }`}
        >
          {note.message}
        </p>
      )}
    </div>
  );
}
