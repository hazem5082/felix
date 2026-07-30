import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Panel } from "@/components/ui/panel";
import { FileQuestion } from "lucide-react";

export default async function NotFound() {
  const t = await getTranslations("errors");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Panel raised className="w-full max-w-md text-center">
        <FileQuestion
          className="mx-auto mb-3 text-[var(--color-text-faint)]"
          size={32}
          aria-hidden
        />
        <h1 className="text-base font-semibold">{t("notFoundTitle")}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("notFoundBody")}</p>
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center rounded-lg bg-[var(--color-accent-blue)] px-4 text-sm font-medium text-white hover:brightness-110"
        >
          {t("backHome")}
        </Link>
      </Panel>
    </main>
  );
}
