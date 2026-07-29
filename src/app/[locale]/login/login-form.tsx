"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "framer-motion";
import { login } from "./actions";
import { Panel } from "@/components/ui/panel";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const boundLogin = login.bind(null, locale);
  const [state, formAction, pending] = useActionState(boundLogin, undefined);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-sm"
    >
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--color-border-strong)] bg-gradient-to-b from-[#3a3f47] to-[#1c1e22] text-sm font-bold tracking-widest text-white shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset]">
          FX
        </div>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">{t("signInTitle")}</h1>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t("signInSubtitle")}</p>
      </div>

      <Panel raised>
        <form action={formAction} className="space-y-4">
          <div>
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" name="password" type="password" required autoComplete="current-password" />
          </div>

          {state?.error && (
            <p className="rounded-lg bg-[var(--color-accent-red-dim)] px-3 py-2 text-xs text-[var(--color-accent-red)]">
              {t("invalidCredentials")}
            </p>
          )}

          <Button type="submit" variant="accent" className="w-full" disabled={pending}>
            {pending ? t("signingIn") : t("signIn")}
          </Button>
        </form>
      </Panel>

      <p className="mt-4 text-center text-xs text-[var(--color-text-faint)]">{t("noAccount")}</p>
    </motion.div>
  );
}
