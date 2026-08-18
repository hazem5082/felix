// Seeds one licensed FELIX showroom with a full demo dataset: staff and
// investor accounts, vehicles with equity splits, leads, and deal tickets
// across every status (including one executed sale, so the wallets and
// ledger aren't empty).
//
//   node --env-file=.env.local scripts/seed-demo.mjs
//   node --env-file=.env.local scripts/seed-demo.mjs --slug=clientb --name="Client B Motors"
//
// Seed a second showroom to see tenancy actually working: the two datasets
// are identical in shape and completely invisible to each other.
//
// REWRITTEN FOR SCHEMA-PER-TENANT (migrations 0008-0013). Before 0008,
// every showroom's rows lived in `public.*` behind a `tenant_id` column,
// and this script wrote there directly. Since 0011 moved live data into
// t_<slug> schemas and 0010 moved the registry into `platform`, that would
// silently create a showroom nothing in the app can ever reach — exactly
// what happened to the `henryautomotive` and `clientb` test tenants this
// script's own earlier runs left behind, stranded in `public.*` with no
// `platform.tenants` row and no way to sign in. This version:
//
//   * looks up / provisions the tenant through `platform.tenants` and
//     `platform.provision_tenant()`, the same RPC route.ts calls;
//   * calls `platform.sync_postgrest_schemas()` right after provisioning,
//     since provision_tenant() deliberately does not (0010's own comment:
//     "the caller runs it after COMMIT") — skip this and every insert
//     below 404s with PGRST106 until someone remembers to run it by hand;
//   * writes business data through a client pinned to `t_<slug>` instead
//     of `public`, and drops `tenant_id` from every payload — the tenant
//     schema tables don't have that column at all; the schema itself is
//     the boundary now (0011 dropped it on the way in for exactly this
//     reason);
//   * writes invitations through `platform.staff_invitations`, whose
//     primary key is now `(tenant_id, email)` rather than `email` alone.
//
// Two things this script must still respect, both easy to get wrong:
//
//  1. Roles come from staff_invitations, NOT user_metadata. Migration 0003
//     made metadata untrusted (anyone with the anon key could otherwise
//     sign up as CEO), so an invitation row has to exist *before* the auth
//     user is created — that is what handle_new_user() reads.
//  2. auth.users is global across FELIX, A-Star and Calendar (one GoTrue
//     instance — see calander/RUNBOOK.md and A-Star's HANDOFF.md). Emails
//     this script creates must not collide with a real account on another
//     product; emailFor() namespaces every address under *.filex.demo,
//     which resolves nowhere and cannot collide with anything real.
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Auth admin calls (createUser, listUsers) go through GoTrue's REST API,
// not PostgREST, so they are not schema-scoped — this client is fine for
// those regardless of which schema it was built with.
const supabase = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// The tenant registry — platform.tenants, platform.provision_tenant(),
// platform.staff_invitations. Never business data.
const platformDb = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: "platform" },
});

// Never a literal. This file is in the repository, and the accounts it
// creates are real sign-ins on a real showroom — a password committed
// here is a published credential for whoever the seed last ran against.
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD || PASSWORD.length < 12) {
  console.error(
    "SEED_PASSWORD is not set (or is shorter than 12 characters).\n" +
      "Set it in .env.local before seeding, e.g.\n" +
      "  SEED_PASSWORD=<a strong passphrase>\n"
  );
  process.exit(1);
}

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SLUG = arg("slug", "felix").toLowerCase();
const NAME = arg("name", SLUG === "felix" ? "FELIX Flagship Showroom" : `${SLUG} Motors`);
const SCHEMA = `t_${SLUG}`;

if (!/^[a-z0-9]+$/.test(SLUG)) {
  console.error(`✗ --slug must be lowercase letters and digits only (got "${SLUG}")`);
  process.exit(1);
}

// auth.users.email is globally unique across every 508.world product, so
// demo accounts can't reuse the same addresses across showrooms — or
// collide with a real A-Star/Calendar account. .filex.demo resolves
// nowhere and is namespaced under this script's own product, so it can't
// collide with anything real on the shared GoTrue instance.
const emailFor = (role) => (SLUG === "felix" ? `${role}@filex.demo` : `${role}@${SLUG}.filex.demo`);

let TENANT_ID;
let tenantDb; // built once the schema is known to exist

