"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

export function ReferralLinkCard({ salespersonId }: { salespersonId: string }) {
  const t = useTranslations("crm");
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");

  if (typeof window !== "undefined" && !url) {
    setUrl(`${window.location.origin}/refer/${salespersonId}`);
  }

  function copy() {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Panel className="flex items-center justify-between">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{t("referralLink")}</p>
        <p className="num mt-1 text-sm text-[var(--color-text)]">{url}</p>
      </div>
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {t("copyLink")}
      </Button>
    </Panel>
  );
}
