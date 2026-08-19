// Puts a sales pipeline on a showroom that is already trading.
//
//   node --env-file=.env.local scripts/demo-pipeline.mjs
//   node --env-file=.env.local scripts/demo-pipeline.mjs --slug=clientb
//
// Six leads and what each of them wants — including two buyers after a
// Toyota Hilux the showroom does not stock, which is the row the CEO's
// demand panel exists to surface.
//
// SPLIT OUT FROM seed-demo.mjs FOR THE REASON demo-photos.mjs WAS. That
// script provisions a tenant, creates six auth accounts and executes a
// sale through the real RPC; it needs SEED_PASSWORD and does a great deal
// more than anyone wants when the only missing thing is a pipeline. This
// needs the service key, it touches two tables, and it is safe to run
// against a showroom in use.
//
// REQUIRES MIGRATION 0016. Without it lead_vehicle_interests does not
// exist, the leads still land, and the script says so rather than dying
// halfway.
//
// Idempotent: leads are matched by phone number and interests by the pair
// that identifies them, so a re-run adds only what is missing and never
// overwrites a budget somebody edited while demonstrating the product.
import { createClient } from "@supabase/supabase-js";
import { BASE_VINS, vinFor, seedPipeline } from "./demo-fixtures.mjs";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SLUG = arg("slug", "felix").toLowerCase();
const SCHEMA = `t_${SLUG}`;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} is not set. Run with --env-file=.env.local.`);
    process.exit(1);
  }
  return v;
}

const db = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false }, db: { schema: SCHEMA } }
);

console.log(`— demo pipeline -> showroom ${SLUG} —\n`);

// The four demo cars, by VIN. seed-demo.mjs has these ids in hand from
// the inserts it just made; here they have to be looked up.
const vehicleIds = {};
for (const key of Object.keys(BASE_VINS)) {
  const { data, error } = await db
    .from("vehicles").select("id").eq("vin", vinFor(SLUG, key)).maybeSingle();
  if (error) throw new Error(`looking up ${key}: ${error.message}`);
  if (!data) {
    console.log(`· ${key} is not on this showroom — interests naming it will be skipped`);
    continue;
  }
  vehicleIds[key] = data.id;
}

// The sales exec, in preference to anyone else: leads_select gives a rep
// only their OWN pipeline, so leads parked on a manager are invisible
// when the demo is toured as the salesperson — which is the persona the
// CRM screen is for. Tried in order rather than with a single ORDER BY,
// because 'branch_manager' sorts ahead of 'sales_exec' alphabetically and
// that is how the first run put four leads on the manager.
let sales = null;
for (const role of ["sales_exec", "branch_manager", "ceo"]) {
  const { data } = await db
    .from("profiles").select("id, full_name, role").eq("role", role).limit(1).maybeSingle();
  if (data) { sales = data; break; }
}

if (!sales) {
  console.error(`✗ ${SCHEMA} has no staff profile to own the leads. Run the full seed first.`);
  process.exit(1);
}

const { data: branch } = await db
  .from("branches").select("id, name").order("created_at").limit(1).maybeSingle();

if (!branch) {
  console.error(`✗ ${SCHEMA} has no branch. Run the full seed first.`);
  process.exit(1);
}

console.log(`· leads will belong to ${sales.full_name} (${sales.role}) at ${branch.name}\n`);

const result = await seedPipeline({
  db,
  branchId: branch.id,
  salespersonId: sales.id,
  vehicleIdFor: (key) => vehicleIds[key] ?? null,
  log: (line) => console.log(line),
});

console.log(
  `\n${result.leadsAdded} lead(s) and ${result.interestsAdded} vehicle interest(s) added on ${SCHEMA}.`
);

if (result.interestsSkipped) {
  console.log("Apply supabase/migrations/0016_lead_vehicle_interests.sql, then re-run.");
  process.exit(1);
}

if (!result.leadsAdded && !result.interestsAdded) {
  console.log("Nothing to do — the pipeline is already there.");
}
