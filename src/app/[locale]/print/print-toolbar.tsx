"use client";

import { useTranslations } from "next-intl";
import { Printer, X } from "lucide-react";

/**
 * Floating screen-only controls for a print page. `print:hidden` keeps
 * them off the paper; everything else on these pages is plain document.
 */
export function PrintToolbar() {
  const t = useTranslations("printDoc");
  return (
    <div className="fixed end-6 top-6 z-10 flex gap-2 print:hidden">
      <button
        type="button"
        onClick={() => window.print()}
        className="flex items-center gap-2 rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow-lg transition-opacity hover:opacity-80"
      >
        <Printer size={15} />
        {t("printSave")}
      </button>
      <button
        type="button"
        onClick={() => window.close()}
        className="flex items-center gap-2 rounded-xl border border-black/20 bg-white px-4 py-2 text-sm font-medium text-black shadow-lg transition-colors hover:bg-black/5"
      >
        <X size={15} />
        {t("close")}
      </button>
    </div>
  );
}
