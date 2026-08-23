"use client";

import { useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveVinDecodedDetails } from "../actions";

/**
 * Re-decodes a vehicle ALREADY in stock — the retrofit path 0041 opened.
 * createVehicle() only ever decodes at intake; every car taken in
 * before this feature existed has a VIN but no decoded details, and
 * without this button there is no screen where that gap could ever be
 * closed.
 *
 * Fully server-driven (see saveVinDecodedDetails in ../actions.ts): this
 * component sends only the vehicle id and the viewer's own locale (for
 * the FraudRadar email's "view it" link, if this VIN turns out to
 * mismatch). The decode, what gets saved, and the fraud check all run
 * server-side off the VIN actually on record — never off anything
 * decoded in this browser tab.
 *
 * Deliberately still a manual, one-click action rather than something
 * that runs automatically when the page loads: re-running it on every
 * view of a car that stays mismatched would re-send the CEO the same
 * FraudRadar email every time anyone opened it.
 */
export function VinRedecodeButton({ vehicleId }: { vehicleId: string }) {
  const t = useTranslations("inventory");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ kind: "empty" | "error"; message: string } | null>(null);

  function handleClick() {
    setNote(null);
    startTransition(async () => {
      const res = await saveVinDecodedDetails({ vehicle_id: vehicleId, locale: locale === "ar" ? "ar" : "en" });
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
