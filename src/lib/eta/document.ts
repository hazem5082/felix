/**
 * The ETA document builder: FELIX rows in, one e-invoice JSON out.
 *
 * PURE, AND DELIBERATELY SO. No database handle, no environment, no
 * clock unless you pass one. Everything that decides whether a sale can
 * be e-invoiced at all is arithmetic over columns that already exist —
 * 0022's VAT triple, 0026's item code, 0020's buyer national ID, 0019 +
 * 0022's branch tax registration — so it belongs in a function a test
 * can call a hundred times in a millisecond, not behind a fetch.
 *
 * THE RESULT IS A VERDICT, NOT AN EXCEPTION
 * -----------------------------------------
 * The panel has to tell an accountant what is stopping the submission
 * BEFORE they press anything, and "what is stopping it" is usually more
 * than one thing. So the builder returns every blocker it found rather
 * than throwing on the first, and separates the two kinds:
 *
 *   blockers  the document cannot be built. Missing VAT treatment,
 *             no seller tax registration, a buyer with no national ID
 *             on an invoice at or above the EGP 25,000 threshold, a
 *             ticket that was never executed.
 *   warnings  the document CAN be built and is worth filing, but a
 *             human should know something. An unregistered item code
 *             substituted with a marked placeholder is the main one.
 *
 * Warnings are carried all the way onto the eta_submissions row
 * (0034's `warnings text[]`), because "we filed this with a placeholder
 * product code" is exactly the fact that must still be findable in
 * March when the portal asks about it.
 *
 * WHY `discount_amount` IS NOT MAPPED TO THE ETA DISCOUNT BLOCK
 * ------------------------------------------------------------
 * The obvious mapping is `deal_tickets.discount_amount` -> the line's
 * `discount.amount`, and it would be wrong. 0009's
 * compute_sale_waterfall() subtracts the discount from profit IN
 * ADDITION to using agreed_price as the sale price, so in FELIX's own
 * arithmetic the discount is an internal margin adjustment and
 * agreed_price is already the consideration the buyer agreed to pay.
 * Mapping it into the invoice would understate the taxable base by the
 * discount, which is an under-declaration of VAT. The discount block is
 * therefore emitted as a structural zero, and the day a showroom needs
 * a real invoice-level discount it needs a column that means that.
 */

import type {
  EtaDocument,
  EtaInvoiceLine,
  EtaItemType,
  EtaPersonType,
  EtaAddress,
} from "./types";

/**
 * The threshold at which the buyer's identifier stops being optional.
 * ETA requires a receiver ID on any B2C invoice at or above EGP 25,000
 * — which, as 0020's header puts it, is every car.
 */
export const B2C_RECEIVER_ID_THRESHOLD_EGP = 25_000;

/**
 * ETA's standard-rate VAT sub-type code. See types.ts for why a
 * schedule-tax vehicle at a non-14% rate still declares V009.
 */
export const VAT_SUBTYPE = "V009";

/**
 * ISIC code for the sale of motor vehicles. A default, not a constant:
 * it is a property of the taxpayer's own ETA registration, so a
 * deployment overrides it with ETA_ACTIVITY_CODE.
 */
export const DEFAULT_ACTIVITY_CODE = "4510";

/**
 * What goes in `itemCode` when 0026's `vehicles.item_code` is null.
 *
 * It is deliberately loud. An EGS code is `EG-{seller tax registration}-
 * {internal code}`, so this is a structurally valid EGS code whose
 * internal part reads UNREGISTERED — a preprod submission carrying it
 * will be visible as such on the portal, and a production submission
 * carrying it will be rejected by ETA's code registry rather than
 * silently filed against somebody else's product. Every result that
 * uses it also carries the `placeholderItemCode` warning, and the panel
 * shows it before the accountant confirms.
 */
export function placeholderItemCode(sellerRin: string): string {
  return `EG-${sellerRin}-UNREGISTERED`;
}

