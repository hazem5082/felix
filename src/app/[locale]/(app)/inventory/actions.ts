"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

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
  const supabase = await createClient();

  const totalPct = input.splits.reduce((s, r) => s + r.percentage, 0);
  if (Math.abs(totalPct - 100) > 0.5) {
    return { error: "Equity splits must sum to 100%." };
  }

  const { data, error } = await supabase.rpc("create_vehicle_with_equity_splits", {
    p_branch_id: input.branch_id,
    p_vin: input.vin,
    p_year: input.year,
    p_make: input.make,
    p_model: input.model,
    p_trim: input.trim,
    p_purchase_price: input.purchase_price,
    p_photos: input.photos,
    p_splits: input.splits,
  });

  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { id: data as string };
}

export async function addExpense(input: {
  vehicle_id: string;
  category: string;
  amount: number;
  note: string;
  is_ceo_override: boolean;
}) {
  const supabase = await createClient();
  const { error } = await supabase.from("vehicle_expenses").insert({
    vehicle_id: input.vehicle_id,
    category: input.category,
    amount: input.amount,
    note: input.note || null,
    is_ceo_override: input.is_ceo_override,
  });
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function fetchInvestorsForPicker() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("investors")
    .select("id, profiles(full_name)");
  return data ?? [];
}
