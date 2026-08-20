import { z } from "zod";

// Every Server Action is a public HTTP endpoint: any authenticated user can
// invoke any exported action with hand-crafted arguments, whatever the UI
// renders. These schemas are the server-side contract — parse first, then
// authorize, then touch the database.

// ── Primitives ──────────────────────────────────────────────

export const Uuid = z.uuid();

/** Trimmed, non-empty, length-capped free text. */
const text = (max: number) => z.string().trim().min(1).max(max);

/** Trimmed optional text — "" and undefined both collapse to null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

/**
 * Money coming off a form. Rejects NaN/Infinity (which `parseFloat("")` and
 * `parseFloat("abc")` happily produce and Postgres would then reject far from
 * the call site), and caps the magnitude so a typo can't poison the waterfall.
 */
const money = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000_000)
  .refine((n) => Number.isFinite(n), { message: "Amount must be a number" });

const positiveMoney = money.refine((n) => n > 0, {
  message: "Amount must be greater than zero",
});

/** Money typed into a text input — "" becomes null rather than NaN. */
const optionalMoneyString = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v) => (v ? Number(v) : null))
  .refine((n) => n === null || (Number.isFinite(n) && n >= 0), {
    message: "Must be a non-negative number",
  });

const percentage = z.number().finite().min(0).max(100);

// Egyptian national ID: a non-empty value must be exactly the 14 digits
// the DB CHECKs demand (profiles_national_id_check in 0018,
// leads_national_id_check in 0020), so the user gets a readable message
// instead of a raw constraint violation. Shared by the staff statutory
// fields and the lead identity fields.
const nationalId = z
  .string()
  .trim()
  .regex(/^[0-9]{14}$/, { message: "National ID must be exactly 14 digits" });

// Loose on purpose: this system is deployed for Arabic- and English-speaking
// markets, so no country-specific format is assumed. We only guarantee the
// value is dialable and bounded.
const phone = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .regex(/^[+()\d\s-]+$/, { message: "Phone number contains invalid characters" });

// ── Vehicles & equity ───────────────────────────────────────

// 17 chars, excluding I/O/Q which the VIN standard omits to avoid confusion
// with 1/0. Blank is allowed — plenty of stock arrives before paperwork does.
export const VinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/, { message: "VIN must be 17 characters (no I, O or Q)" });

export const EquitySplitSchema = z
  .object({
    holder_type: z.enum(["ceo", "investor"]),
    holder_id: Uuid.nullable(),
    amount_invested: money,
    percentage,
  })
  // Mirrors the holder_id_matches_type constraint in 0001_init.sql, so the
  // user gets a readable error instead of a raw Postgres violation.
  .refine((s) => (s.holder_type === "ceo" ? s.holder_id === null : s.holder_id !== null), {
    message: "An investor split must name an investor; a CEO split must not",
    path: ["holder_id"],
  });

