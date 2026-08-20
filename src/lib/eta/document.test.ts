import { describe, expect, it } from "vitest";
import {
  B2C_RECEIVER_ID_THRESHOLD_EGP,
  buildEtaDocument,
  classifyItemCode,
  etaTimestamp,
  placeholderItemCode,
  recoverVat,
  round5,
  vehicleDescription,
  type EtaBuildInput,
} from "./document";

const ISSUED = new Date("2026-08-20T09:30:15.482Z");

function input(over: {
  ticket?: Partial<EtaBuildInput["ticket"]>;
  vehicle?: Partial<EtaBuildInput["vehicle"]>;
  buyer?: Partial<EtaBuildInput["buyer"]>;
  issuer?: Partial<EtaBuildInput["issuer"]>;
  contract?: EtaBuildInput["contract"];
} = {}): EtaBuildInput {
  return {
    ticket: {
      id: "ticket-1",
      status: "executed",
      // 570,000 inclusive of 14% -> base 500,000, tax 70,000. Chosen so
      // the recovery lands on round numbers and a wrong direction is
      // obvious rather than a rounding argument.
      agreed_price: 570_000,
      vat_rate: 14,
      vat_amount: 70_000,
      price_includes_vat: true,
      executed_at: "2026-08-19T10:00:00Z",
      ...over.ticket,
    },
    vehicle: {
      vin: "1HGBH41JXMN109186",
      year: 2024,
      make: "Toyota",
      model: "Corolla",
      trim: "GLI",
      color: "White",
      item_code: "EG-123456789-CAR-COROLLA",
      ...over.vehicle,
    },
    contract: over.contract === undefined ? { serial: "FLX-000123" } : over.contract,
    buyer: {
      name: "Ahmed Hassan",
      nationalId: "29001011234567",
      address: null,
      ...over.buyer,
    },
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
      ...over.issuer,
    },
    issuedAt: ISSUED,
  };
}

function ok(result: ReturnType<typeof buildEtaDocument>) {
  if (!result.ok) {
    throw new Error(`expected a document, got blockers: ${result.blockers.map((b) => b.code).join(", ")}`);
  }
  return result;
}

describe("round5", () => {
  it("rounds to ETA's five decimal places", () => {
    expect(round5(1.234567)).toBe(1.23457);
    expect(round5(500000)).toBe(500000);
    expect(round5(0.000004)).toBe(0);
  });
});

describe("recoverVat", () => {
  it("recovers the taxable base out of a VAT-inclusive price", () => {
    expect(recoverVat(570_000, 14, true)).toEqual({
      base: 500_000,
      tax: 70_000,
      total: 570_000,
    });
  });

  it("adds VAT on top of a VAT-exclusive price", () => {
    expect(recoverVat(500_000, 14, false)).toEqual({
      base: 500_000,
      tax: 70_000,
      total: 570_000,
    });
  });

  it("treats the two directions as genuinely different arithmetic", () => {
    // The bug this guards: reading price_includes_vat backwards. On the
    // same number the two answers differ by 14% of the base.
    const inclusive = recoverVat(570_000, 14, true);
    const exclusive = recoverVat(570_000, 14, false);
    expect(exclusive.tax).toBeGreaterThan(inclusive.tax);
    expect(exclusive.total).toBe(649_800);
  });

  it("handles a schedule rate that is not 14", () => {
    const r = recoverVat(103_000, 3, true);
    expect(r.base).toBe(100_000);
    expect(r.tax).toBe(3_000);
    expect(round5(r.base + r.tax)).toBe(103_000);
  });

  it("handles a zero rate without dividing by zero", () => {
    expect(recoverVat(100_000, 0, true)).toEqual({ base: 100_000, tax: 0, total: 100_000 });
  });

  it("keeps base + tax equal to the agreed price on an awkward number", () => {
    const r = recoverVat(499_999.99, 14, true);
    expect(round5(r.base + r.tax)).toBe(499_999.99);
  });
});

