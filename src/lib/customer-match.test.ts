import { describe, expect, it } from "vitest";
import {
  canonicalPhone,
  customerKnowsPhone,
  decideCustomerLink,
  isNationalId,
  mergePhoneNumbers,
  normalizePhone,
  phoneVariants,
  type CustomerCandidate,
} from "./customer-match";

let seq = 0;
function customer(over: Partial<CustomerCandidate> = {}): CustomerCandidate {
  return {
    id: `cust-${seq++}`,
    national_id: null,
    phone_numbers: [],
    ...over,
  };
}

const ID_OMAR = "29001011234567";
const ID_SARA = "29505051234567";

describe("isNationalId", () => {
  it("accepts exactly 14 digits, trimmed", () => {
    expect(isNationalId(ID_OMAR)).toBe(true);
    expect(isNationalId(`  ${ID_OMAR}  `)).toBe(true);
  });

  it("rejects everything else, including the empty field", () => {
    expect(isNationalId("")).toBe(false);
    expect(isNationalId(null)).toBe(false);
    expect(isNationalId(undefined)).toBe(false);
    expect(isNationalId("2900101123456")).toBe(false); // 13
    expect(isNationalId("290010112345678")).toBe(false); // 15
    expect(isNationalId("2900101123456X")).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("reduces every spelling of one mobile to the same number", () => {
    for (const spelling of [
      "01012345678",
      "010 1234 5678",
      "010-1234-5678",
      "+201012345678",
      "+20 10 1234 5678",
      "0020 101 234 5678",
      "(010) 1234 5678",
      "1012345678",
    ]) {
      expect(normalizePhone(spelling)).toBe("1012345678");
    }
  });

  it("keeps a landline that merely starts with 20 intact", () => {
    // A Cairo landline: 02 2345 6789. The leading zero is the trunk
    // prefix, not the start of a country code, so it must survive the
    // 20-check and only lose the trunk digit.
    expect(normalizePhone("0223456789")).toBe("223456789");
    expect(normalizePhone("+20223456789")).toBe("223456789");
  });

  it("returns empty for anything without digits, so it never matches", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("  -- ")).toBe("");
  });
});

describe("canonicalPhone", () => {
  it("is the local dialling form, whatever was typed", () => {
    expect(canonicalPhone("+20 10 1234 5678")).toBe("01012345678");
    expect(canonicalPhone("01012345678")).toBe("01012345678");
  });

  it("is empty when there is no number to canonicalise", () => {
    expect(canonicalPhone("")).toBe("");
    expect(canonicalPhone(null)).toBe("");
  });
});

describe("phoneVariants", () => {
  it("always includes the canonical form, so a lookup cannot miss it", () => {
    expect(phoneVariants("+20 10 1234 5678")).toContain("01012345678");
    expect(phoneVariants("010 1234 5678")).toContain("01012345678");
  });

  it("keeps the string as typed, for a customer stored under that spelling", () => {
    expect(phoneVariants("010 1234 5678")).toContain("010 1234 5678");
  });

  it("de-duplicates and stays order-stable", () => {
    const v = phoneVariants("01012345678");
    expect(new Set(v).size).toBe(v.length);
    expect(v).toEqual(phoneVariants("01012345678"));
  });

  it("asks for nothing when there is no number", () => {
    expect(phoneVariants("")).toEqual([]);
    expect(phoneVariants(null)).toEqual([]);
  });
});

describe("customerKnowsPhone", () => {
  it("matches across spellings", () => {
    const c = customer({ phone_numbers: ["+20 10 1234 5678"] });
    expect(customerKnowsPhone(c, "01012345678")).toBe(true);
  });

  it("does not treat two blank numbers as the same person", () => {
    const c = customer({ phone_numbers: [""] });
    expect(customerKnowsPhone(c, "")).toBe(false);
  });

  it("tolerates a null array", () => {
    expect(customerKnowsPhone(customer({ phone_numbers: null }), "01012345678")).toBe(false);
  });
});