export const CreateVehicleSchema = z.object({
  branch_id: Uuid,
  vin: z.union([VinSchema, z.literal("")]).transform((v) => v || ""),
  year: z.number().int().min(1950).max(new Date().getFullYear() + 2),
  make: text(60),
  model: text(60),
  trim: z.string().trim().max(60),
  // Free text, not an enum: the picker offers the common colours but a
  // showroom must still be able to record "Nardo Grey" on intake.
  color: z.string().trim().max(40),
  // Modifications are the whole point of this field — aftermarket rims, a
  // spoiler, body work. It feeds the contract and the sale listing, so it is
  // roomy but still bounded.
  description: z.string().trim().max(2000),
  // Intake condition report. Separate from `photos`, which is the sale
  // gallery: an inspection set is evidence of what the car looked like on
  // the day it was taken in, and mixing the two loses that.
  inspection_photos: z.array(z.url().max(2048)).max(100),
  // Mechanical identifiers for the traffic-authority ownership transfer
  // (migration 0021). Free text, blank allowed: formats vary by
  // manufacturer/era, and used stock sometimes arrives with neither
  // legible. The RPC collapses "" to NULL.
  engine_number: z.string().trim().max(60),
  plate_number: z.string().trim().max(20),
  // CPA Decision 115/2021 windshield-sticker fields (migration 0025).
  // Origin is free text, blank allowed — grey-import paperwork names it
  // inconsistently, and the RPC collapses "" to NULL. Features are the
  // structured amenities list: trimmed, de-duplicated, empties dropped
  // (the notePoints treatment), because the last editor row legitimately
  // sits blank waiting to be typed into.
  country_of_origin: z.string().trim().max(60),
  features: z
    .array(z.string())
    .max(50)
    .transform((rows) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const row of rows) {
        const feature = row.trim().slice(0, 120);
        if (!feature || seen.has(feature)) continue;
        seen.add(feature);
        out.push(feature);
      }
      return out;
    }),
  // ETA e-invoicing product code (migration 0026) — EGS
  // (EG-{tax reg}-{internal code}) or GS1. Free text, blank allowed:
  // stock is taken in before the class is registered on the portal, and
  // the RPC collapses "" to NULL.
  item_code: z.string().trim().max(60),
  purchase_price: positiveMoney,
  // The sticker price and the negotiation floor (0028). Both nullable —
  // stock is often taken in before management prices it. Written by a
  // follow-up UPDATE under the column-limited grant, not by the RPC.
  asking_price: positiveMoney.nullable(),
  min_price: positiveMoney.nullable(),
  photos: z.array(z.url().max(2048)).max(24),
  splits: z
    .array(EquitySplitSchema)
    .min(1)
    .max(20)
    // The DB trigger only rejects >100. Requiring exactly 100 here is what
    // stops profit being silently stranded at sale time.
    .refine((rows) => Math.abs(rows.reduce((s, r) => s + r.percentage, 0) - 100) < 0.01, {
      message: "Equity splits must sum to exactly 100%",
    })
    .refine(
      (rows) => {
        const investors = rows.filter((r) => r.holder_type === "investor").map((r) => r.holder_id);
        return new Set(investors).size === investors.length;
      },
      { message: "The same investor cannot hold two splits on one vehicle" }
    ),
}).refine((v) => v.asking_price === null || v.min_price === null || v.min_price <= v.asking_price, {
  message: "The lowest offer cannot exceed the sticker price",
  path: ["min_price"],
});

// Re-pricing an existing vehicle — the one direct write the tenant role
// holds on vehicles (0028's column-limited grant). Mirrors the DB CHECK.
export const SetVehiclePricesSchema = z
  .object({
    vehicle_id: Uuid,
    asking_price: positiveMoney.nullable(),
    min_price: positiveMoney.nullable(),
  })
  .refine((v) => v.asking_price === null || v.min_price === null || v.min_price <= v.asking_price, {
    message: "The lowest offer cannot exceed the sticker price",
    path: ["min_price"],
  });

// ── Channel listings (0029) ─────────────────────────────────

export const LISTING_CHANNELS = ["dubizzle", "facebook", "instagram", "tiktok", "website", "other"] as const;
export const LISTING_STATUSES = ["draft", "posted", "needs_update", "removed"] as const;

export const UpsertListingSchema = z.object({
  vehicle_id: Uuid,
  channel: z.enum(LISTING_CHANNELS),
  status: z.enum(LISTING_STATUSES),
  // "" clears the link — a draft has none yet.
  url: z.union([z.url().max(2048), z.literal("")]).transform((v) => v || null),
  note: optionalText(500),
});

