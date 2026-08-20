import "server-only";

/**
 * Orchestration: rows -> document -> validate -> sign -> submit ->
 * settle -> write back.
 *
 * EVERY DATABASE ACCESS HERE IS ON THE CALLER'S OWN SESSION. There is no
 * service-role shortcut anywhere in this file, deliberately: migration
 * 0034's policies admit an accountant org-wide and a branch manager to
 * their own branch's rows, and 0024's column-limited UPDATE grant on
 * `contracts` is what stops this path from touching serial, pdf_url or
 * unlocked_at. Reaching for the admin client would discard both, and the
 * only thing it would buy is the ability to file an invoice for a deal
 * the person filing it cannot see.
 *
 * THE SUBMISSION ROW IS WRITTEN BEFORE ANYTHING LEAVES THE PROCESS, and
 * updated as the attempt progresses. That ordering is the point of the
 * table: a submission that crashes between "sent" and "answered" must
 * leave a row saying so, because the alternative — no row — is
 * indistinguishable from "never tried" and invites a second filing of
 * the same sale.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getTenant } from "@/lib/tenant";
import { toUserError } from "@/lib/db-error";
import type { ActionError } from "@/lib/validation";
import type {
  Branch,
  Contract,
  Customer,
  DealTicket,
  EtaSubmission,
  EtaSubmissionRowStatus,
  Lead,
  Vehicle,
} from "@/lib/supabase/types";
import {
  buildEtaDocument,
  type EtaBlocker,
  type EtaBuildInput,
  type EtaDocumentSummary,
  type EtaIssuerConfig,
  type EtaWarning,
} from "./document";
import { createEtaClient, validateEtaDocument } from "./client";
import { signDocument } from "./signing";
import { getEtaActivityCode, getEtaBranchCode, getEtaMode, getEtaPollBudgetMs } from "./env";
import type { EtaError, EtaMode, EtaSubmissionDocumentSummary } from "./types";

/**
 * The seller's structured address.
 *
 * ETA wants governate / regionCity / street / buildingNumber as separate
 * fields; `branches.address` is one free-text line, and parsing an
 * Egyptian address out of free text is a research project with a wrong
 * answer at the end of it. So the components come from configuration —
 * the same reasoning 0022's header gives for putting tax_registration_no
 * on `branches` rather than inventing a settings table, applied in the
 * other direction: this is per-deployment configuration, not per-row
 * data, and it does not earn five columns on `branches`.
 *
 * `branches.address` is still used, as the street line, when it is set.
 */
function issuerAddressFrom(branch: Branch | null, mode: EtaMode) {
  const env = (name: string) => process.env[name]?.trim() || "";

  const configured = {
    country: env("ETA_ISSUER_COUNTRY") || "EG",
    governate: env("ETA_ISSUER_GOVERNATE"),
    regionCity: env("ETA_ISSUER_REGION_CITY"),
    street: env("ETA_ISSUER_STREET") || branch?.address?.trim() || "",
    buildingNumber: env("ETA_ISSUER_BUILDING_NUMBER"),
    postalCode: env("ETA_ISSUER_POSTAL_CODE") || null,
  };

  // Outside the sandbox an unset component stays empty, document.ts sees
  // an unusable address and raises the missingIssuerAddress BLOCKER. In
  // the sandbox it is filled with a value that reads SANDBOX wherever a
  // human looks, so the demo runs end to end without pretending the
  // address is real — and the filling is itself reported as a warning.
  const missing = (["governate", "regionCity", "street", "buildingNumber"] as const).filter(
    (k) => configured[k] === ""
  );
  const filled = mode === "mock" && missing.length > 0;

  if (filled) {
    for (const key of missing) {
      configured[key] = key === "buildingNumber" ? "1" : "SANDBOX";
    }
  }

  return { address: configured, filled };
}

// ── Loading ─────────────────────────────────────────────────

export interface EtaContext {
  ticket: DealTicket;
  vehicle: Vehicle;
  contract: Contract | null;
  buildInput: EtaBuildInput;
  contextWarnings: EtaWarning[];
}

type ContextResult = { ok: true; context: EtaContext } | { ok: false; error: ActionError };

/**
 * Everything the builder needs for one deal ticket, read in three round
 * trips and no more.
 *
 * The buyer is the CUSTOMER (0031) where the lead has been linked to one
 * and the lead itself otherwise. That order matters on a tax document:
 * the customer row is the deduplicated identity whose national ID
 * somebody checked against a document, and the lead's copy is whatever
 * was typed on the day. Where the customer exists it is the better
 * answer, and where it does not the lead is the only answer.
 */
