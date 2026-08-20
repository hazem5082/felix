# Legacy importer — runbook

> **Demonstrating this to a showroom?** `demo-legacy/` next to this file
> holds a ready-made `vehicles.csv` (14 rows) and `customers.csv` (13
> rows) in the shape an Egyptian showroom's Excel export actually
> arrives in — Arabic headers, Arabic-Indic digits, `"1,150,000 جنيه"`
> price formatting — with two deliberately broken cells so the reject
> report has something real in it. No `--map` needed: every header in
> them is one the importer recognises out of the box.
>
> ```bash
> node --env-file=.env.local scripts/import-legacy.mjs --tenant felix ./scripts/import/demo-legacy
> ```
>
> Dry run, as always. See `scripts/DEMO_SCRIPT.md` §10 for what to say
> while it runs.

This is the checklist for bringing a showroom's existing Excel stock list
and customer book into FELIX. It is written for whoever is running the
import, not necessarily an engineer — the commands are copy-paste-able.

## 1. Get the exports from the showroom

Ask them for two files, or as much of the two as they have:

- **Stock list** (`vehicles.csv`) — one row per car currently in
  inventory, or sold historically if they want that history carried
  over too.
- **Customer book** (`customers.csv`) — one row per customer.

How to get a clean CSV out of Excel:

1. Open the spreadsheet.
2. **File → Save As** (or **Export**).
3. Choose **CSV UTF-8 (Comma delimited) (\*.csv)**. If that option isn't
   available, plain **CSV (\*.csv)** is fine too — the importer
   auto-detects comma or semicolon, and reads Arabic text either way.
4. Save it as exactly `vehicles.csv` or `customers.csv`, in one folder.

Don't worry about:

- Extra columns the importer doesn't use — they're ignored.
- Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) in numbers, years, or VINs — they're
  converted automatically.
- Quoted text with commas inside it (an address like
  `"شارع الجمهورية، المعادي"`) — standard CSV quoting is parsed correctly.

## 2. Look at the header row

Open the CSV (or the original spreadsheet) and note the exact column
headers. The importer already recognizes a lot of common Arabic and
English headers out of the box — see the list in
`scripts/import/mapping.example.json`. If a column isn't in that list
(a header spelled differently, or a language mix), you'll add it to a
mapping file in the next step.

Required columns:

| For | Column meaning |
| --- | --- |
| Vehicles | make, model, year, purchase price, branch |
| Customers | customer name |

Everything else (VIN, color, trim, engine/plate number, country of
origin, national ID, phone, address, nationality) is optional — the
importer fills in what's there and leaves the rest blank.

## 3. Write a mapping file (only if needed)

Copy `scripts/import/mapping.example.json` to somewhere handy (e.g.
`mapping.json` next to the CSVs) and edit it: keys are the showroom's
exact column headers, values are the FELIX field name. You only need to
list headers that AREN'T already covered by the built-in defaults —
your file is layered on top of them, not instead of them.

```json
{
  "ماركة العربية": "make",
  "موديل": "model"
}
```

If every header in the export already matches a built-in default,
you can skip `--map` entirely.

## 4. Dry run

**Always dry-run first.** It is the default — you'd have to pass
`--commit` to write anything. A dry run still connects to the database
(to check for duplicates and validate branch names), but writes nothing.

```bash
node --env-file=.env.local scripts/import-legacy.mjs --tenant abaza ./abaza-export --map ./abaza-export/mapping.json
```

Replace `abaza` with the tenant's slug and `./abaza-export` with the
folder holding the CSVs. This needs the same `.env.local` the rest of
the app uses (`NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`) — `node --help` alone works without it,
everything else doesn't.

## 5. Read the report

The dry run writes two files into the input folder:

- **`import-report.md`** — read this one. Per file: how many rows were
  read, how many passed validation, how many are duplicates (within the
  file, or already in the database), how many would be inserted, and a
  table of every rejected row with its row number and the reason.
- **`import-report.json`** — the same information as data, in case you
  want to script something against it or diff two runs.

Fix what needs fixing in the source spreadsheet and re-export, or adjust
the mapping file, then re-run the dry run. Repeat until the counts and
the reject list look right. Common fixes:

- **"missing branch" / listed under "Unknown branches"** — the branch
  name in the CSV doesn't exactly match a branch already in FELIX. Either
  fix the spelling in the CSV, or add `--default-branch "Downtown Showroom"`
  to send everything unmatched to one branch (check the report for which
  rows that actually affects before committing).
- **"purchase price ... must be a positive number"** — an empty, zero, or
  unparseable cost cell. Egyptian pound formatting like `18,000 EGP` or
  `١٨٠٠٠ جنيه` is understood automatically; genuinely missing data is not.
- **"is not a valid 17-character VIN"** — the VIN column has something
  other than a standard 17-character VIN (common on older stock). Either
  fix it in the source, or add `--allow-legacy-vin` to import the vehicle
  anyway with the VIN column left blank and the original text kept in
  its description (see `--help` for why the VIN column itself can't hold
  a non-conforming value).
- **"national ID ... must be exactly 14 digits"** — a typo, or a
  passport/other ID number in that column instead of the national ID.
  Leaving the cell blank is always fine; national ID is optional.

## 6. Commit

Once the dry run's report looks right, add `--commit`:

```bash
node --env-file=.env.local scripts/import-legacy.mjs --tenant abaza ./abaza-export --map ./abaza-export/mapping.json --commit
```

The report files are overwritten with the real, committed counts. Send
`import-report.md` to the showroom's accountant — the **Reconciliation**
section at the bottom (total purchase price imported, vehicle count per
branch) is exactly what they should check against their own books before
signing off.

Re-running `--commit` again (on purpose, or by accident) is safe: rows
already imported are detected as duplicates and skipped, not
re-inserted. Vehicles without a VIN are matched on a weaker key (make +
model + year + purchase price) — the report calls this out explicitly
wherever it applies, since two genuinely different cars can share all
four.

## What every imported vehicle looks like afterwards

- 100% of its equity is booked to the CEO
  (`vehicle_equity_splits.holder_type = 'ceo'`, `percentage = 100`).
  Legacy stock is treated as house-owned; the importer never guesses at
  an outside investor's share. If some of it should actually belong to
  an investor, reassign that from the app after the import.
- `created_by` is left blank (no staff member "took it in" — it arrived
  through this importer instead). Nothing in the app depends on that
  column being set.

## What every imported customer looks like afterwards

- Matched to an existing customer first by national ID (exact, 14
  digits), then by any phone number spelling already on file — the same
  precedence the CRM itself uses when a salesperson saves a lead.
- An existing customer's national ID is **never** overwritten by the
  import — only attached when the existing record had none at all.
- A matched customer's phone list gains any new number this row knows
  about; a genuinely new customer is created with the number(s) from the
  file.