export const AddExpenseSchema = z
  .object({
    vehicle_id: Uuid,
    category: text(60),
    amount: positiveMoney,
    note: optionalText(500),
    // Input VAT (0022) — recorded when the expense carries an e-invoice,
    // which is what makes it deductible on Form 10. All optional: plenty
    // of forecourt expenses have no VAT invoice at all.
    vat_amount: money.nullable(),
    supplier_tax_id: optionalText(50),
    supplier_invoice_no: optionalText(100),
    // Deliberately absent: is_ceo_override. That flag permanently locks a row
    // from non-CEO edits, so it is derived from the caller's role on the server
    // and never accepted from the client.
  })
  // 14% of any base — inclusive or exclusive — is always below the gross,
  // so VAT at or above the expense amount is a mistyped field, not a rate.
  .refine((e) => e.vat_amount === null || e.vat_amount <= e.amount, {
    message: "VAT cannot exceed the expense amount",
    path: ["vat_amount"],
  });

// ── CRM ─────────────────────────────────────────────────────

/**
 * The bullets under a client's note.
 *
 * Blank rows are dropped rather than rejected: the editor renders an
 * empty input for the next point, so a form submitted with one unfilled
 * row is the normal case, not a mistake worth a red banner. What is left
 * is trimmed, deduplicated and capped — twenty requirements is already
 * past the point where a salesperson reads them before a call, and the
 * array is stored inline on the lead.
 */
const notePoints = z
  .array(z.string())
  .max(50)
  .optional()
  .nullable()
  .transform((rows) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows ?? []) {
      const point = row.trim().slice(0, 300);
      if (!point || seen.has(point)) continue;
      seen.add(point);
      out.push(point);
    }
    return out;
  })
  .refine((rows) => rows.length <= 20, {
    message: "A client can carry at most 20 note points",
  });

const LeadFieldsSchema = z.object({
  client_name: text(120),
  phone_number: phone,
  car_interest: optionalText(120),
  address: optionalText(240),
  company_name: optionalText(120),
  job_title: optionalText(120),
  income: optionalMoneyString,
  client_notes: optionalText(2000),
  client_note_points: notePoints,
  // Buyer identity for the sale paperwork (migration 0020): the
  // e-invoice at or above EGP 25,000, the ownership transfer and AML due
  // diligence. Both optional — a lead is worth recording long before the
  // ID is in hand — and deliberately absent from PublicLeadSchema below:
  // an unauthenticated referral page must never ask strangers for their
  // government ID. Staff record it when the person is actually buying.
  national_id: z.union([nationalId, z.literal("")]).transform((v) => v || null),
  nationality: optionalText(60),
});

export const CreateLeadSchema = LeadFieldsSchema;

/**
 * Correcting a client's details after the fact.
 *
 * The same fields as creation plus the id, and deliberately NOT
 * `status`, `branch_id`, `salesperson_id` or `source`. Those three are
 * ownership and pipeline state — status is moved by creating a deal
 * ticket, and reassigning a lead to another branch or salesperson is a
 * different act with different consequences than fixing a phone number.
 * Folding them into the contact form would let one accidental submit
 * move a lead out of the branch that is working it.
 *
 * `contact_time_preference` IS here: it arrives on referral leads from
 * the public form and is a contact detail in the plainest sense — when
 * this person can actually be reached.
 */
export const UpdateLeadSchema = LeadFieldsSchema.extend({
  id: Uuid,
  contact_time_preference: optionalText(120),
});

export const PublicLeadSchema = z.object({
  client_name: text(120),
  phone_number: phone,
  car_interest: optionalText(120),
  contact_time_preference: optionalText(120),
  client_notes: optionalText(1000),
});

/**
 * The "existing customer — will be linked" probe behind the Add Lead
 * dialog (migration 0031).
 *
 * Deliberately the loosest schema in this file, and for a reason the
 * others do not share: it runs while somebody is still typing. A
 * half-entered national ID has to come back "no match", not a validation
 * error thrown at a field nobody has finished with — so both inputs are
 * bounded and character-classed, then quietly TRANSFORMED to null when
 * they are not yet a usable key. The action reads null as "do not look
 * anything up", which is the same answer as "found nobody".
 *
 * Bounded and character-classed all the same: this is still a public
 * endpoint that reads the customer book, and it must not be drivable by
 * arbitrary text or by a 4KB string.
 */