export async function loadEtaContext(ticketId: string): Promise<ContextResult> {
  const supabase = await createClient();

  const { data: ticketRow, error: ticketError } = await supabase
    .from("deal_tickets")
    .select("*, vehicles(*), leads(*, customers(*))")
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketError) return { ok: false, error: toUserError(ticketError, "eta ticket") };
  if (!ticketRow) return { ok: false, error: { error: "That deal ticket no longer exists." } };

  const ticket = ticketRow as DealTicket & {
    vehicles?: Vehicle;
    leads?: (Lead & { customers?: Customer | null }) | null;
  };
  const vehicle = ticket.vehicles;
  if (!vehicle) {
    return { ok: false, error: { error: "That deal ticket has no vehicle." } };
  }

  const [{ data: contractRow }, { data: branchRow }, tenant] = await Promise.all([
    supabase.from("contracts").select("*").eq("deal_ticket_id", ticketId).maybeSingle(),
    supabase.from("branches").select("*").eq("id", ticket.branch_id).maybeSingle(),
    getTenant(),
  ]);

  const contract = (contractRow as Contract | null) ?? null;
  const branch = (branchRow as Branch | null) ?? null;
  const lead = ticket.leads ?? null;
  const customer = lead?.customers ?? null;

  const mode = getEtaMode();
  const { address, filled } = issuerAddressFrom(branch, mode);
  const contextWarnings: EtaWarning[] = [];
  if (filled) contextWarnings.push({ code: "sandboxIssuerAddress" });

  const issuer: EtaIssuerConfig = {
    // The taxpayer is the showroom group; the branch is the premises.
    // The name on the invoice is the group's, which is what the tax
    // registration was issued to.
    name: tenant?.name ?? branch?.name ?? "",
    taxRegistrationNo: branch?.tax_registration_no ?? null,
    branchCode: getEtaBranchCode() ?? null,
    address,
  };

  const buildInput: EtaBuildInput = {
    ticket: {
      id: ticket.id,
      status: ticket.status,
      agreed_price: ticket.agreed_price,
      vat_rate: ticket.vat_rate,
      vat_amount: ticket.vat_amount,
      price_includes_vat: ticket.price_includes_vat,
      executed_at: ticket.executed_at,
    },
    vehicle: {
      vin: vehicle.vin,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim,
      color: vehicle.color,
      item_code: vehicle.item_code ?? null,
    },
    contract: contract ? { serial: contract.serial } : null,
    buyer: {
      name: customer?.full_name ?? lead?.client_name ?? "",
      nationalId: customer?.national_id ?? lead?.national_id ?? null,
      address: null,
    },
    issuer,
    activityCode: getEtaActivityCode(),
  };

  return { ok: true, context: { ticket, vehicle, contract, buildInput, contextWarnings } };
}

// ── Preview ─────────────────────────────────────────────────

export interface EtaPreview {
  mode: EtaMode;
  /** Null when the document could not be built — `blockers` says why. */
  summary: EtaDocumentSummary | null;
  blockers: EtaBlocker[];
  warnings: EtaWarning[];
  /** True when a live (queued/submitted/accepted) submission already exists. */
  alreadySubmitted: boolean;
}

/**
 * What the confirmation dialog shows before anything is sent.
 *
 * `issuedAt` is pinned to the start of the current minute so the preview
 * a person is reading does not change under them between renders. The
 * document actually submitted is rebuilt with the real instant — the
 * preview is a statement about the totals, the buyer and the item code,
 * and every one of those is stable.
 */
export async function previewEtaSubmission(ticketId: string): Promise<EtaPreview | ActionError> {
  const loaded = await loadEtaContext(ticketId);
  if (!loaded.ok) return loaded.error;

  const now = new Date();
  now.setUTCSeconds(0, 0);

  const built = buildEtaDocument({ ...loaded.context.buildInput, issuedAt: now });
  const submissions = await listEtaSubmissions(ticketId);
  const alreadySubmitted =
    Array.isArray(submissions) &&
    submissions.some((s) => s.status === "queued" || s.status === "submitted" || s.status === "accepted");

  return {
    mode: getEtaMode(),
    summary: built.ok ? built.summary : null,
    blockers: built.ok ? [] : built.blockers,
    warnings: [...loaded.context.contextWarnings, ...built.warnings],
    alreadySubmitted,
  };
}