describe("classifyItemCode", () => {
  it("reads GTIN lengths as GS1", () => {
    expect(classifyItemCode("12345678")).toBe("GS1");
    expect(classifyItemCode("6221031492010")).toBe("GS1");
    expect(classifyItemCode("06221031492010")).toBe("GS1");
  });

  it("reads everything else as EGS", () => {
    expect(classifyItemCode("EG-123456789-CAR")).toBe("EGS");
    expect(classifyItemCode("123456")).toBe("EGS");
    expect(classifyItemCode(placeholderItemCode("123456789"))).toBe("EGS");
  });
});

describe("vehicleDescription", () => {
  it("joins what is there and skips what is not", () => {
    expect(
      vehicleDescription({
        vin: null,
        year: 2024,
        make: "Toyota",
        model: "Corolla",
        trim: null,
        color: "White",
        item_code: null,
      })
    ).toBe("2024 Toyota Corolla White");
  });
});

describe("etaTimestamp", () => {
  it("truncates to whole seconds with a Z suffix", () => {
    expect(etaTimestamp(ISSUED)).toBe("2026-08-20T09:30:15Z");
  });
});

describe("buildEtaDocument — the happy path", () => {
  const built = ok(buildEtaDocument(input()));

  it("puts the taxable base on the line and the gross in the total", () => {
    const line = built.document.invoiceLines[0];
    expect(line.unitValue.amountEGP).toBe(500_000);
    expect(line.salesTotal).toBe(500_000);
    expect(line.netTotal).toBe(500_000);
    expect(line.taxableItems[0]).toEqual({
      taxType: "T1",
      amount: 70_000,
      subType: "V009",
      rate: 14,
    });
    expect(line.total).toBe(570_000);
  });

  it("reconciles the header against the line", () => {
    const d = built.document;
    expect(d.totalSalesAmount).toBe(500_000);
    expect(d.netAmount).toBe(500_000);
    expect(d.taxTotals).toEqual([{ taxType: "T1", amount: 70_000 }]);
    expect(d.totalAmount).toBe(570_000);
    expect(d.totalDiscountAmount).toBe(0);
    expect(d.extraDiscountAmount).toBe(0);
  });

  it("names the seller as a business and the buyer as a person", () => {
    expect(built.document.issuer.type).toBe("B");
    expect(built.document.issuer.id).toBe("123456789");
    expect(built.document.issuer.address.branchID).toBe("0");
    expect(built.document.receiver.type).toBe("P");
    expect(built.document.receiver.id).toBe("29001011234567");
  });

  it("uses the contract serial as the document's own number", () => {
    expect(built.document.internalID).toBe("FLX-000123");
    expect(built.document.documentType).toBe("I");
    expect(built.document.documentTypeVersion).toBe("1.0");
    expect(built.document.dateTimeIssued).toBe("2026-08-20T09:30:15Z");
  });

  it("carries the VIN as the line's internal code", () => {
    expect(built.document.invoiceLines[0].internalCode).toBe("1HGBH41JXMN109186");
  });

  it("raises no warnings when everything is recorded", () => {
    expect(built.warnings).toEqual([]);
  });

  it("summarises exactly what the document says", () => {
    expect(built.summary).toMatchObject({
      internalId: "FLX-000123",
      issuerRin: "123456789",
      buyerId: "29001011234567",
      buyerType: "P",
      taxableBase: 500_000,
      vatRate: 14,
      vatAmount: 70_000,
      totalAmount: 570_000,
      usesPlaceholderItemCode: false,
      priceIncludesVat: true,
    });
  });
});

describe("buildEtaDocument — VAT-exclusive pricing", () => {
  it("adds the tax on top rather than carving it out", () => {
    const built = ok(
      buildEtaDocument(
        input({ ticket: { agreed_price: 500_000, price_includes_vat: false, vat_amount: 70_000 } })
      )
    );
    expect(built.document.invoiceLines[0].salesTotal).toBe(500_000);
    expect(built.document.totalAmount).toBe(570_000);
    expect(built.warnings).toEqual([]);
  });
});

