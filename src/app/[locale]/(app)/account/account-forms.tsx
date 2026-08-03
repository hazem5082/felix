"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { changePassword, updateNotificationContacts } from "./actions";

export function AccountForms({
  notificationEmail,
  whatsappNumber,
}: {
  notificationEmail: string | null;
  whatsappNumber: string | null;
}) {
  const t = useTranslations("account");
  const common = useTranslations("common");

  return (
    <>
      <PasswordPanel t={t} common={common} />
      <NotificationsPanel
        t={t}
        common={common}
        initialEmail={notificationEmail ?? ""}
        initialWhatsapp={whatsappNumber ?? ""}
      />
    </>
  );
}

function PasswordPanel({
  t,
  common,
}: {
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
}) {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mismatch = next.length > 0 && confirm.length > 0 && next !== confirm;

  function submit() {
    setError(null);
    setSaved(false);
    if (next !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }
    startTransition(async () => {
      const res = await changePassword({ current_password: current, new_password: next });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("passwordTitle")} subtitle={t("passwordSubtitle")} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label>{t("currentPassword")}</Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("newPassword")}</Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("confirmPassword")}</Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      </div>
      {mismatch && <p className="mt-2 text-xs text-[var(--color-accent-red)]">{t("passwordMismatch")}</p>}
      {error && <p className="mt-2 text-xs text-[var(--color-accent-red)]">{error}</p>}
      {saved && <p className="mt-2 text-xs text-[var(--color-accent-green)]">{common("saved")}</p>}
      <div className="mt-4 flex justify-end">
        <Button
          variant="accent"
          onClick={submit}
          disabled={pending || !current || !next || !confirm}
        >
          {common("save")}
        </Button>
      </div>
    </Panel>
  );
}

function NotificationsPanel({
  t,
  common,
  initialEmail,
  initialWhatsapp,
}: {
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
  initialEmail: string;
  initialWhatsapp: string;
}) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState(initialEmail);
  const [whatsapp, setWhatsapp] = useState(initialWhatsapp);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function submit() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateNotificationContacts({
        notification_email: email,
        whatsapp_number: whatsapp,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("notificationsTitle")} subtitle={t("notificationsSubtitle")} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("notificationEmail")}</Label>
          <Input
            type="email"
            placeholder={t("notificationEmailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <Label>{t("whatsappNumber")}</Label>
            {/* The badge sits on the label, not under the field: someone
                deciding whether to type their number should see the caveat
                before they do, not after. */}
            <span className="mb-1 rounded-full bg-[var(--color-accent-amber-dim)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-accent-amber)]">
              {t("whatsappTrialBadge")}
            </span>
          </div>
          <Input
            type="tel"
            placeholder={t("whatsappNumberPlaceholder")}
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-text-faint)]">{t("whatsappHelper")}</p>
          <p className="mt-1 text-xs text-[var(--color-accent-amber)]">{t("whatsappTrialNote")}</p>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--color-accent-red)]">{error}</p>}
      {saved && <p className="mt-2 text-xs text-[var(--color-accent-green)]">{common("saved")}</p>}
      <div className="mt-4 flex justify-end">
        <Button variant="accent" onClick={submit} disabled={pending}>
          {common("save")}
        </Button>
      </div>
    </Panel>
  );
}
