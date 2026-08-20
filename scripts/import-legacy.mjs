// THE LEGACY IMPORTER — on-ramp for showrooms arriving with Excel stock
// lists and customer books instead of FELIX.
//
//   node --env-file=.env.local scripts/import-legacy.mjs --tenant abaza ./abaza-export
//   node --env-file=.env.local scripts/import-legacy.mjs --tenant abaza ./abaza-export --commit
//   node scripts/import-legacy.mjs --help          (no env required)
//
// DRY RUN IS THE DEFAULT. Nothing is written unless --commit is passed.
// Both modes read the target tenant schema (to report duplicates and
// unknown branches accurately) and both modes write import-report.json +
// import-report.md next to the input files — only --commit writes rows.
//
// All the logic that can be tested without a database — CSV parsing,
// Arabic-digit normalization, header mapping, row validation, dedupe
// fingerprinting — lives in src/lib/import-legacy.ts (vitest coverage in
// src/lib/import-legacy.test.ts). This file is the orchestration around
// it: argument parsing, reading the CSVs, querying the tenant schema for
// what already exists, writing rows when told to, and producing the
// report.
//
// WHY THIS FILE SELF-RESPAWNS WITH --experimental-strip-types. The pure
// logic module is TypeScript (src/lib/import-legacy.ts) so it can share
// types with the rest of the app and sit next to customer-match.ts /
// national-id.ts in the same style. This project has no ts-node, no
// build step for scripts (seed-demo.mjs and friends are plain .mjs), and
// AGENTS.md/the task both rule out adding a dependency to bridge that.
// Node 22.6+ can load a .ts file directly and erase its type syntax at
// import time — but only under a CLI flag, and only for THIS process, not
// automatically for whatever flags the user happened to invoke `node`
// with. So: if the flag isn't already active, this script relaunches
// itself with it and forwards its own argv, then exits with the child's
// status. --help works either way, with no environment variables needed,
// because the relaunch happens before anything reads process.env.
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const STRIP_TYPES_FLAG = "--experimental-strip-types";