/** The audit trail for one ticket, newest first. */
export async function listEtaSubmissions(ticketId: string): Promise<EtaSubmission[] | ActionError> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("eta_submissions")
    .select(
      "id, contract_id, deal_ticket_id, status, mode, eta_submission_id, eta_uuid, eta_long_id, error_detail, warnings, attempt, created_by, created_at, updated_at"
    )
    .eq("deal_ticket_id", ticketId)
    .order("created_at", { ascending: false });

  // A deployment that has not applied 0034 yet has no such table. The
  // panel's manual-transcription half must keep working there, so an
  // unknown relation reads as "no submissions" rather than as an error
  // across the whole page.
  if (error) return relationMissing(error) ? [] : toUserError(error, "eta submissions");
  return (data as EtaSubmission[] | null) ?? [];
}

function relationMissing(error: { code?: string; message: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /does not exist|could not find the table/i.test(error.message)
  );
}

// ── Submission ──────────────────────────────────────────────

export interface EtaSubmitOutcome {
  ok: true;
  status: EtaSubmissionRowStatus;
  submissionRowId: string | null;
  etaUuid: string | null;
  etaLongId: string | null;
  warnings: EtaWarning[];
  /** Present when the authority (or the sandbox) refused the document. */
  rejection: EtaError | null;
}

export type EtaSubmitResult = EtaSubmitOutcome | { ok: false; blockers: EtaBlocker[]; warnings: EtaWarning[] } | ActionError;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one submission attempt for a deal ticket.
 *
 * The caller has already been authorized (eta-actions.ts) and RLS
 * authorizes again. What this owns is the sequence and the record of it.
 */
