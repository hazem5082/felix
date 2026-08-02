"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Upload } from "lucide-react";
import { uploadFile } from "@/lib/upload-client";
import { attachContractFile } from "./actions";

/**
 * Attaches the bank's contract PDF to a partner that was saved without
 * one. Without this, a partner created before the file was to hand sat
 * at "Pending Upload" forever: it never appeared in the installments
 * dropdown, and there was no edit or delete, so the only way out was to
 * re-enter it and leave a permanent duplicate behind.
 */
export function PartnerContractUpload({ partnerId }: { partnerId: string }) {
  const t = useTranslations("accountant");
  const common = useTranslations("common");
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      try {
        const url = await uploadFile(file, "financing-contracts");
        const res = await attachContractFile(partnerId, url);
        if (res && "error" in res) setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : common("uploadFailed"));
      }
    });
  }

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white transition-colors hover:bg-white/10 disabled:opacity-50"
      >
        <Upload size={11} />
        {pending ? common("uploading") : t("uploadContract")}
      </button>
      {error && <p className="mt-1 text-[10px] text-[var(--color-accent-red)]">{error}</p>}
    </div>
  );
}
