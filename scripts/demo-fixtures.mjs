// The four demo cars, described once.
//
// Both scripts that touch them import from here rather than restating the
// facts: seed-demo.mjs creates the rows, demo-photos.mjs puts photographs on
// rows that already exist. Two copies of a VIN table is how you end up with
// eight cars on the demo floor instead of four.
//
// No side effects — importing this file must stay safe. seed-demo.mjs calls
// main() at module scope, which is exactly why the shared constants cannot
// live there.

/**
 * The flagship's four original VINs, verbatim.
 *
 * They are the idempotency key for every write below, so they must match the
 * rows already in the database exactly — deriving them from a shared suffix
 * silently changed three of the four and seeded duplicate cars instead of
 * matching the existing ones.
 */
export const BASE_VINS = {
  fusion: "1FADP3F20EL123456",
  civic: "2HGFC2F59NH123457",
  camry: "3VWFE21C04M123458",
  bmw: "4T1BF1FK5EU123459",
};

/**
 * VINs are globally unique in reality and the vehicles table lives in one
 * tenant's own schema, so a collision only risks the flagship's original
 * four — every other showroom still gets its own set for clarity.
 */
export function vinFor(slug, key) {
  const base = BASE_VINS[key];
  if (!base) throw new Error(`Unknown vehicle key "${key}"`);
  if (slug === "felix") return base;
  const tail = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  return base.slice(0, 11) + tail;
}

/**
 * The demo pipeline: six buyers and what each of them wants.
 *
 * Six rather than the original two because the CEO's demand panel is a
 * ranking, and a ranking of one row demonstrates nothing. The numbers are
 * picked so the panel shows something worth reading rather than four
 * green rows:
 *
 *   Toyota Hilux   two buyers, 30,000-33,500, and the showroom holds
 *                  none. The lost sale the report exists to surface, and
 *                  it ranks first.
 *   Honda Civic    two buyers against a car that cost 22,000, best offer
 *                  22,800. Worth taking.
 *   BMW 3 Series   one buyer at 31,000 against 34,000 of cost. The row
 *                  that should stop somebody discounting it.
 *   Toyota Camry   nobody asked; a salesperson suggested it. Kept out of
 *                  the demand column on purpose.
 *
 * Matched on phone_number rather than "are there any leads at all", so a
 * showroom seeded before this existed picks the new ones up on a re-run.
 */
export const DEMO_LEADS = [
  { key: "taylor", client_name: "Taylor Morgan",  phone_number: "5551234567", car_interest: "2023 Honda Civic",    status: "ticket_created" },
  { key: "riley",  client_name: "Riley Chen",     phone_number: "5559876543", car_interest: "Looking for a sedan", status: "pending" },
  { key: "priya",  client_name: "Priya Nair",     phone_number: "5552048811", car_interest: "2023 Honda Civic",    status: "pending" },
  { key: "omar",   client_name: "Omar Haddad",    phone_number: "5553390274", car_interest: "Toyota Hilux",        status: "pending" },
  { key: "dana",   client_name: "Dana Whitfield", phone_number: "5557712065", car_interest: "Toyota Hilux",        status: "pending" },
  { key: "marco",  client_name: "Marco Silva",    phone_number: "5556640198", car_interest: "BMW 3 Series",        status: "pending" },
];

/**
 * `vehicle` names one of BASE_VINS' keys rather than an id — the caller
 * resolves it, because seed-demo.mjs has the ids in hand from the inserts
 * it just made and demo-pipeline.mjs has to look them up by VIN.
 * Its absence is the point of the row: those buyers want a car the
 * showroom does not have.
 */
