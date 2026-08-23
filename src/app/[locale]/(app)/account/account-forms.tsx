"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { changePassword, updateCompanySettings, updateNotificationContacts } from "./actions";
import { changeSignInEmail } from "../employees/actions";
import { uploadFile } from "@/lib/upload-client";
import type { CompanySettings } from "@/lib/supabase/types";

export function AccountForms({
  profileId,
  signInEmail,
  notificationEmail,
  whatsappNumber,
  isCeo,
  company,
}: {
  profileId: string;
  signInEmail: string;
  notificationEmail: string | null;
  whatsappNumber: string | null;
  isCeo: boolean;
  company: CompanySettings | null;
}) {
  const t = useTranslations("account");
  const common = useTranslations("common");

  return (
    <>
      {/* The company letterhead (0046). CEO only — a branch manager
          changing the legal name on every contract the group issues is
          not a branch-level decision. The server action and the database
          policies both re-check the role; this only decides what to
          render. */}
      {isCeo && <CompanyPanel t={t} common={common} company={company} />}
      <SignInEmailPanel t={t} common={common} profileId={profileId} current={signInEmail} />
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

/**
 * The company profile printed on every contract, report and windshield
 * sticker (migration 0046). Distinct from the branch-level tax numbers
 * (0019/0022): this is the legal entity all the branches belong to.
 *
 * Nothing here is required. A showroom fills it in over time, and a
 * partly-complete letterhead beats a form that refuses to save.
 */
function CompanyPanel({
  t,
  common,
  company,
}: {
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
  company: CompanySettings | null;
}) {
  const [pending, startTransition] = useTransition();
  const [legalName, setLegalName] = useState(company?.legal_name ?? "");
  const [tradeName, setTradeName] = useState(company?.trade_name ?? "");
  const [logoUrl, setLogoUrl] = useState(company?.logo_url ?? "");
  const [taxId, setTaxId] = useState(company?.tax_id ?? "");
  const [commercialReg, setCommercialReg] = useState(company?.commercial_registration ?? "");
  const [address, setAddress] = useState(company?.address ?? "");
  const [phone, setPhone] = useState(company?.phone ?? "");
  const [email, setEmail] = useState(company?.email ?? "");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Let the same file be re-picked after a failure.
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(t("companyLogoNotImage"));
      return;
    }
    setError(null);
    setUploading(true);
    try {
      setLogoUrl(await uploadFile(file, "branding"));
    } catch (err) {
      setError(err instanceof Error ? err.message : common("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateCompanySettings({
        legal_name: legalName,
        trade_name: tradeName,
        logo_url: logoUrl,
        tax_id: taxId,
        commercial_registration: commercialReg,
        address,
        phone,
        email,
      });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("companyTitle")} subtitle={t("companySubtitle")} />

      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-[var(--color-border)] bg-black/[0.02] p-3">
        {logoUrl ? (
          // A CEO-uploaded R2 URL, not a stable remote pattern next/image
          // can be configured for — same reason every other uploaded
          // image in this app is a plain img.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={t("companyLogo")}
            className="h-14 w-auto max-w-[12rem] object-contain"
          />
        ) : (
          <div className="flex h-14 w-32 items-center justify-center rounded-md border border-dashed border-[var(--color-border-strong)] text-[11px] text-[var(--color-text-faint)]">
            {t("companyNoLogo")}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:bg-black/[0.03]">
            {uploading ? common("uploading") : t("companyUploadLogo")}
            <input type="file" accept="image/*" className="hidden" onChange={handleLogo} />
          </label>
          {logoUrl && (
            <button
              type="button"
              onClick={() => setLogoUrl("")}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)]"
            >
              {common("delete")}
            </button>
          )}
        </div>
        <p className="basis-full text-[11px] text-[var(--color-text-faint)]">{t("companyLogoHint")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("companyLegalName")}</Label>
          <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={200} />
          <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">{t("companyLegalNameHint")}</p>
        </div>
        <div>
          <Label>{t("companyTradeName")}</Label>
          <Input value={tradeName} onChange={(e) => setTradeName(e.target.value)} maxLength={200} />
        </div>
        {/* dir=ltr on both numbers: a tax registration is a Latin digit
            string read off a certificate even in the Arabic UI — the
            same treatment the VIN and the ETA item code already get. */}
        <div>
          <Label>{t("companyTaxId")}</Label>
          <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={50} dir="ltr" />
        </div>
        <div>
          <Label>{t("companyCommercialReg")}</Label>
          <Input
            value={commercialReg}
            onChange={(e) => setCommercialReg(e.target.value)}
            maxLength={50}
            dir="ltr"
          />
        </div>
        <div className="sm:col-span-2">
          <Label>{t("companyAddress")}</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
        </div>
        <div>
          <Label>{t("companyPhone")}</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} dir="ltr" />
        </div>
        <div>
          <Label>{t("companyEmail")}</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            dir="ltr"
          />
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-[var(--color-accent-red)]">{error}</p>}
      {saved && <p className="mt-2 text-xs text-[var(--color-accent-green)]">{common("saved")}</p>}

      <div className="mt-4 flex justify-end">
        <Button variant="accent" onClick={submit} disabled={pending || uploading}>
          {common("save")}
        </Button>
      </div>
    </Panel>
  );
}

/**
 * Change your own sign-in address.
 *
 * REQUIRES THE CURRENT PASSWORD, and that is the point rather than
 * friction for its own sake. The sign-in address is the account
 * recovery channel — whoever controls it can request a password reset —
 * so changing it is a credential change, and a borrowed unlocked laptop
 * must not be enough to redirect somebody's resets to an attacker's
 * inbox. `changeSignInEmail` enforces the same rule server-side for the
 * self path and deliberately does NOT for the supervisor path, where a
 * manager cannot know the password and the whole point is an employee
 * who has lost access to their inbox.
 *
 * Distinct from the notification address below it, which is a contact
 * preference and self-editable with no ceremony at all.
 */
function SignInEmailPanel({
  t,
  common,
  profileId,
  current,
}: {
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
  profileId: string;
  current: string;
}) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState(current);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function submit() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await changeSignInEmail({
        profile_id: profileId,
        new_email: email,
        current_password: password,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setPassword("");
      setSaved(true);
    });
  }

  const unchanged = email.trim().toLowerCase() === current.trim().toLowerCase();

  return (
    <Panel>
      <PanelHeader title={t("changeSignInEmail")} subtitle={t("signInEmailHint")} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("newEmail")}</Label>
          <Input
            type="email"
            dir="ltr"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("currentPassword")}</Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--color-accent-red)]">{error}</p>}
      {saved && <p className="mt-2 text-xs text-[var(--color-accent-green)]">{t("emailChanged")}</p>}
      <div className="mt-4 flex justify-end">
        <Button
          variant="accent"
          onClick={submit}
          disabled={pending || unchanged || !email.includes("@") || !password}
        >
          {common("save")}
        </Button>
      </div>
    </Panel>
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
