"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Coffee, LogIn, LogOut, MapPin, ShieldAlert, Smartphone } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import {
  allowedNext,
  dayTone,
  formatDuration,
  localTime,
  type DaySummary,
  type PunchKind,
  type PunchState,
} from "@/lib/attendance";
import { DEVICE_SECRET_KEY, newDeviceSecret } from "@/lib/device";
import { distanceMetres, formatDistance, geofenceFromBranch, isWithinGeofence } from "@/lib/geo";
import { confirmDeviceCode, punch, requestDeviceCode } from "./actions";

interface BranchOption {
  id: string;
  name: string;
  latitude: number | string | null;
  longitude: number | string | null;
  geofence_radius_m: number | string | null;
}

type Position = { latitude: number; longitude: number; accuracy: number };

/**
 * The punch screen. Designed for a phone held in one hand in a
 * showroom doorway: one big button, one line of explanation, nothing
 * to scroll past before reaching it.
 *
 * WHAT THE PREVIEW HERE IS AND IS NOT
 * The "42 m from the showroom / inside the fence" line is a courtesy so
 * a person knows what will happen before they commit. It is NOT the
 * verdict — that is computed in Postgres on insert and comes back in
 * the response, which is what gets displayed afterwards. The two agree
 * because src/lib/geo.ts mirrors the SQL, and where they ever disagree
 * the database is right.
 */
