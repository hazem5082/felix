import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import type { CompanySettings } from "@/lib/supabase/types";

/**
 * The shared branding chrome for every printable FELIX document —
 * contracts, the whole report suite and the CPA windshield sticker. One
 * header, one footer, so a client holding a sale contract and an
 * investor holding a statement are looking at the same letterhead.
 *
 * The FELIX and 508.world marks are dark-on-transparent PNGs, so they
 * print correctly on white without any theme juggling.
 */

/**
 * The showroom's own letterhead identity (migration 0046), or null.
 *
 * Every print page needs this and none of them should each hand-roll the
 * query, so it lives beside the component that renders it. NULL is the
 * ORDINARY case, not an error: the tenant template is pure DDL and
 * cannot seed the row, so it does not exist until a CEO fills the form
 * in — and until then DocHeader falls back to the tenant name exactly as
 * it did before this existed.
 */
export async function getCompanySettings(): Promise<CompanySettings | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("company_settings").select("*").maybeSingle();
  return (data as CompanySettings | null) ?? null;
}

export async function DocHeader({
  showroomName,
  docTitle,
  meta,
  company,
}: {
  showroomName: string;
  docTitle: string;
  /** Right-hand column lines: serial, date range, generated-by … */
  meta: React.ReactNode;
  /** The company profile (0046). Absent until a CEO has saved one. */
  company?: CompanySettings | null;
}) {
  // The company's own name outranks the licence label from
  // platform.tenants — that label was chosen by 508.world at
  // provisioning and is not what the customer trades as. Trade name
  // first (the brand over the door), then legal name, then the
  // pre-0046 fallback.
  const headline =
    company?.trade_name?.trim() || company?.legal_name?.trim() || showroomName;
  // Shown under the headline only when it adds something — repeating
  // "Al-Nasr Motors" twice because trade and legal name match reads as a
  // rendering bug.
  const legalLine =
    company?.legal_name?.trim() && company.legal_name.trim() !== headline
      ? company.legal_name.trim()
      : null;

  const identifiers = [
    company?.tax_id?.trim() ? `Tax Reg. ${company.tax_id.trim()}` : null,
    company?.commercial_registration?.trim()
      ? `CR ${company.commercial_registration.trim()}`
      : null,
  ].filter(Boolean);

  const contact = [
    company?.address?.trim() || null,
    company?.phone?.trim() || null,
    company?.email?.trim() || null,
  ].filter(Boolean);

  return (
    <header className="border-b-2 border-black pb-4">
      <div className="flex items-center justify-between">
        {/* The customer's own logo takes the primary slot when they have
            uploaded one; FELIX's mark steps aside to the middle so the
            document reads as the showroom's paper, not the vendor's. */}
        {company?.logo_url ? (
          <div className="flex items-center gap-4">
            {/* A CEO-uploaded R2 URL, not a configured remote pattern —
                plain img for the same reason every other uploaded image
                in this app is one. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={company.logo_url}
              alt={headline}
              className="h-14 w-auto max-w-[16rem] object-contain"
            />
            <Image
              src="/brand/felix-logo.png"
              alt="FELIX"
              width={340}
              height={110}
              priority
              className="h-7 w-auto opacity-60"
            />
          </div>
        ) : (
          <Image
            src="/brand/felix-logo.png"
            alt="FELIX"
            width={340}
            height={110}
            priority
            className="h-12 w-auto"
          />
        )}
        <Image
          src="/brand/508world.png"
          alt="508.world"
          width={160}
          height={160}
          priority
          className="h-16 w-auto"
        />
      </div>
      <div className="mt-3 flex items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight">{headline}</h1>
          {legalLine && <p className="text-[12px] text-black/70">{legalLine}</p>}
          {identifiers.length > 0 && (
            // dir=ltr: tax and commercial-register numbers are Latin
            // digit strings even on an Arabic document.
            <p className="text-[11px] text-black/60" dir="ltr">
              {identifiers.join(" · ")}
            </p>
          )}
          {contact.length > 0 && (
            <p className="text-[11px] text-black/55">{contact.join(" · ")}</p>
          )}
          <p className="mt-0.5 text-black/60">{docTitle}</p>
        </div>
        <div className="shrink-0 text-end text-[12px] text-black/60">{meta}</div>
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