describe("mergePhoneNumbers", () => {
  it("records the typed spelling and the canonical one", () => {
    expect(mergePhoneNumbers([], "+20 10 1234 5678")).toEqual([
      "+20 10 1234 5678",
      "01012345678",
    ]);
  });

  it("adds one entry when the typed form is already canonical", () => {
    expect(mergePhoneNumbers([], "01012345678")).toEqual(["01012345678"]);
  });

  it("is idempotent — a customer contacted twice gains nothing the second time", () => {
    const once = mergePhoneNumbers([], "010 1234 5678");
    expect(mergePhoneNumbers(once, "010 1234 5678")).toEqual(once);
  });

  it("appends a genuinely new handset without disturbing the old one", () => {
    const first = mergePhoneNumbers([], "01012345678");
    expect(mergePhoneNumbers(first, "01198765432")).toEqual([
      "01012345678",
      "01198765432",
    ]);
  });

  it("leaves the list alone for an unusable number", () => {
    expect(mergePhoneNumbers(["01012345678"], "")).toEqual(["01012345678"]);
    expect(mergePhoneNumbers(["01012345678"], null)).toEqual(["01012345678"]);
  });

  it("never mutates the array it was given", () => {
    const existing = ["01012345678"];
    mergePhoneNumbers(existing, "01198765432");
    expect(existing).toEqual(["01012345678"]);
  });
});

describe("decideCustomerLink", () => {
  it("mints a customer when nobody matches", () => {
    expect(decideCustomerLink({ phone_number: "01012345678" }, [])).toEqual({
      action: "create",
    });
  });

  it("links on the national ID", () => {
    const omar = customer({ national_id: ID_OMAR });
    expect(
      decideCustomerLink({ national_id: ID_OMAR, phone_number: "01012345678" }, [omar])
    ).toEqual({
      action: "link",
      customerId: omar.id,
      matchedOn: "national_id",
      setNationalId: null,
    });
  });

  it("prefers the national ID over a phone that points elsewhere", () => {
    // The handset was passed on. Following it would file this sale under
    // the previous owner's identity on the ETA invoice.
    const previousOwner = customer({ phone_numbers: ["01012345678"] });
    const omar = customer({ national_id: ID_OMAR, phone_numbers: ["01199998888"] });

    const plan = decideCustomerLink(
      { national_id: ID_OMAR, phone_number: "01012345678" },
      [previousOwner, omar]
    );

    expect(plan).toMatchObject({ action: "link", customerId: omar.id, matchedOn: "national_id" });
  });

  it("falls through to the phone when the ID matches nobody", () => {
    const returning = customer({ phone_numbers: ["+20 10 1234 5678"] });
    expect(decideCustomerLink({ phone_number: "01012345678" }, [returning])).toEqual({
      action: "link",
      customerId: returning.id,
      matchedOn: "phone",
      setNationalId: null,
    });
  });

  it("completes an identity: an ID collected on the second visit", () => {
    const returning = customer({ national_id: null, phone_numbers: ["01012345678"] });
    expect(
      decideCustomerLink({ national_id: ID_OMAR, phone_number: "01012345678" }, [returning])
    ).toEqual({
      action: "link",
      customerId: returning.id,
      matchedOn: "phone",
      setNationalId: ID_OMAR,
    });
  });

  it("never overwrites an ID a customer already has", () => {
    // Two documents cannot both belong to one person, and nothing in this
    // flow is entitled to decide which one is right.
    const sara = customer({ national_id: ID_SARA, phone_numbers: ["01012345678"] });
    const plan = decideCustomerLink(
      { national_id: ID_OMAR, phone_number: "01012345678" },
      [sara]
    );
    expect(plan).toMatchObject({ matchedOn: "phone", setNationalId: null });
  });

  it("ignores a malformed national ID entirely", () => {
    const omar = customer({ national_id: ID_OMAR, phone_numbers: ["01012345678"] });
    const plan = decideCustomerLink({ national_id: "123", phone_number: "01012345678" }, [omar]);
    expect(plan).toMatchObject({ matchedOn: "phone", setNationalId: null });
  });

  it("creates rather than guessing when the lead carries no usable number", () => {
    const anonymous = customer({ phone_numbers: [""] });
    expect(decideCustomerLink({ phone_number: "" }, [anonymous])).toEqual({ action: "create" });
    expect(decideCustomerLink({ phone_number: null }, [anonymous])).toEqual({ action: "create" });
  });

  it("takes the first phone match, so the caller's ordering decides", () => {
    const older = customer({ phone_numbers: ["01012345678"] });
    const newer = customer({ phone_numbers: ["01012345678"] });
    expect(decideCustomerLink({ phone_number: "01012345678" }, [older, newer])).toMatchObject({
      customerId: older.id,
    });
  });
});