export const DEMO_INTERESTS = [
  { lead: "taylor", vehicle: "civic", budget_amount: 21500, origin: "requested", status: "shown",
    note: "Test drove Saturday. Wants the alloys thrown in." },
  { lead: "priya",  vehicle: "civic", budget_amount: 22800, origin: "requested", status: "open",
    note: "Trading in a 2016 Corolla." },
  { lead: "marco",  vehicle: "bmw",   budget_amount: 31000, origin: "requested", status: "open",
    note: "Firm on the number — has a quote from a dealer in Alexandria." },
  { lead: "riley",  vehicle: "camry", budget_amount: null,  origin: "suggested", status: "shown",
    note: "Asked for a sedan generally; showed her the Camry." },
  { lead: "omar",   vehicle: "bmw",   budget_amount: null,  origin: "suggested", status: "open",
    note: "Offered the BMW while he waits for a Hilux." },
  { lead: "omar",   wanted_make: "Toyota", wanted_model: "Hilux", wanted_year: 2024,
    budget_amount: 33500, origin: "requested", status: "open",
    note: "Double cab, diesel. Needs it before the end of the quarter." },
  { lead: "dana",   wanted_make: "Toyota", wanted_model: "Hilux", wanted_year: 2022,
    budget_amount: 30000, origin: "requested", status: "open",
    note: "Would take a 2022 if the mileage is under 60k." },
];

/**
 * Writes DEMO_LEADS and DEMO_INTERESTS into one showroom.
 *
 * Exported as a function rather than inlined in seed-demo.mjs because
 * demo-pipeline.mjs needs the identical rows and cannot import that file
 * (it runs main() at module scope). Defining it here keeps this module
 * import-safe: nothing happens until somebody calls it.
 *
 * Idempotent on both halves — leads by phone number, interests by the
 * pair that identifies the row — so a re-run neither duplicates a buyer
 * nor overwrites a budget somebody edited while demonstrating the
 * product.
 *
 * @param db            service-role client already pinned to t_<slug>
 * @param branchId      branch every seeded lead belongs to
 * @param salespersonId owner of the leads and author of the interests
 * @param vehicleIdFor  BASE_VINS key -> vehicles.id, or null if absent
 * @returns {Promise<{leads: Record<string,string>, leadsAdded: number,
 *                    interestsAdded: number, interestsSkipped: boolean}>}
 */
export async function seedPipeline({ db, branchId, salespersonId, vehicleIdFor, log = () => {} }) {
  const leads = {};
  let leadsAdded = 0;

  for (const l of DEMO_LEADS) {
    const { data: existing } = await db
      .from("leads").select("id").eq("phone_number", l.phone_number).maybeSingle();
    if (existing) { leads[l.key] = existing.id; continue; }

    const { data, error } = await db
      .from("leads")
      .insert({
        branch_id: branchId,
        salesperson_id: salespersonId,
        client_name: l.client_name,
        phone_number: l.phone_number,
        car_interest: l.car_interest,
        status: l.status,
        source: "manual",
      })
      .select("id").single();
    if (error) throw new Error(`seeding lead ${l.client_name}: ${error.message}`);
    leads[l.key] = data.id;
    leadsAdded++;
    log(`✓ lead ${l.client_name}`);
  }

  // The table arrives with migration 0016. A showroom one migration
  // behind must still get its leads rather than failing the whole seed.
  const { error: probeErr } = await db.from("lead_vehicle_interests").select("id").limit(1);
  if (probeErr) {
    log(`! lead_vehicle_interests unavailable (${probeErr.message}) — apply migration 0016, then re-run.`);
    return { leads, leadsAdded, interestsAdded: 0, interestsSkipped: true };
  }

  let interestsAdded = 0;
  for (const w of DEMO_INTERESTS) {
    const leadId = leads[w.lead];
    if (!leadId) continue;

    const vehicleId = w.vehicle ? vehicleIdFor(w.vehicle) : null;
    // A car the seed expected to find is missing from this showroom —
    // skip rather than silently rewriting the row as an off-floor want,
    // which would put a phantom entry at the top of the demand report.
    if (w.vehicle && !vehicleId) continue;

    let q = db.from("lead_vehicle_interests").select("id").eq("lead_id", leadId);
    q = vehicleId
      ? q.eq("vehicle_id", vehicleId)
      : q.is("vehicle_id", null).eq("wanted_model", w.wanted_model);
    const { data: already } = await q.maybeSingle();
    if (already) continue;

    const { error } = await db.from("lead_vehicle_interests").insert({
      lead_id: leadId,
      vehicle_id: vehicleId,
      wanted_make: w.wanted_make ?? null,
      wanted_model: w.wanted_model ?? null,
      wanted_year: w.wanted_year ?? null,
      budget_amount: w.budget_amount,
      origin: w.origin,
      status: w.status,
      note: w.note,
      created_by: salespersonId,
    });
    if (error) throw new Error(`seeding interest for ${w.lead}: ${error.message}`);
    interestsAdded++;
  }

  return { leads, leadsAdded, interestsAdded, interestsSkipped: false };
}

