/**
 * THE LEGACY IMPORTER — pure logic.
 *
 * A big showroom group (Abaza: 10 branches) arrives with years of stock
 * and customer records in Excel exports, not FELIX. scripts/import-legacy.mjs
 * is the on-ramp: it reads their CSVs, maps their column headers onto FELIX
 * fields, validates every row, and writes vehicles + customers into one
 * tenant schema through the service-role client.
 *
 * Everything that can be got wrong — CSV quoting, Arabic-Indic digits,
 * which header means what, whether a row is even valid, whether two rows
 * are the same vehicle or the same person — is decided here, in functions
 * that take plain data and return plain data. No Supabase client, no
 * filesystem, no process.argv: that is what makes this file testable
 * without a database, exactly like customer-match.ts and national-id.ts
 * next to it. The orchestration (reading files, querying the tenant
 * schema for existing rows, writing, printing the report) lives in
 * scripts/import-legacy.mjs, which imports these functions.
 *
 * ARABIC IS THE NORM. Showroom staff type in Arabic, on Arabic Windows,
 * often with Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) even inside otherwise-Latin
 * fields like a VIN or a price. Every numeric field is normalized through
 * normalizeArabicDigits() before it is parsed. The extended (Persian/Urdu)
 * digit block (۰۱۲۳۴۵۶۷۸۹) is normalized too — cheap to support, and some
 * regional keyboard layouts and older Office installs emit it instead of
 * the standard Arabic-Indic block.
 */

import {
  decideCustomerLink,
  isNationalId,
  mergePhoneNumbers,
  type CustomerCandidate,
} from "./customer-match";

// ============================================================
// Text & digit normalization
// ============================================================

/** Standard Arabic-Indic digits, U+0660–U+0669, in ascending order. */
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** Extended Arabic-Indic (Persian/Urdu) digits, U+06F0–U+06F9. */
const EXTENDED_ARABIC_INDIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/**
 * Rewrites Arabic-Indic and Extended Arabic-Indic digits to ASCII 0-9.
 * Every other character passes through untouched — this is a digit
 * substitution, not a transliteration, so Arabic letters in a name or a
 * branch are left exactly as typed.
 */
