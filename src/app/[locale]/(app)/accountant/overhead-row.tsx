"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { upsertOverhead } from "./actions";

export function OverheadRow({
  branchId,
  branchName,
  initialAmount,
  editable,
}: {
  branchId: string;
  branchName: string;
  initialAmount: number;
  editable: boolean;
}) {
  const [amount, setAmount] = useState(String(initialAmount));
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function save() {
    startTransition(async () => {
      await upsertOverhead(branchId, parseFloat(amount || "0"));
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    });
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-black/[0.02] px-3 py-2">
      <span className="text-sm">{branchName}</span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!editable}
          className="w-32"
        />
        {editable && (
          <Button variant="outline" size="sm" onClick={save} disabled={pending}>
            {saved ? "✓" : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}
