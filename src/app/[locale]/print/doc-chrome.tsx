import Image from "next/image";
import { getTranslations } from "next-intl/server";

/**
 * The shared branding chrome for every printable FELIX document —
 * contracts and the whole report suite. One header, one footer, so a
 * client holding a sale contract and an investor holding a statement
 * are looking at the same letterhead.
 *
 * Both marks are dark-on-transparent PNGs, so they print correctly on
 * white without any theme juggling.
 */
export async function DocHeader({
  showroomName,
  docTitle,
  meta,
}: {
  showroomName: string;
  docTitle: string;
  /** Right-hand column lines: serial, date range, generated-by … */
  meta: React.ReactNode;
}) {
  return (
    <header className="border-b-2 border-black pb-4">
      <div className="flex items-center justify-between">
        <Image
          src="/brand/felix-logo.png"
          alt="FELIX"
          width={340}
          height={110}
          priority
          className="h-12 w-auto"
        />
        <Image
          src="/brand/508world.png"
          alt="508.world"
          width={160}
          height={160}
          priority
          className="h-16 w-auto"
        />
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-black tracking-tight">{showroomName}</h1>
          <p className="text-black/60">{docTitle}</p>
        </div>
        <div className="text-end text-[12px] text-black/60">{meta}</div>
      </div>
    </header>
  );
}

export async function DocFooter({ line }: { line?: string }) {
  const t = await getTranslations("printDoc");
  return (
    <footer className="mt-10 border-t border-black/20 pt-3 text-[10px] text-black/45">
      {line && <p>{line}</p>}
      {/* The provenance line every FELIX document carries. */}
      <p className="mt-0.5 font-medium">{t("provenance")}</p>
    </footer>
  );
}
