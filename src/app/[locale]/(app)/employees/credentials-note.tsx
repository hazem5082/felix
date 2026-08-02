"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, KeyRound } from "lucide-react";

/**
 * The one place a temporary password is ever visible. It exists only in
 * this component's props for the lifetime of the dialog — never in the
 * database, the logs, or the URL — so the copy button matters: closing
 * the dialog is irreversible and the UI says so.
 */
export function CredentialsNote({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const t = useTranslations("employees");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${email}\n${password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the values are on screen; nothing to do.
    }
  }

  return (
    <div className="rounded-xl border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber-dim)] p-4">
      <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-accent-amber)]">
        <KeyRound size={13} />
        {t("credentialsTitle")}
      </p>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t("credentialsOnce")}</p>

      <div className="mt-3 space-y-1.5 rounded-lg bg-black/40 p-3 font-mono text-sm">
        <p className="select-all text-white">{email}</p>
        <p className="select-all text-white">{password}</p>
      </div>

      <button
        type="button"
        onClick={copy}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs text-white transition-colors hover:bg-white/10"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? t("copied") : t("copyBoth")}
      </button>
    </div>
  );
}
