import { describe, expect, it } from "vitest";
import {
  MockEtaClient,
  deterministicLongId,
  deterministicUuid,
  validateEtaDocument,
} from "./client";
import { buildEtaDocument, type EtaBuildInput } from "./document";
import type { EtaDocument, SignedDocument } from "./types";

const ISSUED = new Date("2026-08-20T09:30:15Z");

function buildInput(over: Partial<EtaBuildInput["ticket"]> = {}): EtaBuildInput {
  return {
    ticket: {
      id: "ticket-1",
      status: "executed",
      agreed_price: 570_000,
      vat_rate: 14,
      vat_amount: 70_000,
      price_includes_vat: true,
      ...over,
    },
    vehicle: {
      vin: "1HGBH41JXMN109186",
      year: 2024,
      make: "Toyota",
      model: "Corolla",
      trim: "GLI",
      color: "White",
      item_code: "EG-123456789-CAR-COROLLA",
    },
    contract: { serial: "FLX-000123" },
    buyer: { name: "Ahmed Hassan", nationalId: "29001011234567", address: null },
    issuer: {
      name: "Abaza Motors",
      taxRegistrationNo: "123456789",
      branchCode: "0",
      address: {
        country: "EG",
        governate: "Cairo",
        regionCity: "Maadi",
        street: "Road 9",
        buildingNumber: "12",
      },
    },
    issuedAt: ISSUED,
  };
}

function goodDocument(): EtaDocument {
  const built = buildEtaDocument(buildInput());
  if (!built.ok) throw new Error("fixture does not build");
  return built.document;
}

/** The builder's output is what the pipeline signs; the mode is irrelevant here. */
function signed(document: EtaDocument): SignedDocument {
  return { document, signingMode: "none", canonicalString: "" };
}

function codes(details: { code: string }[] | undefined): string[] {
  return (details ?? []).map((d) => d.code);
}

describe("validateEtaDocument — a document our own builder produced", () => {
  it("passes without complaint", () => {
    expect(validateEtaDocument(goodDocument())).toBeNull();
  });

  it("passes for a VAT-exclusive sale too", () => {
    const built = buildEtaDocument({
      ...buildInput(),
      ticket: { ...buildInput().ticket, agreed_price: 500_000, price_includes_vat: false },
    });
    if (!built.ok) throw new Error("fixture does not build");
    expect(validateEtaDocument(built.document)).toBeNull();
  });
});

