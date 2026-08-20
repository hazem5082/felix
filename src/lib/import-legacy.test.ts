import { describe, expect, it } from "vitest";
import {
  normalizeArabicDigits,
  normalizeText,
  parseMoney,
  stripBom,
  detectDelimiter,
  parseCsv,
  DEFAULT_HEADER_MAP,
  mapHeaders,
  mapRowsToRecords,
  validateVehicleRow,
  validateCustomerRow,
  buildBranchIndex,
  resolveBranch,
  vehicleFingerprint,
  dedupeVehiclesInFile,
  dedupeCustomersInFile,
  type ValidVehicleRow,
  type ValidCustomerRow,
} from "./import-legacy";

const NOW = new Date("2026-08-20T00:00:00Z");

// ============================================================
// Arabic digit / text normalization
// ============================================================

describe("normalizeArabicDigits", () => {
  it("converts standard Arabic-Indic digits to ASCII", () => {
    expect(normalizeArabicDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("converts extended (Persian/Urdu) Arabic-Indic digits to ASCII", () => {
    expect(normalizeArabicDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("leaves Arabic letters and other text untouched", () => {
    expect(normalizeArabicDigits("تويوتا كامري ٢٠٢٤")).toBe("تويوتا كامري 2024");
  });

  it("handles mixed ASCII and Arabic-Indic digits in one string", () => {
    expect(normalizeArabicDigits("18٠٠٠")).toBe("18000");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeArabicDigits(null)).toBe("");
    expect(normalizeArabicDigits(undefined)).toBe("");
  });
});

describe("normalizeText", () => {
  it("trims ordinary whitespace", () => {
    expect(normalizeText("  Toyota  ")).toBe("Toyota");
  });

  it("strips a leading byte-order mark", () => {
    expect(normalizeText("﻿Toyota")).toBe("Toyota");
  });

  it("strips zero-width and directional marks anywhere in the string", () => {
    expect(normalizeText("Toy​ota‫")).toBe("Toyota");
  });

  it("preserves internal whitespace and Arabic text", () => {
    expect(normalizeText("الفرع الرئيسي")).toBe("الفرع الرئيسي");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});

describe("parseMoney", () => {
  it("parses a plain integer", () => {
    expect(parseMoney("18000")).toBe(18000);
  });

  it("parses thousands commas", () => {
    expect(parseMoney("1,234,567")).toBe(1234567);
  });

  it("parses a trailing currency word or symbol", () => {
    expect(parseMoney("18,000 EGP")).toBe(18000);
    expect(parseMoney("$18000")).toBe(18000);
    expect(parseMoney("18000 جنيه")).toBe(18000);
  });

  it("parses Arabic-Indic digits with Arabic currency words", () => {
    expect(parseMoney("١٨٠٠٠ جنيه")).toBe(18000);
  });

  it("parses decimals", () => {
    expect(parseMoney("18000.50")).toBe(18000.5);
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney("not a number")).toBeNull();
    expect(parseMoney("TBD")).toBeNull();
  });
});

// ============================================================
// CSV parsing
// ============================================================

describe("stripBom", () => {
  it("removes a leading UTF-8 BOM", () => {
    expect(stripBom("﻿hello")).toBe("hello");
  });

  it("leaves text with no BOM untouched", () => {
    expect(stripBom("hello")).toBe("hello");
  });
});

describe("detectDelimiter", () => {
  it("detects comma-delimited text", () => {
    expect(detectDelimiter("make,model,year\nToyota,Camry,2024")).toBe(",");
  });

  it("detects semicolon-delimited text", () => {
    expect(detectDelimiter("make;model;year\nToyota;Camry;2024")).toBe(";");
  });

  it("ignores delimiters inside quoted fields when detecting", () => {
    // Semicolons inside a quoted address must not tip the count toward ";"
    // when the file is genuinely comma-delimited.
    expect(detectDelimiter('name,address\n"Omar","Cairo; Nasr City"')).toBe(",");
  });
});

describe("parseCsv", () => {
  it("parses a simple comma-delimited file", () => {
    const { headers, rows } = parseCsv("make,model,year\nToyota,Camry,2024\nHonda,Civic,2023");
    expect(headers).toEqual(["make", "model", "year"]);
    expect(rows).toEqual([
      ["Toyota", "Camry", "2024"],
      ["Honda", "Civic", "2023"],
    ]);
  });

  it("parses a semicolon-delimited file", () => {
    const { headers, rows } = parseCsv("make;model;year\nToyota;Camry;2024");
    expect(headers).toEqual(["make", "model", "year"]);
    expect(rows).toEqual([["Toyota", "Camry", "2024"]]);
  });

  it("strips a leading BOM before parsing", () => {
    const { headers } = parseCsv("﻿make,model\nToyota,Camry");
    expect(headers).toEqual(["make", "model"]);
  });

  it("handles a quoted field with an embedded comma", () => {
    const { rows } = parseCsv('name,address\n"Omar Hassan","Cairo, Nasr City"');
    expect(rows).toEqual([["Omar Hassan", "Cairo, Nasr City"]]);
  });

  it("handles a quoted field with an embedded newline", () => {
    const { rows } = parseCsv('name,notes\n"Omar","Line one\nLine two"');
    expect(rows).toEqual([["Omar", "Line one\nLine two"]]);
  });

  it("handles doubled-quote escaping for a literal quote", () => {
    const { rows } = parseCsv('name,notes\n"Omar","He said ""hello"""');
    expect(rows).toEqual([["Omar", 'He said "hello"']]);
  });

  it("handles quoted Arabic text containing a comma", () => {
    const { rows } = parseCsv('الاسم,العنوان\n"عمر حسن","شارع الجمهورية، المعادي"');
    expect(rows).toEqual([["عمر حسن", "شارع الجمهورية، المعادي"]]);
  });

  it("handles CRLF line endings", () => {
    const { headers, rows } = parseCsv("make,model\r\nToyota,Camry\r\nHonda,Civic");
    expect(headers).toEqual(["make", "model"]);
    expect(rows).toEqual([
      ["Toyota", "Camry"],
      ["Honda", "Civic"],
    ]);
  });

  it("drops blank lines wherever they occur", () => {
    const { rows } = parseCsv("make,model\nToyota,Camry\n\nHonda,Civic\n");
    expect(rows).toEqual([
      ["Toyota", "Camry"],
      ["Honda", "Civic"],
    ]);
  });

  it("handles a file with no trailing newline", () => {
    const { rows } = parseCsv("make,model\nToyota,Camry");
    expect(rows).toEqual([["Toyota", "Camry"]]);
  });
});

// ============================================================
// Header mapping
// ============================================================

describe("mapHeaders / mapRowsToRecords", () => {
  it("maps known Arabic headers to FELIX fields", () => {
    const mapped = mapHeaders(["الماركة", "الموديل", "سنة الصنع"], DEFAULT_HEADER_MAP);
    expect(mapped).toEqual(["make", "model", "year"]);
  });

  it("maps known English headers case-insensitively", () => {
    const mapped = mapHeaders(["MAKE", "Model", "year"], DEFAULT_HEADER_MAP);
    expect(mapped).toEqual(["make", "model", "year"]);
  });

  it("returns null for an unmapped header", () => {
    const mapped = mapHeaders(["Some Random Column"], DEFAULT_HEADER_MAP);
    expect(mapped).toEqual([null]);
  });

  it("tolerates surrounding whitespace in headers", () => {
    const mapped = mapHeaders(["  make  "], DEFAULT_HEADER_MAP);
    expect(mapped).toEqual(["make"]);
  });

  it("mapRowsToRecords drops unmapped columns and keys by field name", () => {
    const parsed = { headers: ["الماركة", "Unmapped", "سعر الشراء"], rows: [["Toyota", "x", "18000"]] };
    const records = mapRowsToRecords(parsed, DEFAULT_HEADER_MAP);
    expect(records).toEqual([{ make: "Toyota", purchase_price: "18000" }]);
  });

  it("a user mapping merged over the defaults can add or override headers", () => {
    const mapping = { ...DEFAULT_HEADER_MAP, "ماركة العربية": "make" };
    const mapped = mapHeaders(["ماركة العربية"], mapping);
    expect(mapped).toEqual(["make"]);
  });
});

// ============================================================
// Vehicle row validation
// ============================================================

describe("validateVehicleRow", () => {
  const base = {
    make: "Toyota",
    model: "Camry",
    year: "2024",
    purchase_price: "18000",
    branch: "Downtown Showroom",
  };

  it("accepts a fully valid row", () => {
    const result = validateVehicleRow(base, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vehicle.make).toBe("Toyota");
      expect(result.vehicle.year).toBe(2024);
      expect(result.vehicle.purchasePrice).toBe(18000);
      expect(result.vehicle.vin).toBeNull();
    }
  });

  it("rejects a row missing make", () => {
    const result = validateVehicleRow({ ...base, make: "" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/make/);
  });

  it("rejects a row missing model", () => {
    const result = validateVehicleRow({ ...base, model: "" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(false);
  });

  it("rejects a row missing branch", () => {
    const result = validateVehicleRow({ ...base, branch: "" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/branch/);
  });

  it("rejects a year before 1980", () => {
    const result = validateVehicleRow({ ...base, year: "1975" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(false);
  });

  it("rejects a year more than one year in the future", () => {
    const result = validateVehicleRow({ ...base, year: "2028" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(false);
  });

  it("accepts the year boundaries (1980 and current+1)", () => {
    expect(validateVehicleRow({ ...base, year: "1980" }, { allowLegacyVin: false, now: NOW }).ok).toBe(true);
    expect(validateVehicleRow({ ...base, year: "2027" }, { allowLegacyVin: false, now: NOW }).ok).toBe(true);
  });

  it("normalizes Arabic-Indic digits in the year", () => {
    const result = validateVehicleRow({ ...base, year: "٢٠٢٤" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vehicle.year).toBe(2024);
  });

  it("rejects a missing or zero purchase price", () => {
    expect(validateVehicleRow({ ...base, purchase_price: "" }, { allowLegacyVin: false, now: NOW }).ok).toBe(false);
    expect(validateVehicleRow({ ...base, purchase_price: "0" }, { allowLegacyVin: false, now: NOW }).ok).toBe(false);
  });

  it("rejects a negative purchase price", () => {
    expect(validateVehicleRow({ ...base, purchase_price: "-500" }, { allowLegacyVin: false, now: NOW }).ok).toBe(
      false
    );
  });

  it("accepts a purchase price with commas, currency word, and Arabic digits", () => {
    const result = validateVehicleRow(
      { ...base, purchase_price: "١٨,٠٠٠ جنيه" },
      { allowLegacyVin: false, now: NOW }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vehicle.purchasePrice).toBe(18000);
  });

  it("accepts a conforming 17-character VIN and uppercases it", () => {
    const result = validateVehicleRow(
      { ...base, vin: "1fadp3f20el123456" },
      { allowLegacyVin: false, now: NOW }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vehicle.vin).toBe("1FADP3F20EL123456");
      expect(result.vehicle.legacyVin).toBeNull();
    }
  });

  it("rejects a 17-character VIN containing I, O, or Q without --allow-legacy-vin", () => {
    // 17 chars, but contains the disallowed letter O.
    const result = validateVehicleRow(
      { ...base, vin: "1FADP3F2OEL123456" },
      { allowLegacyVin: false, now: NOW }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/VIN/);
  });

  it("rejects a VIN of the wrong length without --allow-legacy-vin", () => {
    const result = validateVehicleRow({ ...base, vin: "SHORTVIN123" }, { allowLegacyVin: false, now: NOW });
    expect(result.ok).toBe(false);
  });

  it("imports a non-conforming VIN with --allow-legacy-vin, leaving vin null and noting it in description", () => {
    const result = validateVehicleRow({ ...base, vin: "SHORTVIN123" }, { allowLegacyVin: true, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vehicle.vin).toBeNull();
      expect(result.vehicle.legacyVin).toBe("SHORTVIN123");
      expect(result.vehicle.description).toMatch(/SHORTVIN123/);
    }
  });

  it("an absent VIN validates fine with vin null and no legacy note, flag or no flag", () => {
    const withoutFlag = validateVehicleRow({ ...base, vin: "" }, { allowLegacyVin: false, now: NOW });
    const withFlag = validateVehicleRow({ ...base, vin: "" }, { allowLegacyVin: true, now: NOW });
    expect(withoutFlag.ok).toBe(true);
    expect(withFlag.ok).toBe(true);
    if (withoutFlag.ok) {
      expect(withoutFlag.vehicle.vin).toBeNull();
      expect(withoutFlag.vehicle.legacyVin).toBeNull();
    }
  });

  it("normalizes Arabic-Indic digits inside a VIN before validating", () => {
    const result = validateVehicleRow(
      { ...base, vin: "1FADP3F20EL12345٦" }, // last digit is Arabic-Indic 6
      { allowLegacyVin: false, now: NOW }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vehicle.vin).toBe("1FADP3F20EL123456");
  });

  it("passes through optional fields when present", () => {
    const result = validateVehicleRow(
      { ...base, trim: "SE", color: "Nardo Grey", engine_number: "ENG123", plate_number: "PL123" },
      { allowLegacyVin: false, now: NOW }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vehicle.trim).toBe("SE");
      expect(result.vehicle.color).toBe("Nardo Grey");
      expect(result.vehicle.engineNumber).toBe("ENG123");
      expect(result.vehicle.plateNumber).toBe("PL123");
    }
  });
});

// ============================================================
// Customer row validation
// ============================================================

describe("validateCustomerRow", () => {
  it("accepts a row with just a name", () => {
    const result = validateCustomerRow({ full_name: "Omar Hassan" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.customer.fullName).toBe("Omar Hassan");
      expect(result.customer.nationalId).toBeNull();
    }
  });

  it("rejects a row missing full_name", () => {
    const result = validateCustomerRow({ full_name: "" });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid 14-digit national ID", () => {
    const result = validateCustomerRow({ full_name: "Omar", national_id: "29001011234567" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.customer.nationalId).toBe("29001011234567");
  });

  it("normalizes Arabic-Indic digits in the national ID", () => {
    const result = validateCustomerRow({ full_name: "Omar", national_id: "٢٩٠٠١٠١١٢٣٤٥٦٧" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.customer.nationalId).toBe("29001011234567");
  });

  it("rejects a national ID that is too short", () => {
    const result = validateCustomerRow({ full_name: "Omar", national_id: "12345" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/national ID/);
  });

  it("rejects a national ID that is too long", () => {
    const result = validateCustomerRow({ full_name: "Omar", national_id: "290010112345678999" });
    expect(result.ok).toBe(false);
  });

  it("rejects a national ID containing non-digit characters", () => {
    const result = validateCustomerRow({ full_name: "Omar", national_id: "2900101123456A" });
    expect(result.ok).toBe(false);
  });

  it("passes through phone, address, and nationality when present", () => {
    const result = validateCustomerRow({
      full_name: "Omar",
      phone: "٠١٠١٢٣٤٥٦٧٨",
      address: "Cairo",
      nationality: "Egyptian",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.customer.phone).toBe("01012345678");
      expect(result.customer.address).toBe("Cairo");
      expect(result.customer.nationality).toBe("Egyptian");
    }
  });
});

// ============================================================
// Branch resolution
// ============================================================

describe("buildBranchIndex / resolveBranch", () => {
  const branches = [
    { id: "b1", name: "Downtown Showroom" },
    { id: "b2", name: "Airport Road Branch" },
  ];

  it("resolves an exact (case-insensitive, trimmed) match", () => {
    const idx = buildBranchIndex(branches);
    expect(resolveBranch("  downtown showroom ", idx, null)).toEqual({ ok: true, branchId: "b1" });
  });

  it("falls back to the default branch when given and no match", () => {
    const idx = buildBranchIndex(branches);
    expect(resolveBranch("Some Other Branch", idx, "b2")).toEqual({ ok: true, branchId: "b2" });
  });

  it("fails with the branch name when there is no match and no default", () => {
    const idx = buildBranchIndex(branches);
    const result = resolveBranch("Nonexistent Branch", idx, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.branchName).toBe("Nonexistent Branch");
  });
});

// ============================================================
// Vehicle dedupe fingerprinting
// ============================================================

describe("vehicleFingerprint / dedupeVehiclesInFile", () => {
  it("builds a case-insensitive, trimmed fingerprint", () => {
    const a = vehicleFingerprint({ make: " Toyota ", model: "Camry", year: 2024, purchasePrice: 18000 });
    const b = vehicleFingerprint({ make: "toyota", model: "CAMRY", year: 2024, purchasePrice: 18000 });
    expect(a).toBe(b);
  });

  function veh(overrides: Partial<ValidVehicleRow>): ValidVehicleRow {
    return {
      vin: null,
      legacyVin: null,
      year: 2024,
      make: "Toyota",
      model: "Camry",
      trim: null,
      color: null,
      engineNumber: null,
      plateNumber: null,
      countryOfOrigin: null,
      itemCode: null,
      description: null,
      purchasePrice: 18000,
      branchName: "Downtown Showroom",
      ...overrides,
    };
  }

  it("flags two rows with the same VIN as duplicates", () => {
    const items = [veh({ vin: "1FADP3F20EL123456" }), veh({ vin: "1FADP3F20EL123456", model: "Different" })];
    const { unique, duplicates } = dedupeVehiclesInFile(items);
    expect(unique).toHaveLength(1);
    expect(duplicates).toEqual([{ index: 1, matchedIndex: 0, matchedOn: "vin" }]);
  });

  it("flags two VIN-less rows sharing the weak fingerprint as duplicates", () => {
    const items = [veh({}), veh({})];
    const { unique, duplicates } = dedupeVehiclesInFile(items);
    expect(unique).toHaveLength(1);
    expect(duplicates).toEqual([{ index: 1, matchedIndex: 0, matchedOn: "fingerprint" }]);
  });

  it("does not flag two VIN-less rows with different fingerprints", () => {
    const items = [veh({}), veh({ model: "Corolla" })];
    const { unique, duplicates } = dedupeVehiclesInFile(items);
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it("does not confuse a VIN'd row with a VIN-less row sharing the same fingerprint fields", () => {
    const items = [veh({ vin: "1FADP3F20EL123456" }), veh({})];
    const { unique } = dedupeVehiclesInFile(items);
    expect(unique).toHaveLength(2);
  });
});

// ============================================================
// Customer dedupe
// ============================================================

describe("dedupeCustomersInFile", () => {
  function cust(overrides: Partial<ValidCustomerRow>): ValidCustomerRow {
    return { fullName: "Omar Hassan", nationalId: null, phone: null, address: null, nationality: null, ...overrides };
  }

  it("keeps two unrelated customers separate", () => {
    const { merged, duplicates } = dedupeCustomersInFile([
      cust({ nationalId: "29001011234567" }),
      cust({ fullName: "Sara Ali", nationalId: "29002021234567" }),
    ]);
    expect(merged).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it("merges two rows sharing a national ID, folding phone numbers together", () => {
    const { merged, duplicates } = dedupeCustomersInFile([
      cust({ nationalId: "29001011234567", phone: "01012345678" }),
      cust({ nationalId: "29001011234567", phone: "01098765432" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(duplicates).toEqual([{ index: 1, matchedIndex: 0, matchedOn: "national_id" }]);
    expect(merged[0].phoneNumbers).toContain("01012345678");
    expect(merged[0].phoneNumbers).toContain("01098765432");
    expect(merged[0].sourceIndexes).toEqual([0, 1]);
  });

  it("merges two rows sharing a phone number and no national ID", () => {
    const { merged, duplicates } = dedupeCustomersInFile([
      cust({ phone: "01012345678" }),
      cust({ phone: "+201012345678" }), // same number, different spelling
    ]);
    expect(merged).toHaveLength(1);
    expect(duplicates).toEqual([{ index: 1, matchedIndex: 0, matchedOn: "phone" }]);
  });

  it("attaches a national ID to a phone-matched entry that had none", () => {
    const { merged } = dedupeCustomersInFile([
      cust({ phone: "01012345678" }),
      cust({ phone: "01012345678", nationalId: "29001011234567" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].nationalId).toBe("29001011234567");
  });

  it("never overwrites a national ID already attached, even if a later row disagrees", () => {
    const { merged, duplicates } = dedupeCustomersInFile([
      cust({ phone: "01012345678" }),
      cust({ phone: "01012345678", nationalId: "29001011234567" }), // attaches the first ID
      cust({ phone: "01012345678", nationalId: "29009091234567" }), // different ID, same phone
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].nationalId).toBe("29001011234567"); // unchanged
    expect(duplicates).toHaveLength(2);
  });
});
