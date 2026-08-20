"use client";

import { useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Copy, Check, ExternalLink } from "lucide-react";
import { formatMoney } from "@/lib/currency";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { BrandMark } from "@/components/ui/brand-mark";
import { cn } from "@/lib/utils";
import type { ListingChannel, ListingStatus, VehicleListing, VehicleStatus } from "@/lib/supabase/types";
import { upsertListing } from "./actions";

/** The shop-window columns only — this board never sees a cost (0028). */
export interface ListingVehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
  status: VehicleStatus;
  asking_price: number | null;
  photos: string[];
  features: string[];
  description: string | null;
}

const CHANNELS: ListingChannel[] = ["dubizzle", "facebook", "instagram", "tiktok", "website", "other"];
const STATUSES: ListingStatus[] = ["draft", "posted", "needs_update", "removed"];

const CHIP_TONE: Record<ListingStatus, string> = {
  draft: "border-[var(--color-border)] text-[var(--color-text-muted)]",
  posted: "border-[var(--color-accent-green)]/40 bg-[var(--color-accent-green)]/10 text-[var(--color-accent-green)]",
  needs_update: "border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 text-[var(--color-accent-amber)]",
  removed: "border-[var(--color-border)] text-[var(--color-text-faint)] line-through",
};

export function ListingsBoard({
  vehicles,
  listings,
}: {
  vehicles: ListingVehicle[];
  listings: VehicleListing[];
}) {
  const t = useTranslations("marketing");
  const inventory = useTranslations("inventory");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  const byKey = useMemo(() => {
    const m = new Map<string, VehicleListing>();
    for (const l of listings) m.set(`${l.vehicle_id}:${l.channel}`, l);
    return m;
  }, [listings]);

  const [editing, setEditing] = useState<{ vehicle: ListingVehicle; channel: ListingChannel } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /**
   * A ready-to-paste post: what the car is, what it costs the buyer, what
   * it has. Composed from the same fields the windshield sticker uses —
   * never the cost.
   */
  async function copyCaption(v: ListingVehicle) {
    const lines = [
      `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}`,
      v.asking_price != null ? formatMoney(v.asking_price, locale) : null,
      v.features.length ? v.features.slice(0, 6).map((f) => `• ${f}`).join("\n") : null,
      v.description,
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(v.id);
      setTimeout(() => setCopied((c) => (c === v.id ? null : c)), 1500);
    } catch {
      // Clipboard needs a secure context; the caption is not worth an error state.
    }
  }

  return (
    <Panel>
      <PanelHeader title={t("boardTitle")} subtitle={t("boardSubtitle")} />

      <div className="space-y-2">
        {vehicles.map((v) => (
          <div
            key={v.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {v.photos?.[0] ? (
              <img src={v.photos[0]} alt="" className="h-10 w-14 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex h-10 w-14 shrink-0 items-center justify-center rounded bg-black/[0.04]">
                <BrandMark make={v.make} size={16} />
              </span>
            )}

            <div className="min-w-40 flex-1">
              <p className="text-sm font-medium">
                {v.year} {v.make} {v.model} {v.trim ?? ""}
              </p>
              <p className="num text-xs text-[var(--color-text-muted)]">
                {v.asking_price != null ? (
                  formatMoney(v.asking_price, locale)
                ) : (
                  <span className="text-[var(--color-accent-amber)]">{inventory("notPriced")}</span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {CHANNELS.map((channel) => {
                const listing = byKey.get(`${v.id}:${channel}`);
                return (
                  <button
                    key={channel}
                    type="button"
                    onClick={() => setEditing({ vehicle: v, channel })}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:brightness-95",
                      listing
                        ? CHIP_TONE[listing.status]
                        : "border-dashed border-[var(--color-border)] text-[var(--color-text-faint)]"
                    )}
                    title={listing ? t(`status_${listing.status}`) : t("notListed")}
                  >
                    {t(`channel_${channel}`)}
                  </button>
                );
              })}
            </div>

            <Button variant="ghost" size="sm" onClick={() => copyCaption(v)}>
              {copied === v.id ? <Check size={12} /> : <Copy size={12} />}
              {copied === v.id ? t("captionCopied") : t("copyCaption")}
            </Button>
          </div>
        ))}

        {!vehicles.length && (
          <p className="py-6 text-center text-sm text-[var(--color-text-faint)]">{t("noStock")}</p>
        )}
      </div>

      {editing && (
        <ListingDialog
          vehicle={editing.vehicle}
          channel={editing.channel}
          listing={byKey.get(`${editing.vehicle.id}:${editing.channel}`) ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </Panel>
  );
}

function ListingDialog({
  vehicle,
  channel,
  listing,
  onClose,
  onSaved,
}: {
  vehicle: ListingVehicle;
  channel: ListingChannel;
  listing: VehicleListing | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("marketing");
  const common = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ListingStatus>(listing?.status ?? "draft");
  const [url, setUrl] = useState(listing?.url ?? "");
  const [note, setNote] = useState(listing?.note ?? "");

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await upsertListing({
        vehicle_id: vehicle.id,
        channel,
        status,
        url: url.trim(),
        note: note.trim(),
      });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      onSaved();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("listingFor", {
          channel: t(`channel_${channel}`),
          vehicle: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        })}
      >
        <div className="space-y-3">
          <div>
            <Label>{common("status")}</Label>
            <Select value={status} onChange={(e) => setStatus(e.target.value as ListingStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status_${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t("url")}</Label>
            <div className="flex items-center gap-2">
              <Input
                dir="ltr"
                type="url"
                placeholder="https://…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              {listing?.url && (
                <a
                  href={listing.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  aria-label={t("openPost")}
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>
          <div>
            <Label>{t("note")}</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {common("cancel")}
          </Button>
          <Button variant="accent" onClick={save} disabled={pending}>
            {common("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