describe("validateEtaDocument — the arithmetic ETA actually checks", () => {
  it("catches a header total that does not match the lines", () => {
    const doc = goodDocument();
    doc.totalAmount = 999_999;
    const error = validateEtaDocument(doc);
    expect(error).not.toBeNull();
    expect(codes(error?.details)).toContain("0034");
    expect(error?.details?.[0].propertyPath).toMatch(/^documents\[0\]\./);
  });

  it("catches a tax amount that is not the declared rate of the base", () => {
    const doc = goodDocument();
    doc.invoiceLines[0].taxableItems[0].amount = 60_000;
    const error = validateEtaDocument(doc);
    expect(codes(error?.details)).toContain("0025");
  });

  it("catches a line total that does not equal net plus tax", () => {
    const doc = goodDocument();
    doc.invoiceLines[0].total = 500_000;
    expect(codes(validateEtaDocument(doc)?.details)).toContain("0026");
  });

  it("catches salesTotal that is not quantity times unit value", () => {
    const doc = goodDocument();
    doc.invoiceLines[0].quantity = 2;
    const found = codes(validateEtaDocument(doc)?.details);
    expect(found).toContain("0023");
  });

  it("catches a header sales total that does not sum the lines", () => {
    const doc = goodDocument();
    doc.totalSalesAmount = 400_000;
    expect(codes(validateEtaDocument(doc)?.details)).toContain("0030");
  });

  it("catches a tax total that does not sum the lines' tax", () => {
    const doc = goodDocument();
    doc.taxTotals[0].amount = 1;
    expect(codes(validateEtaDocument(doc)?.details)).toContain("0032");
  });

  it("catches a tax that appears on a line but never in the header", () => {
    const doc = goodDocument();
    doc.taxTotals = [];
    // The header now reconciles on its own terms (netAmount + 0 tax), so
    // 0033 is the only thing that can catch this.
    doc.totalAmount = doc.netAmount;
    expect(codes(validateEtaDocument(doc)?.details)).toContain("0033");
  });

  it("catches a missing issuer registration and branch code", () => {
    const doc = goodDocument();
    doc.issuer.id = "";
    doc.issuer.address.branchID = "";
    const found = codes(validateEtaDocument(doc)?.details);
    expect(found).toContain("0010");
    expect(found).toContain("0011");
  });

  it("catches a missing item code and a zero quantity", () => {
    const doc = goodDocument();
    doc.invoiceLines[0].itemCode = "";
    doc.invoiceLines[0].quantity = 0;
    const found = codes(validateEtaDocument(doc)?.details);
    expect(found).toContain("0021");
    expect(found).toContain("0022");
  });

  it("catches a document with no lines at all", () => {
    const doc = goodDocument();
    doc.invoiceLines = [];
    expect(codes(validateEtaDocument(doc)?.details)).toContain("0020");
  });

  it("catches an unsupported version and a future issue date", () => {
    const doc = goodDocument();
    doc.documentTypeVersion = "0.9" as EtaDocument["documentTypeVersion"];
    doc.dateTimeIssued = new Date(Date.now() + 90 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .concat("Z");
    const found = codes(validateEtaDocument(doc)?.details);
    expect(found).toContain("0002");
    expect(found).toContain("0004");
  });

  it("enforces the EGP 25,000 receiver-ID rule independently of the builder", () => {
    // A document assembled by anything other than buildEtaDocument must
    // still be refused — this is the authority's rule, not ours.
    const doc = goodDocument();
    delete doc.receiver.id;
    expect(codes(validateEtaDocument(doc)?.details)).toContain("0040");
  });

  it("reports every problem in one error rather than the first", () => {
    const doc = goodDocument();
    doc.totalAmount = 1;
    doc.totalSalesAmount = 2;
    doc.issuer.id = "";
    const error = validateEtaDocument(doc);
    expect((error?.details ?? []).length).toBeGreaterThanOrEqual(3);
    expect(error?.code).toBe("400");
  });

  it("indexes the property path by the document's position in the batch", () => {
    const doc = goodDocument();
    doc.totalAmount = 1;
    const error = validateEtaDocument(doc, 3);
    expect(error?.details?.[0].propertyPath).toMatch(/^documents\[3\]\./);
  });
});

describe("deterministic identifiers", () => {
  it("produces a v4-shaped uuid", () => {
    expect(deterministicUuid("anything")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("is stable for the same input and different for a different one", () => {
    expect(deterministicUuid("a")).toBe(deterministicUuid("a"));
    expect(deterministicUuid("a")).not.toBe(deterministicUuid("b"));
  });

  it("shapes the long ID as EG-{rin}-{random}", () => {
    const longId = deterministicLongId("123456789", "seed");
    expect(longId).toMatch(/^EG-123456789-[0-9A-F]{16}$/);
    expect(deterministicLongId("123456789", "seed")).toBe(longId);
  });
});

describe("MockEtaClient — acceptance", () => {
  it("authenticates without credentials", async () => {
    const token = await new MockEtaClient().authenticate();
    expect(token.accessToken).toBe("sandbox-token");
  });

  it("accepts a well-formed document and issues real-shaped identifiers", async () => {
    const client = new MockEtaClient();
    const response = await client.submitDocuments([signed(goodDocument())]);

    expect(response.rejectedDocuments).toEqual([]);
    expect(response.acceptedDocuments).toHaveLength(1);

    const accepted = response.acceptedDocuments[0];
    expect(accepted.internalId).toBe("FLX-000123");
    expect(accepted.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(accepted.longId).toMatch(/^EG-123456789-[0-9A-F]{16}$/);
    expect(accepted.hashKey).toHaveLength(64);
  });

  it("answers the same document with the same identifiers every time", async () => {
    const first = await new MockEtaClient().submitDocuments([signed(goodDocument())]);
    const second = await new MockEtaClient().submitDocuments([signed(goodDocument())]);
    expect(second.acceptedDocuments[0].uuid).toBe(first.acceptedDocuments[0].uuid);
    expect(second.acceptedDocuments[0].longId).toBe(first.acceptedDocuments[0].longId);
    expect(second.submissionId).toBe(first.submissionId);
  });

  it("is stateful within the instance: the verdict can be polled back", async () => {
    const client = new MockEtaClient();
    const response = await client.submitDocuments([signed(goodDocument())]);

    const submission = await client.getSubmission(response.submissionId);
    expect(submission.documentCount).toBe(1);
    expect(submission.documents[0].status).toBe("Valid");
    expect(submission.documents[0].longId).toBe(response.acceptedDocuments[0].longId);

    const doc = await client.getDocument(response.acceptedDocuments[0].uuid);
    expect(doc.status).toBe("Valid");
    expect(doc.error).toBeNull();
  });

  it("does not know about another instance's submissions", async () => {
    const a = new MockEtaClient();
    const response = await a.submitDocuments([signed(goodDocument())]);
    await expect(new MockEtaClient().getSubmission(response.submissionId)).rejects.toThrow(
      /Unknown submission/
    );
  });

  it("reports its mode so nothing downstream can mistake it for the authority", () => {
    expect(new MockEtaClient().mode).toBe("mock");
  });
});

describe("MockEtaClient — the rejection path", () => {
  it("refuses a document whose totals do not add up", async () => {
    const doc = goodDocument();
    doc.totalAmount = 1;

    const client = new MockEtaClient();
    const response = await client.submitDocuments([signed(doc)]);

    expect(response.acceptedDocuments).toEqual([]);
    expect(response.rejectedDocuments).toHaveLength(1);
    expect(response.rejectedDocuments[0].internalId).toBe("FLX-000123");
    expect(codes(response.rejectedDocuments[0].error.details)).toContain("0034");
  });

  it("records the rejection so the verdict can be polled like any other", async () => {
    const doc = goodDocument();
    doc.invoiceLines[0].taxableItems[0].amount = 1;

    const client = new MockEtaClient();
    const response = await client.submitDocuments([signed(doc)]);
    const submission = await client.getSubmission(response.submissionId);

    expect(submission.documentCount).toBe(0);
    expect(submission.documents[0].status).toBe("Invalid");
    expect(submission.documents[0].longId).toBeNull();
    expect(submission.documents[0].error).not.toBeNull();
  });

  it("splits a mixed batch into accepted and rejected", async () => {
    const bad = goodDocument();
    bad.internalID = "FLX-000999";
    bad.totalAmount = 7;

    const response = await new MockEtaClient().submitDocuments([
      signed(goodDocument()),
      signed(bad),
    ]);

    expect(response.acceptedDocuments.map((d) => d.internalId)).toEqual(["FLX-000123"]);
    expect(response.rejectedDocuments.map((d) => d.internalId)).toEqual(["FLX-000999"]);
  });

  it("refuses an empty batch outright", async () => {
    await expect(new MockEtaClient().submitDocuments([])).rejects.toThrow(/no documents/);
  });

  it("refuses to answer for a document it never saw", async () => {
    await expect(new MockEtaClient().getDocument("not-a-uuid")).rejects.toThrow(/Unknown document/);
  });
});
