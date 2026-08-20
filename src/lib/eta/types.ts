/**
 * The Egyptian Tax Authority e-invoice document model, version 1.0.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Migration 0024 added recording slots for the identifiers the ETA
 * portal issues, and said in its header that the showroom "submits on
 * the ETA portal by hand and transcribes". Decision 281/2025 makes that
 * untenable at group scale: every business over EGP 250k of revenue must
 * e-invoice, B2C e-receipts are mandatory per branch per POS, and the
 * penalty is EGP 20,000 plus 1,000 a day. Ten branches transcribing
 * UUIDs by hand is ten places to be late.
 *
 * WHAT THESE TYPES ARE
 * --------------------
 * The JSON document shape the ETA invoicing API accepts (schema version
 * "1.0"), narrowed to what a vehicle sale actually needs. It is NOT the
 * full published schema — the omitted parts (delivery, payment terms,
 * multi-currency, credit/debit notes, service items) are omitted
 * deliberately and each omission is noted where it belongs, so that
 * adding one later is a decision rather than an archaeology exercise.
 *
 * NOTHING IN THIS FILE TALKS TO THE NETWORK. See client.ts for the
 * transport and the sandbox mock, document.ts for the builder, and
 * service.ts for the orchestration.
 *
 * NUMBERS
 * -------
 * ETA carries monetary values as JSON numbers with up to five decimal
 * places and validates the arithmetic between lines and header. Every
 * amount produced by document.ts is passed through `round5`, and the
 * mock validator re-checks the relationships ETA checks. Egyptian pounds
 * throughout: `currencySold` is "EGP" and there is no exchange rate,
 * because a showroom that sells in USD has a different problem (the
 * `amountSold`/`currencyExchangeRate` pair) that no FELIX column
 * currently records.
 */

/** ETA taxpayer type codes. B = business (has a tax registration), P = natural person. */
export type EtaPersonType = "B" | "P";

/**
 * Document type. Only "I" (invoice) is produced here.
 *
 * "C" (credit note) and "D" (debit note) both require `references` back
 * to the original document's UUID, and FELIX has no concept of a sale
 * being partially reversed — the deal ticket is executed or it is not.
 * When returns exist, they are a new document type here and a new row in
 * eta_submissions, not a mutation of an accepted invoice: ETA documents
 * are immutable once accepted, and 0034's unique index encodes that.
 */
export type EtaDocumentType = "I";

/**
 * Item classification scheme. EGS is Egypt's own (EG-{tax registration}-
 * {internal code}); GS1 is the international GTIN. 0026 stores whichever
 * the showroom registered on `vehicles.item_code` as free text, so the
 * scheme is inferred from the code's shape — see `classifyItemCode`.
 */
export type EtaItemType = "EGS" | "GS1";

/**
 * Tax type codes, from ETA's code table.
 *
 * T1 is VAT, which is the only one a car sale raises. The others exist
 * in the schedule (T2 table tax, T3 stamp, T4 withholding, …) and none
 * of them has a column in FELIX to be driven from, so emitting one would
 * be inventing a tax liability.
 */
export type EtaTaxType = "T1";

export interface EtaAddress {
  /**
   * ETA's own identifier for the issuing branch, as registered on the
   * portal. Required on the ISSUER address and forbidden on the
   * receiver's. FELIX has no column for it — see `EtaIssuerConfig.branchCode`
   * for how it is supplied and what happens when it is missing.
   */
  branchID?: string;
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode?: string;
  floor?: string;
  room?: string;
  landmark?: string;
  additionalInformation?: string;
}

export interface EtaIssuer {
  address: EtaAddress;
  type: EtaPersonType;
  /** The Registration Identification Number — the seller's tax registration. */
  id: string;
  name: string;
}

export interface EtaReceiver {
  address?: EtaAddress;
  type: EtaPersonType;
  /**
   * The buyer's identifier: a tax registration for type B, the 14-digit
   * national ID for type P. Mandatory for any invoice at or above
   * EGP 25,000 — which is every car — and 0020 is why `leads.national_id`
   * exists at all.
   */
  id?: string;
  name: string;
}

export interface EtaUnitValue {
  currencySold: "EGP";
  amountEGP: number;
}

export interface EtaTaxableItem {
  taxType: EtaTaxType;
  /** In EGP. Must equal `rate`% of the line's netTotal, or ETA rejects. */
  amount: number;
  /**
   * ETA's tax sub-type code. V009 is the standard-rate VAT sub-type used
   * for goods; a schedule-tax vehicle at a different rate still declares
   * V009 with its own `rate`, because the sub-type names the tax regime
   * and the rate names the number.
   */
  subType: string;
  /** Percentage, e.g. 14. Stored per transaction on the ticket (0022). */
  rate: number;
}

export interface EtaDiscount {
  rate: number;
  amount: number;
}

