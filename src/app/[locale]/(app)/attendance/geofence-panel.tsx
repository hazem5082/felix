"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Crosshair, ExternalLink, MapPin } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  DEFAULT_RADIUS_M,
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  googleMapsLink,
  parseCoordinate,
} from "@/lib/geo";
import { setBranchGeofence } from "./manage-actions";

interface BranchRow {
  id: string;
  name: string;
  latitude: number | string | null;
  longitude: number | string | null;
  geofence_radius_m: number | string | null;
}

/**
 * Place a showroom on the map and draw its fence.
 *
 * THE MAP IS OPTIONAL AND THE COORDINATES ARE NOT.
 *
 * The embedded Google map needs `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, and
 * a Maps key is billed per load. So the map is an ENHANCEMENT: without
 * the key this panel still works completely — coordinate fields, a
 * "use my current location" button, a radius, and a link out to Google
 * Maps to check the pin landed on the building rather than on the
 * roundabout outside it. A deployment that never sets the key loses a
 * picture, not a feature.
 *
 * The embed API is used rather than the full JavaScript SDK on purpose:
 * it is one <iframe>, it needs no script injection (this app runs behind
 * a strict CSP on Cloudflare), and the interaction it lacks — dragging
 * a pin — is replaced by the two things a manager actually does, which
 * are "I am standing in the showroom, use my position" and "I have the
 * coordinates from Google Maps on my desktop, paste them".
 */
export function GeofencePanel({ branches }: { branches: BranchRow[] }) {
  const t = useTranslations("attendance");
  const [pending, startTransition] = useTransition();
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");

  const branch = useMemo(() => branches.find((b) => b.id === branchId), [branches, branchId]);

  const [lat, setLat] = useState(() => str(branches[0]?.latitude));
  const [lng, setLng] = useState(() => str(branches[0]?.longitude));
  const [radius, setRadius] = useState(() => num(branches[0]?.geofence_radius_m, DEFAULT_RADIUS_M));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function selectBranch(id: string) {
    const b = branches.find((x) => x.id === id);
    setBranchId(id);
    setLat(str(b?.latitude));
    setLng(str(b?.longitude));
    setRadius(num(b?.geofence_radius_m, DEFAULT_RADIUS_M));
    setError(null);
    setSaved(false);
  }

  function useMyPosition() {
    setError(null);
    if (!navigator.geolocation) {
      setError(t("noGeolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
      },
      () => setError(t("geoUnavailable")),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }
    );
  }

  function save() {
    setError(null);
    setSaved(false);
    const parsedLat = lat.trim() === "" ? null : parseCoordinate(lat, "lat");
    const parsedLng = lng.trim() === "" ? null : parseCoordinate(lng, "lng");

    if ((lat.trim() !== "" && parsedLat === null) || (lng.trim() !== "" && parsedLng === null)) {
      setError(t("badCoordinates"));
      return;
    }
    if ((parsedLat === null) !== (parsedLng === null)) {
      setError(t("halfPin"));
      return;
    }

    startTransition(async () => {
      const res = await setBranchGeofence({
        branch_id: branchId,
        latitude: parsedLat,
        longitude: parsedLng,
        geofence_radius_m: radius,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  }

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const pinned = parseCoordinate(lat, "lat") !== null && parseCoordinate(lng, "lng") !== null;
  const at = pinned
    ? { latitude: Number(lat), longitude: Number(lng) }
    : null;

  // Zoom chosen from the radius so the fence roughly fills the frame:
  // a 25 m fence at zoom 15 is an invisible dot, and a 5 km one at
  // zoom 19 shows a wall.
  const zoom = radius <= 100 ? 19 : radius <= 300 ? 18 : radius <= 1000 ? 16 : 14;

  if (branches.length === 0) return null;

  return (
    <Panel>
      <PanelHeader title={t("geofenceTitle")} subtitle={t("geofenceSubtitle")} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label>{t("branch")}</Label>
          <Select value={branchId} onChange={(e) => selectBranch(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t("latitude")}</Label>
          <Input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            inputMode="decimal"
            placeholder="30.044420"
          />
        </div>
        <div>
          <Label>{t("longitude")}</Label>
          <Input
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            inputMode="decimal"
            placeholder="31.235712"
          />
        </div>
        <div>
          <Label>{t("radius", { metres: radius })}</Label>
          <input
            type="range"
            min={MIN_RADIUS_M}
            max={MAX_RADIUS_M}
            step={5}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="mt-3 w-full accent-[var(--color-accent)]"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={useMyPosition}>
          <Crosshair size={14} />
          {t("useMyPosition")}
        </Button>
        {at && (
          <a
            href={googleMapsLink(at)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--color-accent)] underline underline-offset-2"
          >
            <ExternalLink size={14} />
            {t("openInMaps")}
          </a>
        )}
        <Button size="sm" disabled={pending || !branchId} onClick={save}>
          {t("saveGeofence")}
        </Button>
        {saved && (
          <span className="text-sm text-[var(--color-accent-green)]">{t("geofenceSaved")}</span>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] px-3 py-2 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      {/* The map, when there is a key and a pin to show. */}
      {apiKey && at ? (
        <iframe
          title={t("mapTitle", { branch: branch?.name ?? "" })}
          className="mt-4 h-72 w-full rounded-md border border-[var(--color-border)]"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          src={`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(
            apiKey
          )}&q=${at.latitude},${at.longitude}&zoom=${zoom}`}
        />
      ) : (
        <p className="mt-4 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">
          <MapPin size={14} />
          {!apiKey ? t("mapKeyMissing") : t("mapNeedsPin")}
        </p>
      )}

      <p className="mt-3 text-xs text-[var(--color-text-muted)]">{t("geofenceNote")}</p>
    </Panel>
  );
}

function str(v: number | string | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

function num(v: number | string | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