// ── Issue codes ─────────────────────────────────────────────
//
// Codes rather than sentences, because the panel renders them in Arabic
// and English and the database stores them for years. The `detail` is
// the un-translatable part (two numbers that disagree, the name of a
// missing column) and is appended verbatim.

export type EtaBlockerCode =
  | "ticketNotExecuted"
  | "missingContract"
  | "missingVatFields"
  | "nonPositivePrice"
  | "missingIssuerRin"
  | "missingIssuerAddress"
  | "missingBuyerId";

export type EtaWarningCode =
  | "placeholderItemCode"
  | "missingBuyerId"
  | "vatAmountMismatch"
  | "zeroVatRate"
  | "missingBuyerAddress"
  | "missingIssuerBranchCode"
  /** Raised by service.ts, not here — see `loadEtaContext`. */
  | "sandboxIssuerAddress";

export interface EtaIssue<C extends string> {
  code: C;
  detail?: string;
}

export type EtaBlocker = EtaIssue<EtaBlockerCode>;
export type EtaWarning = EtaIssue<EtaWarningCode>;

// ── Inputs ──────────────────────────────────────────────────

/** The seller, as the invoice must name them. */
export interface EtaIssuerConfig {
  /** Legal name of the taxpayer. */
  name: string;
  /** The RIN — `branches.tax_registration_no` (0022). */
  taxRegistrationNo: string | null;
  /**
   * ETA's branch code for the issuing premises, as registered on the
   * portal. FELIX has no column for it: it is an identifier the ETA
   * portal assigns, not one the showroom chooses, and inventing a
   * column for it would mean asking every existing branch to go and
   * find it before any of this works. It is supplied per deployment
   * (ETA_BRANCH_CODE) and defaults to "0", which is what the portal
   * assigns to a single-branch taxpayer's head office. A multi-branch
   * group MUST set it per branch before production — see the warning.
   */
  branchCode: string | null;
  address: EtaAddressInput;
}

export interface EtaAddressInput {
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode?: string | null;
}

/** The buyer, from the lead / customer behind the deal. */
export interface EtaBuyerInput {
  name: string;
  /** 0020's `leads.national_id` / 0031's `customers.national_id`. */
  nationalId: string | null;
  /** Set only when the buyer is itself a registered business. */
  taxRegistrationNo?: string | null;
  address?: EtaAddressInput | null;
}

export interface EtaTicketInput {
  id: string;
  status: string;
  agreed_price: number;
  vat_rate: number | null;
  vat_amount: number | null;
  price_includes_vat: boolean | null;
  executed_at?: string | null;
}

export interface EtaVehicleInput {
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
  /** 0026. Null until the vehicle's class is registered on the portal. */
  item_code: string | null;
}

export interface EtaBuildInput {
  ticket: EtaTicketInput;
  vehicle: EtaVehicleInput;
  /** `contracts.serial` becomes the document's internalID. */
  contract: { serial: string } | null;
  buyer: EtaBuyerInput;
  issuer: EtaIssuerConfig;
  /** Defaults to now. Injected so tests and the preview are stable. */
  issuedAt?: Date;
  activityCode?: string;
}

// ── Output ──────────────────────────────────────────────────

/**
 * What the confirmation dialog shows. Derived from the document rather
 * than computed a second time alongside it, so the number the accountant
 * approves is definitionally the number that gets filed.
 */
export interface EtaDocumentSummary {
  internalId: string;
  dateTimeIssued: string;
  issuerName: string;
  issuerRin: string;
  buyerName: string;
  buyerType: EtaPersonType;
  buyerId: string | null;
  itemDescription: string;
  itemCode: string;
  itemType: EtaItemType;
  usesPlaceholderItemCode: boolean;
  /** Net of VAT — the taxable base. */
  taxableBase: number;
  vatRate: number;
  vatAmount: number;
  /** What the buyer pays: taxableBase + vatAmount. */
  totalAmount: number;
  priceIncludesVat: boolean;
}

