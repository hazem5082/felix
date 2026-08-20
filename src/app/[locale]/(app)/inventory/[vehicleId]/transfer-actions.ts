"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authenticate, authorize, assertBranch, REVIEWER_ROLES } from "@/lib/auth";
import { RequestStockTransferSchema, Uuid, parseInput } from "@/lib/validation";
import { toUserError } from "@/lib/db-error";
import type { StockTransfer } from "@/lib/supabase/types";
import type { ActionError } from "@/lib/validation";

// Every export here is a public HTTP endpoint. The role props that hide
// these controls in TransferPanel do nothing for a hand-crafted POST, so
// each action re-checks the caller's role and branch before it writes —
// the same discipline deals/actions.ts and installment-actions.ts use.

function revalidateVehicle() {
  revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
}

type TransferScope = {
  id: string;
  vehicle_id: string;
  from_branch_id: string;
  to_branch_id: string;
  status: string;
};

async function loadTransferScope(transferId: string): Promise<TransferScope | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("stock_transfers")
    .select("id, vehicle_id, from_branch_id, to_branch_id, status")
    .eq("id", transferId)
    .maybeSingle();
  return data as TransferScope | null;
}

/**
 * The full transfer history for one vehicle, newest first — RLS
 * (stock_transfers_select, migration 0035) is the real narrowing: either
 * branch's staff, the accountant org-wide, and the CEO. This action only
 * requires a signed-in session, the same shape loadEtaSubmissions() uses
 * for a read nothing here can turn into a write.
 */
export async function loadVehicleTransfers(
  vehicleId: string
): Promise<StockTransfer[] | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(vehicleId);
  if (!id.success) return { error: "Unknown vehicle." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stock_transfers")
    .select(
      "*, from_branch:branches!stock_transfers_from_branch_id_fkey(id, name), " +
        "to_branch:branches!stock_transfers_to_branch_id_fkey(id, name)"
    )
    .eq("vehicle_id", id.data)
    .order("requested_at", { ascending: false });
  if (error) return toUserError(error);

  return (data as unknown as StockTransfer[]) ?? [];
}

/**
 * Raise a request to move a car to another branch. from_branch_id is
 * never taken from the client — it is read off the vehicle's own
 * current branch, exactly as enforce_transfer_eligible() (0035) pins it
 * again on the way in, so the two can never disagree about where a
 * transfer "starts".
 *
 * REVIEWER_ROLES (ceo, branch_manager) — a stock movement decision, not
 * a sales-floor one, on the same reasoning INTAKE_ROLES gates vehicle
 * intake. RLS technically admits any staff member of the source branch
 * (can_act_on_branch(from_branch_id) alone), which is intentional: the
 * database is the outer bound, and this action is the narrower rule the
 * app actually enforces.
 */
export async function requestTransfer(input: {
  vehicleId: string;
  toBranchId: string;
  note: string;
}) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(RequestStockTransferSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();

  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("id, branch_id")
    .eq("id", parsed.data.vehicleId)
    .maybeSingle();
  if (!vehicle) return { error: "Unknown vehicle." };

  const v = vehicle as { id: string; branch_id: string };

  const branchError = await assertBranch(auth.profile, v.branch_id);
  if (branchError) return branchError;

  if (v.branch_id === parsed.data.toBranchId) {
    return { error: "The destination must be a different branch." };
  }

  const { error } = await supabase.from("stock_transfers").insert({
    vehicle_id: v.id,
    from_branch_id: v.branch_id,
    to_branch_id: parsed.data.toBranchId,
    requested_by: auth.profile.id,
    note: parsed.data.note,
  });
  if (error) return toUserError(error);

  revalidateVehicle();
  return { ok: true };
}

/**
 * The sending branch (or the CEO) stands down. REVIEWER_ROLES at the app
 * layer; RLS admits either end's actor at the write, and
 * guard_stock_transfer_status() is what actually confines a cancel to a
 * 'requested' row.
 */
export async function cancelTransfer(transferId: string) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(transferId);
  if (!id.success) return { error: "Unknown transfer." };

  const transfer = await loadTransferScope(id.data);
  if (!transfer) return { error: "Unknown transfer." };

  if (transfer.status !== "requested") {
    return { error: "This transfer has already been decided." };
  }

  const branchError = await assertBranch(auth.profile, transfer.from_branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("stock_transfers")
    .update({ status: "cancelled" })
    .eq("id", id.data)
    .eq("status", "requested");
  if (error) return toUserError(error);

  revalidateVehicle();
  return { ok: true };
}

/**
 * Accept a transfer — and move the car.
 *
 * THE ORDER IS DELIBERATE AND READS BACKWARDS: the vehicle moves FIRST,
 * the transfer flips to 'accepted' SECOND. supabase/migrations/
 * 0035_stock_transfers.sql's header explains why at length — the
 * widened vehicles_update policy and its guard trigger both key off
 * stock_transfers.status = 'requested', so accepting the transfer
 * before moving the car would flip the row to 'accepted' and refuse the
 * very write that was meant to follow. Moving first, while the row is
 * still 'requested', keeps both writes authorized in sequence.
 *
 * NO CROSS-CALL TRANSACTION — the same reasoning
 * installment-actions.ts's payment recording gives for its own
 * multi-step writes. If the second write fails after the vehicle has
 * already moved, this reverts the vehicle rather than leaving the two
 * out of step. guard_stock_transfer_move() permits that revert for
 * exactly this reason: it authorises branch_id to move in EITHER
 * direction along the same open transfer, for as long as it is still
 * 'requested' — which it still is here, because the transfer write is
 * what just failed.
 */
export async function acceptTransfer(transferId: string) {
  const auth = await authorize(REVIEWER_ROLES);
  if (!auth.ok) return auth.error;

  const id = Uuid.safeParse(transferId);
  if (!id.success) return { error: "Unknown transfer." };

  const transfer = await loadTransferScope(id.data);
  if (!transfer) return { error: "Unknown transfer." };

  if (transfer.status !== "requested") {
    return { error: "This transfer has already been decided." };
  }

  const branchError = await assertBranch(auth.profile, transfer.to_branch_id);
  if (branchError) return branchError;

  const supabase = await createClient();

  const { error: moveError } = await supabase
    .from("vehicles")
    .update({ branch_id: transfer.to_branch_id })
    .eq("id", transfer.vehicle_id);
  if (moveError) return toUserError(moveError, "acceptTransfer:move");

  const { error: acceptError, data: acceptedRows } = await supabase
    .from("stock_transfers")
    .update({ status: "accepted" })
    .eq("id", id.data)
    .eq("status", "requested")
    .select("id");

  if (acceptError || !acceptedRows?.length) {
    const { error: revertError } = await supabase
      .from("vehicles")
      .update({ branch_id: transfer.from_branch_id })
      .eq("id", transfer.vehicle_id);

    if (revertError) {
      return {
        error:
          "The car moved but the transfer could not be marked accepted, and the automatic repair also failed. Contact support before touching this vehicle again.",
      };
    }

    return acceptError
      ? toUserError(acceptError, "acceptTransfer:accept")
      : { error: "This transfer was already decided by someone else. The vehicle move was reverted." };
  }

  revalidateVehicle();
  return { ok: true };
}
