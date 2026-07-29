"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Waterfall } from "@/components/waterfall";
import { updateChecklist, approveTicket, rejectTicket, executeSale, fetchWaterfallPreview } from "../actions";
import type { DealTicket, WaterfallPreview } from "@/lib/supabase/types";
import { CheckCircle2, Lock, ShieldCheck } from "lucide-react";

export function TicketPanel({
  ticket,
  canReview,
  canExecute,
  investorNames,
  contractSerial,
}: {
  ticket: DealTicket;
  canReview: boolean;
  canExecute: boolean;
  investorNames: Record<string, string>;
  contractSerial: string | null;
}) {
  const t = useTranslations("deals");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [preview, setPreview] = useState<WaterfallPreview | null>(null);

  const [checklist, setChecklist] = useState({
    financial_check_passed: ticket.financial_check_passed,
    discount_validated: ticket.discount_validated,
    rate_revalidated: ticket.rate_revalidated,
  });

  useEffect(() => {
    fetchWaterfallPreview(ticket.vehicle_id, ticket.agreed_price, ticket.discount_amount).then(setPreview);
  }, [ticket.vehicle_id, ticket.agreed_price, ticket.discount_amount]);

  function toggleCheck(key: keyof typeof checklist) {
    const next = { ...checklist, [key]: !checklist[key] };
    setChecklist(next);
    startTransition(async () => {
      await updateChecklist(ticket.id, { [key]: next[key] });
    });
  }

  const allChecked = checklist.financial_check_passed && checklist.discount_validated && checklist.rate_revalidated;

  function approve() {
    setError(null);
    startTransition(async () => {
      const res = await approveTicket(ticket.id);
      if (res.error) setError(res.error);
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const res = await rejectTicket(ticket.id, rejectReason);
      if (res.error) setError(res.error);
    });
  }

  function execute() {
    setError(null);
    startTransition(async () => {
      const res = await executeSale(ticket.id);
      if (res.error) setError(res.error);
    });
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {canReview && ticket.status === "submitted" && (
        <Panel>
          <PanelHeader title={t("reviewChecklist")} />
          <div className="space-y-2">
            <CheckRow label={t("financialCheck")} checked={checklist.financial_check_passed} onToggle={() => toggleCheck("financial_check_passed")} />
            <CheckRow label={t("discountValidated")} checked={checklist.discount_validated} onToggle={() => toggleCheck("discount_validated")} />
            <CheckRow label={t("rateRevalidated")} checked={checklist.rate_revalidated} onToggle={() => toggleCheck("rate_revalidated")} />
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

          {!showReject ? (
            <div className="mt-4 flex gap-2">
              <Button variant="success" size="sm" onClick={approve} disabled={!allChecked || pending}>
                <CheckCircle2 size={14} />
                {t("approve")}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setShowReject(true)} disabled={pending}>
                {t("reject")}
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <Textarea
                rows={2}
                placeholder={t("rejectionReason")}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button variant="danger" size="sm" onClick={reject} disabled={pending || !rejectReason.trim()}>
                  {common("confirm")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowReject(false)}>
                  {common("cancel")}
                </Button>
              </div>
            </div>
          )}
        </Panel>
      )}

      <Panel>
        <PanelHeader title={t("contractVault")} />
        {contractSerial ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[var(--color-accent-green)]">
              <ShieldCheck size={16} />
              <span className="num text-sm font-medium">{contractSerial}</span>
            </div>
            {canExecute && ticket.status === "approved" && (
              <Button variant="accent" size="sm" onClick={execute} disabled={pending}>
                {t("executeSale")}
              </Button>
            )}
            {ticket.status === "executed" && (
              <p className="text-xs text-[var(--color-accent-green)]">{misc("saleExecuted")}</p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[var(--color-text-faint)]">
            <Lock size={14} />
            <span className="text-sm">{t("contractLocked")}</span>
          </div>
        )}
      </Panel>

      <Panel className="md:col-span-2">
        <PanelHeader title={t("waterfall")} />
        {preview ? (
          <Waterfall preview={preview} investorNames={investorNames} />
        ) : (
          <p className="text-xs text-[var(--color-text-faint)]">{common("loading")}</p>
        )}
      </Panel>
    </div>
  );
}

function CheckRow({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={onToggle} className="h-4 w-4 accent-[var(--color-accent-blue)]" />
      {label}
    </label>
  );
}
