"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCw } from "lucide-react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");

  useEffect(() => {
    // The digest is the only handle on the server-side stack, which Next
    // deliberately withholds from the client in production.
    console.error("[app] unhandled error", { digest: error.digest, message: error.message });
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
