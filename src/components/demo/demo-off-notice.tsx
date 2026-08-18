import { getTranslations } from "next-intl/server";
import { Panel } from "@/components/ui/panel";
import { CirclePause } from "lucide-react";

/**
 * What the flagship demo shows when it is switched off.
 *
 * Deliberately shaped like not-found.tsx and the (app) error boundary —
 * a single raised panel, an icon, a line of explanation — because a
 * visitor who arrives mid-reset should feel like they hit a normal state
 * of a working product, not a broken deployment. Amber rather than red:
 * nothing has gone wrong, someone switched it off on purpose.
 *
 * `offMessage` is the operator's own text from public.demo_status, shown
 * verbatim when present so a reason can be published without a deploy.
 * It is written by 508.world operators through the shared registry, not
 * by any visitor, and React escapes it either way.
 */
export async function DemoOffNotice({ offMessage }: { offMessage: string | null }) {
  const t = await getTranslations("demo");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Panel raised className="w-full max-w-md text-center">
        <CirclePause
          className="mx-auto mb-3 text-[var(--color-accent-amber)]"
          size={32}
          aria-hidden
        />
        <h1 className="text-base font-semibold">{t("offTitle")}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          {offMessage ?? t("offBody")}
        </p>
      </Panel>
    </main>
  );
}
