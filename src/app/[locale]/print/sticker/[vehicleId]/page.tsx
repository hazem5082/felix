import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveTenant, STAFF_ROLES } from "@/lib/auth";
import { getTenant } from "@/lib/tenant";
import { formatMoney } from "@/lib/currency";
import { colorLabel } from "@/lib/vehicle-color";
import { originLabel } from "@/lib/vehicle-origin";
import type { DealTicket, Vehicle } from "@/lib/supabase/types";
import { PrintToolbar } from "../../print-toolbar";
import { DocFooter, DocHeader } from "../../doc-chrome";

/**
 * The CPA windshield sticker — Consumer Protection Agency Decision
 * 115/2021 requires every displayed vehicle to carry a sticker naming
 * the country of origin and a standardized feature/amenities list, with
 * the price inclusive of tax. Browser print-to-PDF is the export path,
 * as on every other FELIX print page.
 *
 * ARABIC-FIRST, BY LAW. The sticker faces the Egyptian public, so its
 * labels render from the `ar` message catalogue regardless of the UI
 * locale the staff member happens to be browsing in, with the Latin
 * label beneath as a fallback. The whole sheet is dir="rtl".
 *
 * PRICE. FELIX has no display-price concept for in-stock vehicles (the
 * schema carries only the internal purchase_price, which must never be
 * shown to a customer). When the vehicle has an active deal ticket
 * (submitted or approved), its agreed price — minus discount, plus VAT
 * when the ticket says the price excludes it — is printed as the
 * tax-inclusive price. Otherwise the price area renders as a blank
 * ruled line for the showroom to hand-write.
 *
 * Any staff role may print it: hanging the sticker is a showroom-floor
 * task, and nothing on it is internal.
 */
export default async function StickerPrintPage({
  params,
}: {
  params: Promise<{ locale: string; vehicleId: string }>;
}) {
  const { locale, vehicleId } = await params;
  await requireActiveTenant(locale, STAFF_ROLES);

  // The legally required face of the document is Arabic; the UI locale
  // only decides the Latin fallback line, which stays English either way.
  const ar = await getTranslations({ locale: "ar", namespace: "stickerDoc" });
  const en = await getTranslations({ locale: "en", namespace: "stickerDoc" });
  const colorsAr = await getTranslations({ locale: "ar", namespace: "colors" });
  const originsAr = await getTranslations({ locale: "ar", namespace: "origins" });

  const supabase = await createClient();
  const tenant = await getTenant();

  const [{ data: vehicleRow }, { data: ticketRow }] = await Promise.all([
    supabase.from("vehicles").select("*").eq("id", vehicleId).maybeSingle(),
    supabase
      .from("deal_tickets")
      .select("agreed_price, discount_amount, vat_amount, price_includes_vat")
      .eq("vehicle_id", vehicleId)
      .in("status", ["submitted", "approved"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!vehicleRow) notFound();

  const v = vehicleRow as Vehicle;
  const ticket = ticketRow as Pick<
    DealTicket,
    "agreed_price" | "discount_amount" | "vat_amount" | "price_includes_vat"
  > | null;

  // Tax-inclusive by construction: when the ticket recorded a
  // VAT-exclusive price, the recorded VAT is added back on.
  const displayPrice = ticket
    ? Number(ticket.agreed_price) -
      Number(ticket.discount_amount) +
      (ticket.price_includes_vat === false && ticket.vat_amount != null
        ? Number(ticket.vat_amount)
        : 0)
    : null;

  const features = v.features.filter((f) => f.trim());

  /** Arabic label with the small Latin fallback beneath. */
  const label = (key: string) => (
    <>
      <span className="block font-bold">{ar(key)}</span>
      <span className="block text-[10px] text-black/45" dir="ltr">
        {en(key)}
      </span>
    </>
  );

  return (
    <article dir="rtl" lang="ar" className="relative text-[14px] leading-relaxed text-black">
      <PrintToolbar />

      <DocHeader
        showroomName={tenant?.name ?? "FELIX"}
        docTitle={`${ar("title")} — ${en("title")}`}
        meta={
          <>
            {/* Make/model stay Latin — they are stored canonically and
                the trade reads them that way on either side. */}
            <p className="font-semibold text-black" dir="ltr">
              {v.year} {v.make} {v.model}
              {v.trim ? ` ${v.trim}` : ""}
            </p>
            {v.vin && (
              <p className="font-mono" dir="ltr">
                {v.vin}
              </p>
            )}
          </>
        }
      />

      {/* Identity table */}
      <section className="mt-6">
        <table className="w-full border-collapse">
          <tbody>
            {(
              [
                ["make", v.make],
                ["model", v.model],
                ["year", String(v.year)],
                ["trim", v.trim ?? "—"],
                ["color", colorLabel(colorsAr, v.color) ?? "—"],
                ["origin", originLabel(originsAr, v.country_of_origin) ?? "—"],
              ] as const
            ).map(([key, value]) => (
              <tr key={key} className="border-b border-black/15">
                <td className="w-56 py-2 align-top">{label(key)}</td>
                <td className="py-2 text-base font-semibold">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Features / amenities — the standardized list the decision
          demands. Two columns so a well-equipped car still fits an A4. */}
      <section className="mt-6">
        <h2 className="border-b-2 border-black pb-1">{label("features")}</h2>
        {features.length > 0 ? (
          <ul className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1.5">
            {features.map((feature) => (
              <li key={feature} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-black/50">{ar("noFeatures")}</p>
        )}
      </section>

      {/* Price, inclusive of tax */}
      <section className="mt-8 rounded-lg border-2 border-black p-4">
        <div className="flex items-center justify-between gap-6">
          <div>{label("priceInclTax")}</div>
          {displayPrice !== null ? (
            <div className="text-start">
              <p className="text-2xl font-black" dir="rtl">
                {formatMoney(displayPrice, "ar")}
              </p>
              <p className="text-[11px] text-black/45" dir="ltr">
                {formatMoney(displayPrice, "en")}
              </p>
            </div>
          ) : (
            // No display-price concept exists for in-stock vehicles —
            // a ruled blank line for the showroom to hand-write.
            <div className="h-8 w-64 self-end border-b-2 border-dotted border-black/60" />
          )}
        </div>
      </section>

      {/* The statutory reference the sticker exists to satisfy. */}
      <p className="mt-4 text-[11px] text-black/55">{ar("legal")}</p>
      <p className="text-[10px] text-black/40" dir="ltr">
        {en("legal")}
      </p>

      <DocFooter />
    </article>
  );
}
