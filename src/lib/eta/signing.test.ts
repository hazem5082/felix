import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, getSigningMode, signDocument } from "./signing";
import { buildEtaDocument } from "./document";
import type { EtaDocument } from "./types";

const KEYS = [
  "ETA_MODE",
  "ETA_SIGNING_MODE",
  "ETA_SIGNING_KEY",
  "ETA_SIGNER_URL",
] as const;

const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function document(): EtaDocument {
  const built = buildEtaDocument({
    ticket: {
      id: "t",
      status: "executed",
      agreed_price: 570_000,
      vat_rate: 14,
      vat_amount: 70_000,
      price_includes_vat: true,
    },
    vehicle: {
      vin: "VIN1",
      year: 2024,
      make: "Toyota",
      model: "Corolla",
      trim: null,
      color: null,
      item_code: "EG-123456789-CAR",
    },
    contract: { serial: "FLX-1" },
    buyer: { name: "Ahmed", nationalId: "29001011234567", address: null },
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
    issuedAt: new Date("2026-08-20T09:30:15Z"),
  });
  if (!built.ok) throw new Error("fixture does not build");
  return built.document;
}

describe("canonicalize", () => {
  it("uppercases property names and quotes scalar values", () => {
    expect(canonicalize({ name: "Ahmed", id: 7 })).toBe('"NAME""Ahmed""ID""7"');
  });

  it("recurses into nested objects", () => {
    expect(canonicalize({ issuer: { type: "B" } })).toBe('"ISSUER""TYPE""B"');
  });

  it("repeats the property name once per array element, as ETA specifies", () => {
    expect(canonicalize({ taxTotals: [{ amount: 1 }, { amount: 2 }] })).toBe(
      '"TAXTOTALS""AMOUNT""1""TAXTOTALS""AMOUNT""2"'
    );
  });

  it("excludes signatures — a signature cannot cover itself", () => {
    const withSig = { internalID: "X", signatures: [{ signatureType: "I", value: "abc" }] };
    expect(canonicalize(withSig)).toBe('"INTERNALID""X"');
    expect(canonicalize(withSig)).toBe(canonicalize({ internalID: "X" }));
  });

  it("skips undefined values rather than serialising the word", () => {
    expect(canonicalize({ a: "1", b: undefined })).toBe('"A""1"');
  });

  it("is stable across calls for the same document", () => {
    expect(canonicalize(document())).toBe(canonicalize(document()));
  });

  it("changes when any amount changes", () => {
    const a = document();
    const b = document();
    b.totalAmount = 1;
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });
});

describe("getSigningMode", () => {
  it("defaults to none in the sandbox", () => {
    delete process.env.ETA_SIGNING_MODE;
    process.env.ETA_MODE = "mock";
    expect(getSigningMode()).toBe("none");
  });

  it("defaults to cades-bes anywhere that can reach a real authority", () => {
    delete process.env.ETA_SIGNING_MODE;
    process.env.ETA_MODE = "preprod";
    expect(getSigningMode()).toBe("cades-bes");
  });

  it("refuses a value it does not recognise", () => {
    process.env.ETA_SIGNING_MODE = "rsa";
    expect(() => getSigningMode()).toThrow(/not one of/);
  });
});

describe("signDocument", () => {
  it("attaches no signature in the sandbox, and says so structurally", async () => {
    process.env.ETA_MODE = "mock";
    process.env.ETA_SIGNING_MODE = "none";
    const signed = await signDocument(document());
    expect(signed.signingMode).toBe("none");
    expect(signed.document.signatures).toEqual([]);
    expect(signed.canonicalString.length).toBeGreaterThan(0);
  });

  it("refuses to send an unsigned document anywhere real", async () => {
    process.env.ETA_MODE = "preprod";
    process.env.ETA_SIGNING_MODE = "none";
    await expect(signDocument(document())).rejects.toThrow(/only permitted when ETA_MODE=mock/);
  });

  it("produces a deterministic, clearly-marked development signature", async () => {
    process.env.ETA_MODE = "mock";
    process.env.ETA_SIGNING_MODE = "hmac-dev";
    process.env.ETA_SIGNING_KEY = "dev-key";

    const a = await signDocument(document());
    const b = await signDocument(document());

    expect(a.document.signatures?.[0].signatureType).toBe("I");
    expect(a.document.signatures?.[0].value).toMatch(/^DEV-HMAC-SHA256:/);
    expect(a.document.signatures?.[0].value).toBe(b.document.signatures?.[0].value);
  });

  it("signs a different document to a different value", async () => {
    process.env.ETA_MODE = "mock";
    process.env.ETA_SIGNING_MODE = "hmac-dev";
    process.env.ETA_SIGNING_KEY = "dev-key";

    const a = await signDocument(document());
    const other = document();
    other.totalAmount = 1;
    const b = await signDocument(other);

    expect(a.document.signatures?.[0].value).not.toBe(b.document.signatures?.[0].value);
  });

  it("needs a key before it will produce even a development signature", async () => {
    process.env.ETA_MODE = "mock";
    process.env.ETA_SIGNING_MODE = "hmac-dev";
    delete process.env.ETA_SIGNING_KEY;
    await expect(signDocument(document())).rejects.toThrow(/ETA_SIGNING_KEY/);
  });

  it("refuses to pass an HMAC off as an e-seal in production", async () => {
    process.env.ETA_MODE = "production";
    process.env.ETA_SIGNING_MODE = "hmac-dev";
    process.env.ETA_SIGNING_KEY = "dev-key";
    await expect(signDocument(document())).rejects.toThrow(/not an e-seal/);
  });

  it("refuses CAdES-BES outright rather than returning something signature-shaped", async () => {
    process.env.ETA_MODE = "production";
    process.env.ETA_SIGNING_MODE = "cades-bes";
    delete process.env.ETA_SIGNER_URL;
    await expect(signDocument(document())).rejects.toThrow(/signing token not configured/i);
  });

  it("says what to implement when a signer URL has been configured", async () => {
    process.env.ETA_MODE = "production";
    process.env.ETA_SIGNING_MODE = "cades-bes";
    process.env.ETA_SIGNER_URL = "https://signer.internal";
    await expect(signDocument(document())).rejects.toThrow(/signViaCadesToken/);
  });
});