export function PunchCard({
  branches,
  homeBranchId,
  state,
  today,
  offsetMinutes,
  workMode,
}: {
  branches: BranchOption[];
  homeBranchId: string | null;
  state: PunchState;
  today: DaySummary;
  offsetMinutes: number;
  workMode: "on_site" | "remote";
}) {
  const t = useTranslations("attendance");
  const [pending, startTransition] = useTransition();

  const [branchId, setBranchId] = useState(homeBranchId ?? branches[0]?.id ?? "");
  const [position, setPosition] = useState<Position | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ kind: PunchKind; within: boolean | null; distance: number | null } | null>(null);

  // The enrolment sub-flow, entered only when the server says this
  // phone is not trusted.
  const [enrol, setEnrol] = useState<"idle" | "needed" | "sent">("idle");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");

  const branch = useMemo(() => branches.find((b) => b.id === branchId) ?? null, [branches, branchId]);
  const fence = useMemo(() => (branch ? geofenceFromBranch(branch) : null), [branch]);

  const preview = useMemo(() => {
    if (!fence || !position) return null;
    const within = isWithinGeofence(fence, position, position.accuracy);
    return { within, distance: distanceMetres(fence, position) };
  }, [fence, position]);

  const requestPosition = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError(t("noGeolocation"));
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED ? t("geoDenied") : t("geoUnavailable")
        );
      },
      // A long timeout and no cached fix: a stale position from an hour
      // ago is exactly the wrong thing to stamp an arrival with.
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }
    );
  }, [t]);

  // Ask for a fix as soon as the screen opens. The browser only shows
  // its permission prompt in response to this call, so doing it on
  // mount means the prompt is answered while the person is looking at
  // the screen rather than after they have tapped the button.
  useEffect(() => {
    requestPosition();
  }, [requestPosition]);


  function deviceSecret(): string {
    let secret = window.localStorage.getItem(DEVICE_SECRET_KEY);
    if (!secret) {
      secret = newDeviceSecret();
      window.localStorage.setItem(DEVICE_SECRET_KEY, secret);
    }
    return secret;
  }

  function submit(kind: PunchKind) {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await punch({
        kind,
        branch_id: branchId,
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
        accuracy_m: position?.accuracy ?? null,
        device_secret: deviceSecret(),
      });

      if ("needsDevice" in res) {
        setEnrol("needed");
        setError(res.needsDevice === "revoked" ? t("deviceRevoked") : null);
        return;
      }
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setDone({ kind, within: res.within_geofence, distance: res.distance_m });
      // The state machine lives on the server; a refresh is the honest
      // way to pick up the new one rather than guessing it here.
      setTimeout(() => window.location.reload(), 1200);
    });
  }

  function sendCode() {
    setError(null);
    startTransition(async () => {
      const res = await requestDeviceCode({
        device_secret: deviceSecret(),
        user_agent: navigator.userAgent,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      if ("alreadyTrusted" in res) {
        setEnrol("idle");
        return;
      }
      setSentTo(res.sentTo);
      setEnrol("sent");
    });
  }

  function submitCode() {
    setError(null);
    startTransition(async () => {
      const res = await confirmDeviceCode({ device_secret: deviceSecret(), code });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setEnrol("idle");
      setCode("");
      window.location.reload();
    });
  }

  if (workMode === "remote") {
    return (
      <Panel>
        <PanelHeader title={t("remoteTitle")} subtitle={t("remoteBody")} />
      </Panel>
    );
  }

  const next = allowedNext(state);

  return (
    <Panel>
      <PanelHeader title={t("punchTitle")} subtitle={t(`state_${state}`)} />

      {/* Where. Hidden entirely when there is only one branch to pick. */}
      {branches.length > 1 && (
        <div className="mb-4 max-w-xs">
          <Label>{t("branch")}</Label>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* The location line. Says exactly what is known and what is not. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <MapPin size={15} className="text-[var(--color-text-muted)]" />
        {locating ? (
          <span className="text-[var(--color-text-muted)]">{t("locating")}</span>
        ) : geoError ? (
          <span className="text-[var(--color-accent-amber)]">{geoError}</span>
        ) : !fence ? (
          <span className="text-[var(--color-text-muted)]">{t("branchNotPinned")}</span>
        ) : preview ? (
          <span className={preview.within ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}>
            {preview.within
              ? t("insideFence", { distance: formatDistance(preview.distance) })
              : t("outsideFence", { distance: formatDistance(preview.distance) })}
          </span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{t("locationUnknown")}</span>
        )}
        <button
          type="button"
          onClick={requestPosition}
          className="text-xs text-[var(--color-accent)] underline underline-offset-2"
        >
          {t("refreshLocation")}
        </button>
      </div>

      {/* A punch outside the fence is ACCEPTED and flagged, never blocked.
          A geofence that stops someone recording a real day turns into a
          reason to keep a paper book beside it. */}
      {preview && !preview.within && (
        <p className="mb-4 rounded-md border border-[var(--color-accent-amber)]/30 bg-[var(--color-accent-amber-dim)] px-3 py-2 text-xs text-[var(--color-accent-amber)]">
          {t("outsideWarning")}
        </p>
      )}

      {enrol === "needed" && (
        <DevicePrompt t={t} onSend={sendCode} pending={pending} />
      )}

      {enrol === "sent" && (
        <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <p className="mb-3 text-sm text-[var(--color-text)]">{t("codeSent", { address: sentTo })}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Label>{t("codeLabel")}</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
              />
            </div>
            <Button onClick={submitCode} disabled={pending || code.length !== 6}>
              {t("confirmDevice")}
            </Button>
            <Button variant="ghost" onClick={sendCode} disabled={pending}>
              {t("resendCode")}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] px-3 py-2 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      {done && (
        <p className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-accent-green)]/30 bg-[var(--color-accent-green-dim)] px-3 py-2 text-sm text-[var(--color-accent-green)]">
          <CheckCircle2 size={15} />
          {t(`recorded_${done.kind}`)}
          {done.distance !== null && ` · ${formatDistance(done.distance)}`}
        </p>
      )}

      {/* The buttons. Big, because this is used standing up, one-handed. */}
      <div className="grid gap-2 sm:grid-cols-3">
        {next.map((kind) => (
          <Button
            key={kind}
            size="lg"
            variant={kind === "in" ? "primary" : kind === "out" ? "outline" : "ghost"}
            disabled={pending || !branchId}
            onClick={() => submit(kind)}
            className="h-14"
          >
            {kind === "in" && <LogIn size={17} />}
            {kind === "out" && <LogOut size={17} />}
            {(kind === "break_start" || kind === "break_end") && <Coffee size={17} />}
            {t(`punch_${kind}`)}
          </Button>
        ))}
      </div>

      <TodayLine t={t} today={today} offsetMinutes={offsetMinutes} />
    </Panel>
  );
}

function DevicePrompt({
  t,
  onSend,
  pending,
}: {
  t: ReturnType<typeof useTranslations>;
  onSend: () => void;
  pending: boolean;
}) {
  return (
    <div className="mb-4 rounded-md border border-[var(--color-accent-blue)]/30 bg-[var(--color-accent-blue-dim)] p-4">
      <p className="mb-1 flex items-center gap-2 text-sm font-medium text-[var(--color-accent-blue)]">
        <Smartphone size={15} />
        {t("newDeviceTitle")}
      </p>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">{t("newDeviceBody")}</p>
      <Button size="sm" onClick={onSend} disabled={pending}>
        {t("sendCode")}
      </Button>
    </div>
  );
}

function TodayLine({
  t,
  today,
  offsetMinutes,
}: {
  t: ReturnType<typeof useTranslations>;
  today: DaySummary;
  offsetMinutes: number;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--color-border)] pt-4 text-sm">
      <div>
        <span className="text-xs text-[var(--color-text-muted)]">{t("arrived")}</span>{" "}
        <span className="text-[var(--color-text)]">
          {today.firstIn ? localTime(today.firstIn, offsetMinutes) : "—"}
        </span>
      </div>
      <div>
        <span className="text-xs text-[var(--color-text-muted)]">{t("worked")}</span>{" "}
        <span className="text-[var(--color-text)]">{formatDuration(today.workedMinutes)}</span>
      </div>
      <div>
        <span className="text-xs text-[var(--color-text-muted)]">{t("onBreak")}</span>{" "}
        <span className="text-[var(--color-text)]">{formatDuration(today.breakMinutes)}</span>
      </div>
      {today.outsideFence > 0 && (
        <span className="flex items-center gap-1.5 text-xs text-[var(--color-accent-red)]">
          <ShieldAlert size={13} />
          {t("flaggedToday", { count: today.outsideFence })}
        </span>
      )}
      <StatusPill label={t(`status_${statusOf(today)}`)} tone={dayTone(statusOf(today))} />
    </div>
  );
}

function statusOf(day: DaySummary) {
  if (day.events.length === 0) return "absent" as const;
  if (day.outsideFence > 0) return "flagged" as const;
  if (day.adjusted) return "adjusted" as const;
  if (day.open) return "open" as const;
  return "present" as const;
}