export const CustomerLookupSchema = z.object({
  national_id: z
    .string()
    .trim()
    .max(32)
    .optional()
    .nullable()
    .transform((v) => (v && /^[0-9]{14}$/.test(v) ? v : null)),
  phone_number: z
    .string()
    .trim()
    .max(32)
    .regex(/^[+()\d\s-]*$/, { message: "Phone number contains invalid characters" })
    .optional()
    .nullable()
    .transform((v) => (v && v.length >= 6 ? v : null)),
});

export const LeadCommentSchema = z.object({
  lead_id: Uuid,
  body: text(2000),
  contact_method: z.enum(["phone", "whatsapp", "in_person", "email"]).nullable(),
});

// ── Lead ↔ vehicle interest ─────────────────────────────────

/**
 * Links a buyer to a car and records what they will pay for it.
 *
 * `vehicle_id` and the `wanted_*` fields are alternatives, not a pair: the
 * buyer either wants something on the floor or something the showroom does
 * not have. The refine below mirrors migration 0016's
 * `lead_vehicle_interests_names_a_car` CHECK, so a row that names no car at
 * all is refused here with a sentence rather than as a constraint violation.
 *
 * `budget_amount` is nullable on purpose and `optionalMoneyString` keeps it
 * that way: a lead who will not name a number is still worth recording, and
 * a zero invented to satisfy the form would sit in the CEO's demand report
 * looking like an offer.
 */
export const CreateLeadInterestSchema = z
  .object({
    lead_id: Uuid,
    vehicle_id: z.union([Uuid, z.literal("")]).transform((v) => v || null),
    wanted_make: optionalText(60),
    wanted_model: optionalText(60),
    wanted_year: z
      .string()
      .trim()
      .optional()
      .nullable()
      .transform((v) => (v ? Number(v) : null))
      .refine(
        (n) => n === null || (Number.isInteger(n) && n >= 1950 && n <= new Date().getFullYear() + 2),
        { message: "Year must be between 1950 and next year" }
      ),
    budget_amount: optionalMoneyString.refine((n) => n === null || n > 0, {
      message: "A budget must be greater than zero",
    }),
    origin: z.enum(["requested", "suggested"]),
    note: optionalText(500),
  })
  .refine((i) => i.vehicle_id !== null || i.wanted_make !== null, {
    message: "Pick a car from stock, or say which make the buyer is asking for",
    path: ["wanted_make"],
  });

/**
 * Status on its own, for the inline control on each interest row.
 *
 * Kept separate from the full edit below: this is a one-click move that
 * must not require the caller to resend the whole row, and a payload
 * that carried the other fields could silently blank them on a partial
 * client update.
 */
export const UpdateLeadInterestStatusSchema = z.object({
  id: Uuid,
  status: z.enum(["open", "shown", "declined"]),
});

/**
 * Revising what a buyer wants.
 *
 * Originally only `status` was editable, on the reasoning that an
 * interest records a conversation and a conversation is corrected by a
 * new row. That holds for `origin` — who raised the car is a fact about
 * an event — but not for the rest: a buyer raises their budget, the
 * salesperson finds they meant the Sport trim rather than the base, or a
 * car the showroom did not have arrives on the floor and the row should
 * point at the actual vehicle instead of free text. Forcing a new row
 * for those double-counts the buyer in the CEO's demand report, which is
 * the one number this table exists to get right.
 *
 * `lead_id` is absent on purpose and its absence is load-bearing: the
 * table's UPDATE policy carries a WITH CHECK precisely to stop a visible
 * row being re-pointed at another salesperson's lead, and an action that
 * accepted the column would be inviting the attempt.
 *
 * Same car-or-wanted refinement as creation, mirroring the
 * `lead_vehicle_interests_names_a_car` CHECK.
 */