if (!process.execArgv.includes(STRIP_TYPES_FLAG)) {
  const result = spawnSync(
    process.execPath,
    [STRIP_TYPES_FLAG, "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}

// Registered before the first .ts import — see scripts/import/ts-loader.mjs
// for exactly what gap this closes (Node's native loader does not try
// appending ".ts" to a relative specifier the way it tries ".js"/".mjs").
register("./import/ts-loader.mjs", import.meta.url);

const importLegacy = await import("../src/lib/import-legacy.ts");
const customerMatch = await import("../src/lib/customer-match.ts");
const { buildMarkdownReport } = await import("./import/report.mjs");
const { createClient } = await import("@supabase/supabase-js");

// ============================================================
// CLI
// ============================================================

const HELP = `
THE LEGACY IMPORTER — bring a showroom's Excel stock list and customer
book into FELIX.

USAGE
  node --env-file=.env.local scripts/import-legacy.mjs --tenant <slug> <dir> [options]

  <dir>  a directory containing vehicles.csv and/or customers.csv
         (UTF-8, comma- or semicolon-delimited, BOM tolerated, Arabic
         content — including Arabic-Indic digits — expected as the norm)

REQUIRED
  --tenant <slug>          the tenant this import writes into (t_<slug>).
                            Refused with no default — an import always
                            targets exactly one showroom.

OPTIONS
  --map <mapping.json>      column-header translations layered on top of
                            the built-in defaults (see
                            scripts/import/mapping.example.json). Only
                            needed for headers the defaults don't cover.
  --commit                  actually write. Without this flag the run is
                            a DRY RUN: every check happens (including
                            duplicate detection against the database) but
                            nothing is inserted or updated.
  --allow-legacy-vin         import a vehicle whose VIN is not a
                            conforming 17-character VIN, rather than
                            rejecting the row. The vin column is left
                            NULL (the database's vehicles_vin_format_check
                            constraint is enforced on every insert
                            regardless of how it was added — a script
                            cannot write a non-conforming string into
                            vin) and the original text is preserved in
                            the vehicle's description instead of lost.
  --default-branch <name>   branch to use for rows whose branch column
                            doesn't exactly match an existing branch.
                            Without this, unmatched branches are rejected
                            and listed in the report — this importer
                            never invents a branch.
  --help, -h                print this and exit. Never requires env vars.

WHAT GETS VALIDATED
  Vehicles
    purchase price   required, > 0
    year              1980..(current year + 1)
    VIN                validated against the standard 17-char format when
                       17 characters are supplied; a non-conforming VIN
                       is rejected unless --allow-legacy-vin
    branch             resolved by exact name match against this
                       tenant's branches (report only — never invented)
  Customers
    full_name          required
    national_id        when present, must be exactly 14 digits

EQUITY. Every imported vehicle is booked 100% to the CEO
(vehicle_equity_splits: holder_type 'ceo', holder_id NULL, amount_invested
= purchase_price, percentage 100). Legacy stock is treated as house-owned
— this importer never guesses at an outside investor's share. Reassign
equity from the app afterwards if some of it should belong to an investor.

DEDUPE / IDEMPOTENCY. Re-running with --commit is safe:
  vehicles    matched by VIN when present, else by the weak
              (make, model, year, purchase_price) fingerprint — a
              genuinely different car sharing all four is possible and
              would be skipped; the report flags every skip so it can be
              checked.
  customers   matched by national_id (14 digits, exact), then by any
              known phone spelling (customer-match.ts's canonicalization).
              An existing customer's national_id is NEVER overwritten;
              a matched customer's phone_numbers gains any new spelling
              this row knows about.

OUTPUT. Both modes write, next to the input directory:
  import-report.json   machine-readable, safe to diff between runs
  import-report.md      the file to hand to the showroom's accountant —
                        per-file counts, every reject with its row number
                        and reason, unknown branches, and a
                        reconciliation block (total purchase price and
                        vehicle count by branch) to check against their
                        books.
`;

function parseArgs(argv) {
  const args = {
    help: false,
    tenant: null,
    dir: null,
    map: null,
    commit: false,
    allowLegacyVin: false,
    defaultBranch: null,
  };
  const positional = [];

  const takeValue = (flag, i) => {
    if (i + 1 >= argv.length) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--commit") args.commit = true;
    else if (a === "--allow-legacy-vin") args.allowLegacyVin = true;
    else if (a === "--tenant") { args.tenant = takeValue(a, i); i++; }
    else if (a.startsWith("--tenant=")) args.tenant = a.slice("--tenant=".length);
    else if (a === "--map") { args.map = takeValue(a, i); i++; }
    else if (a.startsWith("--map=")) args.map = a.slice("--map=".length);
    else if (a === "--dir") { args.dir = takeValue(a, i); i++; }
    else if (a.startsWith("--dir=")) args.dir = a.slice("--dir=".length);
    else if (a === "--default-branch") { args.defaultBranch = takeValue(a, i); i++; }
    else if (a.startsWith("--default-branch=")) args.defaultBranch = a.slice("--default-branch=".length);
    else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}\nRun with --help for usage.`);
      process.exit(1);
    } else positional.push(a);
  }

  if (!args.dir && positional.length) args.dir = positional[0];
  return args;
}

function fatal(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

if (!args.tenant) fatal("--tenant is required. Run with --help for usage.");
if (!/^[a-z0-9]+$/.test(args.tenant)) fatal(`--tenant must be lowercase letters and digits only (got "${args.tenant}")`);
if (!args.dir) fatal("an input directory is required (positional argument or --dir). Run with --help for usage.");

const inputDir = path.resolve(args.dir);
if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  fatal(`input directory does not exist: ${inputDir}`);
}

const vehiclesPath = path.join(inputDir, "vehicles.csv");
const customersPath = path.join(inputDir, "customers.csv");
const hasVehicles = fs.existsSync(vehiclesPath);
const hasCustomers = fs.existsSync(customersPath);
if (!hasVehicles && !hasCustomers) {
  fatal(`neither vehicles.csv nor customers.csv found in ${inputDir}`);
}

// ============================================================
// Environment / clients — only touched past this point, so --help never
// needs them.
// ============================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  fatal(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set " +
      "(e.g. `node --env-file=.env.local scripts/import-legacy.mjs ...`)."
  );
}

const SCHEMA = `t_${args.tenant}`;
const platformDb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: "platform" },
});
const tenantDb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: SCHEMA },
});

const { data: tenantRow, error: tenantErr } = await platformDb
  .from("tenants")
  .select("id, slug")
  .eq("slug", args.tenant)
  .maybeSingle();
if (tenantErr) fatal(`could not look up tenant "${args.tenant}": ${tenantErr.message}`);
if (!tenantRow) fatal(`tenant "${args.tenant}" is not provisioned (no row in platform.tenants)`);

// ============================================================
// Mapping
// ============================================================

let mapping = { ...importLegacy.DEFAULT_HEADER_MAP };
if (args.map) {
  const mapPath = path.resolve(args.map);
  if (!fs.existsSync(mapPath)) fatal(`--map file not found: ${mapPath}`);
  let userMap;
  try {
    userMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  } catch (e) {
    fatal(`--map file is not valid JSON: ${e.message}`);
  }
  mapping = { ...mapping, ...userMap };
}

// ============================================================
// Banner
// ============================================================

const bar = "=".repeat(70);
console.log(bar);
console.log(args.commit ? "  COMMIT — WRITING TO THE DATABASE" : "  DRY RUN — NOTHING WILL BE WRITTEN");
console.log(`  tenant:  ${args.tenant}  (schema ${SCHEMA})`);
console.log(`  input:   ${inputDir}`);
if (args.allowLegacyVin) console.log("  flag:    --allow-legacy-vin");
if (args.defaultBranch) console.log(`  flag:    --default-branch "${args.defaultBranch}"`);
console.log(bar);
console.log();

// ============================================================
// Branches
// ============================================================

const { data: branchRows, error: branchesErr } = await tenantDb.from("branches").select("id, name");
if (branchesErr) fatal(`could not read branches: ${branchesErr.message}`);
const branches = branchRows ?? [];
const branchIndex = importLegacy.buildBranchIndex(branches);
const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

let defaultBranchId = null;
if (args.defaultBranch) {
  const resolved = importLegacy.resolveBranch(args.defaultBranch, branchIndex, null);
  if (!resolved.ok) fatal(`--default-branch "${args.defaultBranch}" does not match any existing branch`);
  defaultBranchId = resolved.branchId;
}

// ============================================================
// Vehicles
// ============================================================

async function processVehicles() {
  if (!hasVehicles) return null;

  const text = fs.readFileSync(vehiclesPath, "utf8");
  const parsed = importLegacy.parseCsv(text);
  const records = importLegacy.mapRowsToRecords(parsed, mapping);

  const rejects = [];
  const validWithRow = [];
  records.forEach((rec, i) => {
    const rowNumber = i + 2; // header is row 1
    const result = importLegacy.validateVehicleRow(rec, { allowLegacyVin: args.allowLegacyVin });
    if (result.ok) validWithRow.push({ rowNumber, vehicle: result.vehicle });
    else rejects.push({ row: rowNumber, reason: result.reason });
  });

  const { duplicates: fileDuplicates } = importLegacy.dedupeVehiclesInFile(
    validWithRow.map((v) => v.vehicle)
  );
  const dupIndexes = new Set(fileDuplicates.map((d) => d.index));
  const uniqueWithRow = validWithRow.filter((_, i) => !dupIndexes.has(i));
  const duplicatesReport = fileDuplicates.map((d) => ({
    row: validWithRow[d.index].rowNumber,
    matchedRow: validWithRow[d.matchedIndex].rowNumber,
    matchedOn: d.matchedOn,
  }));

  const unknownBranches = [];
  const branchResolved = [];
  for (const { rowNumber, vehicle } of uniqueWithRow) {
    const resolved = importLegacy.resolveBranch(vehicle.branchName, branchIndex, defaultBranchId);
    if (!resolved.ok) {
      unknownBranches.push({ row: rowNumber, branch: resolved.branchName });
      continue;
    }
    branchResolved.push({ rowNumber, vehicle, branchId: resolved.branchId });
  }

  // Idempotency against what this tenant already has.
  const { data: existingVinRows, error: vinErr } = await tenantDb
    .from("vehicles")
    .select("vin")
    .not("vin", "is", null);
  if (vinErr) fatal(`could not read existing vehicle VINs: ${vinErr.message}`);
  const existingVins = new Set((existingVinRows ?? []).map((r) => String(r.vin).toUpperCase()));

  const { data: existingFpRows, error: fpErr } = await tenantDb
    .from("vehicles")
    .select("make,model,year,purchase_price")
    .is("vin", null);
  if (fpErr) fatal(`could not read existing VIN-less vehicles: ${fpErr.message}`);
  const existingFingerprints = new Set(
    (existingFpRows ?? []).map((r) =>
      importLegacy.vehicleFingerprint({
        make: r.make,
        model: r.model,
        year: r.year,
        purchasePrice: Number(r.purchase_price),
      })
    )
  );

  const dbDuplicates = [];
  const insertable = [];
  for (const row of branchResolved) {
    const { vehicle } = row;
    if (vehicle.vin) {
      if (existingVins.has(vehicle.vin)) {
        dbDuplicates.push({ row: row.rowNumber, reason: `VIN ${vehicle.vin} already exists in ${SCHEMA}` });
        continue;
      }
    } else if (existingFingerprints.has(importLegacy.vehicleFingerprint(vehicle))) {
      dbDuplicates.push({
        row: row.rowNumber,
        reason: "matches an existing VIN-less vehicle on make/model/year/price (weak key)",
      });
      continue;
    }
    insertable.push(row);
  }

  let insertedCount = 0;
  const writeErrors = [];
  const countByBranch = {};
  let totalPurchasePrice = 0;

  for (const row of insertable) {
    const { vehicle, branchId } = row;
    const branchName = branchNameById.get(branchId) ?? branchId;
    totalPurchasePrice += vehicle.purchasePrice;
    countByBranch[branchName] = (countByBranch[branchName] ?? 0) + 1;

    if (!args.commit) continue;

    const { data: inserted, error: insErr } = await tenantDb
      .from("vehicles")
      .insert({
        branch_id: branchId,
        vin: vehicle.vin,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        trim: vehicle.trim,
        color: vehicle.color,
        description: vehicle.description,
        engine_number: vehicle.engineNumber,
        plate_number: vehicle.plateNumber,
        country_of_origin: vehicle.countryOfOrigin,
        item_code: vehicle.itemCode,
        purchase_price: vehicle.purchasePrice,
        created_by: null,
      })
      .select("id")
      .single();

    if (insErr || !inserted) {
      writeErrors.push({ row: row.rowNumber, message: insErr?.message ?? "insert failed" });
      continue;
    }

    // 100% CEO, house-owned — see --help. holder_id NULL matches the
    // holder_id_matches_type check (0009 §5).
    const { error: eqErr } = await tenantDb.from("vehicle_equity_splits").insert({
      vehicle_id: inserted.id,
      holder_type: "ceo",
      holder_id: null,
      amount_invested: vehicle.purchasePrice,
      percentage: 100,
    });
    if (eqErr) {
      writeErrors.push({
        row: row.rowNumber,
        message: `vehicle ${inserted.id} was created but its 100% CEO equity split failed (${eqErr.message}) — fix manually`,
      });
      continue;
    }

    insertedCount++;
  }

  return {
    section: {
      file: "vehicles.csv",
      mode: args.commit ? "commit" : "dry-run",
      read: records.length,
      valid: validWithRow.length,
      rejected: rejects.length,
      duplicateInFile: duplicatesReport.length,
      duplicateInDb: dbDuplicates.length,
      unknownBranch: unknownBranches.length,
      insertable: insertable.length,
      inserted: insertedCount,
      writeErrors: writeErrors.length,
      rejects,
      duplicates: duplicatesReport,
      dbDuplicates,
      unknownBranches,
      errors: writeErrors,
    },
    reconciliation: { totalPurchasePrice, countByBranch },
  };
}

// ============================================================
// Customers
// ============================================================

function unionPhones(existing, additions) {
  const out = [...(existing ?? [])];
  for (const p of additions) if (!out.includes(p)) out.push(p);
  return out;
}

async function processCustomers() {
  if (!hasCustomers) return null;

  const text = fs.readFileSync(customersPath, "utf8");
  const parsed = importLegacy.parseCsv(text);
  const records = importLegacy.mapRowsToRecords(parsed, mapping);

  const rejects = [];
  const validList = [];
  const rowNumberByValidIndex = [];
  records.forEach((rec, i) => {
    const rowNumber = i + 2;
    const result = importLegacy.validateCustomerRow(rec);
    if (result.ok) {
      validList.push(result.customer);
      rowNumberByValidIndex.push(rowNumber);
    } else {
      rejects.push({ row: rowNumber, reason: result.reason });
    }
  });

  const { merged, duplicates: fileDuplicates } = importLegacy.dedupeCustomersInFile(validList);
  const duplicatesReport = fileDuplicates.map((d) => ({
    row: rowNumberByValidIndex[d.index],
    matchedRow: rowNumberByValidIndex[d.matchedIndex],
    matchedOn: d.matchedOn,
  }));

  const nationalIds = [...new Set(merged.filter((m) => m.nationalId).map((m) => m.nationalId))];
  const allVariants = [
    ...new Set(merged.flatMap((m) => m.phoneNumbers.flatMap((p) => customerMatch.phoneVariants(p)))),
  ];

  const byId = nationalIds.length
    ? await tenantDb.from("customers").select("id,national_id,phone_numbers").in("national_id", nationalIds)
    : { data: [] };
  if (byId.error) fatal(`could not read existing customers by national ID: ${byId.error.message}`);

  const byPhone = allVariants.length
    ? await tenantDb
        .from("customers")
        .select("id,national_id,phone_numbers")
        .overlaps("phone_numbers", allVariants)
        .order("created_at", { ascending: true })
    : { data: [] };
  if (byPhone.error) fatal(`could not read existing customers by phone: ${byPhone.error.message}`);

  const dbCandidates = [];
  const seenIds = new Set();
  for (const row of [...(byId.data ?? []), ...(byPhone.data ?? [])]) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    dbCandidates.push(row);
  }

  // Same precedence as customer-match.ts's decideCustomerLink: national ID
  // first, then any known phone spelling — generalized to a merged file
  // entry that may carry more than one phone number.
  function decideAgainstDb(entry) {
    if (entry.nationalId) {
      const hit = dbCandidates.find((c) => (c.national_id ?? "").trim() === entry.nationalId);
      if (hit) return { action: "link", matchedOn: "national_id", candidate: hit };
    }
    for (const phone of entry.phoneNumbers) {
      const hit = dbCandidates.find((c) => customerMatch.customerKnowsPhone(c, phone));
      if (hit) return { action: "link", matchedOn: "phone", candidate: hit };
    }
    return { action: "create" };
  }

  const dbDuplicates = [];
  const insertableEntries = [];
  const enrichEntries = [];
  for (const entry of merged) {
    const row = rowNumberByValidIndex[entry.sourceIndexes[0]];
    const plan = decideAgainstDb(entry);
    if (plan.action === "link") {
      dbDuplicates.push({
        row,
        reason: `matches existing customer ${plan.candidate.id} (${plan.matchedOn})`,
        customerId: plan.candidate.id,
      });
      const mergedPhones = unionPhones(plan.candidate.phone_numbers, entry.phoneNumbers);
      // Never overwrite an existing national_id — only attach one where there was none.
      const setNationalId =
        entry.nationalId && !(plan.candidate.national_id ?? "").trim() ? entry.nationalId : null;
      const phonesChanged = mergedPhones.length !== (plan.candidate.phone_numbers ?? []).length;
      if (phonesChanged || setNationalId) {
        enrichEntries.push({ row, customerId: plan.candidate.id, phoneNumbers: phonesChanged ? mergedPhones : null, setNationalId });
      }
      continue;
    }
    insertableEntries.push({ row, entry });
  }

  let insertedCount = 0;
  let enrichedCount = 0;
  const writeErrors = [];

  if (args.commit) {
    for (const { row, entry } of insertableEntries) {
      const { data, error } = await tenantDb
        .from("customers")
        .insert({
          full_name: entry.fullName,
          national_id: entry.nationalId,
          phone_numbers: entry.phoneNumbers,
          address: entry.address,
          nationality: entry.nationality,
        })
        .select("id")
        .single();
      if (error || !data) {
        writeErrors.push({ row, message: error?.message ?? "insert failed" });
        continue;
      }
      insertedCount++;
    }

    for (const e of enrichEntries) {
      const patch = {};
      if (e.phoneNumbers) patch.phone_numbers = e.phoneNumbers;
      if (e.setNationalId) patch.national_id = e.setNationalId;
      if (Object.keys(patch).length === 0) continue;
      const { error } = await tenantDb.from("customers").update(patch).eq("id", e.customerId);
      if (error) {
        writeErrors.push({ row: e.row, message: `enriching existing customer ${e.customerId}: ${error.message}` });
        continue;
      }
      enrichedCount++;
    }
  }

  return {
    file: "customers.csv",
    mode: args.commit ? "commit" : "dry-run",
    read: records.length,
    valid: validList.length,
    rejected: rejects.length,
    duplicateInFile: duplicatesReport.length,
    duplicateInDb: dbDuplicates.length,
    insertable: insertableEntries.length,
    inserted: insertedCount,
    enriched: args.commit ? enrichedCount : enrichEntries.length,
    writeErrors: writeErrors.length,
    rejects,
    duplicates: duplicatesReport,
    dbDuplicates,
    errors: writeErrors,
  };
}

// ============================================================
// Run
// ============================================================

const vehiclesResult = await processVehicles();
const customersResult = await processCustomers();

const report = {
  tool: "import-legacy",
  mode: args.commit ? "commit" : "dry-run",
  tenant: args.tenant,
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  inputDir,
  flags: { allowLegacyVin: args.allowLegacyVin, defaultBranch: args.defaultBranch, mapFile: args.map },
  vehicles: vehiclesResult?.section ?? null,
  customers: customersResult ?? null,
  reconciliation: {
    vehicles: vehiclesResult?.reconciliation ?? null,
  },
};

const jsonPath = path.join(inputDir, "import-report.json");
const mdPath = path.join(inputDir, "import-report.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
fs.writeFileSync(mdPath, buildMarkdownReport(report), "utf8");

console.log(`Vehicles:  ${hasVehicles ? summarize(report.vehicles) : "no vehicles.csv — skipped"}`);
console.log(`Customers: ${hasCustomers ? summarize(report.customers) : "no customers.csv — skipped"}`);
console.log();
console.log(`Report written: ${jsonPath}`);
console.log(`             and ${mdPath}`);
console.log();
console.log(bar);
console.log(
  args.commit
    ? "  COMMIT COMPLETE"
    : "  DRY RUN COMPLETE — nothing was written. Re-run with --commit to write it."
);
console.log(bar);

function summarize(section) {
  if (!section) return "skipped";
  const parts = [
    `${section.read} read`,
    `${section.valid} valid`,
    `${section.rejected} rejected`,
    `${section.duplicateInFile} dup-in-file`,
    `${section.duplicateInDb} dup-in-db`,
  ];
  if ("unknownBranch" in section) parts.push(`${section.unknownBranch} unknown-branch`);
  parts.push(args.commit ? `${section.inserted} inserted` : `${section.insertable} would-insert`);
  if (section.writeErrors) parts.push(`${section.writeErrors} write-errors`);
  return parts.join(", ");
}
