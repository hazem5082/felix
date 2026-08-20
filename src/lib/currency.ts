/**
 * The one place money display is defined. FELIX serves Egyptian
 * showrooms: every statutory artifact this app can print (VAT return
 * inputs, e-invoice totals, social-insurance salary sheets) is
 * EGP-denominated, so the display currency is EGP everywhere. Amounts
 * in the database are plain numerics with no currency column — this
 * module is display-layer only.
 *
 * A single constant rather than a literal at each call site so a
 * future tenant-level currency setting has exactly one seam to replace.
 */
export const APP_CURRENCY = "EGP";

/**
 * Format a monetary amount in the app currency.
 *
 * `locale` is the app locale ("en" | "ar", or a BCP 47 tag). Arabic is
 * mapped to "ar-EG" so the pound renders as the local symbol (ج.م.)
 * with Eastern Arabic digits — matching how `formatDate` already treats
 * the "ar" locale. Everything else formats as English ("EGP 1,234").
 *
 * Whole pounds only (fraction digits fixed at 0), consistently across
 * dashboards, print documents, and contracts; Intl rounds fractional
 * inputs for us.
 */
export function formatMoney(amount: number, locale: string = "en"): string {
  const intlLocale = locale === "ar" || locale.startsWith("ar-") ? "ar-EG" : "en";
  return new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: APP_CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