/**
 * Photography for the same four cars, as it sits in R2.
 *
 * The masters are committed under scripts/demo-vehicles/ — see that folder's
 * README.md for sources, licence, and how close each photographed car is to
 * the one described here — but the database points at R2, not at the app's
 * own /public. Three reasons, in order of how much they hurt:
 *
 *   1. A same-origin path is a promise that a specific deployment is live.
 *      The row would render as a broken tile on demo-felix.508.world for as
 *      long as it took someone to ship the assets, and `Cover` in
 *      inventory-browser.tsx degrades to a marque monogram rather than an
 *      error — so it looks like "no photos yet", not "deploy pending".
 *   2. R2 is where a real showroom's photos already are: staff upload them
 *      through /api/upload and the absolute public URL is what lands in the
 *      column. Seed rows that look like every other row are the point.
 *   3. Photos survive a rebuild. Nothing about the demo's content should be
 *      coupled to the app's build output.
 *
 * `photos` is the sale gallery; `inspection_photos` is the intake condition
 * report, and migration 0015 is emphatic that merging the two destroys a
 * distinction no later migration can recover. Two of the four cars carry no
 * inspection report at all — that is the realistic case, and it is the only
 * way the empty state on the detail page ever gets looked at.
 */
const R2_PREFIX = "vehicles/demo";

/** Local master -> R2 key. demo-photos.mjs uploads exactly this list. */
export const PHOTO_FILES = [
  "ford-fusion-front.jpg",
  "ford-fusion-rear.jpg",
  "ford-fusion-interior.jpg",
  "honda-civic-front.jpg",
  "honda-civic-front-left.jpg",
  "toyota-camry-front.jpg",
  "toyota-camry-rear.jpg",
  "bmw-3-series-front.jpg",
  "bmw-3-series-rear.jpg",
  "bmw-3-series-boot.jpg",
];

export const r2KeyFor = (file) => `${R2_PREFIX}/${file}`;

/**
 * Absolute R2 URLs for each car, built from R2_PUBLIC_URL.
 *
 * Read at call time rather than at import time so a script that only needs
 * the VINs does not fail because R2 is unconfigured.
 */
export function photosFor(publicUrl) {
  const origin = String(publicUrl ?? "").replace(/\/$/, "");
  if (!origin) {
    throw new Error(
      "R2_PUBLIC_URL is not set — the demo photographs live in R2 and their " +
        "URLs cannot be built without it. Set it in .env.local."
    );
  }
  const at = (file) => `${origin}/${r2KeyFor(file)}`;

  return {
    fusion: {
      photos: [at("ford-fusion-front.jpg"), at("ford-fusion-rear.jpg")],
      inspection_photos: [at("ford-fusion-interior.jpg")],
    },
    civic: {
      photos: [at("honda-civic-front.jpg"), at("honda-civic-front-left.jpg")],
      inspection_photos: [],
    },
    camry: {
      photos: [at("toyota-camry-front.jpg"), at("toyota-camry-rear.jpg")],
      inspection_photos: [],
    },
    bmw: {
      photos: [at("bmw-3-series-front.jpg"), at("bmw-3-series-rear.jpg")],
      inspection_photos: [at("bmw-3-series-boot.jpg")],
    },
  };
}
