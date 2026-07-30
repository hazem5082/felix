"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

export function ReferralLinkCard({ salespersonId }: { salespersonId: string }) {
  const t = useTranslations("crm");
  const common = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");

  // window.location is only available after mount; setting state during
  // render (as this did) forces an extra render pass and is unsafe under
  // concurrent rendering.
  useEffect(() => {
    setUrl(`${window.location.origin}/refer/${salespersonId}`);
  }, [salespersonId]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access is denied outside a secure context — select the
      // text instead of failing silently.
      const selection = window.getSelection();
      const node = document.getElementById("referral-link-value");
      if (selection && node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  return (
    <Panel className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {t("referralLink")}
        </p>
        <p id="referral-link-value" className="num mt-1 truncate text-sm text-[var(--color-text)]">
          {url || "…"}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={copy} disabled={!url}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? common("copied") : t("copyLink")}
      </Button>
    </Panel>
  );
}
