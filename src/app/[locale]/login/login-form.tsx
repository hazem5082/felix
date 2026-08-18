"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "framer-motion";
import Image from "next/image";
import { login } from "./actions";
import { Panel } from "@/components/ui/panel";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DemoSwitcher } from "@/components/demo/demo-switcher";
import type { DemoPersona } from "@/lib/demo-accounts";

export function LoginForm({
  locale,
  showroomName,
  demoPersonas,
}: {
  locale: string;
  showroomName: string | null;
  /**
   * Null everywhere except the flagship demo with the demo switched on.
   * When present, the visitor never needs a password at all.
   */
  demoPersonas?: DemoPersona[] | null;
}) {
  const t = useTranslations("auth");
  const boundLogin = login.bind(null, locale);
  const [state, formAction, pending] = useActionState(boundLogin, undefined);

  // Non-null only on the flagship demo with the demo switched on (see the
  // prop doc above). There the persona panel IS the sign-in flow — the
  // password form never renders — rather than a shortcut sitting beneath
  // it. Every licensed showroom takes the `else` branch exactly as before.
  // (Re-derived as its own variable, rather than reused as a boolean flag,
  // so the ternary below narrows `activeDemoPersonas` to non-null.)
  const activeDemoPersonas = demoPersonas && demoPersonas.length > 0 ? demoPersonas : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-sm"
    >
      <div className="mb-6 text-center">
        <Image
          src="/brand/felix-logo.png"
          alt="FELIX"
          width={420}
          height={140}
          className="mx-auto mb-4 h-10 w-auto"
          priority
        />
        <h1 className="text-lg font-semibold text-[var(--color-text)]">{t("signInTitle")}</h1>
        {/* Which licensed showroom this subdomain belongs to. Makes it
            obvious at a glance that you're at the right client's door. */}
        {showroomName ? (
          <p className="mt-1 text-xs font-medium text-[var(--color-text-muted)]">{showroomName}</p>
        ) : (
          <p className="mt-1 text-xs text-[var(--color-accent-red)]">{t("unknownTenant")}</p>
        )}
        <p className="mt-1 text-xs text-[var(--color-text-faint)]">{t("signInSubtitle")}</p>
      </div>

      {activeDemoPersonas ? (
        // The flagship demo, switched on: the persona panel IS the sign-in
        // flow, not a shortcut under it. The password form never renders
        // here — a prospect should never be shown a field there's no
        // password to fill in. Password login stays functional at the
        // server-action level (see ./actions.ts) for every non-flagship
        // tenant; on this host it's simply not on the page.
        <DemoSwitcher
          locale={locale}
          personas={activeDemoPersonas}
          currentKey={null}
          variant="login"
        />
      ) : (
        <>
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
                <p
                  role="alert"
                  className="rounded-lg bg-[var(--color-accent-red-dim)] px-3 py-2 text-xs text-[var(--color-accent-red)]"
                >
                  {state.error === "throttled"
                    ? `${t("tooManyAttempts")} ${state.message ?? ""}`.trim()
                    : state.error === "wrongTenant"
                      ? t("wrongTenant")
                      : state.error === "tenantSuspended"
                        ? t("tenantSuspended")
                        : state.error === "demoOff"
                          ? t("demoOff")
                          : t("invalidCredentials")}
                </p>
              )}

              <Button type="submit" variant="accent" className="w-full" disabled={pending}>
                {pending ? t("signingIn") : t("signIn")}
              </Button>
            </form>
          </Panel>

          <p className="mt-4 text-center text-xs text-[var(--color-text-faint)]">{t("noAccount")}</p>
        </>
      )}
    </motion.div>
  );
}
