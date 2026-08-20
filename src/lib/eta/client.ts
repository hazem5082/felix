/**
 * The ETA transport, behind one interface, with a sandbox that is
 * honest about being a sandbox.
 *
 * WHY AN INTERFACE AND A MOCK RATHER THAN A HALF-BUILT HTTP CLIENT
 * ---------------------------------------------------------------
 * There are no ETA credentials in this environment and no reachable
 * authority, so an HTTP client written here could not be exercised even
 * once. Two ways to handle that. The tempting one is to write the fetch
 * calls and leave them untested, which produces a feature that has
 * never run. The other is to define the transport as an interface,
 * write the real HTTP implementation against the documented API, and
 * write a second implementation that behaves the way the authority
 * behaves — including refusing documents whose arithmetic does not
 * reconcile — so the ENTIRE pipeline above the transport runs end to
 * end, every day, in the demo and in the tests.
 *
 * This file is the second way. `MockEtaClient` is not a stub that
 * returns success: it re-derives every relationship ETA validates
 * between the invoice lines and the header and rejects the document
 * with an ETA-shaped error when they do not hold, which is what makes
 * the rejection path in the UI a real path rather than a screenshot.
 *
 * WHAT THE MOCK DOES NOT DO, AND MUST NOT BE READ AS DOING
 * -------------------------------------------------------
 * It does not file anything. A document "accepted" by MockEtaClient has
 * not been seen by the Egyptian Tax Authority, has no legal standing,
 * and its UUID belongs to nobody. Every submission row records `mode`
 * (0034), and the panel shows a Sandbox badge in both languages, for
 * exactly this reason.
 *
 * NO TEST IN THIS REPOSITORY MAKES A NETWORK CALL. `HttpEtaClient` is
 * constructed only when ETA_MODE is preprod or production, which the
 * test suite never sets, and the base URLs have no defaults (env.ts).
 *
 * WORKERS COMPATIBILITY: `fetch` only. No node:http, no agents, no
 * keep-alive pools.
 */

import type {
  EtaAcceptedDocument,
  EtaClient,
  EtaDocument,
  EtaError,
  EtaErrorDetail,
  EtaMode,
  EtaRejectedDocument,
  EtaSubmissionDocumentSummary,
  EtaSubmissionResponse,
  EtaSubmitResponse,
  EtaToken,
  SignedDocument,
} from "./types";
import { B2C_RECEIVER_ID_THRESHOLD_EGP, round5 } from "./document";
import { getEtaHttpConfig, getEtaMode } from "./env";

/** Five decimal places is ETA's precision; anything under it is noise. */
const EPS = 1e-5;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