describe("buildEtaDocument — the item code", () => {
  it("substitutes a marked placeholder and warns when 0026's column is null", () => {
    const built = ok(buildEtaDocument(input({ vehicle: { item_code: null } })));
    expect(built.document.invoiceLines[0].itemCode).toBe("EG-123456789-UNREGISTERED");
    expect(built.document.invoiceLines[0].itemType).toBe("EGS");
    expect(built.summary.usesPlaceholderItemCode).toBe(true);
    expect(built.warnings.map((w) => w.code)).toContain("placeholderItemCode");
  });

  it("treats an all-whitespace code as absent", () => {
    const built = ok(buildEtaDocument(input({ vehicle: { item_code: "   " } })));
    expect(built.warnings.map((w) => w.code)).toContain("placeholderItemCode");
  });

  it("classifies a registered GTIN as GS1", () => {
    const built = ok(buildEtaDocument(input({ vehicle: { item_code: "6221031492010" } })));
    expect(built.document.invoiceLines[0].itemType).toBe("GS1");
    expect(built.warnings).toEqual([]);
  });
});

describe("buildEtaDocument — the buyer identifier", () => {
  it("blocks at or above the EGP 25,000 threshold when there is no national ID", () => {
    const result = buildEtaDocument(input({ buyer: { nationalId: null } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toContain("missingBuyerId");
  });

  it("only warns below the threshold", () => {
    // 20,000 inclusive of 14% -> a total of 20,000, under the threshold.
    const result = buildEtaDocument(
      input({
        buyer: { nationalId: null },
        ticket: { agreed_price: 20_000, vat_amount: round5(20_000 - 20_000 / 1.14) },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((w) => w.code)).toContain("missingBuyerId");
    expect(result.document.receiver.id).toBeUndefined();
  });

  it("blocks exactly AT the threshold, not merely above it", () => {
    const result = buildEtaDocument(
      input({
        buyer: { nationalId: null },
        ticket: {
          agreed_price: B2C_RECEIVER_ID_THRESHOLD_EGP,
          vat_amount: round5(25_000 - 25_000 / 1.14),
        },
      })
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a company buyer by tax registration and calls them type B", () => {
    const built = ok(
      buildEtaDocument(
        input({ buyer: { nationalId: null, taxRegistrationNo: "987654321" } })
      )
    );
    expect(built.document.receiver.type).toBe("B");
    expect(built.document.receiver.id).toBe("987654321");
    expect(built.warnings.map((w) => w.code)).not.toContain("missingBuyerId");
  });

  it("prefers the tax registration over a national ID when both are present", () => {
    const built = ok(buildEtaDocument(input({ buyer: { taxRegistrationNo: "987654321" } })));
    expect(built.document.receiver.id).toBe("987654321");
  });

  it("omits the address key entirely for a person, and does not warn", () => {
    // ETA makes the receiver address optional for a natural person, and
    // FELIX has no structured address column — warning here would put a
    // permanent warning on every car the showroom sells.
    const built = ok(buildEtaDocument(input()));
    expect(built.document.receiver.address).toBeUndefined();
    expect(built.warnings.map((w) => w.code)).not.toContain("missingBuyerAddress");
  });

  it("warns when a BUSINESS buyer has no address, which ETA requires", () => {
    const built = ok(
      buildEtaDocument(input({ buyer: { taxRegistrationNo: "987654321", address: null } }))
    );
    expect(built.warnings.map((w) => w.code)).toContain("missingBuyerAddress");
  });

  it("carries a usable buyer address onto the receiver", () => {
    const built = ok(
      buildEtaDocument(
        input({
          buyer: {
            address: {
              country: "EG",
              governate: "Giza",
              regionCity: "Dokki",
              street: "Tahrir",
              buildingNumber: "5",
            },
          },
        })
      )
    );
    expect(built.document.receiver.address).toEqual({
      country: "EG",
      governate: "Giza",
      regionCity: "Dokki",
      street: "Tahrir",
      buildingNumber: "5",
    });
  });
});

describe("buildEtaDocument — blockers", () => {
  it("refuses a ticket that was never executed", () => {
    const result = buildEtaDocument(input({ ticket: { status: "approved" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const blocked = result.blockers.find((b) => b.code === "ticketNotExecuted");
    expect(blocked?.detail).toBe("approved");
  });

  it("refuses a deal with no contract row", () => {
    const result = buildEtaDocument(input({ contract: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toContain("missingContract");
  });

  it("refuses when 0022's VAT fields are missing, and names which", () => {
    const result = buildEtaDocument(
      input({ ticket: { vat_rate: null, vat_amount: null, price_includes_vat: null } })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const blocked = result.blockers.find((b) => b.code === "missingVatFields");
    expect(blocked?.detail).toBe("vat_rate, vat_amount, price_includes_vat");
  });

  it("refuses when only the VAT treatment is missing — it cannot be guessed", () => {
    const result = buildEtaDocument(input({ ticket: { price_includes_vat: null } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.find((b) => b.code === "missingVatFields")?.detail).toBe(
      "price_includes_vat"
    );
  });

  it("refuses without the seller's tax registration", () => {
    const result = buildEtaDocument(input({ issuer: { taxRegistrationNo: null } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toContain("missingIssuerRin");
  });

  it("refuses an unusable issuer address", () => {
    const result = buildEtaDocument(
      input({
        issuer: {
          address: {
            country: "EG",
            governate: "",
            regionCity: "Maadi",
            street: "Road 9",
            buildingNumber: "12",
          },
        },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toContain("missingIssuerAddress");
  });

  it("refuses a non-positive price", () => {
    const result = buildEtaDocument(input({ ticket: { agreed_price: 0 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toContain("nonPositivePrice");
  });

  it("reports every blocker at once rather than the first", () => {
    const result = buildEtaDocument(
      input({
        ticket: { status: "submitted", vat_rate: null, vat_amount: null, price_includes_vat: null },
        issuer: { taxRegistrationNo: null },
        contract: null,
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code).sort()).toEqual(
      ["missingContract", "missingIssuerRin", "missingVatFields", "ticketNotExecuted"].sort()
    );
  });
});

describe("buildEtaDocument — warnings that do not stop a filing", () => {
  it("flags a recorded VAT amount that disagrees with the rate, and files the computed one", () => {
    const built = ok(buildEtaDocument(input({ ticket: { vat_amount: 61_000 } })));
    const warning = built.warnings.find((w) => w.code === "vatAmountMismatch");
    expect(warning?.detail).toBe("recorded 61000 vs computed 70000");
    // The DOCUMENT carries the computed figure, because ETA re-derives
    // the tax from the rate and the base and would reject anything else.
    expect(built.document.taxTotals[0].amount).toBe(70_000);
  });

  it("tolerates a one-piastre rounding difference silently", () => {
    const built = ok(buildEtaDocument(input({ ticket: { vat_amount: 70_000.009 } })));
    expect(built.warnings.map((w) => w.code)).not.toContain("vatAmountMismatch");
  });

  it("flags a zero rate", () => {
    const built = ok(
      buildEtaDocument(input({ ticket: { vat_rate: 0, vat_amount: 0 } }))
    );
    expect(built.warnings.map((w) => w.code)).toContain("zeroVatRate");
    expect(built.document.totalAmount).toBe(570_000);
  });

  it("flags a missing ETA branch code but still defaults it to head office", () => {
    const built = ok(buildEtaDocument(input({ issuer: { branchCode: null } })));
    expect(built.warnings.map((w) => w.code)).toContain("missingIssuerBranchCode");
    expect(built.document.issuer.address.branchID).toBe("0");
  });
});
