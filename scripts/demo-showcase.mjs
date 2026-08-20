// THE SHOWCASE SCENES — everything migrations 0030-0036 built, standing
// up as data a person can walk through in front of a ten-branch group.
//
// seed-demo.mjs lays down a working showroom: staff, four cars, a
// pipeline, one executed cash sale. That is enough to prove the product
// runs and not nearly enough to sell it. Nothing in that dataset has a
// second branch, an aged car, a consigned car, a trade-in, a receivable,
// a cheque, a transfer or an e-invoice — so every screen those six
// migrations added opens EMPTY on the demo tenant, which is the worst
// possible first impression of a feature that works.
//
// This module adds one scene per feature. It is imported and called by
// seed-demo.mjs at the end of main(); it is a separate file for the same
// reason demo-fixtures.mjs is one — importing it must stay free of side
// effects, and seed-demo.mjs calls main() at module scope.
//
// THREE RULES, ALL OF THEM LEARNED FROM THE SCHEMA
// ------------------------------------------------
//  1. EVERY SCENE IS PROBE-GUARDED. This runs against a LIVE demo
//     tenant that people have been clicking around in. A re-run must add
//     what is missing and touch nothing else — never a second Heliopolis
//     branch, never a fifth cheque, never a price a salesperson edited
//     while demonstrating the product. The probe is named in the log
//     line so a skip is legible.
//
//  2. WRITE IN THE ORDER THE TRIGGERS ALLOW, not the order the finished
//     state suggests. A cheque cannot be born 'cleared'
//     (guard_cheque_status, 0033): it is inserted 'deposited' and moved.
//     A deal ticket cannot be born 'approved' (guard_deal_ticket_status,
//     0009). A sale cannot be executed by the service role at all
//     (execute_vehicle_sale reads auth.uid()), so the CEO signs in and
//     does it — which is also why this module takes `signedInAs` rather
//     than only a database handle. A price history row is not inserted:
//     it is the RESULT of an UPDATE to asking_price
//     (record_vehicle_price_history, 0036), so the scene writes the
//     price twice and lets the trigger keep the history.
//
//  3. ARABIC WHEREVER A HUMAN NAME OR A NOTE GOES. The pitch is in
//     Arabic. A consignor called "Consignor #2" is worse than no
//     consignment car at all.
//
// A SCENE THAT FAILS DOES NOT TAKE THE SEED DOWN. Each is run inside
// scene(), which catches, logs the reason with the scene's name, and
// carries on — so a tenant that is one migration behind gets the eleven
// scenes it can support instead of none. The failures are returned and
// summarised by the caller.
//
// PRICES ARE IN EGP AND THE ORIGINAL FOUR CARS ARE NOT. seed-demo.mjs's
// Fusion/Civic/Camry/BMW are priced in the tens of thousands, from a
// time when the demo was not Egyptian. They are deliberately left alone:
// the Fusion is SOLD, its waterfall is posted to the ledger, and
// guard_vehicle_status() locks a sold car's cost basis — restating those
// four would mean unwinding a settled sale. The showcase cars added here
// are priced the way a Cairo forecourt prices them, and the walkthrough
// in scripts/DEMO_SCRIPT.md is written around them.

import { vinFor } from "./demo-fixtures.mjs";

// ── Time ────────────────────────────────────────────────────
//
// Every backdated write uses an EXPLICIT timestamp computed from one
// `now` captured at the top of the run, so a scene that takes a minute
// does not straddle a day boundary halfway through and put two halves of
// the same story in different ageing buckets.

const DAY = 24 * 60 * 60 * 1000;

/** ISO instant, `n` days before the run's own start. */
const daysAgo = (now, n) => new Date(now.getTime() - n * DAY).toISOString();

/** 'yyyy-mm-dd', `n` days before the run's own start. */
const dateDaysAgo = (now, n) => daysAgo(now, n).slice(0, 10);

// ── The showcase cars ───────────────────────────────────────
//
// Their own VIN table rather than an addition to BASE_VINS: those four
// are the idempotency key for demo-photos.mjs and demo-pipeline.mjs, and
// adding to that object would have both scripts looking for photographs
// and buyers that do not exist. The slug tail is applied exactly as
// vinFor() applies it, so a second showroom gets its own set.

const SHOWCASE_VINS = {
  // The in-house instalment sale — sold, financed by the showroom itself.
  cerato: "KNAFX4A82H5FX0021",
  // The trade-in ticket, still awaiting approval.
  elantra: "KMHD84LF5MU5L0022",
  // Consignment, still on the floor.
  sunny: "JN1BF6AP5KY0N0023",
  // Consignment, sold — the payout the accountant owes an outsider.
  tiggo: "LVVDB11B5MD0T0024",
  // Dead stock, and the car whose price gets cut.
  sportage: "KNAPB81BFL7SP0025",
  // Stale stock, and the car with an open transfer request.
  mg5: "LSJA24U95NZ0G0026",
};

/** The 2019 Lanos the buyer trades in. Never inserted here — see §5. */
const LANOS_VIN_BASE = "KLATF08Y1YB0N0027";

const showcaseVin = (slug, base) => {
  if (slug === "felix") return base;
  const tail = slug.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  return base.slice(0, 11) + tail;
};

// ── Arabic fixtures ─────────────────────────────────────────

const HELIOPOLIS_NAME = "فرع مصر الجديدة";
const HELIOPOLIS_ADDRESS = "12 شارع الميرغني، مصر الجديدة، القاهرة";

/** The in-house instalment buyer. Named on the cheques and the invoice. */
const BUYER = {
  name: "محمود عبد العزيز شاهين",
  phone: "01005512477",
  // 14 digits, matching customers_national_id_check / leads' own.
  nationalId: "28704121201553",
  address: "34 شارع مصدق، الدقي، الجيزة",
  interest: "كيا سيراتو 2022 — تقسيط داخلي",
  nationality: "مصري",
};

/** The trade-in buyer: the Elantra out, a 2019 Lanos in. */
const TRADE_IN_BUYER = {
  name: "شريف محمد أنور القاضي",
  phone: "01278004195",
  nationalId: "29102284401726",
  address: "8 شارع عباس العقاد، مدينة نصر، القاهرة",
  interest: "هيونداي إلنترا 2021 — مع تبديل لانوس 2019",
  nationality: "مصري",
};

/** Who bought the consigned Tiggo. */
const CONSIGNMENT_BUYER = {
  name: "ياسمين طارق عبد الوهاب",
  phone: "01554407132",
  nationalId: "29507113301842",
  address: "19 شارع النزهة، مصر الجديدة، القاهرة",
  interest: "شيري تيجو 4 موديل 2021",
  nationality: "مصرية",
};

const BANQUE_MISR = "بنك مصر";
const NBE = "البنك الأهلي المصري";

/** Where a bought car came from, when nothing else says. */
const ACQUISITION_SOURCES = ["مزاد", "عميل سابق", "استيراد", "معرض شريك"];

/** A stable small integer from a string — used only to vary fixtures. */
function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// ── The runner ──────────────────────────────────────────────

