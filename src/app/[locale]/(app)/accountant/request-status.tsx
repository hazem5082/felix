"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Select } from "@/components/ui/input";
import type { FinancingRequestStatus } from "@/lib/supabase/types";
import { updateFinancingRequestStatus } from "./actions";

const STATUSES: FinancingRequestStatus[] = [
  "submitted",
  "in_review",
  "approved_by_bank",
  "rejected_by_bank",
];

/**
 * Moves a financing request through the bank workflow. The action
 * behind this existed since the first migration but had no caller, so
 * a request could be created and then never progress — the table was
 * read-only and the status pill was decoration.
 */
export function RequestStatusControl({
  requestId,
  status,
}: {
  requestId: string;
  status: FinancingRequestStatus;
}) {
  const t = useTranslations("accountant");
  const [value, setValue] = useState<FinancingRequestStatus>(status);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(next: FinancingRequestStatus) {
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const res = await updateFinancingRequestStatus(requestId, next);
      if (res && "error" in res) {
        setValue(previous); // put the control back where the data is
        setError(res.error);
      }
    });
  }

  return (
    <div>
      <Select
        className="h-8 text-xs"
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value as FinancingRequestStatus)}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {t(`requestStatus_${s}`)}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-[10px] text-[var(--color-accent-red)]">{error}</p>}
    </div>
  );
}
