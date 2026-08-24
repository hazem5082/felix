"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorize } from "@/lib/auth";
import { UpsertListingSchema, parseInput } from "@/lib/validation";
import { toUserError } from "@/lib/db-error";
import type { Role } from "@/lib/supabase/types";

// Who runs the shop window. Managers are included because the DB policy
// includes them (a manager pulling a sold car's post at 9pm should not
// need to find the marketing person first).
const LISTING_ROLES: Role[] = ["ceo", "branch_manager", "marketing"];

/**
 * Records where a car is advertised — one row per (vehicle, channel),
 * upserted under the unique index from 0029. RLS pins posted_by to the
 * caller and re-checks the role list server-side.
 */
export async function upsertListing(input: {
  vehicle_id: string;
  channel: string;
  status: string;
  url: string;
  note: string;
}) {
  const auth = await authorize(LISTING_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(UpsertListingSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.from("vehicle_listings").upsert(
    {
      vehicle_id: parsed.data.vehicle_id,
      channel: parsed.data.channel,
      status: parsed.data.status,
      url: parsed.data.url,
      note: parsed.data.note,
      posted_by: auth.profile.id,
      // The moment it went live. Anything not live has no live moment.
      posted_at: parsed.data.status === "posted" ? new Date().toISOString() : null,
    },
    { onConflict: "vehicle_id,channel" }
  );
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/marketing", "page");
  return { ok: true };
}
