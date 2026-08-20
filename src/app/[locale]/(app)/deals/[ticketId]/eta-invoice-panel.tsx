"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { AlertTriangle, FileCheck2, Pencil, Send, ShieldAlert } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import type {
  Contract,
  EtaSubmission,
  EtaSubmissionRowStatus,
  EtaSubmissionStatus,
} from "@/lib/supabase/types";
import type { EtaMode } from "@/lib/eta/types";
import type { EtaPreview } from "@/lib/eta/service";
import {
  loadEtaSubmissions,
  previewEtaInvoice,
  recordEtaInvoice,
  submitEtaInvoice,
} from "./eta-actions";

const STATUS_TONE: Record<EtaSubmissionStatus, SemanticTone> = {
  pending: "amber",
  submitted: "blue",
  accepted: "green",
  rejected: "red",
};

const ROW_TONE: Record<EtaSubmissionRowStatus, SemanticTone> = {
  queued: "neutral",
  submitted: "blue",
  accepted: "green",
  rejected: "red",
  failed: "amber",
};

const STATUSES: EtaSubmissionStatus[] = ["pending", "submitted", "accepted", "rejected"];

/**
 * The ETA e-invoice for one contract, in two halves that must both keep
 * working.
 *
 * MANUAL TRANSCRIPTION (migration 0024) is unchanged and stays first in
 * the code for a reason: it is the CURRENT live behaviour, it is the
 * fallback whenever the API path is unavailable — no credentials, no
 * e-seal, a rejected document being chased on the portal by a human —
 * and a showroom that has not applied 0034 has nothing else.
 *
 * SUBMISSION (migration 0034) is the new half: build the document
 * server-side, show the accountant exactly what it says and what is
 * wrong with it, and only then send. The confirmation step is not
 * ceremony — an accepted ETA document is immutable, so the moment of
 * confirming is the last moment anything can be corrected.
 *
 * THE SANDBOX BADGE IS NOT DECORATION. When ETA_MODE is `mock` nothing
 * is filed with anybody, and a green "Accepted" pill next to a UUID is
 * exactly what a filed invoice looks like. The badge is what stops that
 * from being a lie, and it is rendered in both languages.
 *
 * Renders nothing while there is no contract row: an e-invoice for an
 * unapproved deal is a category error, and the vault panel above already
 * explains the lock.
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
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [uuid, setUuid] = useState(contract?.eta_uuid ?? "");
  const [longId, setLongId] = useState(contract?.eta_long_id ?? "");
  const [status, setStatus] = useState<string>(contract?.eta_submission_status ?? "submitted");
  const [submittedAt, setSubmittedAt] = useState(
    contract?.eta_submitted_at ? contract.eta_submitted_at.slice(0, 10) : ""
  );

  // ── submission half ───────────────────────────────────────
  const [submissions, setSubmissions] = useState<EtaSubmission[]>([]);
  const [mode, setMode] = useState<EtaMode | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [preview, setPreview] = useState<EtaPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await loadEtaSubmissions({ ticketId });
    if ("error" in result) return;
    setSubmissions(result.submissions);
    setMode(result.mode);
  }, [ticketId]);

  useEffect(() => {
    if (!contract) return;
    void refresh();
  }, [contract, refresh]);

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
      void refresh();
    });
  }

  async function openSubmitDialog() {
    setSubmitOpen(true);
    setPreview(null);
    setPreviewError(null);
    setBusy(true);
    const result = await previewEtaInvoice({ ticketId });
    setBusy(false);
    if ("error" in result) {
      setPreviewError(result.error);
      return;
    }
    setPreview(result);
  }

  async function confirmSubmit() {
    setPreviewError(null);
    setBusy(true);
    const result = await submitEtaInvoice({ ticketId });
    setBusy(false);
    await refresh();

    if ("error" in result) {
      setPreviewError(result.error);
      return;
    }
    if (!result.ok) {
      // Blockers appeared between the preview and the confirmation —
      // somebody edited the ticket in another tab. Re-render them rather
      // than closing on a submission that never happened.
      setPreview((p) => (p ? { ...p, blockers: result.blockers, summary: null } : p));
      return;
    }
    setSubmitOpen(false);
  }

  const statusLabel = (s: EtaSubmissionStatus) =>
    s === "pending"
      ? t("etaStatusPending")
      : s === "submitted"
        ? t("etaStatusSubmitted")
        : s === "accepted"
          ? t("etaStatusAccepted")
          : t("etaStatusRejected");

  const rowStatusLabel = (s: EtaSubmissionRowStatus) =>
    s === "queued"
      ? t("etaRowQueued")
      : s === "submitted"
        ? t("etaRowSubmitted")
        : s === "accepted"
          ? t("etaRowAccepted")
          : s === "rejected"
            ? t("etaRowRejected")
            : t("etaRowFailed");

  const modeLabel = (m: EtaMode) =>
    m === "mock" ? t("etaModeMock") : m === "preprod" ? t("etaModePreprod") : t("etaModeProduction");

  /**
   * Issue codes translated in a switch rather than through a computed
   * key. next-intl types its messages, so `t(`etaIssue_${code}`)` would
   * compile only by being cast to something that defeats the check — and
   * the check is what guarantees every code this panel can receive has a
   * sentence in both languages.
   */
  const issueLabel = (code: string, blocking: boolean): string => {
    switch (code) {
      case "ticketNotExecuted":
        return t("etaIssueTicketNotExecuted");
      case "missingContract":
        return t("etaIssueMissingContract");
      case "missingVatFields":
        return t("etaIssueMissingVatFields");
      case "nonPositivePrice":
        return t("etaIssueNonPositivePrice");
      case "missingIssuerRin":
        return t("etaIssueMissingIssuerRin");
      case "missingIssuerAddress":
        return t("etaIssueMissingIssuerAddress");
      case "missingBuyerId":
        return blocking ? t("etaIssueMissingBuyerId") : t("etaIssueMissingBuyerIdWarn");
      case "placeholderItemCode":
        return t("etaIssuePlaceholderItemCode");
      case "vatAmountMismatch":
        return t("etaIssueVatAmountMismatch");
      case "zeroVatRate":
        return t("etaIssueZeroVatRate");
      case "missingBuyerAddress":
        return t("etaIssueMissingBuyerAddress");
      case "missingIssuerBranchCode":
        return t("etaIssueMissingIssuerBranchCode");
      case "sandboxIssuerAddress":
        return t("etaIssueSandboxIssuerAddress");
      default:
        return code;
    }
  };

  const canSubmit =
    !!preview && preview.blockers.length === 0 && !preview.alreadySubmitted && !busy;

  return (
    <Panel>
      <PanelHeader
        title={t("etaTitle")}
        subtitle={t("etaSubtitle")}
        action={
          canEdit ? (
            <div className="flex items-center gap-2">
              <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
                <DialogTrigger asChild>
                  <Button variant="accent" size="sm" onClick={openSubmitDialog}>
                    <Send size={14} />
                    {t("etaSubmitAction")}
                  </Button>
                </DialogTrigger>
                {submitOpen && (
                  <DialogContent title={t("etaSubmitTitle")}>
                    {mode === "mock" && (
                      <p className="mb-3 rounded-md bg-[var(--color-accent-amber-dim)] px-3 py-2 text-xs text-[var(--color-accent-amber)]">
                        {t("etaSandboxWarning")}
                      </p>
                    )}

                    {busy && !preview && (
                      <p className="text-sm text-[var(--color-text-muted)]">{common("loading")}</p>
                    )}

                    {preview?.summary && (
                      <dl className="space-y-1.5 text-sm">
                        <PreviewRow label={t("etaPreviewDocNo")} value={preview.summary.internalId} mono />
                        <PreviewRow label={t("etaPreviewSeller")} value={`${preview.summary.issuerName} · ${preview.summary.issuerRin}`} />
                        <PreviewRow
                          label={t("etaPreviewBuyer")}
                          value={`${preview.summary.buyerName}${preview.summary.buyerId ? ` · ${preview.summary.buyerId}` : ""}`}
                        />
                        <PreviewRow label={t("etaPreviewItem")} value={preview.summary.itemDescription} />
                        <PreviewRow
                          label={t("etaPreviewItemCode")}
                          value={`${preview.summary.itemCode} (${preview.summary.itemType})`}
                          mono
                        />
                        <PreviewRow
                          label={t("etaPreviewBase")}
                          value={formatMoney(preview.summary.taxableBase, locale)}
                        />
                        <PreviewRow
                          label={t("etaPreviewVat")}
                          value={`${formatMoney(preview.summary.vatAmount, locale)} · ${preview.summary.vatRate}%`}
                        />
                        <PreviewRow
                          label={t("etaPreviewTotal")}
                          value={formatMoney(preview.summary.totalAmount, locale)}
                        />
                      </dl>
                    )}

                    {preview && preview.blockers.length > 0 && (
                      <div className="mt-4">
                        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent-red)]">
                          <ShieldAlert size={13} />
                          {t("etaBlockersTitle")}
                        </p>
                        <ul className="space-y-1">
                          {preview.blockers.map((b, i) => (
                            <li key={`${b.code}-${i}`} className="text-xs text-[var(--color-accent-red)]">
                              {issueLabel(b.code, true)}
                              {b.detail && (
                                <span className="text-[var(--color-text-muted)]"> ({b.detail})</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {preview && preview.warnings.length > 0 && (
                      <div className="mt-4">
                        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent-amber)]">
                          <AlertTriangle size={13} />
                          {t("etaWarningsTitle")}
                        </p>
                        <ul className="space-y-1">
                          {preview.warnings.map((w, i) => (
                            <li key={`${w.code}-${i}`} className="text-xs text-[var(--color-text-muted)]">
                              {issueLabel(w.code, false)}
                              {w.detail && <span className="opacity-70"> ({w.detail})</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {preview?.alreadySubmitted && (
                      <p className="mt-4 text-xs text-[var(--color-text-muted)]">
                        {t("etaAlreadySubmitted")}
                      </p>
                    )}

                    {previewError && (
                      <p className="mt-3 text-xs text-[var(--color-accent-red)]">{previewError}</p>
                    )}

                    <div className="mt-5 flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setSubmitOpen(false)}>
                        {common("cancel")}
                      </Button>
                      <Button variant="accent" onClick={confirmSubmit} disabled={!canSubmit}>
                        {busy ? t("etaSubmitting") : t("etaConfirmSubmit")}
                      </Button>
                    </div>
                  </DialogContent>
                )}
              </Dialog>

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
            </div>
          ) : undefined
        }
      />

      {mode && mode !== "production" && (
        <p className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent-amber-dim)] px-2 py-1 text-[11px] font-medium text-[var(--color-accent-amber)]">
          <AlertTriangle size={12} />
          {mode === "mock" ? t("etaModeMock") : t("etaModePreprod")}
          <span className="font-normal opacity-80">· {t("etaSandboxNote")}</span>
        </p>
      )}

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

      {submissions.length > 0 && (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
            {t("etaTimelineTitle")}
          </p>
          <ol className="space-y-3">
            {submissions.map((s) => (
              <li key={s.id} className="flex items-start gap-2.5">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-border-strong)]" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill label={rowStatusLabel(s.status)} tone={ROW_TONE[s.status]} />
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {t("etaAttempt", { n: s.attempt })} · {modeLabel(s.mode)}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {fmt.dateTime(new Date(s.created_at), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </span>
                  </div>

                  {s.eta_uuid && (
                    <p className="num break-all font-mono text-[11px]" dir="ltr">
                      {s.eta_uuid}
                      {s.eta_long_id ? ` · ${s.eta_long_id}` : ""}
                    </p>
                  )}

                  {s.status === "submitted" && !s.eta_uuid && (
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {t("etaSubmittedPending")}
                    </p>
                  )}

                  {s.warnings.length > 0 && (
                    <p className="text-[11px] text-[var(--color-accent-amber)]">
                      {s.warnings.map((code) => issueLabel(code, false)).join(" · ")}
                    </p>
                  )}

                  {s.error_detail && (
                    <p className="whitespace-pre-line text-[11px] text-[var(--color-accent-red)]">
                      {s.error_detail}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}

function PreviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-32 shrink-0 text-xs text-[var(--color-text-muted)]">{label}</dt>
      <dd
        className={mono ? "num break-all font-mono text-xs" : "break-words text-sm"}
        dir={mono ? "ltr" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