export const UpdateLeadInterestSchema = z
  .object({
    id: Uuid,
    vehicle_id: z.union([Uuid, z.literal("")]).transform((v) => v || null),
    wanted_make: optionalText(60),
    wanted_model: optionalText(60),
    wanted_year: z
      .string()
      .trim()
      .optional()
      .nullable()
      .transform((v) => (v ? Number(v) : null))
      .refine(
        (n) => n === null || (Number.isInteger(n) && n >= 1950 && n <= new Date().getFullYear() + 2),
        { message: "Year must be between 1950 and next year" }
      ),
    budget_amount: optionalMoneyString.refine((n) => n === null || n > 0, {
      message: "A budget must be greater than zero",
    }),
    origin: z.enum(["requested", "suggested"]),
    status: z.enum(["open", "shown", "declined"]),
    note: optionalText(500),
  })
  .refine((i) => i.vehicle_id !== null || i.wanted_make !== null, {
    message: "Pick a car from stock, or say which make the buyer is asking for",
    path: ["wanted_make"],
  });

// ── Deal tickets ────────────────────────────────────────────

export const CreateDealTicketSchema = z
  .object({
    lead_id: Uuid.nullable(),
    vehicle_id: Uuid,
    agreed_price: positiveMoney,
    financing_type: z.enum(["cash", "installments"]),
    financing_partner_id: Uuid.nullable(),
    down_payment: money.nullable(),
    discount_amount: money,
    // VAT on the sale (0022). The rate travels per ticket — schedule-tax
    // vehicles differ from the 14% standard — and price_includes_vat says
    // whether agreed_price already carries it. All nullable so a ticket
    // can be raised before the VAT treatment is settled.
    vat_rate: percentage.nullable(),
    vat_amount: money.nullable(),
    price_includes_vat: z.boolean().nullable(),
    // Settlement channel (0023). Egyptian payment rules push car sales
    // through bank channels; the ticket records the channel actually used
    // plus the reference and receiving bank. All nullable — a ticket can
    // be raised before settlement, and 'cash' is recorded rather than
    // forbidden (legacy/edge cases are the owner's compliance call).
    settlement_method: z.enum(["bank_transfer", "cheque", "instapay", "cash"]).nullable(),
    settlement_reference: optionalText(120),
    settlement_bank: optionalText(120),
  })
  .refine((t) => t.financing_type === "cash" || t.financing_partner_id !== null, {
    message: "Installment deals require a financing partner",
    path: ["financing_partner_id"],
  })
  .refine((t) => t.discount_amount <= t.agreed_price, {
    message: "Discount cannot exceed the agreed price",
    path: ["discount_amount"],
  })
  .refine((t) => t.down_payment === null || t.down_payment <= t.agreed_price, {
    message: "Down payment cannot exceed the agreed price",
    path: ["down_payment"],
  });

