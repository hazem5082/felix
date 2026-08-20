// Turns the counters and row-level notes scripts/import-legacy.mjs
// accumulates while processing vehicles.csv / customers.csv into the two
// artefacts the runbook promises: import-report.json (machine-readable,
// safe to diff between runs) and import-report.md (what a non-engineer
// ops person, or the showroom's accountant, actually reads).
//
// Row numbers everywhere here count the header as row 1 — the number you'd
// see if you opened the CSV in a spreadsheet and clicked the row with the
// problem, not a zero-based array index.

function money(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fileSectionMd(title, section) {
  if (!section) return `## ${title}\n\n_No ${section === null ? "file" : "data"} found — skipped._\n`;

  const lines = [];
  lines.push(`## ${title}`);
  lines.push("");
  lines.push(`Source file: \`${section.file}\``);
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Rows read | ${section.read} |`);
  lines.push(`| Passed validation | ${section.valid} |`);
  lines.push(`| Rejected | ${section.rejected} |`);
  lines.push(`| Duplicate within file | ${section.duplicateInFile} |`);
  lines.push(`| Duplicate against database | ${section.duplicateInDb} |`);
  if ("unknownBranch" in section) lines.push(`| Unknown branch | ${section.unknownBranch} |`);
  if ("enriched" in section)
    lines.push(`| Existing customer enriched (phone/national ID) | ${section.enriched} |`);
  lines.push(`| ${section.mode === "commit" ? "Inserted" : "Would insert"} | ${section.insertable} |`);
  if (section.mode === "commit") lines.push(`| Actually written | ${section.inserted} |`);
  if (section.writeErrors) lines.push(`| Write errors | ${section.writeErrors} |`);
  lines.push("");

  if (section.rejects?.length) {
    lines.push("### Rejected rows");
    lines.push("");
    lines.push("| Row | Reason |");
    lines.push("| ---: | --- |");
    for (const r of section.rejects) lines.push(`| ${r.row} | ${r.reason} |`);
    lines.push("");
  }

  if (section.unknownBranches?.length) {
    lines.push("### Unknown branches");
    lines.push("");
    lines.push("These rows named a branch that does not exist (by exact name) in this tenant.");
    lines.push("Add the branch first, fix the spelling in the CSV, or re-run with `--default-branch`.");
    lines.push("");
    lines.push("| Row | Branch as written |");
    lines.push("| ---: | --- |");
    for (const r of section.unknownBranches) lines.push(`| ${r.row} | ${r.branch} |`);
    lines.push("");
  }

  if (section.duplicates?.length) {
    lines.push("### Duplicates within the file");
    lines.push("");
    lines.push("| Row | Same as row | Matched on |");
    lines.push("| ---: | ---: | --- |");
    for (const d of section.duplicates) lines.push(`| ${d.row} | ${d.matchedRow} | ${d.matchedOn} |`);
    lines.push("");
  }

  if (section.dbDuplicates?.length) {
    lines.push("### Already in the database");
    lines.push("");
    lines.push("| Row | Reason |");
    lines.push("| ---: | --- |");
    for (const d of section.dbDuplicates) lines.push(`| ${d.row} | ${d.reason} |`);
    lines.push("");
  }

  if (section.errors?.length) {
    lines.push("### Write errors");
    lines.push("");
    lines.push("| Row | Error |");
    lines.push("| ---: | --- |");
    for (const e of section.errors) lines.push(`| ${e.row} | ${e.message} |`);
    lines.push("");
  }

  return lines.join("\n");
}

export function buildMarkdownReport(report) {
  const lines = [];
  const bannerWord = report.mode === "commit" ? "COMMIT" : "DRY RUN";

  lines.push(`# Legacy import report — ${bannerWord}`);
  lines.push("");
  lines.push(`- Tenant: \`${report.tenant}\` (schema \`${report.schema}\`)`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input directory: \`${report.inputDir}\``);
  lines.push(
    `- Mode: **${bannerWord}**${
      report.mode === "dry-run" ? " — nothing below was written. Re-run with `--commit` to write it." : ""
    }`
  );
  if (report.flags.allowLegacyVin) lines.push("- `--allow-legacy-vin` was set.");
  if (report.flags.defaultBranch) lines.push(`- Default branch: \`${report.flags.defaultBranch}\``);
  lines.push("");

  lines.push(fileSectionMd("Vehicles", report.vehicles));
  lines.push("");
  lines.push(fileSectionMd("Customers", report.customers));
  lines.push("");

  lines.push("## Reconciliation");
  lines.push("");
  lines.push(
    "Check these two numbers against the showroom's own books before trusting the import. " +
      "They cover only the vehicles this run inserted (or would insert)."
  );
  lines.push("");
  if (report.reconciliation.vehicles) {
    const rec = report.reconciliation.vehicles;
    lines.push(`- Total purchase price: **${money(rec.totalPurchasePrice)}**`);
    lines.push("");
    lines.push("| Branch | Vehicles |");
    lines.push("| --- | ---: |");
    for (const [branch, count] of Object.entries(rec.countByBranch)) {
      lines.push(`| ${branch} | ${count} |`);
    }
  } else {
    lines.push("_No vehicles processed._");
  }
  lines.push("");
  lines.push(
    "Every imported vehicle is booked 100% to the CEO's equity (`vehicle_equity_splits`, " +
      "`holder_type = 'ceo'`, `percentage = 100`) — legacy stock is treated as house-owned. " +
      "Reassign any of it to an investor from the app afterwards; this importer never guesses at outside ownership."
  );
  lines.push("");

  return lines.join("\n");
}