async function ensureTenant() {
  const { data: existing } = await platformDb
    .from("tenants")
    .select("id, name")
    .eq("slug", SLUG)
    .maybeSingle();

  if (existing) {
    console.log(`↷ tenant "${SLUG}" already exists`);
    return existing.id;
  }

  // Same entry point the real licensing flow uses (platform.provision_tenant,
  // called by /api/provision), so seeding exercises the production
  // provisioning path rather than a parallel one.
  const { data, error } = await platformDb.rpc("provision_tenant", {
    p_slug: SLUG,
    p_name: NAME,
    p_ceo_email: emailFor("ceo"),
    p_ceo_full_name: "Alex Carter",
    p_first_branch_name: "Downtown Showroom",
    p_licensed_via: "seed-demo",
  });
  if (error) throw error;
  console.log(`✓ provisioned tenant "${SLUG}" (schema ${data.schema_name})`);

  // provision_tenant() deliberately does not call this itself — see the
  // header. Without it, every query below against t_<slug> 404s.
  const { error: syncError } = await platformDb.rpc("sync_postgrest_schemas");
  if (syncError) throw new Error(`sync_postgrest_schemas after provisioning: ${syncError.message}`);
  console.log("✓ exposed schema to PostgREST");

  return data.tenant.id;
}

async function upsertBranches() {
  const { data: existing } = await tenantDb.from("branches").select("*");
  if (existing?.length >= 2) return existing;

  const want = [
    { name: "Downtown Showroom", address: "123 Main St" },
    { name: "Airport Road Branch", address: "45 Airport Rd" },
  ].filter((b) => !existing?.some((e) => e.name === b.name));

  if (want.length) {
    const { error } = await tenantDb.from("branches").insert(want);
    if (error) throw error;
  }

  const { data } = await tenantDb.from("branches").select("*");
  return data;
}

async function upsertOverhead(branches) {
  for (const b of branches) {
    await tenantDb
      .from("overhead_config")
      .upsert({ branch_id: b.id, monthly_opex_amount: 3000 }, { onConflict: "branch_id" });
  }
}

async function upsertCommissionTiers() {
  const { data } = await tenantDb.from("commission_tiers").select("tier_index");
  if (data?.length) return;
  const rows = Array.from({ length: 10 }, (_, i) => ({
    tier_index: i + 1,
    cumulative_amount: (i + 1) * 6000,
  }));
  await tenantDb.from("commission_tiers").insert(rows);
}