export const ChecklistSchema = z
  .object({
    financial_check_passed: z.boolean().optional(),
    discount_validated: z.boolean().optional(),
    rate_revalidated: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, { message: "Nothing to update" });

export const RejectTicketSchema = z.object({
  ticketId: Uuid,
  // A rejection is a permanent record on the ticket's audit trail — make the
  // reviewer actually say something.
  reason: text(1000),
});

/**
 * Recording the ETA portal's identifiers on a contract (migration 0024).
 *
 * The eta_uuid is NOT an RFC uuid — the portal issues a 26-character
 * base-36-looking code, and its exact shape has varied across portal
 * versions — so it is bounded free text, not `Uuid`. Everything except
 * the ticket id is optional: the showroom transcribes what the portal
 * shows, which right after submission is a UUID and a 'submitted'
 * status with no long ID yet. Requiring the full set would force
 * inventing values. The one refinement: recording a submission with no
 * identifier and no status at all is a no-op worth refusing.
 */
export const RecordEtaInvoiceSchema = z
  .object({
    ticketId: Uuid,
    eta_uuid: optionalText(64),
    eta_long_id: optionalText(100),
    eta_submission_status: z
      .union([z.enum(["pending", "submitted", "accepted", "rejected"]), z.literal("")])
      .nullable()
      .transform((v) => v || null),
    // Off a `date` input; "" collapses to null. Bounded like `instant`
    // so a mistyped year cannot park the submission in 1970.
    eta_submitted_at: z
      .string()
      .trim()
      .optional()
      .nullable()
      .transform((v) => (v ? v : null))
      .refine((s) => s === null || !Number.isNaN(Date.parse(s)), {
        message: "Not a valid date",
      })
      .transform((s) => (s === null ? null : new Date(s).toISOString()))
      .refine(
        (iso) => {
          if (iso === null) return true;
          const year = new Date(iso).getUTCFullYear();
          return year >= 2000 && year <= 2100;
        },
        { message: "Date must be between 2000 and 2100" }
      ),
  })
  .refine(
    (e) => e.eta_uuid !== null || e.eta_long_id !== null || e.eta_submission_status !== null,
    { message: "Record at least the ETA UUID, long ID or a status" }
  );

/**
 * Submitting the e-invoice through the ETA API (migration 0034).
 *
 * Only the ticket: every number on the document is derived server-side
 * from rows the client cannot influence. That is the whole security
 * argument for this action — there is no payload to tamper with, so a
 * hand-crafted POST can at most file the same invoice the UI would have.
 */
export const SubmitEtaInvoiceSchema = z.object({ ticketId: Uuid });

// ── Calendar ────────────────────────────────────────────────

/**
 * An instant off a `datetime-local` input, which submits wall-clock text
 * with no zone. The client converts to an ISO string before it reaches
 * here; this only guarantees the server can parse it, and bounds it so a
 * mistyped year cannot park a meeting in 1970 or 4000.
 */
const instant = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Not a valid date and time" })
  .transform((s) => new Date(s).toISOString())
  .refine(
    (iso) => {
      const year = new Date(iso).getUTCFullYear();
      return year >= 2000 && year <= 2100;
    },
    { message: "Date must be between 2000 and 2100" }
  );

/**
 * Mirrors the checks inside `create_meeting()` so the form can say what
 * is wrong inline. The RPC re-checks all of it — this is the friendly
 * copy, not the enforcement.
 */
export const CreateMeetingSchema = z
  .object({
    title: text(120),
    agenda: optionalText(2000),
    location: optionalText(160),
    starts_at: instant,
    ends_at: instant,
    // Ignored for a branch manager: create_meeting() overwrites it with
    // their own branch rather than trusting the client.
    branch_id: Uuid.nullable(),
    invitee_ids: z
      .array(Uuid)
      .min(1, { message: "Invite at least one person" })
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "The same person cannot be invited twice",
      }),
  })
  .refine((m) => Date.parse(m.ends_at) > Date.parse(m.starts_at), {
    message: "A meeting must end after it starts",
    path: ["ends_at"],
  })
  .refine(
    (m) => Date.parse(m.ends_at) - Date.parse(m.starts_at) <= 12 * 60 * 60 * 1000,
    { message: "A meeting may not run longer than 12 hours", path: ["ends_at"] }
  );

export const MeetingResponseSchema = z.object({
  meeting_id: Uuid,
  response: z.enum(["accepted", "declined"]),
});

export const CancelMeetingSchema = z.object({ meeting_id: Uuid });

/** `?month=YYYY-MM`, falling back to the current month if absent or junk. */
export const CalendarMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .optional()
  .catch(undefined);

// ── Financing & overhead ────────────────────────────────────

export const CreateFinancingPartnerSchema = z.object({
  bank_name: text(120),
  product_name: text(120),
  rate: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || (Number.isFinite(n) && n >= 0 && n <= 100), {
      message: "Rate must be between 0 and 100",
    }),
  term_months: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || (Number.isInteger(n) && n > 0 && n <= 480), {
      message: "Term must be a whole number of months (max 480)",
    }),
  min_down_payment: optionalMoneyString,
  contract_file_url: z.url().max(2048).nullable(),
});

export const FinancingRequestStatusSchema = z.object({
  requestId: Uuid,
  status: z.enum(["submitted", "in_review", "approved_by_bank", "rejected_by_bank"]),
});

export const OverheadSchema = z.object({
  branchId: Uuid,
  monthlyOpex: money,
});