export type EtaBuildResult =
  | {
      ok: true;
      document: EtaDocument;
      summary: EtaDocumentSummary;
      warnings: EtaWarning[];
    }
  | { ok: false; blockers: EtaBlocker[]; warnings: EtaWarning[] };

// ── Arithmetic ──────────────────────────────────────────────

/**
 * ETA carries five decimal places and validates the relationships
 * between them, so every amount in the document goes through here. The
 * `+ Number.EPSILON` nudge is the usual defence against 1.005 rounding
 * down; it matters at five places on numbers this size less often than
 * it costs to explain, and it costs nothing.
 */
export function round5(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e5) / 1e5;
}

export interface VatRecovery {
  /** The taxable base — what ETA calls salesTotal / netTotal on the line. */
  base: number;
  /** The tax, computed from the rate and the base. */
  tax: number;
  /** base + tax. Equals agreed_price when the price was VAT-inclusive. */
  total: number;
}

/**
 * Recover the taxable base from the price actually agreed with the
 * buyer, which is the whole reason 0022 stores `price_includes_vat`.
 *
 * Inclusive is the normal Egyptian showroom quote: the sticker is what
 * the customer pays, and the VAT is inside it. Exclusive is the
 * corporate-sale shape where the tax is added on top of a quoted net.
 * Getting this backwards on a 14% invoice misstates the tax by about
 * 12% of itself in one direction and 14% in the other, which is why the
 * column is a blocker when it is null rather than a guess.
 */
export function recoverVat(
  agreedPrice: number,
  vatRatePercent: number,
  priceIncludesVat: boolean
): VatRecovery {
  const factor = 1 + vatRatePercent / 100;
  const base = priceIncludesVat ? round5(agreedPrice / factor) : round5(agreedPrice);
  const tax = round5(priceIncludesVat ? agreedPrice - base : base * (vatRatePercent / 100));
  return { base, tax, total: round5(base + tax) };
}

/**
 * Which classification scheme an item code belongs to.
 *
 * 0026 stores the code as free text because the showroom registers
 * whichever it has, so the scheme has to be read back off the string. A
 * GS1 code is all digits at one of the GTIN lengths (8, 12, 13 or 14);
 * everything else is treated as EGS, which is also what an EG-prefixed
 * code is by construction.
 */
export function classifyItemCode(code: string): EtaItemType {
  const digits = /^\d+$/.test(code);
  return digits && [8, 12, 13, 14].includes(code.length) ? "GS1" : "EGS";
}

/** The line description an ETA reviewer (and the buyer) reads. */
export function vehicleDescription(v: EtaVehicleInput): string {
  return [v.year, v.make, v.model, v.trim, v.color]
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== "")
    .join(" ");
}

function toEtaAddress(a: EtaAddressInput, branchID?: string | null): EtaAddress {
  const address: EtaAddress = {
    country: a.country,
    governate: a.governate,
    regionCity: a.regionCity,
    street: a.street,
    buildingNumber: a.buildingNumber,
  };
  if (a.postalCode) address.postalCode = a.postalCode;
  if (branchID) address.branchID = branchID;
  return address;
}

function addressIsUsable(a: EtaAddressInput | null | undefined): a is EtaAddressInput {
  return (
    !!a &&
    [a.country, a.governate, a.regionCity, a.street, a.buildingNumber].every(
      (f) => typeof f === "string" && f.trim() !== ""
    )
  );
}

/**
 * ETA rejects sub-second precision and non-UTC offsets on
 * dateTimeIssued. Truncating rather than rounding so the timestamp is
 * never in the future relative to the instant it describes.
 */
export function etaTimestamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

// ── The builder ─────────────────────────────────────────────

