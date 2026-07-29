// Full demo bootstrap: branches, one user per role, financing partner,
// vehicles with equity splits, leads, and deal tickets across every
// status (including one executed sale so wallets/ledger aren't empty).
//
// Run with: node --env-file=.env.local scripts/seed-demo.mjs
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const PASSWORD = "FilexDemo123!";

async function upsertBranches() {
  const { data: existing } = await supabase.from("branches").select("*");
  if (existing?.length) return existing;

  const { data, error } = await supabase
    .from("branches")
    .insert([
      { name: "Downtown Showroom", address: "123 Main St" },
      { name: "Airport Road Branch", address: "45 Airport Rd" },
    ])
    .select("*");
  if (error) throw error;
  return data;
}

async function upsertOverhead(branches) {
  for (const b of branches) {
    await supabase.from("overhead_config").upsert({ branch_id: b.id, monthly_opex_amount: 3000 });
  }
}

async function upsertCommissionTiers() {
  const { data } = await supabase.from("commission_tiers").select("tier_index");
  if (data?.length) return;
  const rows = Array.from({ length: 10 }, (_, i) => ({ tier_index: i + 1, cumulative_amount: (i + 1) * 6000 }));
  await supabase.from("commission_tiers").insert(rows);
}

async function upsertFinancingPartner() {
  const { data } = await supabase.from("financing_partners").select("id").limit(1);
  if (data?.length) return data[0].id;
  const { data: created, error } = await supabase
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

async function createUser(email, fullName, role, branchId) {
  const { data: existing } = await supabase.auth.admin.listUsers();
  const already = existing?.users?.find((u) => u.email === email);
  if (already) {
    console.log(`↷ ${email} already exists`);
    return already.id;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName, role, branch_id: branchId ?? undefined },
  });
  if (error) {
    console.error(`✗ Failed to create ${email}:`, error.message);
    return null;
  }
  console.log(`✓ Created ${role}: ${email}`);
  return data.user.id;
}