// ── Uploads ─────────────────────────────────────────────────

export const UPLOAD_FOLDERS = [
  "vehicles",
  "financing-contracts",
  "avatars",
  "financing-requests",
] as const;

export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/** 15 MB — comfortably above a phone photo, well below a Worker's patience. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const PresignSchema = z.object({
  // Only the basename is ever used, but reject traversal outright rather than
  // relying on the caller to strip it — the value ends up in an object key.
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((n) => !n.includes("/") && !n.includes("\\") && !n.includes(".."), {
      message: "File name must not contain path separators",
    }),
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  folder: z.enum(UPLOAD_FOLDERS),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

// ── Administration ──────────────────────────────────────────

export const ROLES = ["ceo", "accountant", "branch_manager", "sales_exec", "investor", "marketing"] as const;

// Statutory employee data for Egypt's monthly NOSI filing (migration
// 0018). Everything optional — an account is often created before the
// HR paperwork lands. `nationalId` lives with the primitives.
const StaffStatutoryFields = {
  national_id: z.union([nationalId, z.literal("")]).transform((v) => v || null),
  social_insurance_number: optionalText(64),
  hire_date: z.union([z.iso.date(), z.literal("")]).transform((v) => v || null),
  // The statutory wage basis for NOSI contributions, typed into a text
  // input — distinct from ad-hoc ledger payouts.
  monthly_wage: optionalMoneyString,
  employment_type: z
    .union([z.enum(["full_time", "part_time"]), z.literal("")])
    .nullable()
    .transform((v) => v || null),
} as const;

export const CreateStaffSchema = z
  .object({
    email: z.email().max(254),
    full_name: text(120),
    role: z.enum(ROLES),
    branch_id: Uuid.nullable(),
    phone: z.union([phone, z.literal("")]).transform((v) => v || null),
    ...StaffStatutoryFields,
  })
  // A CEO, an investor and marketing are org-wide; everyone else works
  // out of a branch (marketing lists the whole showroom's stock — 0029).
  .refine((s) => s.role === "ceo" || s.role === "investor" || s.role === "marketing" || s.branch_id !== null, {
    message: "Branch staff must be assigned to a branch",
    path: ["branch_id"],
  });

export const UpdateStaffSchema = z.object({
  id: Uuid,
  full_name: text(120),
  role: z.enum(ROLES),
  branch_id: Uuid.nullable(),
  phone: z.union([phone, z.literal("")]).transform((v) => v || null),
  ...StaffStatutoryFields,
});

// ── Employee targets & profile (0027) ───────────────────────

export const TARGET_METRICS = ["calls", "new_leads", "deals_closed"] as const;

export const SetTargetSchema = z.object({
  profile_id: Uuid,
  metric: z.enum(TARGET_METRICS),
  // Matches the DB CHECK (target_value > 0). There is no "clear a
  // target" path on purpose: the tenant role holds no DELETE grant, and
  // a target that was a mistake is overwritten, audited, not erased.
  target_value: z.number().int().min(1).max(100_000),
  // First day of the month, matching the DB CHECK — one spelling per month.
  period_month: z.iso.date().refine((d) => d.endsWith("-01"), {
    message: "Target month must be the first day of the month",
  }),
});

export const UpdateAvatarSchema = z.object({
  profile_id: Uuid,
  // "" clears the photo. A non-empty value is re-checked against
  // isManagedUploadUrl in the action — the schema only bounds it.
  avatar_url: z
    .union([z.url().max(500), z.literal("")])
    .transform((v) => v || null),
});

export const BranchSchema = z.object({
  name: text(120),
  address: optionalText(240),
});

/**
 * Granting or revoking one branch of extra authority (migration 0030).
 * The note is where the CEO records WHY — "covers Heliopolis while Tarek
 * is on leave" — so the authority list stays readable months later.
 */
export const BranchGrantSchema = z.object({
  profile_id: Uuid,
  branch_id: Uuid,
  note: optionalText(240),
});

