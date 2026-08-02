import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveTenant } from "@/lib/auth";
import { getTenant } from "@/lib/tenant";
import type {
  Branch,
  Contract,
  DealTicket,
  FinancingPartner,
  Lead,
  Vehicle,
} from "@/lib/supabase/types";
import { PrintToolbar } from "../../print-toolbar";
import { DocFooter, DocHeader } from "../../doc-chrome";

/**
 * The sale contract as a printable document. The browser's own
 * print-to-PDF is the export path: it is the only PDF engine that
 * ships full Arabic shaping and RTL for free, works identically on the
 * Workers runtime (nothing renders server-side but HTML), and costs no
 * dependencies.
 *
 * Every figure on this page came through RLS under the viewer's own
 * session — a salesperson from another branch gets notFound(), another
 * tenant's staff can't even resolve the ticket id. Deliberately absent:
 * the vehicle's purchase price and the investor equity splits. This is
 * the document a CUSTOMER signs; the showroom's internal economics
 * don't belong on it.
 */
export default async function ContractPrintPage({
  params,
}: {
  params: Promise<{ locale: string; ticketId: string }>;
}) {
  const { locale, ticketId } = await params;
  await requireActiveTenant(locale);

  const t = await getTranslations("contractDoc");
  const fmt = await getFormatter();
  const supabase = await createClient();
  const tenant = await getTenant();

  const { data: ticketRow } = await supabase
    .from("deal_tickets")
    .select("*, vehicles(*), leads(*), financing_partners(*)")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticketRow) notFound();

  const ticket = ticketRow as DealTicket & {
    vehicles?: Vehicle;
    leads?: Lead;
    financing_partners?: FinancingPartner;
  };

  const [{ data: contractRow }, { data: branchRow }] = await Promise.all([
    supabase.from("contracts").select("*").eq("deal_ticket_id", ticketId).maybeSingle(),
    supabase.from("branches").select("*").eq("id", ticket.branch_id).maybeSingle(),
  ]);

  // No contract row means the deal was never approved — there is
  // nothing to print, and the URL should not pretend otherwise.
  if (!contractRow) notFound();
  const contract = contractRow as Contract;
  const vehicle = ticket.vehicles;
  const buyer = ticket.leads;
  const branch = branchRow as Branch | null;

  const executed = ticket.status === "executed";
  const money = (n: number) =>
    fmt.number(n, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const date = (iso: string) => fmt.dateTime(new Date(iso), { dateStyle: "long" });

  const finalPrice = Number(ticket.agreed_price) - Number(ticket.discount_amount);

  return (
    <article className="relative text-[13px] leading-relaxed text-black">
      <PrintToolbar />

      {/* Watermark until the sale has actually been executed, so a
          printout of a pending deal can never pass for a closed one. */}
      {!executed && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="rotate-[-30deg] text-[90px] font-black tracking-widest text-black/[0.06]">
            {t("draft")}
          </span>
        </div>
      )}

      <DocHeader
        showroomName={tenant?.name ?? "FELIX"}
        docTitle={
          branch
            ? `${t("title")} — ${branch.name}${branch.address ? `, ${branch.address}` : ""}`
            : t("title")
        }
        meta={
          <>
            <p className="font-mono font-semibold text-black">{contract.serial}</p>
            <p>{date(contract.generated_at)}</p>
          </>
        }
      />

      {/* Parties */}
      <section className="mt-6 grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-black/50">
            {t("seller")}
          </h2>
          <p className="mt-1 font-semibold">{tenant?.name ?? "—"}</p>
          {branch && <p className="text-black/70">{branch.name}</p>}
        </div>
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-black/50">
            {t("buyer")}
          </h2>
          <p className="mt-1 font-semibold">{buyer?.client_name ?? t("walkIn")}</p>
          {buyer?.phone_number && (
            <p className="text-black/70" dir="ltr">
              {buyer.phone_number}
            </p>
          )}
          {buyer?.address && <p className="text-black/70">{buyer.address}</p>}
        </div>
      </section>

      {/* Vehicle */}
      <section className="mt-6">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-black/50">
          {t("vehicle")}
        </h2>
        <table className="mt-2 w-full border-collapse">
          <tbody>
            {[
              [t("makeModel"), vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}` : "—"],
              [t("vin"), vehicle?.vin ?? t("vinPending")],
            ].map(([k, v]) => (
              <tr key={k} className="border-b border-black/10">
                <td className="w-48 py-1.5 font-medium text-black/60">{k}</td>
                <td className="py-1.5 font-semibold">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Terms */}
      <section className="mt-6">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-black/50">
          {t("terms")}
        </h2>
        <table className="mt-2 w-full border-collapse">
          <tbody>
            <tr className="border-b border-black/10">
              <td className="w-48 py-1.5 font-medium text-black/60">{t("agreedPrice")}</td>
              <td className="py-1.5 font-semibold">{money(Number(ticket.agreed_price))}</td>
            </tr>
            {Number(ticket.discount_amount) > 0 && (
              <tr className="border-b border-black/10">
                <td className="py-1.5 font-medium text-black/60">{t("discount")}</td>
                <td className="py-1.5 font-semibold">−{money(Number(ticket.discount_amount))}</td>
              </tr>
            )}
            <tr className="border-b border-black/10">
              <td className="py-1.5 font-medium text-black/60">{t("finalPrice")}</td>
              <td className="py-1.5 text-base font-black">{money(finalPrice)}</td>
            </tr>
            <tr className="border-b border-black/10">
              <td className="py-1.5 font-medium text-black/60">{t("paymentMethod")}</td>
              <td className="py-1.5 font-semibold">
                {ticket.financing_type === "cash" ? t("cash") : t("installments")}
              </td>
            </tr>
            {ticket.financing_type === "installments" && ticket.financing_partners && (
              <>
                <tr className="border-b border-black/10">
                  <td className="py-1.5 font-medium text-black/60">{t("financedBy")}</td>
                  <td className="py-1.5 font-semibold">
                    {ticket.financing_partners.bank_name} — {ticket.financing_partners.product_name}
                    {ticket.financing_partners.rate != null && ` (${ticket.financing_partners.rate}%)`}
                    {ticket.financing_partners.term_months != null &&
                      ` · ${ticket.financing_partners.term_months} ${t("months")}`}
                  </td>
                </tr>
                {ticket.down_payment != null && (
                  <tr className="border-b border-black/10">
                    <td className="py-1.5 font-medium text-black/60">{t("downPayment")}</td>
                    <td className="py-1.5 font-semibold">{money(Number(ticket.down_payment))}</td>
                  </tr>
                )}
              </>
            )}
            {executed && ticket.executed_at && (
              <tr className="border-b border-black/10">
                <td className="py-1.5 font-medium text-black/60">{t("executedOn")}</td>
                <td className="py-1.5 font-semibold">{date(ticket.executed_at)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Clauses */}
      <section className="mt-6 space-y-2 text-black/80">
        <p>{t("clauseAgreement")}</p>
        <p>{t("clauseCondition")}</p>
        <p>{t("clauseTitle")}</p>
      </section>

      {/* Signatures */}
      <section className="mt-12 grid grid-cols-2 gap-12">
        {[t("sellerSignature"), t("buyerSignature")].map((label) => (
          <div key={label}>
            <div className="h-16 border-b border-black/60" />
            <p className="mt-2 text-black/60">{label}</p>
            <p className="mt-4 text-black/60">{t("dateLabel")}: ____________________</p>
          </div>
        ))}
      </section>

      <DocFooter line={t("footer", { serial: contract.serial })} />
    </article>
  );
}
