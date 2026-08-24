"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, INTAKE_ROLES, EXPENSE_ROLES } from "@/lib/auth";
import {
  AddExpenseSchema,
  CreateVehicleSchema,
  RedecodeVehicleVinSchema,
  SetVehiclePricesSchema,
  parseInput,
} from "@/lib/validation";
import { toUserError } from "@/lib/db-error";
import { getTenant } from "@/lib/tenant";
import { vinMakeMismatch } from "@/lib/vin-match";
import { sendSuspiciousVinAlert } from "@/lib/vin-fraud-alert";
import { decodeVin } from "@/lib/vin-decode";

export interface EquitySplitInput {
  holder_type: "ceo" | "investor";
  holder_id: string | null;
  amount_invested: number;
  percentage: number;
}

export async function createVehicle(input: {
  branch_id: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  color: string;
  // Recorded at intake, updatable afterwards (migration 0036). Both
  // optional: stock is taken in before either is always known.
  odometer_km: number | null;
  acquisition_source: string;
  description: string;
  inspection_photos: string[];
  engine_number: string;
  plate_number: string;
  country_of_origin: string;
  // VIN-decoded details (migration 0040) — see lib/vin-decode.ts.
  body_type: string;
  engine_info: string;
  drive_type: string;
  doors: number | null;
  plant_country: string;
  locale: string;
  features: string[];
  item_code: string;
  // How the showroom came to have this car (0032). 'trade_in' is not
  // offered: such a row is born only inside execute_vehicle_sale().
  acquisition_type: "purchase" | "consignment";
  consignor_name: string;
  consignor_phone: string;
  consignor_national_id: string;
  consignment_commission_type: "fixed" | "percent" | "";
  consignment_commission_value: number | null;
  purchase_price: number;
  asking_price: number | null;
  min_price: number | null;
  photos: string[];
  splits: EquitySplitInput[];
}) {
  const auth = await authorize(INTAKE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(CreateVehicleSchema, input);
  if (!parsed.ok) return parsed.error;

  const branchError = await assertBranch(auth.profile, parsed.data.branch_id);
  if (branchError) return branchError;

  // Allocating investor equity is a CEO decision — a branch manager may take
  // stock in, but not decide who owns it. Migration 0003 enforces the same
  // rule inside the RPC; this makes the failure legible.
  const hasInvestorSplits = parsed.data.splits.some((s) => s.holder_type === "investor");
  if (hasInvestorSplits && auth.profile.role !== "ceo") {
    return { error: "Only the CEO can allocate investor equity on a vehicle." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_vehicle_with_equity_splits", {
    p_branch_id: parsed.data.branch_id,
    p_vin: parsed.data.vin,
    p_year: parsed.data.year,
    p_make: parsed.data.make,
    p_model: parsed.data.model,
    p_trim: parsed.data.trim,
    p_color: parsed.data.color,
    p_description: parsed.data.description,
    p_inspection_photos: parsed.data.inspection_photos,
    p_engine_number: parsed.data.engine_number,
    p_plate_number: parsed.data.plate_number,
    p_country_of_origin: parsed.data.country_of_origin,
    p_features: parsed.data.features,
    p_item_code: parsed.data.item_code,
    // 0032 widened the RPC 17 → 23. The consignor group is sent for
    // every intake and written only for a consignment — the function
    // discards it otherwise, so a stale client cannot name somebody as
    // the owner of a car the showroom bought.
    p_acquisition_type: parsed.data.acquisition_type,
    p_consignor_name: parsed.data.consignor_name,
    p_consignor_phone: parsed.data.consignor_phone,
    p_consignor_national_id: parsed.data.consignor_national_id,
    p_consignment_commission_type: parsed.data.consignment_commission_type || null,
    p_consignment_commission_value: parsed.data.consignment_commission_value,
    p_purchase_price: parsed.data.purchase_price,
    p_photos: parsed.data.photos,
    p_splits: parsed.data.splits,
    // 0036 widened the RPC 23 → 25, appended after p_splits.
    p_odometer_km: parsed.data.odometer_km,
    p_acquisition_source: parsed.data.acquisition_source,
    // 0040 widened the RPC 25 → 30, appended after p_acquisition_source.
    p_body_type: parsed.data.body_type,
    p_engine_info: parsed.data.engine_info,
    p_drive_type: parsed.data.drive_type,
    p_doors: parsed.data.doors,
    p_plant_country: parsed.data.plant_country,
  });

  if (error) return toUserError(error);

  // FraudRadar — fully automatic, server-authoritative. A client is
  // NEVER trusted to self-report what a VIN decoded to (an earlier
  // version of this feature did exactly that via a decoded_make field
  // the client computed and sent — a manipulated request could simply
  // omit or fake it and suppress its own fraud alert). Instead the
  // server re-decodes the VIN itself, off the real, just-inserted
  // vehicle id, whether or not the intake form's own "Decode VIN"
  // button was ever clicked. Never allowed to fail the intake itself —
  // a mail outage or a slow NHTSA response must not block a car from
  // being taken into stock.
  if (parsed.data.vin) {
    try {
      const decoded = await decodeVin(parsed.data.vin);
      if (decoded?.decoded && decoded.make && vinMakeMismatch(decoded.make, parsed.data.make)) {
        const tenant = await getTenant();
        if (tenant) {
          await sendSuspiciousVinAlert({
            schemaName: tenant.schema_name,
            tenantSlug: tenant.slug,
            vehicleId: data as string,
            vin: parsed.data.vin,
            recordedMake: parsed.data.make,
            recordedModel: parsed.data.model,
            decodedMake: decoded.make,
            decodedModel: decoded.model,
            locale: parsed.data.locale,
          });
        }
      }
    } catch (err) {
      console.error("[inventory] FraudRadar check failed", err);
    }
  }

  // The intake RPC stays at 17 arguments (0028's header): sticker/min
  // price ride the column-limited UPDATE grant instead. Not atomic with
  // the create, and deliberately so — the worst case is a car that
  // exists un-priced, which is also what intake without prices produces.
  if (parsed.data.asking_price !== null || parsed.data.min_price !== null) {
    const { error: priceError } = await supabase
      .from("vehicles")
      .update({ asking_price: parsed.data.asking_price, min_price: parsed.data.min_price })
      .eq("id", data as string);
    if (priceError) {
      // The car is IN — returning an error here would leave the intake
      // dialog open and a retry would create a duplicate. The prices can
      // be set from the vehicle page; log and move on.
      console.error("[inventory] vehicle created but pricing failed", priceError.message);
    }
  }

  revalidatePath("/[locale]/(app)/inventory", "page");
  return { id: data as string };
}

/**
 * Re-prices a vehicle — sticker and lowest offer. The one direct write
 * the tenant role holds on vehicles: 0028's grant is limited to exactly
 * these two columns, and the vehicles_update policy scopes a manager to
 * their own branch. Cost, status and the rest remain RPC-only.
 */
export async function setVehiclePrices(input: {
  vehicle_id: string;
  asking_price: number | null;
  min_price: number | null;
}) {
  const auth = await authorize(INTAKE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(SetVehiclePricesSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("id, branch_id")
    .eq("id", parsed.data.vehicle_id)
    .maybeSingle();
  const v = vehicle as { id: string; branch_id: string } | null;
  if (!v) return { error: "Unknown vehicle." };

  const branchError = await assertBranch(auth.profile, v.branch_id);
  if (branchError) return branchError;

  const { error } = await supabase
    .from("vehicles")
    .update({ asking_price: parsed.data.asking_price, min_price: parsed.data.min_price })
    .eq("id", parsed.data.vehicle_id);
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/inventory", "page");
  revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
  return { ok: true };
}

/**
 * Re-decodes an EXISTING vehicle's VIN — the retrofit path 0041 opened.
 * createVehicle() sets body_type/engine_info/drive_type/doors/
 * plant_country once, at intake; this is the only way any car intaken
 * before that feature existed (which is every car already in stock) can
 * ever get them. Column-limited UPDATE grant (0041) + vehicles_update's
 * existing row policy (CEO, or a manager on their own branch) — same
 * shape as setVehiclePrices() above, no RPC ceremony.
 */
export async function saveVinDecodedDetails(input: { vehicle_id: string; locale: string }) {
  const auth = await authorize(INTAKE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(RedecodeVehicleVinSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("id, branch_id, make, model, vin")
    .eq("id", parsed.data.vehicle_id)
    .maybeSingle();
  const v = vehicle as { id: string; branch_id: string; make: string; model: string; vin: string | null } | null;
  if (!v) return { error: "Unknown vehicle." };
  if (!v.vin) return { error: "This vehicle has no VIN on record." };

  const branchError = await assertBranch(auth.profile, v.branch_id);
  if (branchError) return branchError;

  // Fully server-driven, off the VIN actually on record — never off a
  // client-reported decode. See the identical note in createVehicle().
  const decoded = await decodeVin(v.vin);
  if (!decoded?.decoded) {
    return { error: "No data came back for this VIN — it may be outside the decoder's coverage." };
  }

  const { error } = await supabase
    .from("vehicles")
    .update({
      body_type: decoded.bodyType,
      engine_info: decoded.engineInfo,
      drive_type: decoded.driveType,
      doors: decoded.doors,
      plant_country: decoded.countryOfOrigin,
    })
    .eq("id", parsed.data.vehicle_id);
  if (error) return toUserError(error);

  if (decoded.make && vinMakeMismatch(decoded.make, v.make)) {
    const tenant = await getTenant();
    if (tenant) {
      await sendSuspiciousVinAlert({
        schemaName: tenant.schema_name,
        tenantSlug: tenant.slug,
        vehicleId: v.id,
        vin: v.vin,
        recordedMake: v.make,
        recordedModel: v.model,
        decodedMake: decoded.make,
        decodedModel: decoded.model,
        locale: parsed.data.locale,
      }).catch((err) => console.error("[inventory] FraudRadar alert failed", err));
    }
  }

  revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
  return { ok: true };
}

export async function addExpense(input: {
  vehicle_id: string;
  category: string;
  amount: number;
  note: string;
  vat_amount: number | null;
  supplier_tax_id: string;
  supplier_invoice_no: string;
  is_ceo_override: boolean;
}) {
  const auth = await authorize(EXPENSE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(AddExpenseSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  // The expense must belong to a vehicle this actor is allowed to touch —
  // an expense silently reduces the profit every equity holder is paid.
  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("id, branch_id, status")
    .eq("id", parsed.data.vehicle_id)
    .maybeSingle();

  const v = vehicle as { id: string; branch_id: string; status: string } | null;
  if (!v) return { error: "Unknown vehicle." };

  const branchError = await assertBranch(auth.profile, v.branch_id);
  if (branchError) return branchError;

  if (v.status === "sold") {
    return { error: "This vehicle has been sold — its cost basis is locked." };
  }

  // is_ceo_override permanently locks the row from every non-CEO edit, so it
  // is derived from the caller's actual role rather than taken from the
  // client, where the checkbox was only ever hidden by a UI prop.
  const isCeoOverride = auth.profile.role === "ceo" && input.is_ceo_override === true;

  const { error } = await supabase.from("vehicle_expenses").insert({
    vehicle_id: parsed.data.vehicle_id,
    category: parsed.data.category,
    amount: parsed.data.amount,
    note: parsed.data.note,
    vat_amount: parsed.data.vat_amount,
    supplier_tax_id: parsed.data.supplier_tax_id,
    supplier_invoice_no: parsed.data.supplier_invoice_no,
    created_by: auth.profile.id,
    is_ceo_override: isCeoOverride,
  });
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
  return { ok: true };
}

export async function fetchInvestorsForPicker() {
  const auth = await authorize(INTAKE_ROLES);
  if (!auth.ok) return [];

  const supabase = await createClient();
  const { data } = await supabase.from("investors").select("id, profiles(full_name)");
  return data ?? [];
}