// ── Deterministic identifier generation ─────────────────────
//
// The mock's identifiers are a pure function of the document. Two
// reasons, both practical: a demo that shows the same UUID every time it
// is replayed is a demo somebody can write a runbook against, and a test
// can assert on the value rather than on its shape. FNV-1a because it is
// four lines, has no dependency and is not being used for anything
// security-bearing — the real UUID comes from the authority.

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** `length` hex characters derived deterministically from `input`. */
function hexFrom(input: string, length: number): string {
  let out = "";
  let seed = 0x811c9dc5;
  while (out.length < length) {
    seed = fnv1a(`${input}#${out.length}`, seed);
    out += seed.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/** A v4-SHAPED uuid. Shaped, not random — see the note above. */
export function deterministicUuid(input: string): string {
  const h = hexFrom(input, 32);
  const variant = "89ab"[parseInt(h[16], 16) % 4];
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * The long ID, in the shape this build uses: `EG-{issuer RIN}-{16}`.
 *
 * 0024 stores `eta_long_id` as free text precisely because the portal's
 * format has changed across versions, so nothing downstream parses this.
 * The RIN is embedded because a long ID that does not name its issuer is
 * useless in a folder of them.
 */
export function deterministicLongId(rin: string, input: string): string {
  return `EG-${rin}-${hexFrom(`long:${input}`, 16).toUpperCase()}`;
}

// ── Validation, as the authority does it ────────────────────

function detail(code: string, message: string, path: string): EtaErrorDetail {
  return { code, message, target: path.split(".").pop() ?? path, propertyPath: path };
}

/**
 * Every relationship ETA checks between a document's parts, re-derived.
 *
 * These are the rejections a real submission actually collects: the line
 * total that does not equal net plus tax, the header total that does not
 * equal the sum of its lines, the tax amount that is not the declared
 * rate of the declared base, the missing receiver ID on a B2C invoice
 * over the threshold. Returns one ETA-shaped error carrying every
 * detail, or null.
 *
 * Exported so the service can pre-flight a document against the same
 * rules before it is signed and sent — a rejection the showroom can see
 * in half a second beats one that arrives from Cairo in ten.
 */
export function validateEtaDocument(doc: EtaDocument, index = 0): EtaError | null {
  const details: EtaErrorDetail[] = [];
  const at = (path: string) => `documents[${index}].${path}`;

  if (doc.documentType !== "I") {
    details.push(detail("0001", "Unsupported document type.", at("documentType")));
  }
  if (doc.documentTypeVersion !== "1.0") {
    details.push(
      detail("0002", "Unsupported document type version.", at("documentTypeVersion"))
    );
  }

  const issued = Date.parse(doc.dateTimeIssued);
  if (Number.isNaN(issued)) {
    details.push(detail("0003", "dateTimeIssued is not a valid instant.", at("dateTimeIssued")));
  } else if (issued - Date.now() > 24 * 3600 * 1000) {
    details.push(detail("0004", "dateTimeIssued is in the future.", at("dateTimeIssued")));
  }

  if (!doc.issuer?.id?.trim()) {
    details.push(detail("0010", "Issuer registration number is required.", at("issuer.id")));
  }
  if (!doc.issuer?.address?.branchID?.trim()) {
    details.push(
      detail("0011", "Issuer branch code is required.", at("issuer.address.branchID"))
    );
  }
  if (!doc.issuer?.name?.trim()) {
    details.push(detail("0012", "Issuer name is required.", at("issuer.name")));
  }
  if (!doc.receiver?.name?.trim()) {
    details.push(detail("0013", "Receiver name is required.", at("receiver.name")));
  }

  const lines = doc.invoiceLines ?? [];
  if (lines.length === 0) {
    details.push(detail("0020", "At least one invoice line is required.", at("invoiceLines")));
  }

  let sumSales = 0;
  const sumTaxByType = new Map<string, number>();

  lines.forEach((line, i) => {
    const p = (f: string) => at(`invoiceLines[${i}].${f}`);

    if (!line.itemCode?.trim()) {
      details.push(detail("0021", "Item code is required.", p("itemCode")));
    }
    if (!(line.quantity > 0)) {
      details.push(detail("0022", "Quantity must be greater than zero.", p("quantity")));
    }

    const expectedSales = round5(line.quantity * line.unitValue.amountEGP);
    if (!near(line.salesTotal, expectedSales)) {
      details.push(
        detail(
          "0023",
          `salesTotal ${line.salesTotal} does not equal quantity x unit value (${expectedSales}).`,
          p("salesTotal")
        )
      );
    }

    const expectedNet = round5(line.salesTotal - (line.discount?.amount ?? 0));
    if (!near(line.netTotal, expectedNet)) {
      details.push(
        detail(
          "0024",
          `netTotal ${line.netTotal} does not equal salesTotal less discount (${expectedNet}).`,
          p("netTotal")
        )
      );
    }

    let lineTax = 0;
    (line.taxableItems ?? []).forEach((tax, j) => {
      const expectedTax = round5(line.netTotal * (tax.rate / 100));
      if (!near(tax.amount, expectedTax)) {
        details.push(
          detail(
            "0025",
            `Tax amount ${tax.amount} is not ${tax.rate}% of netTotal (${expectedTax}).`,
            p(`taxableItems[${j}].amount`)
          )
        );
      }
      lineTax = round5(lineTax + tax.amount);
      sumTaxByType.set(tax.taxType, round5((sumTaxByType.get(tax.taxType) ?? 0) + tax.amount));
    });

    const expectedTotal = round5(line.netTotal + lineTax);
    if (!near(line.total, expectedTotal)) {
      details.push(
        detail(
          "0026",
          `Line total ${line.total} does not equal netTotal plus tax (${expectedTotal}).`,
          p("total")
        )
      );
    }

    sumSales = round5(sumSales + line.salesTotal);
  });

  if (!near(doc.totalSalesAmount, sumSales)) {
    details.push(
      detail(
        "0030",
        `totalSalesAmount ${doc.totalSalesAmount} does not equal the sum of the lines (${sumSales}).`,
        at("totalSalesAmount")
      )
    );
  }

  const expectedNetAmount = round5(doc.totalSalesAmount - (doc.totalDiscountAmount ?? 0));
  if (!near(doc.netAmount, expectedNetAmount)) {
    details.push(
      detail(
        "0031",
        `netAmount ${doc.netAmount} does not equal totalSalesAmount less discounts (${expectedNetAmount}).`,
        at("netAmount")
      )
    );
  }

  let declaredTax = 0;
  (doc.taxTotals ?? []).forEach((total, i) => {
    const fromLines = sumTaxByType.get(total.taxType) ?? 0;
    if (!near(total.amount, fromLines)) {
      details.push(
        detail(
          "0032",
          `${total.taxType} total ${total.amount} does not equal the sum from the lines (${fromLines}).`,
          at(`taxTotals[${i}].amount`)
        )
      );
    }
    declaredTax = round5(declaredTax + total.amount);
  });
  // A tax that appears on a line but never in the header is the one
  // arithmetic mismatch the checks above cannot see: every header total
  // reconciles, and the missing tax is simply absent from both sides.
  sumTaxByType.forEach((_amount, taxType) => {
    if (!(doc.taxTotals ?? []).some((t) => t.taxType === taxType)) {
      details.push(
        detail("0033", `${taxType} appears on a line but not in taxTotals.`, at("taxTotals"))
      );
    }
  });

  const expectedTotalAmount = round5(
    doc.netAmount + declaredTax - (doc.extraDiscountAmount ?? 0)
  );
  if (!near(doc.totalAmount, expectedTotalAmount)) {
    details.push(
      detail(
        "0034",
        `totalAmount ${doc.totalAmount} does not equal netAmount plus tax (${expectedTotalAmount}).`,
        at("totalAmount")
      )
    );
  }

  // The threshold rule that 0020 exists to satisfy. Checked here as well
  // as in document.ts because the authority checks it here: a document
  // assembled by anything other than our builder must still be refused.
  if (
    doc.receiver?.type === "P" &&
    !doc.receiver.id?.trim() &&
    doc.totalAmount >= B2C_RECEIVER_ID_THRESHOLD_EGP
  ) {
    details.push(
      detail(
        "0040",
        `Receiver identifier is mandatory at or above EGP ${B2C_RECEIVER_ID_THRESHOLD_EGP}.`,
        at("receiver.id")
      )
    );
  }

  if (details.length === 0) return null;
  return {
    code: "400",
    message: "Validation error",
    target: "document",
    details,
  };
}

// ── The sandbox ─────────────────────────────────────────────

/**
 * An in-process ETA.
 *
 * Stateful for the lifetime of the instance: a submission it accepts can
 * be read back through `getSubmission` and `getDocument`, which is what
 * lets service.ts run its real submit-then-settle sequence rather than a
 * shortened one. The state is per-instance and per-request — nothing is
 * persisted here, because the persistent record of a submission is the
 * `eta_submissions` row, and a second source of truth for it would be a
 * bug waiting for a restart.
 *
 * Settlement is IMMEDIATE rather than delayed. The real authority takes
 * seconds to minutes; simulating that with a timer would make the demo
 * flaky and would test nothing that a real preprod run will not test
 * properly. What the mock does preserve is the SHAPE: submit returns a
 * submissionId and an accepted/rejected split, and the verdict is then
 * read back by polling, so no code above it is written against a
 * synchronous authority.
 */
export class MockEtaClient implements EtaClient {
  readonly mode: EtaMode = "mock";

  private submissions = new Map<string, EtaSubmissionResponse>();
  private documents = new Map<string, EtaSubmissionDocumentSummary>();

  async authenticate(): Promise<EtaToken> {
    return { accessToken: "sandbox-token", expiresIn: 3600, tokenType: "Bearer" };
  }

  async submitDocuments(documents: SignedDocument[]): Promise<EtaSubmitResponse> {
    if (documents.length === 0) {
      throw new Error("submitDocuments called with no documents.");
    }

    const accepted: EtaAcceptedDocument[] = [];
    const rejected: EtaRejectedDocument[] = [];
    const summaries: EtaSubmissionDocumentSummary[] = [];

    documents.forEach((signed, index) => {
      const doc = signed.document;
      const internalId = doc.internalID;
      const error = validateEtaDocument(doc, index);
      const fingerprint = `${internalId}|${doc.issuer.id}|${doc.totalAmount}|${doc.dateTimeIssued}`;
      const uuid = deterministicUuid(fingerprint);

      if (error) {
        rejected.push({ internalId, error });
        summaries.push({ uuid, internalId, longId: null, status: "Invalid", error });
        return;
      }

      const longId = deterministicLongId(doc.issuer.id, fingerprint);
      accepted.push({
        uuid,
        longId,
        internalId,
        hashKey: hexFrom(`hash:${fingerprint}`, 64),
      });
      summaries.push({ uuid, internalId, longId, status: "Valid", error: null });
    });

    const submissionId = deterministicUuid(
      `submission:${documents.map((d) => d.document.internalID).join(",")}`
    );

    const response: EtaSubmissionResponse = {
      submissionId,
      documentCount: accepted.length,
      documents: summaries,
    };
    this.submissions.set(submissionId, response);
    summaries.forEach((s) => this.documents.set(s.uuid, s));

    return { submissionId, acceptedDocuments: accepted, rejectedDocuments: rejected };
  }

  async getSubmission(submissionId: string): Promise<EtaSubmissionResponse> {
    const found = this.submissions.get(submissionId);
    if (!found) throw new Error(`Unknown submission ${submissionId}.`);
    return found;
  }

  async getDocument(uuid: string): Promise<EtaSubmissionDocumentSummary> {
    const found = this.documents.get(uuid);
    if (!found) throw new Error(`Unknown document ${uuid}.`);
    return found;
  }
}

// ── The real thing ──────────────────────────────────────────

interface RawSubmitResponse {
  submissionId?: string;
  acceptedDocuments?: EtaAcceptedDocument[];
  rejectedDocuments?: EtaRejectedDocument[];
}

interface RawSubmissionResponse {
  submissionId?: string;
  documentCount?: number;
  documents?: {
    uuid?: string;
    internalId?: string;
    longId?: string | null;
    status?: string;
    error?: EtaError | null;
  }[];
}

/**
 * The documented ETA API, over fetch.
 *
 * Constructed only when ETA_MODE is preprod or production. It has never
 * been executed against the authority from this repository and the
 * commit message says so; what it is is a faithful transcription of the
 * documented request shapes, with the ONE thing that cannot be
 * transcribed — the e-seal — refused loudly upstream in signing.ts.
 *
 * The token is cached on the instance with a 60-second safety margin.
 * Instance-scoped and not module-scoped deliberately: a Worker isolate
 * is shared across requests from different showrooms, and a module-level
 * token cache in a multi-tenant Worker is how one showroom's credentials
 * end up filing another's invoice.
 */
export class HttpEtaClient implements EtaClient {
  readonly mode: EtaMode;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(mode: EtaMode) {
    this.mode = mode;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const { apiBase } = getEtaHttpConfig();
    const token = await this.bearer();
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`ETA ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const t = await this.authenticate();
    this.token = {
      value: t.accessToken,
      expiresAt: Date.now() + Math.max(0, t.expiresIn - 60) * 1000,
    };
    return this.token.value;
  }

  /** OAuth2 client_credentials against the ID server. */
  async authenticate(): Promise<EtaToken> {
    const { idBase, clientId, clientSecret } = getEtaHttpConfig();
    const res = await fetch(`${idBase}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "InvoicingAPI",
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`ETA authentication failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };
    return {
      accessToken: json.access_token,
      expiresIn: json.expires_in,
      tokenType: json.token_type,
    };
  }

  async submitDocuments(documents: SignedDocument[]): Promise<EtaSubmitResponse> {
    const raw = await this.request<RawSubmitResponse>("/api/v1.0/documentsubmissions", {
      method: "POST",
      body: JSON.stringify({ documents: documents.map((d) => d.document) }),
    });
    return {
      submissionId: raw.submissionId ?? "",
      acceptedDocuments: raw.acceptedDocuments ?? [],
      rejectedDocuments: raw.rejectedDocuments ?? [],
    };
  }

  async getSubmission(submissionId: string): Promise<EtaSubmissionResponse> {
    const raw = await this.request<RawSubmissionResponse>(
      `/api/v1.0/documentsubmissions/${encodeURIComponent(submissionId)}`
    );
    return {
      submissionId: raw.submissionId ?? submissionId,
      documentCount: raw.documentCount ?? (raw.documents?.length ?? 0),
      documents: (raw.documents ?? []).map((d) => ({
        uuid: d.uuid ?? "",
        internalId: d.internalId ?? "",
        longId: d.longId ?? null,
        status: (d.status as EtaSubmissionDocumentSummary["status"]) ?? "Submitted",
        error: d.error ?? null,
      })),
    };
  }

  async getDocument(uuid: string): Promise<EtaSubmissionDocumentSummary> {
    const raw = await this.request<{
      uuid?: string;
      internalId?: string;
      longId?: string | null;
      status?: string;
      error?: EtaError | null;
    }>(`/api/v1.0/documents/${encodeURIComponent(uuid)}/details`);
    return {
      uuid: raw.uuid ?? uuid,
      internalId: raw.internalId ?? "",
      longId: raw.longId ?? null,
      status: (raw.status as EtaSubmissionDocumentSummary["status"]) ?? "Submitted",
      error: raw.error ?? null,
    };
  }
}

/**
 * The one place an ETA client is chosen. Default is the sandbox — see
 * `getEtaMode` in env.ts for why that default is deliberate.
 */
export function createEtaClient(mode: EtaMode = getEtaMode()): EtaClient {
  return mode === "mock" ? new MockEtaClient() : new HttpEtaClient(mode);
}
