"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * The locale-wide error boundary.
 *
 * `(app)/error.tsx` covers the authenticated shell; until this file
 * existed, everything OUTSIDE it — /login, /refer, /print/* — fell
 * through to Next's default crash page: unstyled, English-only, and
 * carrying no retry affordance. For a bilingual product whose print
 * routes are customer-facing documents, that was the one surface where a
 * crash looked least like an accident and most like the product's voice.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");

  useEffect(() => {
    console.error("[locale] unhandled error", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Panel raised className="w-full max-w-md text-center">
        <AlertTriangle
          className="mx-auto mb-3 text-[var(--color-accent-amber)]"
          size={32}
          aria-hidden
        />
        <h1 className="text-base font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("body")}</p>
        {error.digest && (
          <p className="num mt-3 text-xs text-[var(--color-text-faint)]">
            {t("reference")}: {error.digest}
          </p>
        )}
        <Button variant="accent" size="sm" className="mt-5" onClick={reset}>
          <RotateCw size={14} aria-hidden />
          {t("retry")}
        </Button>
      </Panel>
    </div>
  );
}