export async function submitTicketToEta(
  ticketId: string,
  actorId: string
): Promise<EtaSubmitResult> {
  const loaded = await loadEtaContext(ticketId);
  if (!loaded.ok) return loaded.error;

  const { contract, contextWarnings, buildInput } = loaded.context;

  const built = buildEtaDocument({ ...buildInput, issuedAt: new Date() });
  if (!built.ok) {
    return { ok: false, blockers: built.blockers, warnings: [...contextWarnings, ...built.warnings] };
  }
  if (!contract) {
    // Unreachable — buildEtaDocument blocks on a missing contract — but
    // the narrowing has to be stated for the insert below.
    return { ok: false, blockers: [{ code: "missingContract" }], warnings: contextWarnings };
  }

  const warnings = [...contextWarnings, ...built.warnings];
  const warningCodes = warnings.map((w) => w.code);
  const mode = getEtaMode();
  const supabase = await createClient();

  // The attempt number. Counted rather than incremented so a row
  // inserted by a concurrent attempt is visible in it; the unique index
  // is what actually prevents the concurrent attempt, and this is only
  // the label on the audit trail.
  const { count } = await supabase
    .from("eta_submissions")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contract.id);

  const { data: inserted, error: insertError } = await supabase
    .from("eta_submissions")
    .insert({
      contract_id: contract.id,
      deal_ticket_id: ticketId,
      status: "queued",
      mode,
      request_payload: built.document as unknown as Record<string, unknown>,
      warnings: warningCodes,
      attempt: (count ?? 0) + 1,
      created_by: actorId,
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    if (insertError.code === "23505") {
      return {
        error:
          "This sale already has a submission in progress or accepted. A new one is only allowed after a rejection or a failure.",
      };
    }
    if (relationMissing(insertError)) {
      return {
        error:
          "The ETA submission log is not installed on this database (migration 0034). Record the identifiers manually instead.",
      };
    }
    return toUserError(insertError, "eta submission insert");
  }

  const rowId = (inserted as { id: string } | null)?.id ?? null;

  const fail = async (message: string): Promise<ActionError> => {
    if (rowId) {
      await supabase
        .from("eta_submissions")
        .update({ status: "failed", error_detail: message.slice(0, 2000) })
        .eq("id", rowId);
      revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");
    }
    return { error: message };
  };

  // Pre-flight against the same rules the authority applies. A failure
  // here means the builder produced something incoherent, which is a bug
  // rather than a data problem — recorded as `failed`, not `rejected`,
  // because nothing was ever sent.
  const preflight = validateEtaDocument(built.document);
  if (preflight) {
    return fail(
      `The document failed local validation before sending: ${(preflight.details ?? [])
        .map((d) => d.message)
        .join(" ")}`
    );
  }

  let signed;
  try {
    signed = await signDocument(built.document);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Signing failed.");
  }

  const client = createEtaClient(mode);
  let submissionId: string;
  let accepted;
  let rejected;
  try {
    const response = await client.submitDocuments([signed]);
    submissionId = response.submissionId;
    accepted = response.acceptedDocuments[0] ?? null;
    rejected = response.rejectedDocuments[0] ?? null;
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The ETA submission failed.");
  }

  if (rowId) {
    await supabase
      .from("eta_submissions")
      .update({ status: "submitted", eta_submission_id: submissionId })
      .eq("id", rowId);
  }

  // Refused at intake — the authority answered, so this is `rejected`
  // and a re-submission is allowed once the underlying data is fixed.
  if (rejected) {
    return settle(supabase, {
      rowId,
      ticketId,
      contractId: contract.id,
      status: "rejected",
      responsePayload: rejected as unknown as Record<string, unknown>,
      error: rejected.error,
      warnings,
    });
  }

  if (!accepted) {
    return fail("The ETA responded without accepting or rejecting the document.");
  }

  // Settlement. ETA accepts for PROCESSING first and issues the verdict
  // after, so an accepted-at-intake document is not yet a filed one.
  const budget = getEtaPollBudgetMs();
  const deadline = Date.now() + budget;
  let verdict: EtaSubmissionDocumentSummary | null = null;
  let delay = 250;
  for (;;) {
    try {
      const submission = await client.getSubmission(submissionId);
      const doc =
        submission.documents.find((d) => d.uuid === accepted.uuid) ??
        submission.documents.find((d) => d.internalId === accepted.internalId) ??
        null;
      if (doc && doc.status !== "Submitted") {
        verdict = doc;
        break;
      }
    } catch {
      // A polling failure is not a submission failure: the document is
      // with the authority either way. Fall through to "submitted".
      break;
    }
    if (Date.now() + delay >= deadline) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  if (!verdict) {
    // Legitimate terminal state for ONE request. The row says
    // `submitted` with the submission id on it, and the panel says the
    // authority has not answered yet.
    return {
      ok: true,
      status: "submitted",
      submissionRowId: rowId,
      etaUuid: accepted.uuid,
      etaLongId: accepted.longId,
      warnings,
      rejection: null,
    };
  }

  if (verdict.status === "Valid") {
    return settle(supabase, {
      rowId,
      ticketId,
      contractId: contract.id,
      status: "accepted",
      responsePayload: verdict as unknown as Record<string, unknown>,
      error: null,
      warnings,
      etaUuid: verdict.uuid,
      etaLongId: verdict.longId ?? accepted.longId,
    });
  }

  return settle(supabase, {
    rowId,
    ticketId,
    contractId: contract.id,
    status: "rejected",
    responsePayload: verdict as unknown as Record<string, unknown>,
    error: verdict.error,
    warnings,
  });
}

/**
 * Write the verdict onto the submission row AND, on acceptance, onto
 * 0024's columns on `contracts`.
 *
 * Both, through the same session, because the existing manual panel and
 * the printed contract's footer (`printDoc.etaFooter`) read the contract
 * columns and would otherwise go on saying "not submitted" about a sale
 * this system filed itself.
 */
async function settle(
  supabase: Awaited<ReturnType<typeof createClient>>,
  args: {
    rowId: string | null;
    ticketId: string;
    contractId: string;
    status: EtaSubmissionRowStatus;
    responsePayload: Record<string, unknown>;
    error: EtaError | null;
    warnings: EtaWarning[];
    etaUuid?: string;
    etaLongId?: string | null;
  }
): Promise<EtaSubmitOutcome> {
  const errorDetail = args.error
    ? [args.error.message, ...(args.error.details ?? []).map((d) => `${d.propertyPath ?? d.target ?? ""}: ${d.message}`)]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000)
    : null;

  if (args.rowId) {
    await supabase
      .from("eta_submissions")
      .update({
        status: args.status,
        response_payload: args.responsePayload,
        error_detail: errorDetail,
        eta_uuid: args.etaUuid ?? null,
        eta_long_id: args.etaLongId ?? null,
      })
      .eq("id", args.rowId);
  }

  await supabase
    .from("contracts")
    .update(
      args.status === "accepted"
        ? {
            eta_uuid: args.etaUuid ?? null,
            eta_long_id: args.etaLongId ?? null,
            eta_submission_status: "accepted",
            eta_submitted_at: new Date().toISOString(),
          }
        : { eta_submission_status: "rejected" }
    )
    .eq("id", args.contractId);

  revalidatePath("/[locale]/(app)/deals/[ticketId]", "page");

  return {
    ok: true,
    status: args.status,
    submissionRowId: args.rowId,
    etaUuid: args.etaUuid ?? null,
    etaLongId: args.etaLongId ?? null,
    warnings: args.warnings,
    rejection: args.error,
  };
}
