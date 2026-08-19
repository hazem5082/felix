"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Select } from "@/components/ui/input";
import type { LeadInterestStatus } from "@/lib/supabase/types";
import { setLeadInterestStatus } from "../actions";

/**
 * Inline status control for one interest.
 *
 * Optimistic on purpose — the select must not sit on the old value while a
 * round trip completes — but it reverts on failure rather than leaving the
 * control showing a state the database refused.
 */
export function InterestStatusSelect({
  id,
  status,
}: {
  id: string;
  status: LeadInterestStatus;
}) {
  const t = useTranslations("interest");
  const [value, setValue] = useState<LeadInterestStatus>(status);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(next: LeadInterestStatus) {
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const res = await setLeadInterestStatus({ id, status: next });
      if ("error" in res) {
        setValue(previous);
        setError(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        aria-label={t("status")}
        className="h-8 w-32 text-xs"
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value as LeadInterestStatus)}
      >
        <option value="open">{t("statusOpen")}</option>
        <option value="shown">{t("statusShown")}</option>
        <option value="declined">{t("statusDeclined")}</option>
      </Select>
      {error && <span className="text-[10px] text-[var(--color-accent-red)]">{error}</span>}
    </div>
  );
}
