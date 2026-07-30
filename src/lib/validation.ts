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
  purchase_price: positiveMoney,
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
});

export const AddExpenseSchema = z.object({
  vehicle_id: Uuid,
  category: text(60),
  amount: positiveMoney,
  note: optionalText(500),
  // Deliberately absent: is_ceo_override. That flag permanently locks a row
  // from non-CEO edits, so it is derived from the caller's role on the server
  // and never accepted from the client.
});

// ── CRM ─────────────────────────────────────────────────────

export const CreateLeadSchema = z.object({
  client_name: text(120),
  phone_number: phone,
  car_interest: optionalText(120),
  address: optionalText(240),
  company_name: optionalText(120),
  job_title: optionalText(120),
  income: optionalMoneyString,
  client_notes: optionalText(2000),
});

export const PublicLeadSchema = z.object({
  client_name: text(120),
  phone_number: phone,
  car_interest: optionalText(120),
  contact_time_preference: optionalText(120),
  client_notes: optionalText(1000),
});

export const LeadCommentSchema = z.object({
  lead_id: Uuid,
  body: text(2000),
  contact_method: z.enum(["phone", "whatsapp", "in_person", "email"]).nullable(),
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

export const ROLES = ["ceo", "accountant", "branch_manager", "sales_exec", "investor"] as const;

export const CreateStaffSchema = z
  .object({
    email: z.email().max(254),
    full_name: text(120),
    role: z.enum(ROLES),
    branch_id: Uuid.nullable(),
    phone: z.union([phone, z.literal("")]).transform((v) => v || null),
  })
  // A CEO and an investor are org-wide; everyone else works out of a branch.
  .refine((s) => s.role === "ceo" || s.role === "investor" || s.branch_id !== null, {
    message: "Branch staff must be assigned to a branch",
    path: ["branch_id"],
  });

export const UpdateStaffSchema = z.object({
  id: Uuid,
  full_name: text(120),
  role: z.enum(ROLES),
  branch_id: Uuid.nullable(),
  phone: z.union([phone, z.literal("")]).transform((v) => v || null),
});

export const BranchSchema = z.object({
  name: text(120),
  address: optionalText(240),
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
