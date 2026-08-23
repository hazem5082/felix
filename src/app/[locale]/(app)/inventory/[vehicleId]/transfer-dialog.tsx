"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ArrowRightLeft } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { StatusPill, type SemanticTone } from "@/components/ui/status-pill";
import { canActOnBranchWithGrants } from "@/lib/branch-authority";
import type { Branch, Role, StockTransfer, VehicleStatus } from "@/lib/supabase/types";
import { acceptTransfer, cancelTransfer, loadVehicleTransfers, requestTransfer } from "./transfer-actions";

const STATUS_TONE: Record<StockTransfer["status"], SemanticTone> = {
  requested: "amber",
  accepted: "green",
  cancelled: "neutral",
};

/**
 * Self-contained branch-transfer panel for the vehicle detail page
 * (migration 0035). Shows the open request (if any) with the
 * accept/cancel controls the viewer's branch authority earns them,
 * a request form when the vehicle is free to move, and a compact
 * history of past transfers.
 *
 * `role`/`homeBranchId`/`grantedBranchIds` are the same three values
 * `canActOnBranch()` (lib/auth.ts) is built from — passed down because
 * this is a client component and that helper is server-only.
 * canActOnBranchWithGrants() (lib/branch-authority.ts) is its pure,
 * client-safe twin, imported directly here rather than re-derived, so
 * the panel narrows its buttons by exactly the rule the server actions
 * and the database re-check.
 */