export interface EtaInvoiceLine {
  description: string;
  itemType: EtaItemType;
  itemCode: string;
  /** Unit of measure. "EA" (each) — a car is a countable unit. */
  unitType: "EA";
  quantity: number;
  /** The showroom's own reference for the line. FELIX uses the VIN when there is one. */
  internalCode?: string;
  unitValue: EtaUnitValue;
  /** quantity x unitValue.amountEGP */
  salesTotal: number;
  discount: EtaDiscount;
  /** salesTotal - discount.amount */
  netTotal: number;
  /** Always 0 here: FELIX records no line-level extra discounts. */
  itemsDiscount: number;
  /** Always 0 here: no valuation difference on a vehicle sale. */
  valueDifference: number;
  /** Always 0 here: no non-tax fees are itemised on the invoice. */
  totalTaxableFees: number;
  taxableItems: EtaTaxableItem[];
  /** netTotal + sum(taxableItems.amount) */
  total: number;
}

export interface EtaTaxTotal {
  taxType: EtaTaxType;
  amount: number;
}

export interface EtaDocument {
  issuer: EtaIssuer;
  receiver: EtaReceiver;
  documentType: EtaDocumentType;
  documentTypeVersion: "1.0";
  /** ISO 8601, UTC, seconds precision — ETA rejects sub-second and offsets. */
  dateTimeIssued: string;
  /**
   * ISIC activity code the taxpayer is registered under. 4530 is
   * "Sale of motor vehicle parts and accessories"; 4510 is the sale of
   * vehicles themselves. Configurable per deployment (`ETA_ACTIVITY_CODE`)
   * because it is a property of the taxpayer's registration, not of the
   * software.
   */
  taxpayerActivityCode: string;
  /** The seller's own document number. FELIX uses `contracts.serial`. */
  internalID: string;
  /** Empty here; ETA requires the key to be present. */
  purchaseOrderReference?: string;
  invoiceLines: EtaInvoiceLine[];
  /** Sum of line salesTotal. */
  totalSalesAmount: number;
  /** Sum of line discounts. */
  totalDiscountAmount: number;
  /** totalSalesAmount - totalDiscountAmount */
  netAmount: number;
  taxTotals: EtaTaxTotal[];
  /** Always 0 here. */
  extraDiscountAmount: number;
  /** Always 0 here. */
  totalItemsDiscountAmount: number;
  /** netAmount + sum(taxTotals.amount) - extraDiscountAmount */
  totalAmount: number;
  /** Filled by signing.ts. Excluded from the canonical serialization. */
  signatures?: EtaSignature[];
}

export interface EtaSignature {
  /** "I" = issuer signature. "S" = service-provider signature (not used). */
  signatureType: "I" | "S";
  /** Base64 CAdES-BES blob at go-live; a marked dev value in the sandbox. */
  value: string;
}

/** A document that has been through signing.ts. */
export interface SignedDocument {
  document: EtaDocument;
  /** Which signing path produced it — carried into the audit row. */
  signingMode: EtaSigningMode;
  /** The canonical string that was signed. Kept for the audit trail. */
  canonicalString: string;
}

export type EtaSigningMode = "none" | "hmac-dev" | "cades-bes";

// ── Transport shapes ────────────────────────────────────────
//
// These mirror the documented API responses so the mock and the real
// client are interchangeable at the call site. Unknown extra keys are
// tolerated (the real service adds fields between versions); missing
// ones are the caller's problem to narrow.

export interface EtaToken {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  tokenType: string;
}

export interface EtaErrorDetail {
  code: string;
  message: string;
  target?: string;
  propertyPath?: string;
}

export interface EtaError {
  code: string;
  message: string;
  target?: string;
  details?: EtaErrorDetail[];
}

export interface EtaAcceptedDocument {
  uuid: string;
  longId: string;
  internalId: string;
  hashKey: string;
}

export interface EtaRejectedDocument {
  internalId: string;
  error: EtaError;
}

export interface EtaSubmitResponse {
  submissionId: string;
  acceptedDocuments: EtaAcceptedDocument[];
  rejectedDocuments: EtaRejectedDocument[];
}

/**
 * ETA settles asynchronously: a submission is accepted for PROCESSING
 * first and the per-document verdict follows. `Valid` / `Invalid` are
 * the terminal document statuses; `Submitted` and `InProgress` are not.
 */
export type EtaDocumentStatus = "Submitted" | "Valid" | "Invalid" | "Cancelled" | "Rejected";

export interface EtaSubmissionDocumentSummary {
  uuid: string;
  internalId: string;
  longId: string | null;
  status: EtaDocumentStatus;
  error: EtaError | null;
}

export interface EtaSubmissionResponse {
  submissionId: string;
  /** ETA's own count of what it accepted for processing. */
  documentCount: number;
  documents: EtaSubmissionDocumentSummary[];
}

/** The transport. One interface, three implementations selected by env. */
export interface EtaClient {
  readonly mode: EtaMode;
  authenticate(): Promise<EtaToken>;
  submitDocuments(documents: SignedDocument[]): Promise<EtaSubmitResponse>;
  getSubmission(submissionId: string): Promise<EtaSubmissionResponse>;
  getDocument(uuid: string): Promise<EtaSubmissionDocumentSummary>;
}

/**
 * Which ETA a submission is talking to.
 *
 * `mock` never leaves the process. `preprod` is ETA's sandbox, which
 * issues real-shaped identifiers against test credentials. `production`
 * is the authority. The value is written onto every eta_submissions row
 * (0034's `mode` column) so nobody can look at an accepted submission
 * later and be unable to tell whether it was ever filed.
 */
export type EtaMode = "mock" | "preprod" | "production";