export function normalizeArabicDigits(input: string | undefined | null): string {
  if (!input) return "";
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (a !== -1) {
      out += String(a);
      continue;
    }
    const e = EXTENDED_ARABIC_INDIC_DIGITS.indexOf(ch);
    if (e !== -1) {
      out += String(e);
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Trims a cell and strips the invisible characters Excel's "CSV UTF-8"
 * export sometimes leaves inside individual fields (byte-order mark, and
 * the zero-width / directional marks Arabic input methods can insert
 * around a word). Ordinary internal whitespace is left alone — a branch
 * name or a multi-word Arabic header is not "cleaned" into something it
 * didn't say.
 */
export function normalizeText(input: string | undefined | null): string {
  if (input == null) return "";
  return input
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .trim();
}

/**
 * A money cell as showrooms actually type it: Arabic digits, thousands
 * commas or spaces, and a trailing currency word or symbol
 * ("18,000 EGP", "١٨٠٠٠ جنيه", "$18000"). Returns null when the cell
 * cannot be read as a number at all — the caller decides whether that is
 * a rejection.
 */
export function parseMoney(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = normalizeArabicDigits(normalizeText(raw));
  if (!s) return null;
  s = s.replace(/[,\s]/g, "");
  s = s.replace(/(egp|le|ج\.م|جنيه|جنيها|\$|€)/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// CSV parsing — quoted fields, embedded delimiters/newlines, BOM,
// comma-or-semicolon auto-detect. No dependency: none of the CSV
// libraries a browser project would reach for are in package.json, and
// AGENTS.md/the task both say not to add one for this.
// ============================================================

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Comma or semicolon, decided by which appears more often outside quoted
 * spans in the first few lines. Semicolon-delimited exports are common
 * from Arabic-locale Excel, where the comma is the decimal separator.
 */
export function detectDelimiter(text: string): "," | ";" {
  const sample = stripBom(text).split(/\r\n|\r|\n/).slice(0, 5).join("\n");
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ",") commas++;
    else if (ch === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

/**
 * A small state machine rather than a split() chain, because split()
 * cannot know that a comma or a newline inside `"…"` is data, not a
 * delimiter — and a customer's multi-line note or an address with a
 * comma in it ("شارع الجمهورية، المعادي") is exactly the content this
 * importer exists to carry over intact.
 *
 * `""` inside a quoted field is the standard CSV escape for a literal
 * quote (RFC 4180 §2.7). Lines may end in \r\n, \r, or \n.
 */
export function parseCsv(text: string, delimiter?: "," | ";"): ParsedCsv {
  const clean = stripBom(text);
  const delim = delimiter ?? detectDelimiter(clean);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = clean.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delim) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (clean[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // The file doesn't necessarily end with a newline.
  if (field.length > 0 || row.length > 0) pushRow();

  // A blank line becomes a single-field [""] row; drop those wherever
  // they occur (leading, trailing, or a stray separator mid-export) —
  // never real data, since every real row here has multiple mapped
  // columns.
  const nonBlank = rows.filter((r) => !(r.length === 1 && r[0] === ""));

  const [headers, ...dataRows] = nonBlank;
  return { headers: headers ?? [], rows: dataRows };
}

// ============================================================
// Header mapping — their column names to FELIX field names
// ============================================================

/**
 * Common Arabic and English header spellings, mapped onto the field
 * names validateVehicleRow()/validateCustomerRow() read. A `--map`
 * file supplied on the command line is merged OVER this, so a showroom
 * whose export uses different wording adds or overrides entries rather
 * than replacing the whole table.
 */
export const DEFAULT_HEADER_MAP: Record<string, string> = {
  // ── Vehicles — Arabic ──────────────────────────────────
  "الماركة": "make",
  "الشركة الصانعة": "make",
  "الموديل": "model",
  "الطراز": "model",
  "سنة الصنع": "year",
  "سنة الموديل": "year",
  "الموديل سنة": "year",
  "رقم الشاسيه": "vin",
  "الشاسيه": "vin",
  "رقم الشاصي": "vin",
  "سعر الشراء": "purchase_price",
  "التكلفة": "purchase_price",
  "سعر التكلفة": "purchase_price",
  "الفرع": "branch",
  "فرع": "branch",
  "اللون": "color",
  "درجة اللون": "trim",
  "الفئة": "trim",
  "رقم المحرك": "engine_number",
  "رقم اللوحة": "plate_number",
  "رقم اللوحه": "plate_number",
  "بلد المنشأ": "country_of_origin",
  "بلد الصنع": "country_of_origin",
  "كود الصنف": "item_code",
  "ملاحظات": "description",

  // ── Vehicles — English ─────────────────────────────────
  make: "make",
  brand: "make",
  manufacturer: "make",
  model: "model",
  year: "year",
  "model year": "year",
  "manufacture year": "year",
  vin: "vin",
  "chassis number": "vin",
  chassis_number: "vin",
  "chassis no": "vin",
  "purchase price": "purchase_price",
  purchase_price: "purchase_price",
  cost: "purchase_price",
  "cost price": "purchase_price",
  branch: "branch",
  showroom: "branch",
  color: "color",
  colour: "color",
  trim: "trim",
  "engine number": "engine_number",
  engine_number: "engine_number",
  "plate number": "plate_number",
  plate_number: "plate_number",
  "license plate": "plate_number",
  "country of origin": "country_of_origin",
  country_of_origin: "country_of_origin",
  "item code": "item_code",
  item_code: "item_code",
  description: "description",
  notes: "description",

  // ── Customers — Arabic ─────────────────────────────────
  "اسم العميل": "full_name",
  "اسم العميل بالكامل": "full_name",
  "الاسم": "full_name",
  "اسم": "full_name",
  "الرقم القومي": "national_id",
  "الرقم القومى": "national_id",
  "رقم البطاقة": "national_id",
  "رقم التليفون": "phone",
  "رقم الهاتف": "phone",
  "الموبايل": "phone",
  "رقم الموبايل": "phone",
  "العنوان": "address",
  "الجنسية": "nationality",

  // ── Customers — English ────────────────────────────────
  "full name": "full_name",
  full_name: "full_name",
  "customer name": "full_name",
  name: "full_name",
  "national id": "national_id",
  national_id: "national_id",
  "id number": "national_id",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  "mobile number": "phone",
  address: "address",
  nationality: "nationality",
};

function normalizeHeaderKey(raw: string): string {
  return normalizeText(raw).replace(/\s+/g, " ").toLowerCase();
}

/** Case-insensitive, whitespace-tolerant lookup index built from a header map. */
export function buildHeaderIndex(map: Record<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [header, field] of Object.entries(map)) {
    idx.set(normalizeHeaderKey(header), field);
  }
  return idx;
}

/** Which FELIX field (if any) each input header resolves to, in column order. */
export function mapHeaders(headers: string[], mapping: Record<string, string>): (string | null)[] {
  const idx = buildHeaderIndex(mapping);
  return headers.map((h) => idx.get(normalizeHeaderKey(h)) ?? null);
}

/**
 * Turns parsed CSV rows into records keyed by FELIX field name. A header
 * with no mapping is silently dropped — not every column in a legacy
 * export is one this importer uses — and a row shorter than the header
 * (a ragged export) reads its missing cells as "".
 */
export function mapRowsToRecords(
  parsed: ParsedCsv,
  mapping: Record<string, string>
): Record<string, string>[] {
  const mappedHeaders = mapHeaders(parsed.headers, mapping);
  return parsed.rows.map((row) => {
    const rec: Record<string, string> = {};
    mappedHeaders.forEach((field, i) => {
      if (field) rec[field] = row[i] ?? "";
    });
    return rec;
  });
}

// ============================================================
// Vehicle row validation
// ============================================================

export interface VehicleImportInput {
  vin?: string;
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  color?: string;
  engine_number?: string;
  plate_number?: string;
  country_of_origin?: string;
  item_code?: string;
  description?: string;
  purchase_price?: string;
  branch?: string;
}

export interface ValidVehicleRow {
  vin: string | null;
  /** The as-typed VIN, kept only when it failed validation and --allow-legacy-vin let the row through. */
  legacyVin: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
  engineNumber: string | null;
  plateNumber: string | null;
  countryOfOrigin: string | null;
  itemCode: string | null;
  description: string | null;
  purchasePrice: number;
  branchName: string;
}

export type VehicleValidation = { ok: true; vehicle: ValidVehicleRow } | { ok: false; reason: string };

export interface VehicleValidationOptions {
  allowLegacyVin: boolean;
  /** Injectable for tests; defaults to the real clock. */
  now?: Date;
}

/** 0021's standard VIN alphabet: 17 chars, uppercase alphanumerics excluding I, O, Q. */
const VIN_FORMAT = /^[A-HJ-NPR-Z0-9]{17}$/;
const MIN_VEHICLE_YEAR = 1980;

function combineDescription(description: string | null, legacyVinNote: string | null): string | null {
  if (!legacyVinNote) return description;
  const note = `Legacy VIN carried over unvalidated (not stored in the vin column): ${legacyVinNote}`;
  return description ? `${description}\n${note}` : note;
}

/**
 * Purchase price required and > 0; year sane (1980..current+1); VIN
 * validated against the 17-char format when 17 characters are supplied.
 *
 * A VIN that IS supplied but does not conform (wrong length, or 17 chars
 * outside the standard alphabet) is a "legacy VIN": the row is rejected
 * unless `allowLegacyVin` is set, in which case the vehicle is still
 * imported with `vin` left null and the original text preserved in
 * `description`. This is not merely a style choice: `vehicles_vin_format_check`
 * (0021) is enforced on every INSERT regardless of whether it was added
 * NOT VALID — NOT VALID only skips the initial scan of rows that existed
 * before the constraint did. A script performing new inserts can never
 * write a non-conforming string into `vin`; `--allow-legacy-vin` is
 * therefore "keep the vehicle, drop the VIN from its own column, don't
 * lose the original text" rather than "bypass the database check", which
 * is not something a client can do.
 *
 * A VIN that is simply ABSENT is not "legacy" — it validates fine as
 * `vin: null`, with no flag required.
 */
export function validateVehicleRow(
  input: VehicleImportInput,
  opts: VehicleValidationOptions
): VehicleValidation {
  const make = normalizeText(input.make);
  if (!make) return { ok: false, reason: "missing make" };

  const model = normalizeText(input.model);
  if (!model) return { ok: false, reason: "missing model" };

  const branchName = normalizeText(input.branch);
  if (!branchName) return { ok: false, reason: "missing branch" };

  const yearDigits = normalizeArabicDigits(normalizeText(input.year)).replace(/[^0-9]/g, "");
  const year = yearDigits ? Number.parseInt(yearDigits, 10) : NaN;
  const maxYear = (opts.now ?? new Date()).getUTCFullYear() + 1;
  if (!Number.isInteger(year) || year < MIN_VEHICLE_YEAR || year > maxYear) {
    return {
      ok: false,
      reason: `year "${input.year ?? ""}" is not a sane vehicle year (${MIN_VEHICLE_YEAR}-${maxYear})`,
    };
  }

  const purchasePrice = parseMoney(input.purchase_price);
  if (purchasePrice === null || purchasePrice <= 0) {
    return {
      ok: false,
      reason: `purchase price "${input.purchase_price ?? ""}" must be a positive number`,
    };
  }

  let vin: string | null = null;
  let legacyVin: string | null = null;
  const vinCandidate = normalizeArabicDigits(normalizeText(input.vin)).toUpperCase();
  if (vinCandidate) {
    if (vinCandidate.length === 17 && VIN_FORMAT.test(vinCandidate)) {
      vin = vinCandidate;
    } else if (opts.allowLegacyVin) {
      legacyVin = normalizeText(input.vin);
    } else {
      return {
        ok: false,
        reason: `VIN "${input.vin}" is not a valid 17-character VIN (pass --allow-legacy-vin to import without one)`,
      };
    }
  }

  return {
    ok: true,
    vehicle: {
      vin,
      legacyVin,
      year,
      make,
      model,
      trim: normalizeText(input.trim) || null,
      color: normalizeText(input.color) || null,
      engineNumber: normalizeText(input.engine_number) || null,
      plateNumber: normalizeText(input.plate_number) || null,
      countryOfOrigin: normalizeText(input.country_of_origin) || null,
      itemCode: normalizeText(input.item_code) || null,
      description: combineDescription(normalizeText(input.description) || null, legacyVin),
      purchasePrice,
      branchName,
    },
  };
}

// ============================================================
// Branch resolution — exact name match, no invention
// ============================================================

export interface BranchRef {
  id: string;
  name: string;
}

/** Case-insensitive, trimmed lookup — "exact name" tolerant of typing variance, not fuzzy. */
export function buildBranchIndex(branches: BranchRef[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const b of branches) idx.set(normalizeText(b.name).toLowerCase(), b.id);
  return idx;
}

export type BranchResolution =
  | { ok: true; branchId: string }
  | { ok: false; reason: string; branchName: string };

export function resolveBranch(
  rawName: string,
  branchIndex: Map<string, string>,
  defaultBranchId: string | null
): BranchResolution {
  const name = normalizeText(rawName);
  const id = name ? branchIndex.get(name.toLowerCase()) : undefined;
  if (id) return { ok: true, branchId: id };
  if (defaultBranchId) return { ok: true, branchId: defaultBranchId };
  return { ok: false, reason: `unknown branch "${name || rawName}"`, branchName: name || rawName };
}

// ============================================================
// Vehicle dedupe fingerprinting
// ============================================================

/**
 * The weak key used when a vehicle has no VIN: make + model + year +
 * purchase price. Weak on purpose and documented as such everywhere it's
 * used — two different cars can share all four fields — but it is the
 * best a legacy export gives us, and it is far better than importing a
 * duplicate on every re-run.
 */
export function vehicleFingerprint(v: {
  make: string;
  model: string;
  year: number;
  purchasePrice: number;
}): string {
  return [v.make, v.model, String(v.year), String(v.purchasePrice)]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

export interface VehicleDuplicate {
  /** Index (within the array passed in) of the row that turned out to be a duplicate. */
  index: number;
  /** Index of the earlier row it matches. */
  matchedIndex: number;
  /** "vin" when both rows share a VIN, "fingerprint" when matched on the weak key. */
  matchedOn: "vin" | "fingerprint";
}

/** Vehicles that are the same VIN, or (absent a VIN) the same weak fingerprint, within one file. */
export function dedupeVehiclesInFile<
  T extends { vin: string | null; make: string; model: string; year: number; purchasePrice: number },
>(items: T[]): { unique: T[]; duplicates: VehicleDuplicate[] } {
  const seen = new Map<string, number>();
  const unique: T[] = [];
  const duplicates: VehicleDuplicate[] = [];

  items.forEach((item, index) => {
    const matchedOn: "vin" | "fingerprint" = item.vin ? "vin" : "fingerprint";
    const key = item.vin ? `vin:${item.vin}` : `fp:${vehicleFingerprint(item)}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      duplicates.push({ index, matchedIndex: firstIndex, matchedOn });
      return;
    }
    seen.set(key, index);
    unique.push(item);
  });

  return { unique, duplicates };
}

// ============================================================
// Customer row validation
// ============================================================

export interface CustomerImportInput {
  full_name?: string;
  national_id?: string;
  phone?: string;
  address?: string;
  nationality?: string;
}

export interface ValidCustomerRow {
  fullName: string;
  /** Always exactly 14 digits, or null — same shape customer-match.ts expects. */
  nationalId: string | null;
  phone: string | null;
  address: string | null;
  nationality: string | null;
}

export type CustomerValidation =
  | { ok: true; customer: ValidCustomerRow }
  | { ok: false; reason: string };

/** full_name required; national_id, when present, must be exactly 14 digits after Arabic-digit normalization. */
export function validateCustomerRow(input: CustomerImportInput): CustomerValidation {
  const fullName = normalizeText(input.full_name);
  if (!fullName) return { ok: false, reason: "missing full_name" };

  let nationalId: string | null = null;
  const rawId = normalizeText(input.national_id);
  if (rawId) {
    const digits = normalizeArabicDigits(rawId).replace(/[^0-9]/g, "");
    if (!isNationalId(digits)) {
      return { ok: false, reason: `national ID "${input.national_id}" must be exactly 14 digits` };
    }
    nationalId = digits;
  }

  const phone = normalizeArabicDigits(normalizeText(input.phone)) || null;

  return {
    ok: true,
    customer: {
      fullName,
      nationalId,
      phone,
      address: normalizeText(input.address) || null,
      nationality: normalizeText(input.nationality) || null,
    },
  };
}

// ============================================================
// Customer dedupe — reuses customer-match.ts's own precedence rule
// (national ID wins, then phone) so a legacy import decides identity
// the exact same way a salesperson saving a lead does.
// ============================================================

export interface CustomerMergeEntry extends ValidCustomerRow {
  phoneNumbers: string[];
  /** Original row indexes folded into this entry; the first is where it started. */
  sourceIndexes: number[];
}

export interface CustomerDuplicate {
  index: number;
  matchedIndex: number;
  matchedOn: "national_id" | "phone";
}

/**
 * Folds rows that are the same person, within one file, into one entry —
 * same precedence as decideCustomerLink(): national ID first, then any
 * known phone spelling. `mergePhoneNumbers` supplies the canonical `0…`
 * form alongside whatever was typed, exactly as the CRM's own write path
 * does, so the resulting phone_numbers list is queryable the same way.
 */
export function dedupeCustomersInFile(
  customers: ValidCustomerRow[]
): { merged: CustomerMergeEntry[]; duplicates: CustomerDuplicate[] } {
  const merged: CustomerMergeEntry[] = [];
  const duplicates: CustomerDuplicate[] = [];

  customers.forEach((c, index) => {
    const candidates: CustomerCandidate[] = merged.map((m, idx) => ({
      id: String(idx),
      national_id: m.nationalId,
      phone_numbers: m.phoneNumbers,
    }));
    const plan = decideCustomerLink({ national_id: c.nationalId, phone_number: c.phone }, candidates);

    if (plan.action === "link") {
      const idx = Number(plan.customerId);
      const target = merged[idx];
      target.phoneNumbers = mergePhoneNumbers(target.phoneNumbers, c.phone);
      // Never overwrite an existing national ID — only attach one where
      // there was none, same rule decideCustomerLink itself enforces.
      if (plan.setNationalId && !target.nationalId) target.nationalId = plan.setNationalId;
      duplicates.push({ index, matchedIndex: target.sourceIndexes[0], matchedOn: plan.matchedOn });
      target.sourceIndexes.push(index);
    } else {
      merged.push({ ...c, phoneNumbers: mergePhoneNumbers([], c.phone), sourceIndexes: [index] });
    }
  });

  return { merged, duplicates };
}
