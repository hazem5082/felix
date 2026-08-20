"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Ban } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/table";
import {
  PUNCH_KINDS,
  dayStatus,
  dayTone,
  formatDuration,
  localTime,
  type DaySummary,
} from "@/lib/attendance";
import { formatDistance } from "@/lib/geo";
import { recordAdjustment, voidAttendanceEvent } from "./manage-actions";

interface Row {
  profile: {
    id: string;
    full_name: string;
    role: string;
    branch_id: string | null;
    work_mode: string;
  };
  day: DaySummary;
}

/**
 * Who is in today, and the two corrections a manager can make.
 *
 * REMOTE STAFF ARE LISTED AND NOT COUNTED ABSENT. Their row says
 * "remote" rather than showing an accusing empty cell — the whole point
 * of the work_mode column is that an absence has to mean something.
 */
export function TeamBoard({
  rows,
  branches,
  offsetMinutes,
}: {
  rows: Row[];
  branches: { id: string; name: string }[];
  offsetMinutes: number;
}) {
  const t = useTranslations("attendance");
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const onSite = useMemo(() => rows.filter((r) => r.profile.work_mode === "on_site"), [rows]);
  const present = onSite.filter((r) => r.day.events.length > 0).length;
  const flagged = onSite.filter((r) => r.day.outsideFence > 0).length;
  const expandedRow = rows.find((r) => r.profile.id === expanded) ?? null;

  return (
    <Panel>
      <PanelHeader
        title={t("teamTitle")}
        subtitle={t("teamSubtitle", { present, total: onSite.length, flagged })}
      />

      <Table>
        <THead>
          <Th>{t("employee")}</Th>
          <Th>{t("arrived")}</Th>
          <Th>{t("left")}</Th>
          <Th>{t("worked")}</Th>
          <Th>{t("status")}</Th>
          <Th className="text-end">{t("actions")}</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const remote = row.profile.work_mode === "remote";
            const status = dayStatus(row.day);
            return (
              <Tr key={row.profile.id}>
                <Td>
                  <span className="text-[var(--color-text)]">{row.profile.full_name}</span>
                </Td>
                <Td>{row.day.firstIn ? localTime(row.day.firstIn, offsetMinutes) : "—"}</Td>
                <Td>{row.day.lastOut ? localTime(row.day.lastOut, offsetMinutes) : "—"}</Td>
                <Td>{remote ? "—" : formatDuration(row.day.workedMinutes)}</Td>
                <Td>
                  {remote ? (
                    <StatusPill label={t("workMode_remote")} tone="blue" />
                  ) : (
                    <StatusPill label={t(`status_${status}`)} tone={dayTone(status)} />
                  )}
                </Td>
                <Td className="text-end">
                  <div className="flex justify-end gap-1.5">
                    {row.day.events.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setExpanded(expanded === row.profile.id ? null : row.profile.id)
                        }
                      >
                        {t("punches", { count: row.day.events.length })}
                      </Button>
                    )}
                    {!remote && (
                      <Button size="sm" variant="outline" onClick={() => setAdjusting(row)}>
                        <Pencil size={13} />
                        {t("adjust")}
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>

      {expandedRow && (
        <PunchList
          row={expandedRow}
          offsetMinutes={offsetMinutes}
          onClose={() => setExpanded(null)}
        />
      )}

      {adjusting && (
        <AdjustForm row={adjusting} branches={branches} onClose={() => setAdjusting(null)} />
      )}
    </Panel>
  );
}

/**
 * The individual punches behind a day, with the void control.
 *
 * Every row shows how it got there: a GPS punch shows its distance, an
 * adjustment shows the reason the manager had to give. A voided row
 * stays visible, struck through — nothing in FELIX is deleted, and a
 * correction that hides what it corrected is worse than none.
 */
function PunchList({
  row,
  offsetMinutes,
  onClose,
}: {
  row: Row;
  offsetMinutes: number;
  onClose: () => void;
}) {
  const t = useTranslations("attendance");
  const [pending, startTransition] = useTransition();
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submitVoid(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await voidAttendanceEvent({ event_id: id, void_reason: reason });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      window.location.reload();
    });
  }

  return (
    <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-[var(--color-text)]">
          {t("punchesFor", { name: row.profile.full_name })}
        </p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("close")}
        </Button>
      </div>

      {error && (
        <p className="mb-3 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] px-3 py-2 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {row.day.events.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-14 text-[var(--color-text-muted)]">
              {localTime(e.occurred_at, offsetMinutes)}
            </span>
            <span className={e.voided_at ? "text-[var(--color-text-faint)] line-through" : ""}>
              {t(`punch_${e.kind}`)}
            </span>
            {e.source === "adjustment" ? (
              <StatusPill label={t("adjustedBy")} tone="amber" />
            ) : e.within_geofence === false ? (
              <StatusPill
                label={t("outsideShort", { distance: formatDistance(e.distance_m) })}
                tone="red"
              />
            ) : e.within_geofence === null ? (
              <StatusPill label={t("notAssessed")} tone="neutral" />
            ) : (
              <StatusPill label={t("insideShort")} tone="green" />
            )}
            {e.reason && (
              <span className="text-xs text-[var(--color-text-muted)]">&ldquo;{e.reason}&rdquo;</span>
            )}
            {!e.voided_at &&
              (voiding === e.id ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Input
                    value={reason}
                    onChange={(ev) => setReason(ev.target.value)}
                    placeholder={t("voidReasonPlaceholder")}
                    className="h-8 w-52"
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending || reason.trim().length === 0}
                    onClick={() => submitVoid(e.id)}
                  >
                    {t("confirmVoid")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setVoiding(null)}>
                    {t("cancel")}
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setVoiding(e.id);
                    setReason("");
                  }}
                >
                  <Ban size={13} />
                  {t("void")}
                </Button>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Enter a punch on somebody's behalf.
 *
 * The reason field is required by the form AND by a CHECK constraint,
 * because an adjustment without one is indistinguishable from a
 * fabrication when it is read back in six months.
 */
function AdjustForm({
  row,
  branches,
  onClose,
}: {
  row: Row;
  branches: { id: string; name: string }[];
  onClose: () => void;
}) {
  const t = useTranslations("attendance");
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<string>("in");
  const [when, setWhen] = useState(() => localDateTimeValue(new Date()));
  const [branchId, setBranchId] = useState(row.profile.branch_id ?? branches[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await recordAdjustment({
        profile_id: row.profile.id,
        branch_id: branchId,
        kind,
        // `datetime-local` yields a zoneless string; `new Date(...)` on
        // it reads the BROWSER's zone, which is the manager's own — the
        // right one, since they are typing a local wall-clock time.
        occurred_at: new Date(when).toISOString(),
        reason,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      window.location.reload();
    });
  }

  return (
    <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="mb-3 text-sm font-medium text-[var(--color-text)]">
        {t("adjustFor", { name: row.profile.full_name })}
      </p>

      {error && (
        <p className="mb-3 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] px-3 py-2 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label>{t("punchKind")}</Label>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {PUNCH_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`punch_${k}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t("when")}</Label>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div>
          <Label>{t("branch")}</Label>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-3">
        <Label>{t("adjustReason")}</Label>
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("adjustReasonPlaceholder")}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <Button disabled={pending || reason.trim().length === 0 || !branchId} onClick={submit}>
          {t("saveAdjustment")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

/** YYYY-MM-DDTHH:MM in the browser's own zone, for `datetime-local`. */
function localDateTimeValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
