"use server";

import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  authenticate,
  authorize,
  assertBranch,
  canActOnBranch,
  getGrantedBranchIds,
  REVIEWER_ROLES,
} from "@/lib/auth";
import { RequestStockTransferSchema, Uuid, parseInput } from "@/lib/validation";
import { toUserError } from "@/lib/db-error";
import { sendMail } from "../../mail/actions";
import type { StockTransfer } from "@/lib/supabase/types";
import type { ActionError } from "@/lib/validation";

// Every export here is a public HTTP endpoint. The role props that hide
// these controls in TransferPanel do nothing for a hand-crafted POST, so
// each action re-checks the caller's role and branch before it writes —
// the same discipline deals/actions.ts and installment-actions.ts use.

function revalidateVehicle() {
  revalidatePath("/[locale]/(app)/inventory/[vehicleId]", "page");
}

/** The RLS-scoped, tenant-schema-pinned client createClient() hands back. */
type TenantClient = Awaited<ReturnType<typeof createClient>>;

type TransferScope = {
  id: string;
  vehicle_id: string;
  from_branch_id: string;
  to_branch_id: string;
  status: string;
  requested_by: string | null;
};

async function loadTransferScope(transferId: string): Promise<TransferScope | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("stock_transfers")
    .select("id, vehicle_id, from_branch_id, to_branch_id, status, requested_by")
    .eq("id", transferId)
    .maybeSingle();
  return data as TransferScope | null;
}

/**
 * The link a notification mail sends the recipient back to — the
 * vehicle's own page, where the Branch Transfer panel's Accept/Cancel
 * buttons already live. There is no site-wide base URL configured
 * anywhere in this app (each showroom is reached at its own host), so
 * this reads the host the CALLER'S OWN REQUEST arrived on rather than
 * guessing — the same request that is about to send this mail is, by
 * definition, addressed to this tenant's real hostname.
 */
async function vehicleUrl(vehicleId: string): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const locale = await getLocale();
  return `${proto}://${host}/${locale}/inventory/${vehicleId}`;
}

async function branchManagerIds(supabase: TenantClient, branchId: string): Promise<string[]> {
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "branch_manager")
    .eq("branch_id", branchId);
  return ((data as { id: string }[] | null) ?? []).map((p) => p.id);
}

async function ceoIds(supabase: TenantClient): Promise<string[]> {
  const { data } = await supabase.from("profiles").select("id").eq("role", "ceo");
  return ((data as { id: string }[] | null) ?? []).map((p) => p.id);
}

/** The three human-readable strings every transfer notification needs. */
async function transferLabels(
  supabase: TenantClient,
  vehicleId: string,
  fromBranchId: string,
  toBranchId: string
): Promise<{ vehicleLabel: string; fromBranchName: string; toBranchName: string }> {
  const [{ data: vehicleRow }, { data: branchRows }] = await Promise.all([
    supabase.from("vehicles").select("year, make, model").eq("id", vehicleId).maybeSingle(),
    supabase.from("branches").select("id, name").in("id", [fromBranchId, toBranchId]),
  ]);
  const v = vehicleRow as { year: number; make: string; model: string } | null;
  const rows = (branchRows as { id: string; name: string }[] | null) ?? [];
  const branchName = (id: string) => rows.find((b) => b.id === id)?.name ?? "—";
  return {
    vehicleLabel: v ? `${v.year} ${v.make} ${v.model}` : "this vehicle",
    fromBranchName: branchName(fromBranchId),
    toBranchName: branchName(toBranchId),
  };
}

/**
 * Sends the internal mail a stock-transfer event generates — the
 * "notification" half of 0043's transfer/mail work. Plain internal
 * mail, not a bespoke channel: it is sent AS the profile that just
 * performed the action (requestTransfer/acceptTransfer/cancelTransfer
 * already run inside that profile's own authenticated session), so it
 * lands in the recipient's ordinary FELIX Mail inbox and any back-and-
 * forth after this is just replying to it — no separate accept/decline
 * mechanism lives inside mail itself; the buttons on the vehicle page
 * remain the one place a transfer is actually decided.
 *
 * Never allowed to fail the caller's transfer: a mail-send hiccup must
 * not undo (or even appear to undo) a transfer decision that already
 * committed to the database, so every failure here is logged and
 * swallowed.
 */