/**
 * Runs one scene, and never lets it take the seed with it.
 *
 * A scene is skipped for two quite different reasons and the log says
 * which: `↷` is the probe finding the scene already there (the ordinary
 * case on a re-run), `!` is the scene failing — a missing migration, a
 * refused write — which is worth reading but is not worth losing the
 * ten scenes after it.
 */
async function scene(name, log, failures, work) {
  try {
    await work();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${message}`);
    log(`! scene "${name}" skipped — ${message}`);
  }
}

/**
 * Is this table reachable at all?
 *
 * The convention seedPipeline() established for lead_vehicle_interests:
 * a showroom one migration behind must get the scenes it CAN support and
 * a sentence naming the migration it is missing, not a stack trace.
 */
async function requireTable(db, table, migration, columns = "*") {
  const { error } = await db.from(table).select(columns, { head: true, count: "exact" }).limit(1);
  if (error) {
    throw new Error(`${table} unavailable (${error.message}) — apply migration ${migration}, then re-run`);
  }
}

const must = (label, { data, error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};

/**
 * A named buyer, as a lead LINKED to a customer (0031).
 *
 * Both halves, and in that order, because they answer different
 * questions: the lead is this enquiry, the customer is the durable
 * identity behind it — and loadEtaContext() prefers the customer's
 * national ID over the lead's precisely because the customer row is the
 * deduplicated one somebody checked against a document. A ticket whose
 * buyer is only a lead files an e-invoice against whatever was typed on
 * the day.
 *
 * Idempotent on the phone number (leads) and the national ID
 * (customers), which is exactly how seedPipeline() and the CRM's own
 * matcher decide the same question.
 */
async function ensureBuyer(db, buyer, { branchId, salespersonId }) {
  let lead = must(
    `looking up ${buyer.name}`,
    await db.from("leads").select("id, customer_id").eq("phone_number", buyer.phone).maybeSingle()
  );

  if (!lead) {
    lead = must(
      `creating the lead for ${buyer.name}`,
      await db
        .from("leads")
        .insert({
          branch_id: branchId,
          salesperson_id: salespersonId,
          client_name: buyer.name,
          phone_number: buyer.phone,
          national_id: buyer.nationalId,
          address: buyer.address,
          car_interest: buyer.interest,
          status: "ticket_created",
          source: "manual",
        })
        .select("id, customer_id")
        .single()
    );
  }

  if (!lead.customer_id) {
    let customer = must(
      `looking up the customer ${buyer.name}`,
      await db.from("customers").select("id").eq("national_id", buyer.nationalId).maybeSingle()
    );
    if (!customer) {
      customer = must(
        `creating the customer ${buyer.name}`,
        await db
          .from("customers")
          .insert({
            full_name: buyer.name,
            national_id: buyer.nationalId,
            phone_numbers: [buyer.phone],
            address: buyer.address,
            nationality: buyer.nationality ?? "مصري",
          })
          .select("id")
          .single()
      );
    }
    must(
      `linking ${buyer.name}`,
      await db.from("leads").update({ customer_id: customer.id }).eq("id", lead.id)
    );
  }

  return lead;
}

// ============================================================
// THE SCENES
// ============================================================

/**
 * §1 — A SECOND BRANCH.
 *
 * 0030's whole argument is about a group with more branches than one
 * profile can hold, and the seed ships two branches with English names.
 * Heliopolis is the branch every other scene in this file points at: the
 * grant is over it, the transfer is into it.
 *
 * Probe: a branch whose name is already the Arabic one. Matched on the
 * exact name rather than on "are there at least two branches", because
 * the seed's own Airport Road branch would satisfy the count and leave
 * the transfer with nowhere to go.
 */
async function ensureHeliopolis(db, log) {
  const branches = must("reading branches", await db.from("branches").select("id, name"));
  const found = branches.find((b) => b.name === HELIOPOLIS_NAME || /heliopolis/i.test(b.name));
  if (found) {
    log(`↷ ${found.name} already exists`);
    return found;
  }

  const created = must(
    "creating the Heliopolis branch",
    await db
      .from("branches")
      .insert({ name: HELIOPOLIS_NAME, address: HELIOPOLIS_ADDRESS })
      .select("id, name")
      .single()
  );
  log(`✓ branch ${HELIOPOLIS_NAME}`);
  return created;
}

/**
 * §1b — THE GRANT THAT MAKES IT A GROUP.
 *
 * The branch manager keeps their home branch (0030 moves nobody) and
 * gains authority over Heliopolis. `granted_by` is the CEO's profile,
 * which is the only honest answer: a grant nobody issued is exactly the
 * mystery the note column exists to prevent.
 *
 * Probe: the unique (profile_id, branch_id) pair 0030 indexes. A revoked
 * grant is deliberately NOT re-granted here — revoked_at is a decision
 * somebody made, and a seed re-run must not quietly reverse it.
 */
async function ensureBranchGrant(db, log, { managerId, ceoId, branchId }) {
  await requireTable(db, "branch_grants", "0030");
  if (!managerId) throw new Error("no branch manager profile to grant");

  const existing = must(
    "reading branch_grants",
    await db
      .from("branch_grants")
      .select("id, revoked_at")
      .eq("profile_id", managerId)
      .eq("branch_id", branchId)
      .maybeSingle()
  );
  if (existing) {
    log(`↷ the branch manager already holds a grant over ${HELIOPOLIS_NAME}`);
    return;
  }

  must(
    "granting the branch",
    await db.from("branch_grants").insert({
      profile_id: managerId,
      branch_id: branchId,
      granted_by: ceoId ?? null,
      note: "يغطي فرع مصر الجديدة بالإضافة إلى فرعه الأصلي — قرار الإدارة العليا",
    })
  );
  log(`✓ branch manager granted authority over ${HELIOPOLIS_NAME}`);
}

/**
 * §1c — THE SELLER'S TAX REGISTRATION.
 *
 * Not a scene of its own so much as the precondition for §10: without a
 * RIN on the branch, buildEtaDocument() raises the missingIssuerRin
 * BLOCKER and the invoice panel has nothing to show. Written only when
 * the column is empty, because a real number typed by a real showroom
 * must never be overwritten by a demo one.
 */
async function ensureTaxRegistration(db, log, branch) {
  if (branch.tax_registration_no) return branch.tax_registration_no;
  const rin = "512847693";
  must(
    "setting the branch tax registration",
    await db.from("branches").update({ tax_registration_no: rin }).eq("id", branch.id)
  );
  log(`✓ tax registration ${rin} on ${branch.name}`);
  return rin;
}

/**
 * §2/§4 — THE SHOWCASE CARS.
 *
 * Six rows, idempotent on VIN exactly as insertVehicle() in seed-demo.mjs
 * is. Two of them are consignments and carry `purchase_price = 0`, which
 * is legal ONLY because acquisition_type says 'consignment' — 0032's
 * vehicles_purchase_price_check is conditional on the mode, and the same
 * row typed as a purchase is rejected.
 *
 * NO EQUITY SPLITS ON THE CONSIGNMENTS, and not by omission:
 * prevent_split_on_consignment() refuses them outright. The house did
 * not buy the car and has no stake to divide. The four purchased cars
 * are booked 100% to the CEO, which is what the legacy importer does
 * with stock whose funding nobody recorded.
 */
async function ensureShowcaseVehicles(db, log, { slug, branchId, createdBy }) {
  const vin = (key) => showcaseVin(slug, SHOWCASE_VINS[key]);

  const wanted = [
    {
      key: "cerato",
      row: {
        year: 2022, make: "Kia", model: "Cerato", trim: "GT Line", color: "أبيض لؤلؤي",
        purchase_price: 720000, asking_price: 875000, min_price: 840000,
        odometer_km: 38400, acquisition_source: "عميل سابق",
      },
    },
    {
      key: "elantra",
      row: {
        year: 2021, make: "Hyundai", model: "Elantra", trim: "Smart Plus", color: "رمادي",
        purchase_price: 690000, asking_price: 815000, min_price: 785000,
        odometer_km: 61250, acquisition_source: "مزاد",
      },
    },
    {
      key: "sunny",
      row: {
        year: 2019, make: "Nissan", model: "Sunny", trim: "Super Saloon", color: "فضي",
        // بالأمانة: no capital deployed, therefore a zero cost basis and
        // no cap table. 0032, §4.3.
        acquisition_type: "consignment",
        purchase_price: 0, asking_price: 545000, min_price: 525000,
        consignor_name: "منى عبد الرحمن حجازي",
        consignor_phone: "01223318864",
        consignor_national_id: "27905031400287",
        consignment_commission_type: "percent",
        consignment_commission_value: 5,
        odometer_km: 98700, acquisition_source: "بالأمانة — مالك سابق",
      },
    },
    {
      key: "tiggo",
      row: {
        year: 2021, make: "Chery", model: "Tiggo 4", trim: "Comfort", color: "أزرق",
        acquisition_type: "consignment",
        purchase_price: 0, asking_price: 480000, min_price: 455000,
        consignor_name: "سعيد الجندي عبد الفتاح",
        consignor_phone: "01098742310",
        consignor_national_id: "26611274500619",
        consignment_commission_type: "percent",
        consignment_commission_value: 5,
        odometer_km: 54300, acquisition_source: "بالأمانة — مالك سابق",
      },
    },
    {
      key: "sportage",
      row: {
        year: 2020, make: "Kia", model: "Sportage", trim: "EX", color: "أسود",
        purchase_price: 880000,
        // asking_price is deliberately LEFT NULL here. §3 writes it, then
        // rewrites it lower, and the trigger keeps both. Setting it at
        // insert would spend the first history row on the intake price.
        odometer_km: 112900, acquisition_source: "استيراد",
      },
    },
    {
      key: "mg5",
      row: {
        year: 2022, make: "MG", model: "MG5", trim: "Luxury", color: "أحمر",
        purchase_price: 640000, asking_price: 762000, min_price: 735000,
        odometer_km: 27600, acquisition_source: "معرض شريك",
      },
    },
  ];

  const ids = {};
  let added = 0;

  for (const { key, row } of wanted) {
    const existing = must(
      `looking up ${key}`,
      await db.from("vehicles").select("id, acquisition_type").eq("vin", vin(key)).maybeSingle()
    );
    if (existing) {
      ids[key] = existing.id;
      continue;
    }

    const created = must(
      `taking in the ${row.make} ${row.model}`,
      await db
        .from("vehicles")
        .insert({ branch_id: branchId, vin: vin(key), created_by: createdBy ?? null, ...row })
        .select("id")
        .single()
    );
    ids[key] = created.id;
    added += 1;

    // A consigned car has no cap table at all — the trigger would refuse
    // one. Everything else is house-funded.
    if (row.acquisition_type !== "consignment") {
      must(
        `booking equity for ${key}`,
        await db.from("vehicle_equity_splits").insert({
          vehicle_id: created.id,
          holder_type: "ceo",
          holder_id: null,
          amount_invested: row.purchase_price,
          percentage: 100,
        })
      );
    }
  }

  log(added ? `✓ ${added} showcase car(s) taken in` : "↷ the showcase cars are already on the floor");
  return ids;
}

/**
 * §2b — AN ODOMETER AND A PROVENANCE ON EVERY CAR.
 *
 * 0036 added both nullable and backfilled neither, which is right for a
 * migration and wrong for a demo: the inventory card renders "—" where
 * the second question every buyer asks should be. Filled ONLY where the
 * column is null, so a reading somebody corrected through the app
 * survives a re-seed. Deterministic in the VIN so two runs agree.
 */
async function ensureVehicleFacts(db, log, now) {
  // The table always exists; the two COLUMNS are what 0036 added, so the
  // probe names them or the message would say nothing useful.
  await requireTable(db, "vehicles", "0036", "id, odometer_km, acquisition_source");
  const vehicles = must(
    "reading vehicles",
    await db
      .from("vehicles")
      .select("id, vin, year, acquisition_type, odometer_km, acquisition_source")
  );

  const thisYear = now.getUTCFullYear();
  let touched = 0;

  for (const v of vehicles) {
    const patch = {};
    if (v.odometer_km === null || v.odometer_km === undefined) {
      const age = Math.max(0, thisYear - (v.year ?? thisYear));
      const spread = hashOf(v.vin ?? v.id) % 14000;
      // ~18,000 km a year, plus a car-specific spread, to the nearest 50.
      patch.odometer_km = Math.round((age * 18000 + 6000 + spread) / 50) * 50;
    }
    if (!v.acquisition_source) {
      patch.acquisition_source =
        v.acquisition_type === "consignment"
          ? "بالأمانة — مالك سابق"
          : v.acquisition_type === "trade_in"
            ? "تبديل من عميل"
            : ACQUISITION_SOURCES[hashOf(v.vin ?? v.id) % ACQUISITION_SOURCES.length];
    }
    if (!Object.keys(patch).length) continue;

    must(`filling odometer/source on ${v.vin ?? v.id}`, await db.from("vehicles").update(patch).eq("id", v.id));
    touched += 1;
  }

  log(touched ? `✓ odometer and provenance filled on ${touched} car(s)` : "↷ every car already has an odometer and a source");
}

/**
 * §2c — ALL FOUR AGEING BUCKETS.
 *
 * src/lib/stock-age.ts splits stock at 30 / 60 / 90 days, and a demo
 * seeded this morning is four green rows — which demonstrates precisely
 * nothing about a report whose whole purpose is the red one. Four cars
 * are pushed back to 15 / 45 / 75 / 120 days so every bucket, and every
 * colour, is on screen at once.
 *
 * Probe: the car is ALREADY at least (target − 5) days old. That makes a
 * re-run a no-op without a marker column, and it never drags a car
 * FORWARD in time — a demo tenant that has genuinely been standing for
 * two months keeps its real ageing.
 */
async function ensureAgedStock(db, log, { slug, now }) {
  const targets = [
    { vin: vinFor(slug, "civic"), days: 15, label: "Honda Civic" },
    { vin: showcaseVin(slug, SHOWCASE_VINS.elantra), days: 45, label: "Hyundai Elantra" },
    { vin: showcaseVin(slug, SHOWCASE_VINS.mg5), days: 75, label: "MG5" },
    { vin: showcaseVin(slug, SHOWCASE_VINS.sportage), days: 120, label: "Kia Sportage" },
  ];

  let aged = 0;
  for (const t of targets) {
    const v = must(
      `looking up ${t.label}`,
      await db.from("vehicles").select("id, created_at, status").eq("vin", t.vin).maybeSingle()
    );
    if (!v) continue;

    const ageDays = (now.getTime() - new Date(v.created_at).getTime()) / DAY;
    if (ageDays >= t.days - 5) continue;

    must(
      `ageing ${t.label}`,
      await db.from("vehicles").update({ created_at: daysAgo(now, t.days) }).eq("id", v.id)
    );
    aged += 1;
  }

  log(aged ? `✓ ${aged} car(s) backdated into the ageing buckets` : "↷ the ageing buckets are already populated");
}

/**
 * §3 — A PRICE CUT, AND THE HISTORY OF IT.
 *
 * vehicle_price_history rows are never inserted by hand: 0036 writes them
 * from a trigger on UPDATE, which is the only version that cannot drift
 * from what actually happened to the price. So the scene sets a price,
 * then sets a lower one, and reads the two rows back as its own proof.
 *
 * The car is the 120-day Sportage on purpose — a cut on dead stock is
 * the decision the ageing report exists to provoke, and the two screens
 * tell one story when they are about the same car.
 *
 * Probe: two or more history rows already on this vehicle.
 */
async function ensurePriceDrop(db, log, { vehicleId }) {
  await requireTable(db, "vehicle_price_history", "0036");
  if (!vehicleId) throw new Error("the Sportage is not on this showroom");

  const history = must(
    "reading the price history",
    await db.from("vehicle_price_history").select("id").eq("vehicle_id", vehicleId)
  );
  if ((history?.length ?? 0) >= 2) {
    log("↷ the Sportage already carries a price history");
    return;
  }

  // First: what it was listed at on intake.
  must(
    "listing the Sportage",
    await db.from("vehicles").update({ asking_price: 1050000, min_price: 1000000 }).eq("id", vehicleId)
  );
  // Then: the cut, four months in. Two writes, two trigger rows.
  must(
    "cutting the Sportage's price",
    await db.from("vehicles").update({ asking_price: 985000, min_price: 950000 }).eq("id", vehicleId)
  );

  const after = must(
    "re-reading the price history",
    await db.from("vehicle_price_history").select("id").eq("vehicle_id", vehicleId)
  );
  log(`✓ Sportage priced 1,050,000 → 985,000 (${after?.length ?? 0} price history row(s))`);
}

/**
 * §5 — A TRADE-IN, MID-DEAL.
 *
 * Left at 'submitted' rather than 'approved' deliberately: the pitch is
 * meant to WALK the approval — tick the three checks, approve, execute —
 * and watch the 2019 Lanos appear in stock on the other side, booked
 * 100% to the house at the allowance. A ticket already approved skips
 * the half of that flow that makes the point.
 *
 * A new ticket must be born 'submitted' with all three review flags
 * false anyway (guard_deal_ticket_status, 0009), so this is also the
 * only shape the database would accept from a script.
 *
 * Probe: a ticket already carrying this Lanos's VIN.
 */
async function ensureTradeInTicket(db, log, { slug, vehicleId, branchId, salespersonId }) {
  if (!vehicleId) throw new Error("the Elantra is not on this showroom");
  const lanosVin = showcaseVin(slug, LANOS_VIN_BASE);

  const existing = must(
    "looking for the trade-in ticket",
    await db.from("deal_tickets").select("id, status").eq("trade_in_vin", lanosVin).maybeSingle()
  );
  if (existing) {
    log(`↷ the trade-in ticket already exists (${existing.status})`);
    return existing.id;
  }

  const lead = await ensureBuyer(db, TRADE_IN_BUYER, { branchId, salespersonId });

  const ticket = must(
    "raising the trade-in ticket",
    await db
      .from("deal_tickets")
      .insert({
        lead_id: lead.id,
        vehicle_id: vehicleId,
        branch_id: branchId,
        salesperson_id: salespersonId,
        agreed_price: 805000,
        financing_type: "cash",
        discount_amount: 5000,
        // 0022's triple, so the e-invoice panel is not blocked on this
        // ticket either once it is executed.
        vat_rate: 14,
        price_includes_vat: true,
        vat_amount: Math.round((805000 - 805000 / 1.14) * 100) / 100,
        // ── تبديل (0032) ──
        trade_in_make: "Daewoo",
        trade_in_model: "Lanos",
        trade_in_year: 2019,
        trade_in_color: "أبيض",
        trade_in_vin: lanosVin,
        trade_in_odometer_km: 143500,
        trade_in_allowance: 210000,
        trade_in_notes:
          "لانوس 2019 بحالة جيدة، الفحص الفني تم بالمعرض. الرخصة سارية حتى ٢٠٢٧ والعميل مستلم قيمة الفرق نقدًا.",
      })
      .select("id")
      .single()
  );

  log("✓ trade-in ticket raised (Elantra out, 2019 Lanos in at 210,000 — awaiting approval)");
  return ticket.id;
}

/**
 * §6/§7 — THE IN-HOUSE RECEIVABLE BOOK.
 *
 * The one scene that has to happen in a strict order, because every part
 * of it is gated on the part before:
 *
 *   the buyer            a lead, linked to a customer (0031) — the
 *                        customer is who the e-invoice in §10 names, and
 *                        it is the row that carries the national ID.
 *   the ticket           financing_type 'installments' with NO partner.
 *                        Before 0033 that combination was refused
 *                        outright; it is now exactly what "the showroom
 *                        is the bank" means, and
 *                        enforce_in_house_installment_plan() accepts a
 *                        plan on no other shape of ticket.
 *   the sale             executed through execute_vehicle_sale() as the
 *                        CEO, signed in. The service role cannot: the
 *                        function reads auth.uid().
 *   the plan             300,000 over 24 months at 7.5% FLAT — the rate
 *                        Abaza advertises. The schedule is built by
 *                        buildSchedule() from src/lib/receivables.ts,
 *                        imported rather than restated, because a seed
 *                        that computes instalments its own way is a seed
 *                        that eventually disagrees with the app.
 *   two payments         applied through allocatePayment(), so
 *                        amount_paid, paid_at and the receipts rows say
 *                        the same thing the server action would have
 *                        written.
 *   the third line       left unpaid and two weeks past due, which is
 *                        the only reason the ageing panel has anything
 *                        in a red bucket.
 *   four cheques         two cleared (the two paid months), one bounced
 *                        (the missed one — recent, so the accountant hub
 *                        opens on red), one still deposited.
 *
 * Probe: the plan itself. Everything downstream is probed separately, so
 * a run interrupted halfway resumes rather than duplicating.
 */
async function ensureInstalmentBook(
  db,
  log,
  { receivables, vehicleId, branchId, salespersonId, accountantId, ceoId, signedInAs, now }
) {
  await requireTable(db, "installment_plans", "0033");
  if (!vehicleId) throw new Error("the Cerato is not on this showroom");

  const { buildSchedule, allocatePayment, addMonthsClamped, toIsoDate } = receivables;

  // ── The buyer ───────────────────────────────────────────
  const lead = await ensureBuyer(db, BUYER, { branchId, salespersonId });

  // ── The ticket, and the sale ────────────────────────────
  const AGREED = 875000;
  const DOWN = 575000;
  const PRINCIPAL = AGREED - DOWN; // 300,000 — what the showroom finances.

  let ticket = must(
    "looking for the in-house ticket",
    await db
      .from("deal_tickets")
      .select("id, status")
      .eq("vehicle_id", vehicleId)
      .order("created_at")
      .limit(1)
      .maybeSingle()
  );

  if (!ticket) {
    ticket = must(
      "raising the in-house ticket",
      await db
        .from("deal_tickets")
        .insert({
          lead_id: lead.id,
          vehicle_id: vehicleId,
          branch_id: branchId,
          salesperson_id: salespersonId,
          agreed_price: AGREED,
          // The two halves of "the showroom is the bank": instalments,
          // and no bank. 0033 lifted the rule that refused this.
          financing_type: "installments",
          financing_partner_id: null,
          down_payment: DOWN,
          discount_amount: 0,
          vat_rate: 14,
          price_includes_vat: true,
          vat_amount: Math.round((AGREED - AGREED / 1.14) * 100) / 100,
          settlement_method: "bank_transfer",
          settlement_bank: BANQUE_MISR,
          settlement_reference: "TRF-2026-004417",
        })
        .select("id, status")
        .single()
    );
  }

  if (ticket.status !== "executed") {
    await signedInAs("ceo", async (ceo) => {
      if (ticket.status === "submitted") {
        const { error: flagErr } = await ceo
          .from("deal_tickets")
          .update({ financial_check_passed: true, discount_validated: true, rate_revalidated: true })
          .eq("id", ticket.id);
        if (flagErr) throw new Error(`in-house review checklist: ${flagErr.message}`);

        const { error: apprErr } = await ceo
          .from("deal_tickets")
          .update({ status: "approved" })
          .eq("id", ticket.id);
        if (apprErr) throw new Error(`approving the in-house ticket: ${apprErr.message}`);
      }
      const { error: saleErr } = await ceo.rpc("execute_vehicle_sale", { p_deal_ticket_id: ticket.id });
      if (saleErr) throw new Error(`execute_vehicle_sale (in-house): ${saleErr.message}`);
    });
    log("✓ in-house instalment sale executed through execute_vehicle_sale()");
  }

  // The sale settled just now; the book it secures is two and a half
  // months old. execute_vehicle_sale() stamps executed_at/sold_at with
  // its own now(), and only those two columns are moved back — the
  // ledger rows it posted keep today's date on purpose, so the sale
  // still shows in the CEO's month-to-date profit.
  //
  // Guarded on the sale being FRESH (settled within the last week), so a
  // re-run three months from now does not drag an already-backdated sale
  // forward and leave it younger than the plan it secures.
  const SOLD_DAYS = 76;
  const settledAt = must(
    "reading the settlement date",
    await db.from("deal_tickets").select("executed_at").eq("id", ticket.id).single()
  );
  const settledDaysAgo = settledAt.executed_at
    ? (now.getTime() - new Date(settledAt.executed_at).getTime()) / DAY
    : 0;
  if (settledDaysAgo < 7) {
    must(
      "backdating the sale",
      await db.from("deal_tickets").update({ executed_at: daysAgo(now, SOLD_DAYS) }).eq("id", ticket.id)
    );
    must(
      "backdating the delivery",
      await db.from("vehicles").update({ sold_at: daysAgo(now, SOLD_DAYS) }).eq("id", vehicleId)
    );
  }

  // ── The plan ────────────────────────────────────────────
  //
  // Anchored so the THIRD instalment fell two weeks ago: first due date
  // = (today − 14 days) − 2 months. That is what puts a live figure in
  // the 1–30 day arrears bucket instead of a table of zeroes.
  let plan = must(
    "looking for the plan",
    await db
      .from("installment_plans")
      .select("id, status, principal, annual_flat_rate, months, start_date")
      .eq("deal_ticket_id", ticket.id)
      .maybeSingle()
  );

  // A plan that is already there OWNS its own dates. Recomputing the
  // start from today's clock and writing lines against it would give a
  // run that was interrupted after the plan but before the lines a
  // schedule two weeks out of step with the contract it belongs to.
  const startDate = plan
    ? toIsoDate(plan.start_date)
    : addMonthsClamped(toIsoDate(dateDaysAgo(now, 14)), -2);
  const schedule = buildSchedule({
    principal: plan ? Number(plan.principal) : PRINCIPAL,
    annualFlatRate: plan ? Number(plan.annual_flat_rate ?? 0) : 7.5,
    months: plan ? Number(plan.months) : 24,
    startDate,
  });

  if (!plan) {
    plan = must(
      "writing the plan",
      await db
        .from("installment_plans")
        .insert({
          deal_ticket_id: ticket.id,
          branch_id: branchId,
          principal: schedule.principal,
          annual_flat_rate: 7.5,
          months: 24,
          start_date: startDate,
          monthly_amount: schedule.monthlyAmount,
          total_payable: schedule.totalPayable,
          ownership_retained: true,
          status: "active",
          notes: "تقسيط داخلي — ٧.٥٪ ثابت على ٢٤ شهرًا، ورقة الملكية محتفظ بها لحين سداد آخر قسط.",
          created_by: accountantId ?? ceoId ?? null,
        })
        .select("id, status, principal, annual_flat_rate, months, start_date")
        .single()
    );
    log(`✓ plan: ${schedule.principal.toLocaleString("en")} over 24 months at 7.5% flat = ${schedule.totalPayable.toLocaleString("en")}`);
  }

  // ── The lines ───────────────────────────────────────────
  let lines = must(
    "reading the schedule",
    await db
      .from("installment_lines")
      .select("id, seq, due_date, amount_due, amount_paid")
      .eq("plan_id", plan.id)
      .order("seq")
  );

  if (!lines?.length) {
    must(
      "writing the schedule",
      await db.from("installment_lines").insert(
        schedule.lines.map((l) => ({
          plan_id: plan.id,
          seq: l.seq,
          due_date: l.due_date,
          amount_due: l.amount_due,
        }))
      )
    );
    lines = must(
      "re-reading the schedule",
      await db
        .from("installment_lines")
        .select("id, seq, due_date, amount_due, amount_paid")
        .eq("plan_id", plan.id)
        .order("seq")
    );
    log(`✓ ${lines.length} instalment lines written`);
  }

  // ── Two payments, allocated the way the app allocates ───
  const receiptRows = must(
    "reading receipts",
    await db.from("receipts").select("id").eq("plan_id", plan.id)
  );

  if ((receiptRows?.length ?? 0) < 2) {
    const payments = [
      { seq: 1, reference: "CHQ-441207", bank: BANQUE_MISR },
      { seq: 2, reference: "CHQ-441208", bank: NBE },
    ];

    for (const p of payments) {
      // Re-read each pass: allocatePayment() is oldest-first, so the
      // second payment must see the first one already applied or it
      // lands on line 1 twice.
      const current = must(
        "reading the schedule for allocation",
        await db
          .from("installment_lines")
          .select("id, seq, due_date, amount_due, amount_paid")
          .eq("plan_id", plan.id)
          .order("seq")
      );
      const line = current.find((l) => l.seq === p.seq);
      if (!line) continue;
      const outstanding = Number(line.amount_due) - Number(line.amount_paid);
      if (outstanding <= 0) continue;

      const result = allocatePayment(
        current.map((l) => ({
          id: l.id,
          seq: l.seq,
          due_date: l.due_date,
          amount_due: Number(l.amount_due),
          amount_paid: Number(l.amount_paid),
        })),
        outstanding
      );
      if (!result.ok) throw new Error(`allocating instalment ${p.seq}: ${result.error}`);

      // Cleared the day after it fell due — a cheque presented on time.
      const paidAt = new Date(`${line.due_date}T10:00:00.000Z`);
      paidAt.setUTCDate(paidAt.getUTCDate() + 1);

      for (const a of result.allocations) {
        must(
          `posting instalment ${a.seq}`,
          await db
            .from("installment_lines")
            .update({
              amount_paid: a.amountPaid,
              paid_at: a.fullyPaid ? paidAt.toISOString() : null,
            })
            .eq("id", a.id)
        );
      }

      must(
        `receipting instalment ${p.seq}`,
        await db.from("receipts").insert({
          branch_id: branchId,
          deal_ticket_id: ticket.id,
          plan_id: plan.id,
          amount: result.applied,
          method: "cheque",
          reference: p.reference,
          payer_name: BUYER.name,
          note: `تحصيل القسط رقم ${p.seq} — شيك ${p.bank}`,
          received_by: accountantId ?? ceoId ?? salespersonId,
          received_at: paidAt.toISOString(),
        })
      );
    }
    log("✓ two instalments collected; the third is two weeks overdue");
  }

  // ── The cheques in the safe ─────────────────────────────
  //
  // A cheque is BORN 'in_safe' or 'deposited' and nothing else —
  // guard_cheque_status() refuses the rest on INSERT, which is correct
  // and is the reason this is two statements per cheque rather than one.
  // The legal road to 'cleared' and to 'bounced' both start at
  // 'deposited', so all four are deposited and then moved.
  const chequeRows = must("reading cheques", await db.from("cheques").select("id").eq("plan_id", plan.id));

  if ((chequeRows?.length ?? 0) < 4) {
    const bySeq = new Map(lines.map((l) => [l.seq, l]));
    const wanted = [
      { seq: 1, number: "441207", bank: BANQUE_MISR, to: "cleared", note: "حصّل في ميعاده" },
      { seq: 2, number: "441208", bank: NBE, to: "cleared", note: "حصّل في ميعاده" },
      { seq: 3, number: "441209", bank: BANQUE_MISR, to: "bounced", note: "ارتد لعدم كفاية الرصيد — تم إخطار العميل" },
      { seq: 4, number: "441210", bank: NBE, to: null, note: "مودع بالبنك، لم يحصّل بعد" },
    ];

    for (const c of wanted) {
      const line = bySeq.get(c.seq);
      if (!line) continue;

      const inserted = must(
        `depositing cheque ${c.number}`,
        await db
          .from("cheques")
          .insert({
            branch_id: branchId,
            deal_ticket_id: ticket.id,
            plan_id: plan.id,
            cheque_number: c.number,
            bank_name: c.bank,
            drawer_name: BUYER.name,
            amount: Number(line.amount_due),
            due_date: line.due_date,
            status: "deposited",
            note: c.note,
            created_by: accountantId ?? ceoId ?? null,
            created_at: daysAgo(now, SOLD_DAYS),
          })
          .select("id")
          .single()
      );

      if (c.to) {
        must(
          `moving cheque ${c.number} to ${c.to}`,
          await db.from("cheques").update({ status: c.to }).eq("id", inserted.id)
        );
      }
    }
    log("✓ four post-dated cheques: two cleared, one bounced, one still deposited");
  }

  return { ticketId: ticket.id, planId: plan.id, leadId: lead.id, agreedPrice: AGREED };
}

/**
 * §8 — A CONSIGNMENT SALE, AND THE DEBT IT LEAVES.
 *
 * The payout row is NOT written here. execute_vehicle_sale() mints it
 * itself when the vehicle it is settling is a consignment: it skips
 * compute_sale_waterfall() entirely (there is no cap table on a car the
 * house does not own), takes the agreed commission as ONE ceo ledger
 * line, and books the rest as a debt to the consignor. Writing the
 * consignment_payouts row by hand would produce a demo of a number
 * rather than a demo of the engine — and the numbers would be the
 * seed's arithmetic, not the schema's.
 *
 * So the scene's whole job is to get the sale into the state the RPC
 * expects: a ticket on a consignment vehicle, approved, executed by
 * somebody who is a manager or above.
 *
 * Probe: a payout row already exists for this vehicle.
 */
async function ensureConsignmentSale(db, log, { vehicleId, branchId, salespersonId, signedInAs }) {
  await requireTable(db, "consignment_payouts", "0032");
  if (!vehicleId) throw new Error("the consigned Tiggo is not on this showroom");

  const payout = must(
    "reading consignment payouts",
    await db.from("consignment_payouts").select("id, amount_due").eq("vehicle_id", vehicleId).maybeSingle()
  );
  if (payout) {
    log(`↷ the consignment payout already stands at ${Number(payout.amount_due).toLocaleString("en")}`);
    return;
  }

  let ticket = must(
    "looking for the consignment ticket",
    await db.from("deal_tickets").select("id, status").eq("vehicle_id", vehicleId).maybeSingle()
  );

  if (!ticket) {
    const lead = await ensureBuyer(db, CONSIGNMENT_BUYER, { branchId, salespersonId });
    ticket = must(
      "raising the consignment ticket",
      await db
        .from("deal_tickets")
        .insert({
          lead_id: lead.id,
          vehicle_id: vehicleId,
          branch_id: branchId,
          salesperson_id: salespersonId,
          agreed_price: 465000,
          financing_type: "cash",
          discount_amount: 0,
          settlement_method: "instapay",
          settlement_reference: "IPN-2026-77120",
        })
        .select("id, status")
        .single()
    );
  }

  if (ticket.status !== "executed") {
    await signedInAs("ceo", async (ceo) => {
      if (ticket.status === "submitted") {
        const { error: flagErr } = await ceo
          .from("deal_tickets")
          .update({ financial_check_passed: true, discount_validated: true, rate_revalidated: true })
          .eq("id", ticket.id);
        if (flagErr) throw new Error(`consignment review checklist: ${flagErr.message}`);
        const { error: apprErr } = await ceo
          .from("deal_tickets")
          .update({ status: "approved" })
          .eq("id", ticket.id);
        if (apprErr) throw new Error(`approving the consignment ticket: ${apprErr.message}`);
      }
      const { error: saleErr } = await ceo.rpc("execute_vehicle_sale", { p_deal_ticket_id: ticket.id });
      if (saleErr) throw new Error(`execute_vehicle_sale (consignment): ${saleErr.message}`);
    });
  }

  const settled = must(
    "re-reading the consignment payout",
    await db
      .from("consignment_payouts")
      .select("consignor_name, amount_due, commission_amount")
      .eq("vehicle_id", vehicleId)
      .maybeSingle()
  );
  if (!settled) throw new Error("the sale executed but no payout row was minted — check migration 0032");

  log(
    `✓ consignment sold: ${Number(settled.commission_amount).toLocaleString("en")} commission to the house, ` +
      `${Number(settled.amount_due).toLocaleString("en")} owed to ${settled.consignor_name} (unpaid)`
  );
}

/**
 * §9 — A TRANSFER WAITING TO BE ACCEPTED.
 *
 * Inserted as 'requested' because that is the only state a transfer may
 * be born in (guard_stock_transfer_status, 0035), and requested BY the
 * branch manager — who, thanks to §1b's grant, has standing at both
 * ends of the move.
 *
 * The car is the 75-day MG5: it is in stock, it has no submitted or
 * approved ticket against it (enforce_transfer_eligible() refuses one
 * that does), and stale stock moving to a branch where it might sell is
 * the actual reason the feature exists.
 *
 * Probe: 0035's partial unique index — one open transfer per vehicle.
 */
async function ensureStockTransfer(db, log, { vehicleId, fromBranchId, toBranchId, managerId, now }) {
  await requireTable(db, "stock_transfers", "0035");
  if (!vehicleId) throw new Error("the MG5 is not on this showroom");

  const open = must(
    "reading stock transfers",
    await db
      .from("stock_transfers")
      .select("id, status")
      .eq("vehicle_id", vehicleId)
      .eq("status", "requested")
      .maybeSingle()
  );
  if (open) {
    log("↷ the MG5 already has an open transfer request");
    return;
  }

  must(
    "requesting the transfer",
    await db.from("stock_transfers").insert({
      vehicle_id: vehicleId,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId,
      requested_by: managerId ?? null,
      note: "الطلب من فرع مصر الجديدة — العربية واقفة ٧٥ يوم والطلب عليها هناك أعلى.",
      requested_at: daysAgo(now, 3),
    })
  );
  log(`✓ transfer requested: MG5 → ${HELIOPOLIS_NAME} (awaiting acceptance)`);
}

/**
 * §10 — AN E-INVOICE THE SANDBOX ACCEPTED.
 *
 * The document is not hand-written JSON. It is built by
 * buildEtaDocument() from src/lib/eta/document.ts and put through
 * MockEtaClient from src/lib/eta/client.ts — the same two modules the
 * server action uses — so the totals on the stored request_payload are
 * the ticket's own price and VAT by construction rather than by careful
 * typing, and the uuid and long ID are the ones the sandbox actually
 * derives for this document rather than plausible-looking strings.
 *
 * Both columns are then written: the eta_submissions row (0034), which
 * is what the panel's timeline renders, AND 0024's four columns on the
 * contract, which are what the printed contract's footer and the manual
 * half of the panel read. settle() in src/lib/eta/service.ts writes both
 * for exactly this reason and this scene mirrors it.
 *
 * Probe: uniq_eta_submission_live — one live submission per contract.
 */
async function ensureEtaSubmission(db, log, { eta, ticketId, branch, tenantName, accountantId, now }) {
  await requireTable(db, "eta_submissions", "0034");
  if (!ticketId) throw new Error("there is no executed in-house sale to invoice");

  const contract = must(
    "reading the contract",
    await db.from("contracts").select("id, serial").eq("deal_ticket_id", ticketId).maybeSingle()
  );
  if (!contract) throw new Error("the executed sale has no contract row");

  const already = must(
    "reading eta submissions",
    await db.from("eta_submissions").select("id, status").eq("contract_id", contract.id).maybeSingle()
  );
  if (already) {
    log(`↷ the sale already carries an ETA submission (${already.status})`);
    return;
  }

  const ticket = must(
    "reading the invoiced ticket",
    await db
      .from("deal_tickets")
      .select("id, vehicle_id, status, agreed_price, vat_rate, vat_amount, price_includes_vat, executed_at")
      .eq("id", ticketId)
      .maybeSingle()
  );
  if (!ticket) throw new Error("the invoiced ticket no longer exists");

  const vehicle = must(
    "reading the invoiced car",
    await db
      .from("vehicles")
      .select("vin, year, make, model, trim, color, item_code")
      .eq("id", ticket.vehicle_id)
      .maybeSingle()
  );
  if (!vehicle) throw new Error("the invoiced ticket has no vehicle");

  const rin = branch.tax_registration_no ?? "512847693";

  const built = eta.buildEtaDocument({
    ticket: {
      id: ticket.id,
      status: ticket.status,
      agreed_price: Number(ticket.agreed_price),
      vat_rate: Number(ticket.vat_rate),
      vat_amount: Number(ticket.vat_amount),
      price_includes_vat: ticket.price_includes_vat,
      executed_at: ticket.executed_at,
    },
    vehicle: {
      vin: vehicle.vin,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim,
      color: vehicle.color,
      // An EGS code is `EG-{seller RIN}-{internal}`. Supplied so the
      // demo invoice does not carry the UNREGISTERED placeholder — the
      // warning is honest on a real car whose class nobody registered,
      // and a distraction in a pitch.
      item_code:
        vehicle.item_code ??
        `EG-${rin}-${[vehicle.make, vehicle.model, vehicle.year].join("-").toUpperCase().replace(/\s+/g, "")}`,
    },
    contract: { serial: contract.serial },
    buyer: {
      name: BUYER.name,
      nationalId: BUYER.nationalId,
      address: null,
    },
    issuer: {
      // The taxpayer is the GROUP, not the premises — the tax
      // registration was issued to the showroom's legal name and that is
      // the name the invoice must carry. loadEtaContext() reads it from
      // platform.tenants for the same reason.
      name: tenantName ?? branch.name,
      taxRegistrationNo: rin,
      // "0" is what the portal assigns a single-premises taxpayer's head
      // office. A ten-branch group sets a real one per branch before
      // production — which is the conversation this row is meant to open.
      branchCode: "0",
      address: {
        country: "EG",
        governate: "القاهرة",
        regionCity: "مصر الجديدة",
        street: branch.address ?? HELIOPOLIS_ADDRESS,
        buildingNumber: "12",
        postalCode: "11341",
      },
    },
    issuedAt: new Date(ticket.executed_at ?? daysAgo(now, 76)),
  });

  if (!built.ok) {
    throw new Error(`the invoice could not be built: ${built.blockers.map((b) => b.code).join(", ")}`);
  }

  // Straight through the sandbox client, so the identifiers below are
  // the ones this document really derives rather than invented ones.
  // MockEtaClient reads only `.document` off a signed envelope; the
  // signing step is skipped deliberately (signing.ts refuses to fake an
  // e-seal, and rightly).
  const client = new eta.MockEtaClient();
  const response = await client.submitDocuments([
    { document: built.document, signingMode: "none", canonicalString: "" },
  ]);
  const accepted = response.acceptedDocuments[0];
  if (!accepted) {
    throw new Error(
      `the sandbox refused the document: ${response.rejectedDocuments[0]?.error?.message ?? "unknown"}`
    );
  }
  const verdict = (await client.getSubmission(response.submissionId)).documents.find(
    (d) => d.uuid === accepted.uuid
  );

  const submittedAt = new Date(ticket.executed_at ?? daysAgo(now, 76));

  must(
    "recording the ETA submission",
    await db.from("eta_submissions").insert({
      contract_id: contract.id,
      deal_ticket_id: ticket.id,
      status: "accepted",
      mode: "mock",
      request_payload: built.document,
      response_payload: verdict ?? { uuid: accepted.uuid, longId: accepted.longId, status: "Valid" },
      eta_submission_id: response.submissionId,
      eta_uuid: accepted.uuid,
      eta_long_id: accepted.longId,
      warnings: built.warnings.map((w) => w.code),
      attempt: 1,
      created_by: accountantId ?? null,
      created_at: submittedAt.toISOString(),
      updated_at: submittedAt.toISOString(),
    })
  );

  // 0024's columns, so the printed contract's footer agrees with the
  // panel. settle() writes both; a scene that wrote only one would leave
  // the contract saying "not submitted" about an invoice this system
  // filed itself.
  must(
    "stamping the contract",
    await db
      .from("contracts")
      .update({
        eta_uuid: accepted.uuid,
        eta_long_id: accepted.longId,
        eta_submission_status: "accepted",
        eta_submitted_at: submittedAt.toISOString(),
      })
      .eq("id", contract.id)
  );

  log(`✓ e-invoice accepted in the sandbox — ${accepted.longId}`);
}

// ============================================================
// THE ENTRY POINT
// ============================================================

/**
 * Lays every showcase scene onto a showroom that is already trading.
 *
 * @param db          service-role client already pinned to t_<slug>
 * @param slug        the showroom's slug — VINs are derived from it
 * @param branches    the branches upsertBranches() returned
 * @param ids         account key -> profile id, from seed-demo's ACCOUNTS
 * @param signedInAs  seed-demo's own helper: runs work as a real user
 * @param tenantName  the showroom's legal name — the e-invoice issuer
 * @param log         line printer
 * @returns {Promise<{failures: string[]}>}
 */
export async function seedShowcase({
  db,
  slug,
  branches,
  ids,
  signedInAs,
  tenantName = null,
  log = () => {},
}) {
  const now = new Date();
  const failures = [];

  // The TypeScript the app itself runs, loaded through the ts-loader
  // seed-demo.mjs registers. Imported rather than restated: a seed that
  // computes a flat-rate schedule its own way is a seed that eventually
  // disagrees with the server action, and nothing would report it.
  let receivables = null;
  let eta = null;
  try {
    receivables = await import("../src/lib/receivables.ts");
  } catch (e) {
    log(`! src/lib/receivables.ts could not be loaded (${e.message}) — the instalment book will be skipped`);
  }
  try {
    const document = await import("../src/lib/eta/document.ts");
    const client = await import("../src/lib/eta/client.ts");
    eta = { ...document, MockEtaClient: client.MockEtaClient };
  } catch (e) {
    log(`! src/lib/eta could not be loaded (${e.message}) — the e-invoice scene will be skipped`);
  }

  const home =
    branches.find((b) => b.name.includes("Downtown")) ?? branches[0];
  if (!home) throw new Error("this showroom has no branch to hang the showcase on");

  log("\n— showcase scenes —");

  // §1
  let heliopolis = null;
  await scene("second branch", log, failures, async () => {
    heliopolis = await ensureHeliopolis(db, log);
  });

  await scene("branch grant", log, failures, () =>
    ensureBranchGrant(db, log, {
      managerId: ids.manager,
      ceoId: ids.ceo,
      branchId: (heliopolis ?? home).id,
    })
  );

  let rin = null;
  await scene("tax registration", log, failures, async () => {
    const fresh = must(
      "re-reading the branch",
      await db.from("branches").select("*").eq("id", home.id).single()
    );
    rin = await ensureTaxRegistration(db, log, fresh);
  });

  // §2 / §4
  let cars = {};
  await scene("showcase cars", log, failures, async () => {
    cars = await ensureShowcaseVehicles(db, log, {
      slug,
      branchId: home.id,
      createdBy: ids.sales ?? ids.manager ?? null,
    });
  });

  await scene("odometer and provenance", log, failures, () => ensureVehicleFacts(db, log, now));
  await scene("stock ageing", log, failures, () => ensureAgedStock(db, log, { slug, now }));

  // §3
  await scene("price cut", log, failures, () => ensurePriceDrop(db, log, { vehicleId: cars.sportage }));

  // §5
  await scene("trade-in ticket", log, failures, () =>
    ensureTradeInTicket(db, log, {
      slug,
      vehicleId: cars.elantra,
      branchId: home.id,
      salespersonId: ids.sales ?? ids.manager,
    })
  );

  // §6 / §7
  let book = null;
  await scene("in-house instalment book", log, failures, async () => {
    if (!receivables) throw new Error("src/lib/receivables.ts is not loaded");
    book = await ensureInstalmentBook(db, log, {
      receivables,
      vehicleId: cars.cerato,
      branchId: home.id,
      salespersonId: ids.sales ?? ids.manager,
      accountantId: ids.accountant,
      ceoId: ids.ceo,
      signedInAs,
      now,
    });
  });

  // §8
  await scene("consignment payout", log, failures, () =>
    ensureConsignmentSale(db, log, {
      vehicleId: cars.tiggo,
      branchId: home.id,
      salespersonId: ids.sales ?? ids.manager,
      signedInAs,
    })
  );

  // §9
  await scene("stock transfer", log, failures, () =>
    ensureStockTransfer(db, log, {
      vehicleId: cars.mg5,
      fromBranchId: home.id,
      toBranchId: (heliopolis ?? home).id,
      managerId: ids.manager,
      now,
    })
  );

  // §10
  await scene("ETA sandbox invoice", log, failures, async () => {
    if (!eta) throw new Error("src/lib/eta is not loaded");
    const branch = must(
      "re-reading the branch",
      await db.from("branches").select("*").eq("id", home.id).single()
    );
    await ensureEtaSubmission(db, log, {
      eta,
      ticketId: book?.ticketId ?? null,
      branch: { ...branch, tax_registration_no: branch.tax_registration_no ?? rin },
      tenantName,
      accountantId: ids.accountant,
      now,
    });
  });

  if (failures.length) {
    log(`\n! ${failures.length} showcase scene(s) did not land:`);
    for (const f of failures) log(`   · ${f}`);
    log("  The rest of the demo is intact — fix these and re-run; every scene is idempotent.");
  } else {
    log("✓ every showcase scene is in place");
  }

  return { failures };
}
