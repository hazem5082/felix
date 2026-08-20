"use client";

import { useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { FileCheck2, Pencil } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { Contract, EtaSubmissionStatus } from "@/lib/supabase/types";
import { recordEtaInvoice } from "./eta-actions";

const STATUS_TONE: Record<EtaSubmissionStatus, SemanticTone> = {
  pending: "amber",
  submitted: "blue",
  accepted: "green",
  rejected: "red",
};

const STATUSES: EtaSubmissionStatus[] = ["pending", "submitted", "accepted", "rejected"];

/**
 * The ETA e-invoice linkage for one contract: read-only identifiers
 * next to where the internal serial already shows, plus a small
 * record/edit dialog for the finance roles. The showroom submits the
 * invoice on the ETA portal by hand — this only keeps the resulting
 * UUID / long ID / status against the sale (migration 0024).
 *
 * Renders nothing while there is no contract row: an e-invoice for an
 * unapproved deal is a category error, and the vault panel above
 * already explains the lock.
 */
export function EtaInvoicePanel({
  contract,
  canEdit,
  ticketId,
}: {
  contract: Contract | null;
  canEdit: boolean;
  ticketId: string;
}) {
  const t = useTranslations("deals");
  const common = useTranslations("common");
  const fmt = useFormatter();

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [uuid, setUuid] = useState(contract?.eta_uuid ?? "");
  const [longId, setLongId] = useState(contract?.eta_long_id ?? "");
  const [status, setStatus] = useState<string>(contract?.eta_submission_status ?? "submitted");
  const [submittedAt, setSubmittedAt] = useState(
    contract?.eta_submitted_at ? contract.eta_submitted_at.slice(0, 10) : ""
  );

  if (!contract) return null;

  // Loose != on purpose: until migration 0024 is applied by hand, a row
  // read through select("*") simply lacks the eta_* keys, and undefined
  // must read as "not recorded", not as a recorded blank.
  const recorded =
    contract.eta_uuid != null ||
    contract.eta_long_id != null ||
    contract.eta_submission_status != null;

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await recordEtaInvoice({
        ticketId,
        eta_uuid: uuid,
        eta_long_id: longId,
        eta_submission_status: status,
        eta_submitted_at: submittedAt,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
    });
  }

  const statusLabel = (s: EtaSubmissionStatus) =>
    s === "pending"
      ? t("etaStatusPending")
      : s === "submitted"
        ? t("etaStatusSubmitted")
        : s === "accepted"
          ? t("etaStatusAccepted")
          : t("etaStatusRejected");

  return (
    <Panel>
      <PanelHeader
        title={t("etaTitle")}
        subtitle={t("etaSubtitle")}
        action={
          canEdit ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Pencil size={14} />
                  {recorded ? t("etaEdit") : t("etaRecord")}
                </Button>
              </DialogTrigger>
              {open && (
                <DialogContent title={t("etaRecord")}>
                  <div className="space-y-3">
                    <div>
                      <Label>{t("etaUuid")}</Label>
                      <Input
                        value={uuid}
                        onChange={(e) => setUuid(e.target.value)}
                        dir="ltr"
                        className="font-mono"
                      />
                    </div>
                    <div>
                      <Label>{t("etaLongId")}</Label>
                      <Input
                        value={longId}
                        onChange={(e) => setLongId(e.target.value)}
                        dir="ltr"
                        className="font-mono"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>{t("etaStatus")}</Label>
                        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label>{t("etaSubmittedAt")}</Label>
                        <Input
                          type="date"
                          value={submittedAt}
                          onChange={(e) => setSubmittedAt(e.target.value)}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)]">{t("etaHint")}</p>
                  </div>
                  {error && (
                    <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>
                  )}
                  <div className="mt-5 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setOpen(false)}>
                      {common("cancel")}
                    </Button>
                    <Button variant="accent" onClick={submit} disabled={pending}>
                      {common("save")}
                    </Button>
                  </div>
                </DialogContent>
              )}
            </Dialog>
          ) : undefined
        }
      />

      {recorded ? (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <FileCheck2 size={16} className="text-[var(--color-accent-blue)]" />
            {contract.eta_submission_status ? (
              <StatusPill
                label={statusLabel(contract.eta_submission_status)}
                tone={STATUS_TONE[contract.eta_submission_status]}
              />
            ) : (
              <span className="text-[var(--color-text-muted)]">{t("etaNoStatus")}</span>
            )}
            {contract.eta_submitted_at && (
              <span className="text-xs text-[var(--color-text-muted)]">
                {fmt.dateTime(new Date(contract.eta_submitted_at), { dateStyle: "medium" })}
              </span>
            )}
          </div>
          <dl className="space-y-1">
            <div className="flex items-baseline gap-2">
              <dt className="w-28 shrink-0 text-xs text-[var(--color-text-muted)]">
                {t("etaUuid")}
              </dt>
              <dd className="num break-all font-mono text-xs" dir="ltr">
                {contract.eta_uuid ?? "—"}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-28 shrink-0 text-xs text-[var(--color-text-muted)]">
                {t("etaLongId")}
              </dt>
              <dd className="num break-all font-mono text-xs" dir="ltr">
                {contract.eta_long_id ?? "—"}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">{t("etaNotSubmitted")}</p>
      )}
    </Panel>
  );
}