async function notifyTransfer(
  supabase: TenantClient,
  vehicleId: string,
  vehicleLabel: string,
  fromBranchName: string,
  toBranchName: string,
  kind: "requested" | "accepted" | "cancelled" | "declined",
  note: string | null,
  toIds: string[],
  ccIds: string[]
) {
  const to = Array.from(new Set(toIds)).filter(Boolean);
  const cc = Array.from(new Set(ccIds)).filter((id) => Boolean(id) && !to.includes(id));
  if (!to.length && !cc.length) return;

  const url = await vehicleUrl(vehicleId);
  const subject =
    kind === "requested"
      ? `Stock transfer requested: ${vehicleLabel} → ${toBranchName}`
      : kind === "accepted"
        ? `Stock transfer accepted: ${vehicleLabel} is now at ${toBranchName}`
        : kind === "declined"
          ? `Stock transfer declined: ${toBranchName} will not take ${vehicleLabel}`
          : `Stock transfer cancelled: ${vehicleLabel} stays at ${fromBranchName}`;

  const bodyLines = [
    kind === "requested"
      ? `${vehicleLabel} has been requested to move from ${fromBranchName} to ${toBranchName}.`
      : kind === "accepted"
        ? `The transfer of ${vehicleLabel} from ${fromBranchName} to ${toBranchName} has been accepted.`
        : kind === "declined"
          ? `${toBranchName} has declined the transfer of ${vehicleLabel}. The car stays at ${fromBranchName}.`
          : `The transfer of ${vehicleLabel} from ${fromBranchName} to ${toBranchName} has been cancelled.`,
    note ? `\nNote: ${note}` : null,
    kind === "requested" ? `\nOpen the car to accept or decline this request:\n${url}` : `\nOpen the car:\n${url}`,
  ].filter((line): line is string => line !== null);

  const result = await sendMail({
    to_profile_ids: to.length ? to : cc,
    cc_profile_ids: to.length ? cc : [],
    subject,
    body: bodyLines.join("\n"),
  });
  if (result && "error" in result) {
    console.error("[transfers] notification mail failed", { vehicleId, kind, error: result.error });
  }
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

  const parsed = await parseInput(RequestStockTransferSchema, input);
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

  // 0043: tell the receiving branch a car is coming — to its
  // manager(s), cc'd to the CEO and back to the requester as a
  // confirmation copy. Falls back to the CEO as the "to" if the
  // destination branch has no manager on record, rather than the mail
  // silently having nobody to reach.
  const [{ vehicleLabel, fromBranchName, toBranchName }, toMgrs, ceos] = await Promise.all([
    transferLabels(supabase, v.id, v.branch_id, parsed.data.toBranchId),
    branchManagerIds(supabase, parsed.data.toBranchId),
    ceoIds(supabase),
  ]);
  await notifyTransfer(
    supabase,
    v.id,
    vehicleLabel,
    fromBranchName,
    toBranchName,
    "requested",
    parsed.data.note || null,
    toMgrs,
    [...ceos, auth.profile.id]
  );

  revalidateVehicle();
  return { ok: true };
}

/**
 * Standing a transfer down — from EITHER end (0043).
 *
 * The sending branch CANCELS ("never mind, it is not coming"); the
 * receiving branch DECLINES ("no thanks, we do not want it"). Both land
 * the row on the same 'cancelled' status, because the database has only
 * ever had one way out of 'requested' that is not an accept — but they
 * are different acts by different people, so the notification below is
 * routed to whichever end did NOT make the call.
 *
 * RLS admitted both ends from the start (stock_transfers_update, 0035:
 * `can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id)`)
 * and guard_stock_transfer_status() confines the move to a 'requested'
 * row either way. The APP layer used to be the narrower one, asserting
 * the source branch and refusing everyone else — which left the
 * receiving branch a request it could accept but never refuse. That is
 * not a decision, it is a queue.
 *
 * The CEO is org-wide, so canActOnBranch() is true for them at both
 * ends and they read as the sending side: a CEO standing a transfer
 * down is a cancel, and the mail goes to the branch that was expecting
 * the car. That is the right framing and the right audience.
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

  const granted = await getGrantedBranchIds();
  const onSource = canActOnBranch(auth.profile, transfer.from_branch_id, granted);
  const onDestination = canActOnBranch(auth.profile, transfer.to_branch_id, granted);
  if (!onSource && !onDestination) {
    return { error: "That record belongs to another branch." };
  }
  // Only the end you actually stand on decides which act this is; see
  // the header for why a CEO (true at both ends) reads as the sender.
  const declined = !onSource && onDestination;

  const supabase = await createClient();
  const { error } = await supabase
    .from("stock_transfers")
    .update({ status: "cancelled" })
    .eq("id", id.data)
    .eq("status", "requested");
  if (error) return toUserError(error);

  // Tell the end that did NOT make this call. A decline goes back to
  // the branch that asked (and the person who raised it); a cancel goes
  // forward to the branch that was expecting the car. The CEO is cc'd
  // on both, as they are on every other transfer event.
  const [{ vehicleLabel, fromBranchName, toBranchName }, mgrs, ceos] = await Promise.all([
    transferLabels(supabase, transfer.vehicle_id, transfer.from_branch_id, transfer.to_branch_id),
    branchManagerIds(supabase, declined ? transfer.from_branch_id : transfer.to_branch_id),
    ceoIds(supabase),
  ]);

  const to = [...mgrs];
  const cc = [...ceos];
  if (transfer.requested_by && transfer.requested_by !== auth.profile.id) {
    // The requester hears about it either way — as the addressee when
    // their own request was refused, as a copy when somebody else stood
    // their request down.
    (declined ? to : cc).push(transfer.requested_by);
  }

  await notifyTransfer(
    supabase,
    transfer.vehicle_id,
    vehicleLabel,
    fromBranchName,
    toBranchName,
    declined ? "declined" : "cancelled",
    null,
    to,
    cc
  );

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

  // 0043: tell the requester their car has arrived, cc'd to the CEO.
  const [{ vehicleLabel, fromBranchName, toBranchName }, ceos] = await Promise.all([
    transferLabels(supabase, transfer.vehicle_id, transfer.from_branch_id, transfer.to_branch_id),
    ceoIds(supabase),
  ]);
  const to = transfer.requested_by ? [transfer.requested_by] : [];
  await notifyTransfer(supabase, transfer.vehicle_id, vehicleLabel, fromBranchName, toBranchName, "accepted", null, to, ceos);

  revalidateVehicle();
  return { ok: true };
}
