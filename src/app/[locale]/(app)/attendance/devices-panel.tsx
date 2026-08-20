"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Smartphone } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import type { TrustedDevice } from "@/lib/supabase/types";
import { revokeTrustedDevice } from "./manage-actions";

/**
 * The phones allowed to punch as you.
 *
 * ANYONE MAY REVOKE THEIR OWN, without asking a manager. That is the
 * lost-phone path and it must work on a Sunday evening — a device list
 * you can see but not act on would send people to WhatsApp instead.
 * The revocation goes through the user's own session (not the service
 * role) precisely so `record_audit()` stamps who did it.
 *
 * A revoked row is kept and shown, greyed. It is the answer to "was
 * this phone allowed to punch last March", and re-enrolling reuses the
 * same row rather than opening a second one.
 */
export function DevicesPanel({ devices }: { devices: TrustedDevice[] }) {
  const t = useTranslations("attendance");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await revokeTrustedDevice({ device_id: id });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      window.location.reload();
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("devicesTitle")} subtitle={t("devicesSubtitle")} />

      {error && (
        <p className="mb-3 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] px-3 py-2 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      {devices.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t("noDevices")}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <Smartphone
                size={16}
                className={
                  d.status === "active"
                    ? "text-[var(--color-text-muted)]"
                    : "text-[var(--color-text-faint)]"
                }
              />
              <div className="min-w-0 flex-1">
                {/* Rendered as text, never as markup: the label comes
                    from a user agent, which the client controls. */}
                <p className="truncate text-sm text-[var(--color-text)]">
                  {d.label ?? t("unknownDevice")}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {t("enrolledOn", { date: new Date(d.enrolled_at).toLocaleDateString() })}
                  {d.last_seen_at &&
                    ` · ${t("lastUsed", { date: new Date(d.last_seen_at).toLocaleDateString() })}`}
                </p>
              </div>
              <StatusPill
                label={t(`device_${d.status}`)}
                tone={d.status === "active" ? "green" : "neutral"}
              />
              {d.status === "active" && (
                <Button size="sm" variant="danger" disabled={pending} onClick={() => revoke(d.id)}>
                  {t("revokeDevice")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