async function upsertFinancingPartner() {
  const { data } = await tenantDb.from("financing_partners").select("id").limit(1);
  if (data?.length) return data[0].id;
  const { data: created, error } = await tenantDb
    .from("financing_partners")
    .insert({
      bank_name: "First National Bank",
      product_name: "Standard Auto Loan",
      rate: 7.5,
      term_months: 48,
      min_down_payment: 2000,
      contract_file_url: "https://example.com/sample-bank-contract.pdf",
      status: "active",
    })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

// Email local part -> database role. The local parts are the original
// demo addresses, kept verbatim so existing bookmarks and the credentials
// written up in the vault keep working.
const ACCOUNTS = [
  { key: "ceo", role: "ceo", name: "Alex Carter", branch: null },
  { key: "manager", role: "branch_manager", name: "Dana Reyes", branch: "downtown" },
  { key: "accountant", role: "accountant", name: "Sam Nguyen", branch: "downtown" },
  { key: "sales", role: "sales_exec", name: "Jordan Blake", branch: "downtown" },
  { key: "investor1", role: "investor", name: "Morgan Lee", branch: null },
  { key: "investor2", role: "investor", name: "Priya Shah", branch: null },
];

/**
 * One page of auth users, with the HTTP status preserved.
 *
 * The original script called `listUsers()` and destructured only `data`,
 * discarding `error`. On this project that call returns HTTP 500, so
 * `data` was undefined, every email lookup missed, `createUser` then failed
 * with "already registered", the id came back null, and the null surfaced
 * hundreds of lines later as a check-constraint violation on
 * `vehicle_equity_splits`. Errors are returned rather than swallowed here
 * so the failure is visible where it happens.
 */
async function listUsersPage(page, perPage) {
  // Raw fetch rather than supabase-js: it collapses a failure into an empty
  // AuthRetryableFetchError, which hides exactly the detail needed below.
  const res = await fetch(
    `${URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) return { ok: false, status: res.status, body: (await res.text()).slice(0, 200) };
  return { ok: true, users: (await res.json()).users ?? [] };
}

async function loadExistingUsers() {
  const byEmail = new Map();
  const add = (users) => {
    for (const u of users) if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
  };

  // Fast path: whole pages at once.
  let page = 1;
  for (; page <= 200; page++) {
    const r = await listUsersPage(page, 50);
    if (!r.ok) break;
    add(r.users);
    if (r.users.length < 50) return byEmail;
  }

  // Slow path. At least one row in auth.users cannot be serialised by
  // GoTrue ("Database error finding users"), which fails the entire page it
  // lands on — so a batch read returns nothing useful. Almost always a row
  // inserted into auth.users by raw SQL with NULLs in text columns GoTrue
  // expects to be ''. Walking one row at a time isolates the bad row to its
  // own page, so every other account is still readable.
  console.warn(
    "! auth.users has a row GoTrue cannot read — falling back to one-at-a-time.\n" +
    "  Repair it with the UPDATE in the vault note, then this gets fast again."
  );
  byEmail.clear();
  let unreadable = 0;
  for (let n = 1; n <= 500; n++) {
    const r = await listUsersPage(n, 1);
    if (!r.ok) { unreadable++; continue; }
    if (r.users.length === 0) break;
    add(r.users);
  }
  if (unreadable) console.warn(`! ${unreadable} auth user(s) unreadable and skipped`);
  return byEmail;
}

let EXISTING_USERS;

/**
 * Creates a staff/investor account for this showroom.
 *
 * The invitation row is written first and deliberately: it is the only
 * channel that can assign a role, a branch, and a tenant to a new user.
 */
async function createUser(key, dbRole, fullName, branchId) {
  const email = emailFor(key);

  const { error: invError } = await platformDb.from("staff_invitations").upsert(
    {
      tenant_id: TENANT_ID,
      email,
      full_name: fullName,
      role: dbRole,
      branch_id: branchId ?? null,
      accepted_at: null,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "tenant_id,email" }
  );
  if (invError) {
    console.error(`✗ invitation for ${email} failed:`, invError.message);
    return null;
  }

  const already = EXISTING_USERS.get(email);
  if (already) {
    // The invitation was upserted with accepted_at = null, but this user
    // already has a profile, so handle_new_user() will never fire again to
    // consume it. Reconcile the profile directly instead.
    //
    // Only the columns that actually differ are sent.
    // guard_profile_privilege_columns() rejects a role or branch change
    // unless is_ceo(), and the service-role key has no auth.uid() at all —
    // so is_ceo() is false here. Sending an unchanged value would trip the
    // guard for no reason; sending a genuinely changed one is refused, and
    // that refusal is correct rather than a bug to work around.
    const { data: current } = await tenantDb
      .from("profiles")
      .select("full_name, role, branch_id")
      .eq("id", already)
      .maybeSingle();

    const desired = {
      full_name: fullName,
      role: dbRole,
      branch_id: branchId ?? null,
    };
    const diff = Object.fromEntries(
      Object.entries(desired).filter(([k, v]) => (current?.[k] ?? null) !== v)
    );

    if (Object.keys(diff).length === 0) {
      console.log(`↷ ${email} already correct (${dbRole})`);
    } else {
      const { error: fixErr } = await tenantDb.from("profiles").update(diff).eq("id", already);
      if (fixErr) {
        console.error(`✗ ${email}: could not apply ${Object.keys(diff).join(", ")} — ${fixErr.message}`);
        if (/PRIVILEGE_LOCKED|TENANT_LOCKED/.test(fixErr.message)) {
          console.error(
            `   The database guards role/branch/tenant changes. Run this as the CEO, or in the SQL editor:\n` +
            `   update ${SCHEMA}.profiles set ${Object.entries(diff)
              .map(([k, v]) => `${k} = ${v === null ? "null" : `'${v}'`}`)
              .join(", ")} where id = '${already}';`
          );
        }
      } else {
        console.log(`↷ ${email} exists — updated ${Object.keys(diff).join(", ")}`);
      }
    }

    if (dbRole === "investor") {
      await tenantDb.from("investors").upsert({ id: already });
    }
    return already;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    console.error(`✗ Failed to create ${email}:`, error.message);
    return null;
  }
  EXISTING_USERS.set(email, data.user.id);
  console.log(`✓ Created ${dbRole}: ${email}`);
  return data.user.id;
}

async function insertVehicle(branchId, createdBy, vin, year, make, model, trim, purchasePrice) {
  const { data: existing } = await tenantDb
    .from("vehicles")
    .select("id")
    .eq("vin", vin)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await tenantDb
    .from("vehicles")
    .insert({
      branch_id: branchId,
      vin,
      year,
      make,
      model,
      trim,
      purchase_price: purchasePrice,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function insertSplits(vehicleId, splits) {
  const { data: existing } = await tenantDb
    .from("vehicle_equity_splits")
    .select("id")
    .eq("vehicle_id", vehicleId);
  if (existing?.length) return;

  // Fail here, with the reason, rather than letting a null holder_id reach
  // the `holder_id_matches_type` check constraint — which reports the
  // symptom (a bad row) a long way from the cause (an account whose id
  // could not be resolved).
  for (const s of splits) {
    if (s.holder_type === "investor" && !s.holder_id) {
      throw new Error(
        `Investor split for vehicle ${vehicleId} has no holder_id — an investor account could not be resolved. ` +
        `Check the createUser output above.`
      );
    }
  }

  const { error } = await tenantDb
    .from("vehicle_equity_splits")
    .insert(splits.map((s) => ({ vehicle_id: vehicleId, ...s })));
  if (error) throw error;
}

/** Creates a deal ticket in the only state the database will accept a new one in. */
async function submitTicket(fields) {
  const { data, error } = await tenantDb
    .from("deal_tickets")
    .insert(fields)
    .select("id")
    .single();
  if (error) throw new Error(`submitting deal ticket: ${error.message}`);
  return data.id;
}

/**
 * Runs `work` as this showroom's CEO, signed in normally.
 *
 * Reviewing a deal ticket is deliberately impossible for the service-role
 * key: guard_deal_ticket_status() requires is_manager_or_above(), which
 * reads the caller's profile via auth.uid(), and the service-role key has
 * no authenticated user at all. execute_vehicle_sale() refuses for the same
 * reason.
 *
 * That is the schema working as intended — approving a sale is a
 * privileged act that must be attributable to a person. So the seed signs
 * in as the CEO and goes through the real path rather than reaching around
 * it, which also means the demo data is produced by exactly the code the
 * application runs. Pinned to t_<slug> directly (rather than decoding the
 * JWT's felix_tenant claim the way src/lib/supabase/server.ts does) because
 * this script already knows the schema — it is the one thing it exists to
 * provision.
 */
async function signedInAs(accountKey, work) {
  const client = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: SCHEMA },
  });
  const { error } = await client.auth.signInWithPassword({
    email: emailFor(accountKey),
    password: PASSWORD,
  });
  if (error) throw new Error(`could not sign in as ${emailFor(accountKey)}: ${error.message}`);
  try {
    return await work(client);
  } finally {
    await client.auth.signOut();
  }
}

const reviewAs = (work) => signedInAs("ceo", work);

/**
 * Two meetings, created the same way the app creates them.
 *
 * create_meeting() is SECURITY DEFINER and reads the caller's role from
 * auth.uid(), so — like reviewing a deal ticket — the service-role key
 * cannot do this at all. Seeding through the RPC while signed in means
 * the demo data is proof the permission rule works rather than data that
 * merely looks like it: the manager's huddle below would be rejected if
 * it named anyone but their own branch's sales staff.
 */
async function seedMeetings(ids) {
  const { count } = await tenantDb
    .from("meetings")
    .select("id", { count: "exact", head: true });
  if (count) {
    console.log(`· ${count} meeting(s) already present — leaving the calendar alone`);
    return;
  }

  // Next Monday, so the demo calendar always has something ahead of it.
  const monday = new Date();
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const at = (day, hour, minutes = 0) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + day);
    d.setHours(hour, minutes, 0, 0);
    return d.toISOString();
  };

  await signedInAs("ceo", async (ceo) => {
    const { error } = await ceo.rpc("create_meeting", {
      p_title: "Monthly performance review",
      p_agenda: "Inventory ageing, margin by branch, and the approval backlog.",
      p_location: "Head office boardroom",
      p_starts_at: at(0, 9),
      p_ends_at: at(0, 10, 30),
      p_branch_id: null, // showroom-wide: only a CEO can do this
      p_invitees: [ids.manager, ids.accountant, ids.sales].filter(Boolean),
    });
    if (error) throw new Error(`create_meeting (ceo): ${error.message}`);
  });

  await signedInAs("manager", async (manager) => {
    const { error } = await manager.rpc("create_meeting", {
      p_title: "Sales huddle",
      p_agenda: "Pipeline walk-through and this week's test drives.",
      p_location: "Downtown showroom floor",
      p_starts_at: at(1, 8, 30),
      p_ends_at: at(1, 9),
      // Sent deliberately wrong: a branch manager's meeting is pinned to
      // their own branch server-side whatever the client asks for.
      p_branch_id: null,
      p_invitees: [ids.sales].filter(Boolean),
    });
    if (error) throw new Error(`create_meeting (manager): ${error.message}`);
  });

  console.log("✓ seeded 2 meetings through create_meeting()");
}

async function main() {
  TENANT_ID = await ensureTenant();
  tenantDb = createClient(URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: SCHEMA },
  });

  EXISTING_USERS = await loadExistingUsers();
  console.log(`· ${EXISTING_USERS.size} existing auth user(s) in the project`);

  const branches = await upsertBranches();
  const downtown = branches.find((b) => b.name.includes("Downtown")) ?? branches[0];
  const airport = branches.find((b) => b.name.includes("Airport")) ?? branches[1] ?? branches[0];

  await upsertOverhead(branches);
  await upsertCommissionTiers();
  const partnerId = await upsertFinancingPartner();

  const ids = {};
  for (const a of ACCOUNTS) {
    ids[a.key] = await createUser(
      a.key, a.role, a.name, a.branch === "downtown" ? downtown.id : null);
  }
  const salesId = ids.sales;
  const investor1Id = ids.investor1;
  const investor2Id = ids.investor2;

  // handle_new_user() already created these rows; this only adds the note.
  if (investor1Id)
    await tenantDb.from("investors").upsert({ id: investor1Id, notes: "Seed investor #1" });
  if (investor2Id)
    await tenantDb.from("investors").upsert({ id: investor2Id, notes: "Seed investor #2" });

  // Vehicle 1: sold already (drives the executed deal below) — 60/40 CEO/investor1
  const v1 = await insertVehicle(downtown.id, salesId, vin("fusion"), 2022, "Ford", "Fusion", "SE", 18000);
  await insertSplits(v1, [
    { holder_type: "ceo", holder_id: null, amount_invested: 10800, percentage: 60 },
    { holder_type: "investor", holder_id: investor1Id, amount_invested: 7200, percentage: 40 },
  ]);

  // Vehicle 2: in stock, 50/50 CEO/investor2
  const v2 = await insertVehicle(downtown.id, salesId, vin("civic"), 2023, "Honda", "Civic", "Sport", 22000);
  await insertSplits(v2, [
    { holder_type: "ceo", holder_id: null, amount_invested: 11000, percentage: 50 },
    { holder_type: "investor", holder_id: investor2Id, amount_invested: 11000, percentage: 50 },
  ]);

  // Vehicle 3: in stock at the airport branch, CEO-only funded
  const v3 = await insertVehicle(airport.id, salesId, vin("camry"), 2024, "Toyota", "Camry", "XSE", 27500);
  await insertSplits(v3, [{ holder_type: "ceo", holder_id: null, amount_invested: 27500, percentage: 100 }]);

  // Vehicle 4: in stock, three-way split (CEO + 2 investors)
  const v4 = await insertVehicle(downtown.id, salesId, vin("bmw"), 2023, "BMW", "3 Series", "330i", 34000);
  await insertSplits(v4, [
    { holder_type: "ceo", holder_id: null, amount_invested: 17000, percentage: 50 },
    { holder_type: "investor", holder_id: investor1Id, amount_invested: 10200, percentage: 30 },
    { holder_type: "investor", holder_id: investor2Id, amount_invested: 6800, percentage: 20 },
  ]);

  // A couple of leads
  const { data: existingLeads } = await tenantDb.from("leads").select("id").limit(1);
  let leadId;
  if (!existingLeads?.length) {
    const { data: lead1 } = await tenantDb
      .from("leads")
      .insert({
        branch_id: downtown.id, salesperson_id: salesId,
        client_name: "Taylor Morgan", phone_number: "5551234567",
        car_interest: "2023 Honda Civic", status: "ticket_created", source: "manual",
      })
      .select("id").single();
    leadId = lead1?.id;
    await tenantDb.from("leads").insert({
      branch_id: downtown.id, salesperson_id: salesId,
      client_name: "Riley Chen", phone_number: "5559876543",
      car_interest: "Looking for a sedan", status: "pending", source: "manual",
    });
  }

  // Deal ticket 1: executed (against vehicle 1, cash)
  const { data: existingTickets } = await tenantDb.from("deal_tickets").select("id, status");
  if (!existingTickets?.length) {
    // Tickets are created as plain submitted tickets, then reviewed by the
    // CEO through the ordinary path — see reviewAs() for why the service
    // role cannot do this part itself.
    const t1 = await submitTicket({
      vehicle_id: v1, branch_id: downtown.id, salesperson_id: salesId,
      agreed_price: 21500, financing_type: "cash", discount_amount: 200,
    });

    // Deal ticket 2: left pending, so the approval queue opens with work in it.
    await submitTicket({
      lead_id: leadId, vehicle_id: v2, branch_id: downtown.id, salesperson_id: salesId,
      agreed_price: 23000, financing_type: "installments",
      financing_partner_id: partnerId, down_payment: 3000, discount_amount: 0,
    });

    const t3 = await submitTicket({
      vehicle_id: v4, branch_id: downtown.id, salesperson_id: salesId,
      agreed_price: 30000, financing_type: "cash", discount_amount: 0,
    });

    await reviewAs(async (ceo) => {
      // Ticket 1: tick the checklist, approve, then settle the sale with the
      // real waterfall RPC — which is also a live test of that engine.
      const { error: flagErr } = await ceo.from("deal_tickets").update({
        financial_check_passed: true, discount_validated: true, rate_revalidated: true,
      }).eq("id", t1);
      if (flagErr) throw new Error(`review checklist: ${flagErr.message}`);

      const { error: apprErr } = await ceo
        .from("deal_tickets").update({ status: "approved" }).eq("id", t1);
      if (apprErr) throw new Error(`approving ticket: ${apprErr.message}`);

      const { error: saleErr } = await ceo.rpc("execute_vehicle_sale", { p_deal_ticket_id: t1 });
      if (saleErr) throw new Error(`execute_vehicle_sale: ${saleErr.message}`);
      console.log("✓ executed a sale through execute_vehicle_sale()");

      const { error: rejErr } = await ceo.from("deal_tickets").update({
        status: "rejected",
        rejection_reason: "Price too far below market — renegotiate.",
      }).eq("id", t3);
      if (rejErr) throw new Error(`rejecting ticket: ${rejErr.message}`);
    });
  }

  await seedMeetings(ids);

  console.log(`\n— ${NAME} (${SLUG}) — all accounts use password: ${PASSWORD} —`);
  for (const a of ACCOUNTS) {
    console.log(`  ${a.role.padEnd(15)} ${emailFor(a.key)}`);
  }
  console.log(
    SLUG === "felix"
      ? "\nSign in at: https://demo-felix.508.world/en/login"
      : `\nSign in at: https://${SLUG}-felix.508.world/en/login`
  );
  console.log("Referral link: /en/refer/" + salesId);
}

// The flagship's four original VINs, verbatim. They are the idempotency key
// for insertVehicle(), so they must match the rows already in the database
// exactly — deriving them from a shared suffix silently changed three of the
// four and seeded duplicate cars instead of matching the existing ones.
const BASE_VINS = {
  fusion: "1FADP3F20EL123456",
  civic: "2HGFC2F59NH123457",
  camry: "3VWFE21C04M123458",
  bmw: "4T1BF1FK5EU123459",
};

// VINs are globally unique in reality and the vehicles table lives in one
// tenant's own schema, so a collision only risks the flagship's original
// four — every other showroom still gets its own set for clarity.
function vin(key) {
  const base = BASE_VINS[key];
  if (!base) throw new Error(`Unknown vehicle key "${key}"`);
  if (SLUG === "felix") return base;
  const tail = SLUG.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  return base.slice(0, 11) + tail;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
