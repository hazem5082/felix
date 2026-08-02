"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize, assertBranch, INTAKE_ROLES, EXPENSE_ROLES } from "@/lib/auth";
import { AddExpenseSchema, CreateVehicleSchema, parseInput } from "@/lib/validation";
import { toUserError } from "@/lib/db-error";

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
  purchase_price: number;
  photos: string[];
  splits: EquitySplitInput[];
}) {
  const auth = await authorize(INTAKE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CreateVehicleSchema, input);
  if (!parsed.ok) return parsed.error;

  const branchError = assertBranch(auth.profile, parsed.data.branch_id);
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
    p_purchase_price: parsed.data.purchase_price,
    p_photos: parsed.data.photos,
    p_splits: parsed.data.splits,
  });

  if (error) return toUserError(error);
  revalidatePath("/[locale]/(app)/inventory", "page");
  return { id: data as string };
}

export async function addExpense(input: {
  vehicle_id: string;
  category: string;
  amount: number;
  note: string;
  is_ceo_override: boolean;
}) {
  const auth = await authorize(EXPENSE_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(AddExpenseSchema, input);
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

  const branchError = assertBranch(auth.profile, v.branch_id);
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