export function TransferPanel({
  vehicleId,
  currentBranchId,
  vehicleStatus,
  branches,
  role,
  homeBranchId,
  grantedBranchIds,
}: {
  vehicleId: string;
  currentBranchId: string;
  vehicleStatus: VehicleStatus;
  branches: Branch[];
  role: Role;
  homeBranchId: string | null;
  grantedBranchIds: string[];
}) {
  const t = useTranslations("transfers");
  const common = useTranslations("common");
  const fmt = useFormatter();

  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [toBranchId, setToBranchId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * `finally`, and it is load-bearing (0043).
   *
   * loadVehicleTransfers() is a Server Action, so this is a POST across
   * the network: it does not merely RETURN an error, it can THROW one —
   * a dropped connection, a restarted server, a redeploy mid-session.
   * The original body awaited it bare and set `loaded` on the line
   * after, so any throw skipped that line, left `loaded` false forever,
   * and pinned the panel on "Loading…" with no message and no retry.
   * That is the whole visible symptom of "transfers don't work": the
   * request may well have succeeded server-side, but this panel could
   * never say so.
   *
   * So: `loaded` is set in `finally` — the panel always leaves its
   * loading state — and a failure is SURFACED rather than swallowed.
   * The returned-error case is now shown too; it used to be dropped on
   * the floor, rendering "no transfer in progress" for what was really
   * "we could not find out".
   */
  const refresh = useCallback(async () => {
    try {
      const result = await loadVehicleTransfers(vehicleId);
      if ("error" in result) {
        setError(result.error);
      } else {
        setTransfers(result);
        setError(null);
      }
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoaded(true);
    }
  }, [vehicleId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openTransfer = transfers.find((tr) => tr.status === "requested") ?? null;
  const history = transfers.filter((tr) => tr.status !== "requested");

  const canActHere = canActOnBranchWithGrants(role, homeBranchId, currentBranchId, grantedBranchIds);
  const canRequest = loaded && !openTransfer && vehicleStatus !== "sold" && canActHere;
  // The two ends of the OPEN request, evaluated once — the decide
  // buttons below and cancelTransfer() on the server derive the same
  // accept/decline/cancel split from exactly this pair.
  const onSource =
    !!openTransfer &&
    canActOnBranchWithGrants(role, homeBranchId, openTransfer.from_branch_id, grantedBranchIds);
  const onDestination =
    !!openTransfer &&
    canActOnBranchWithGrants(role, homeBranchId, openTransfer.to_branch_id, grantedBranchIds);
  const destinationBranches = branches.filter((b) => b.id !== currentBranchId);

  function submitRequest() {
    setError(null);
    startTransition(async () => {
      const res = await requestTransfer({ vehicleId, toBranchId, note });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setToBranchId("");
      setNote("");
      void refresh();
    });
  }

  function doAccept(transferId: string) {
    setError(null);
    startTransition(async () => {
      const res = await acceptTransfer(transferId);
      if ("error" in res) setError(res.error);
      void refresh();
    });
  }

  function doCancel(transferId: string) {
    setError(null);
    startTransition(async () => {
      const res = await cancelTransfer(transferId);
      if ("error" in res) setError(res.error);
      void refresh();
    });
  }

  const statusLabel = (s: StockTransfer["status"]) =>
    s === "requested" ? t("statusRequested") : s === "accepted" ? t("statusAccepted") : t("statusCancelled");

  const branchLabel = (tr: StockTransfer) =>
    `${tr.from_branch?.name ?? "—"} → ${tr.to_branch?.name ?? "—"}`;

  return (
    <Panel>
      <PanelHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          canRequest ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <ArrowRightLeft size={14} />
                  {t("requestButton")}
                </Button>
              </DialogTrigger>
              {open && (
                <DialogContent title={t("requestButton")}>
                  <div className="space-y-3">
                    <div>
                      <Label>{t("destinationBranch")}</Label>
                      <Select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
                        <option value="">{t("selectPlaceholder")}</option>
                        {destinationBranches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>{t("note")}</Label>
                      <Textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={t("notePlaceholder")}
                      />
                    </div>
                  </div>
                  {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
                  <div className="mt-5 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setOpen(false)}>
                      {common("cancel")}
                    </Button>
                    <Button variant="accent" onClick={submitRequest} disabled={pending || !toBranchId}>
                      {common("save")}
                    </Button>
                  </div>
                </DialogContent>
              )}
            </Dialog>
          ) : undefined
        }
      />

      {!loaded ? (
        <p className="text-sm text-[var(--color-text-muted)]">{common("loading")}</p>
      ) : openTransfer ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={statusLabel(openTransfer.status)} tone={STATUS_TONE[openTransfer.status]} />
            <span className="text-sm text-[var(--color-text)]">{branchLabel(openTransfer)}</span>
          </div>
          {openTransfer.note && (
            <p className="text-xs text-[var(--color-text-muted)]">{openTransfer.note}</p>
          )}
          {/* Which end you stand on decides what you may do (0043), and
              this mirrors cancelTransfer()'s own split exactly — the
              receiving branch DECLINES, the sending branch CANCELS, and
              an org-wide role (true at both ends) reads as the sender,
              so the CEO gets accept + cancel rather than a "decline"
              that would mail the wrong branch. */}
          <div className="flex gap-2">
            {onDestination && (
              <Button variant="success" size="sm" onClick={() => doAccept(openTransfer.id)} disabled={pending}>
                {t("accept")}
              </Button>
            )}
            {onDestination && !onSource && (
              <Button variant="danger" size="sm" onClick={() => doCancel(openTransfer.id)} disabled={pending}>
                {t("decline")}
              </Button>
            )}
            {onSource && (
              <Button variant="danger" size="sm" onClick={() => doCancel(openTransfer.id)} disabled={pending}>
                {t("cancel")}
              </Button>
            )}
          </div>
        </div>
      ) : error ? (
        // "No transfer in progress" is a FACT about this car, and it is
        // only true if the lookup actually answered. When it failed, the
        // error below stands alone rather than under a confident claim
        // the panel is in no position to make.
        null
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">{t("noneOpen")}</p>
      )}

      {error && !open && !openTransfer && (
        <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>
      )}

      {history.length > 0 && (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{t("history")}</p>
          <ol className="space-y-3">
            {history.map((tr) => (
              <li key={tr.id} className="flex items-start gap-2.5">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-border-strong)]" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill label={statusLabel(tr.status)} tone={STATUS_TONE[tr.status]} />
                    <span className="text-xs text-[var(--color-text-muted)]">{branchLabel(tr)}</span>
                  </div>
                  <p className="text-[11px] text-[var(--color-text-faint)]">
                    {fmt.dateTime(new Date(tr.requested_at), { dateStyle: "medium", timeStyle: "short" })}
                    {tr.decided_at &&
                      ` · ${fmt.dateTime(new Date(tr.decided_at), { dateStyle: "medium", timeStyle: "short" })}`}
                  </p>
                  {tr.note && <p className="text-[11px] text-[var(--color-text-faint)]">{tr.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}