async function insertVehicle(branchId, createdBy, vin, year, make, model, trim, purchasePrice) {
  const { data: existing } = await supabase.from("vehicles").select("id").eq("vin", vin).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supabase
    .from("vehicles")
    .insert({ branch_id: branchId, vin, year, make, model, trim, purchase_price: purchasePrice, created_by: createdBy })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function insertSplits(vehicleId, splits) {
  const { data: existing } = await supabase.from("vehicle_equity_splits").select("id").eq("vehicle_id", vehicleId);
  if (existing?.length) return;
  const { error } = await supabase.from("vehicle_equity_splits").insert(
    splits.map((s) => ({ vehicle_id: vehicleId, ...s }))
  );
  if (error) throw error;
}

async function main() {
  const branches = await upsertBranches();
  const downtown = branches.find((b) => b.name.includes("Downtown")) ?? branches[0];
  const airport = branches.find((b) => b.name.includes("Airport")) ?? branches[1] ?? branches[0];

  await upsertOverhead(branches);
  await upsertCommissionTiers();
  const partnerId = await upsertFinancingPartner();

  await createUser("ceo@filex.demo", "Alex Carter", "ceo", null);
  await createUser("manager@filex.demo", "Dana Reyes", "branch_manager", downtown.id);
  await createUser("accountant@filex.demo", "Sam Nguyen", "accountant", downtown.id);
  const salesId = await createUser("sales@filex.demo", "Jordan Blake", "sales_exec", downtown.id);
  const investor1Id = await createUser("investor1@filex.demo", "Morgan Lee", "investor", null);
  const investor2Id = await createUser("investor2@filex.demo", "Priya Shah", "investor", null);

  if (investor1Id) await supabase.from("investors").upsert({ id: investor1Id, notes: "Seed investor #1" });
  if (investor2Id) await supabase.from("investors").upsert({ id: investor2Id, notes: "Seed investor #2" });

  // Vehicle 1: sold already (will drive a full executed deal below) — 60/40 CEO/investor1
  const v1 = await insertVehicle(downtown.id, salesId, "1FADP3F20EL123456", 2022, "Ford", "Fusion", "SE", 18000);
  await insertSplits(v1, [
    { holder_type: "ceo", holder_id: null, amount_invested: 10800, percentage: 60 },
    { holder_type: "investor", holder_id: investor1Id, amount_invested: 7200, percentage: 40 },
  ]);

  // Vehicle 2: in stock, 50/50 CEO/investor2
  const v2 = await insertVehicle(downtown.id, salesId, "2HGFC2F59NH123457", 2023, "Honda", "Civic", "Sport", 22000);
  await insertSplits(v2, [
    { holder_type: "ceo", holder_id: null, amount_invested: 11000, percentage: 50 },
    { holder_type: "investor", holder_id: investor2Id, amount_invested: 11000, percentage: 50 },
  ]);

  // Vehicle 3: in stock at airport branch, CEO-only funded
  const v3 = await insertVehicle(airport.id, salesId, "3VWFE21C04M123458", 2024, "Toyota", "Camry", "XSE", 27500);
  await insertSplits(v3, [{ holder_type: "ceo", holder_id: null, amount_invested: 27500, percentage: 100 }]);

  // Vehicle 4: in stock, three-way split (CEO + 2 investors)
  const v4 = await insertVehicle(downtown.id, salesId, "4T1BF1FK5EU123459", 2023, "BMW", "3 Series", "330i", 34000);
  await insertSplits(v4, [
    { holder_type: "ceo", holder_id: null, amount_invested: 17000, percentage: 50 },
    { holder_type: "investor", holder_id: investor1Id, amount_invested: 10200, percentage: 30 },
    { holder_type: "investor", holder_id: investor2Id, amount_invested: 6800, percentage: 20 },
  ]);

  // A couple of leads
  const { data: existingLeads } = await supabase.from("leads").select("id").limit(1);
  let leadId;
  if (!existingLeads?.length) {
    const { data: lead1 } = await supabase
      .from("leads")
      .insert({
        branch_id: downtown.id, salesperson_id: salesId, client_name: "Taylor Morgan",
        phone_number: "5551234567", car_interest: "2023 Honda Civic", status: "ticket_created", source: "manual",
      })
      .select("id").single();
    leadId = lead1?.id;
    await supabase.from("leads").insert({
      branch_id: downtown.id, salesperson_id: salesId, client_name: "Riley Chen",
      phone_number: "5559876543", car_interest: "Looking for a sedan", status: "pending", source: "manual",
    });
  }

  // Deal ticket 1: executed (against vehicle 1, cash)
  const { data: existingTickets } = await supabase.from("deal_tickets").select("id, status");
  if (!existingTickets?.length) {
    const { data: t1 } = await supabase
      .from("deal_tickets")
      .insert({
        vehicle_id: v1, branch_id: downtown.id, salesperson_id: salesId,
        agreed_price: 21500, financing_type: "cash", discount_amount: 200,
        financial_check_passed: true, discount_validated: true, rate_revalidated: true,
      })
      .select("id").single();

    await supabase.from("deal_tickets").update({ status: "approved" }).eq("id", t1.id);
    const { error: execError } = await supabase.rpc("execute_vehicle_sale", { p_deal_ticket_id: t1.id });
    if (execError) console.error("execute_vehicle_sale failed:", execError.message);
    else console.log("✓ Executed demo sale for vehicle 1 — ledger entries created");

    // Deal ticket 2: pending manager review (against vehicle 2, installments)
    await supabase.from("deal_tickets").insert({
      lead_id: leadId, vehicle_id: v2, branch_id: downtown.id, salesperson_id: salesId,
      agreed_price: 23000, financing_type: "installments", financing_partner_id: partnerId,
      down_payment: 3000, discount_amount: 0,
    });

    // Deal ticket 3: rejected (against vehicle 4)
    const { data: t3 } = await supabase
      .from("deal_tickets")
      .insert({
        vehicle_id: v4, branch_id: downtown.id, salesperson_id: salesId,
        agreed_price: 30000, financing_type: "cash", discount_amount: 0,
      })
      .select("id").single();
    await supabase.from("deal_tickets").update({ status: "rejected", rejection_reason: "Price too far below market — renegotiate." }).eq("id", t3.id);
  }

  console.log("\n— Demo accounts (all use password:", PASSWORD, ") —");
  console.log("CEO:        ceo@filex.demo");
  console.log("Manager:    manager@filex.demo");
  console.log("Accountant: accountant@filex.demo");
  console.log("Sales exec: sales@filex.demo");
  console.log("Investor 1: investor1@filex.demo");
  console.log("Investor 2: investor2@filex.demo");
  console.log("\nReferral link: /en/refer/" + salesId);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