/** Revoking names the same pair; the row is found by it, not by its id. */
export const BranchGrantRevokeSchema = z.object({
  profile_id: Uuid,
  branch_id: Uuid,
});

export const LedgerEntrySchema = z
  .object({
    holder_type: z.enum(["ceo", "investor", "sales_exec"]),
    holder_id: Uuid.nullable(),
    // sale_profit_share is omitted on purpose: those rows are minted only by
    // the security-definer execute_vehicle_sale(), never by hand.
    type: z.enum(["deposit", "withdrawal", "commission", "salary", "opex_offset"]),
    amount: z.number().finite().max(1_000_000_000).min(-1_000_000_000),
    note: optionalText(500),
  })
  .refine((e) => e.holder_type === "ceo" || e.holder_id !== null, {
    message: "A non-CEO ledger entry must name its holder",
    path: ["holder_id"],
  })
  .refine((e) => e.amount !== 0, { message: "Amount cannot be zero" })
  .refine((e) => (e.type === "withdrawal" ? e.amount < 0 : true), {
    message: "A withdrawal must be negative",
    path: ["amount"],
  })
  .refine((e) => (e.type === "deposit" ? e.amount > 0 : true), {
    message: "A deposit must be positive",
    path: ["amount"],
  });

export const CommissionTiersSchema = z.object({
  tiers: z
    .array(
      z.object({
        tier_index: z.number().int().min(1).max(10),
        cumulative_amount: money,
      })
    )
    .min(1)
    .max(10)
    // Tiers are cumulative thresholds; a non-increasing ladder would make
    // "which tier am I on" ambiguous.
    .refine(
      (rows) => {
        const sorted = [...rows].sort((a, b) => a.tier_index - b.tier_index);
        return sorted.every((r, i) => i === 0 || r.cumulative_amount > sorted[i - 1].cumulative_amount);
      },
      { message: "Each tier must be strictly greater than the one below it" }
    ),
});

// ── Account (notification contacts & password) ──────────────

/**
 * "" collapses to null (opt out of that channel); anything else must
 * look like an address the 508.world router Worker could actually send
 * to. Mirrors the CHECK constraints in migration 0007 so the form can
 * say what's wrong before the round trip.
 */
export const UpdateNotificationContactsSchema = z.object({
  notification_email: z
    .union([z.email().max(254), z.literal("")])
    .transform((v) => (v ? v : null)),
  whatsapp_number: z.union([phone, z.literal("")]).transform((v) => (v ? v : null)),
});

export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1, { message: "Enter your current password" }),
  // Supabase's own floor is 6; 10 is this app's choice, and 72 is
  // bcrypt's hard ceiling — anything past it is silently truncated,
  // which would make a longer password *less* secure than it looks.
  new_password: z
    .string()
    .min(10, { message: "New password must be at least 10 characters" })
    .max(72, { message: "New password must be at most 72 characters" }),
});

// ── List controls ───────────────────────────────────────────

export const PAGE_SIZE = 25;

export const ListParamsSchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
  status: z.string().trim().max(40).optional(),
  branch: z.union([Uuid, z.literal("")]).optional(),
  sort: z.string().trim().max(40).optional(),
  dir: z.enum(["asc", "desc"]).catch("desc"),
});

export type ListParams = z.infer<typeof ListParamsSchema>;

// ── Helper ──────────────────────────────────────────────────

export type ActionError = { error: string; fieldErrors?: Record<string, string[]> };

/**
 * Parse an action's input, returning a shape the forms can render directly.
 * Keeps every action's failure path identical: `{ error }` for the banner,
 * `fieldErrors` for inline messages.
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown
): { ok: true; data: z.infer<S> } | { ok: false; error: ActionError } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };

  const flat = z.flattenError(result.error);
  const firstField = Object.values(flat.fieldErrors).flat()[0];
  return {
    ok: false,
    error: {
      error: flat.formErrors[0] ?? firstField ?? "Please check the values you entered.",
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    },
  };
}