export function buildEtaDocument(input: EtaBuildInput): EtaBuildResult {
  const blockers: EtaBlocker[] = [];
  const warnings: EtaWarning[] = [];

  const { ticket, vehicle, contract, buyer, issuer } = input;

  // 1. The sale must have happened. An e-invoice for a deal that was
  //    never executed documents a transaction that does not exist, and
  //    ETA has no concept of un-filing one.
  if (ticket.status !== "executed") {
    blockers.push({ code: "ticketNotExecuted", detail: ticket.status });
  }

  // 2. The contract row is FELIX's document identity. 0024's header
  //    explains why the ETA linkage hangs off contracts and not the
  //    ticket; without a serial there is no internalID to file under.
  if (!contract || !contract.serial) {
    blockers.push({ code: "missingContract" });
  }

  if (!(ticket.agreed_price > 0)) {
    blockers.push({ code: "nonPositivePrice", detail: String(ticket.agreed_price) });
  }

  // 3. 0022's triple. All three are needed and none can be inferred:
  //    the rate is per-transaction because schedule-tax vehicles differ
  //    from the 14% standard, the treatment decides which way the
  //    arithmetic runs, and the recorded amount is what the Form 10
  //    return will say.
  const missingVat: string[] = [];
  if (ticket.vat_rate === null || ticket.vat_rate === undefined) missingVat.push("vat_rate");
  if (ticket.vat_amount === null || ticket.vat_amount === undefined) missingVat.push("vat_amount");
  if (ticket.price_includes_vat === null || ticket.price_includes_vat === undefined) {
    missingVat.push("price_includes_vat");
  }
  if (missingVat.length > 0) {
    blockers.push({ code: "missingVatFields", detail: missingVat.join(", ") });
  }

  // 4. The seller. Without a tax registration there is no issuer, and
  //    without an issuer address ETA rejects the document outright.
  const rin = issuer.taxRegistrationNo?.trim() ?? "";
  if (!rin) blockers.push({ code: "missingIssuerRin" });
  if (!addressIsUsable(issuer.address)) blockers.push({ code: "missingIssuerAddress" });
  if (!issuer.branchCode) {
    warnings.push({ code: "missingIssuerBranchCode" });
  }

  // 5. The buyer. A buyer with a tax registration is a type-B receiver
  //    and their RIN is the identifier; everyone else is type P and the
  //    identifier is the 14-digit national ID 0020 added the column for.
  const buyerRin = buyer.taxRegistrationNo?.trim() || null;
  const buyerNationalId = buyer.nationalId?.trim() || null;
  const buyerType: EtaPersonType = buyerRin ? "B" : "P";
  const buyerId = buyerRin ?? buyerNationalId;

  // The threshold is on the invoice total, so it has to be computed
  // before the receiver can be judged — which is why this block sits
  // after the VAT recovery rather than beside the rest of the buyer
  // checks. Falls back to agreed_price when the VAT fields are missing:
  // the recovery cannot run, but agreed_price is within a rate's worth
  // of the total either way and the threshold is not close.
  const rate = ticket.vat_rate ?? 0;
  const includes = ticket.price_includes_vat ?? true;
  const vat =
    missingVat.length === 0 && ticket.agreed_price > 0
      ? recoverVat(ticket.agreed_price, rate, includes)
      : null;
  const totalForThreshold = vat ? vat.total : round5(ticket.agreed_price);

  if (!buyerId) {
    if (totalForThreshold >= B2C_RECEIVER_ID_THRESHOLD_EGP) {
      blockers.push({
        code: "missingBuyerId",
        detail: `${totalForThreshold} >= ${B2C_RECEIVER_ID_THRESHOLD_EGP}`,
      });
    } else {
      warnings.push({ code: "missingBuyerId" });
    }
  }

  // Only for a BUSINESS buyer. ETA makes the receiver address optional
  // for a natural person and required for a registered business, and
  // FELIX has no structured address column for either — `leads.address`
  // is one free-text line. Warning on every B2C sale would put a
  // permanent warning on every car this showroom ever sells, which is
  // how a warning list stops being read.
  if (buyerType === "B" && !addressIsUsable(buyer.address)) {
    warnings.push({ code: "missingBuyerAddress" });
  }

  if (vat && rate === 0) warnings.push({ code: "zeroVatRate" });

  // 6. The recorded VAT amount against the one the rate implies.
  //    A warning and not a blocker, and the direction matters: the
  //    document states the COMPUTED figure, because ETA re-derives the
  //    tax from the rate and the base and rejects anything that does not
  //    reconcile. The recorded figure is what Form 10 will carry, so a
  //    divergence is a real bookkeeping defect — it is surfaced by name,
  //    with both numbers, rather than quietly reconciled away.
  if (vat && ticket.vat_amount !== null && ticket.vat_amount !== undefined) {
    const drift = Math.abs(round5(ticket.vat_amount) - vat.tax);
    if (drift > 0.01) {
      warnings.push({
        code: "vatAmountMismatch",
        detail: `recorded ${round5(ticket.vat_amount)} vs computed ${vat.tax}`,
      });
    }
  }

  if (blockers.length > 0 || !vat || !contract) {
    return { ok: false, blockers, warnings };
  }

  // 7. The item code. 0026 made it nullable on purpose — stock is taken
  //    in before its class is registered on the portal — so a null here
  //    is an ordinary state of the world and not an error. It is a
  //    warning carried onto the submission row, and the substituted code
  //    says UNREGISTERED in the place a human reads.
  const rawItemCode = vehicle.item_code?.trim() || null;
  const usesPlaceholder = rawItemCode === null;
  const itemCode = rawItemCode ?? placeholderItemCode(rin);
  const itemType = classifyItemCode(itemCode);
  if (usesPlaceholder) warnings.push({ code: "placeholderItemCode", detail: itemCode });

  const description = vehicleDescription(vehicle);

  const line: EtaInvoiceLine = {
    description,
    itemType,
    itemCode,
    unitType: "EA",
    quantity: 1,
    ...(vehicle.vin ? { internalCode: vehicle.vin } : {}),
    unitValue: { currencySold: "EGP", amountEGP: vat.base },
    salesTotal: vat.base,
    // Structural zero — see the file header for why discount_amount is
    // not mapped here.
    discount: { rate: 0, amount: 0 },
    netTotal: vat.base,
    itemsDiscount: 0,
    valueDifference: 0,
    totalTaxableFees: 0,
    taxableItems: [{ taxType: "T1", amount: vat.tax, subType: VAT_SUBTYPE, rate }],
    total: vat.total,
  };

  const document: EtaDocument = {
    issuer: {
      address: toEtaAddress(issuer.address, issuer.branchCode ?? "0"),
      type: "B",
      id: rin,
      name: issuer.name,
    },
    receiver: {
      ...(addressIsUsable(buyer.address) ? { address: toEtaAddress(buyer.address) } : {}),
      type: buyerType,
      ...(buyerId ? { id: buyerId } : {}),
      name: buyer.name,
    },
    documentType: "I",
    documentTypeVersion: "1.0",
    dateTimeIssued: etaTimestamp(input.issuedAt ?? new Date()),
    taxpayerActivityCode: input.activityCode?.trim() || DEFAULT_ACTIVITY_CODE,
    internalID: contract.serial,
    purchaseOrderReference: "",
    invoiceLines: [line],
    totalSalesAmount: vat.base,
    totalDiscountAmount: 0,
    netAmount: vat.base,
    taxTotals: [{ taxType: "T1", amount: vat.tax }],
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
    totalAmount: vat.total,
  };

  const summary: EtaDocumentSummary = {
    internalId: contract.serial,
    dateTimeIssued: document.dateTimeIssued,
    issuerName: issuer.name,
    issuerRin: rin,
    buyerName: buyer.name,
    buyerType,
    buyerId,
    itemDescription: description,
    itemCode,
    itemType,
    usesPlaceholderItemCode: usesPlaceholder,
    taxableBase: vat.base,
    vatRate: rate,
    vatAmount: vat.tax,
    totalAmount: vat.total,
    priceIncludesVat: includes,
  };

  return { ok: true, document, summary, warnings };
}
