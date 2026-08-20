// Hand-written types mirroring supabase/migrations/0001_init.sql.
// (No Supabase CLI access in this environment to auto-generate —
// keep this in sync manually if the schema changes.)

export type Role =
  | "ceo"
  | "accountant"
  | "branch_manager"
  | "sales_exec"
  | "marketing"
  | "investor";

export type VehicleStatus = "in_stock" | "reserved" | "sold";
export type DealStatus = "submitted" | "approved" | "rejected" | "executed";
export type FinancingType = "cash" | "installments";
// How the sale actually settled (migration 0023) — distinct from
// FinancingType, which only says paid-in-full vs financed. 'cash' stays
// representable: Egyptian payment rules restrict cash settlement of car
// sales, but FELIX records the channel rather than forbidding it.
export type SettlementMethod = "bank_transfer" | "cheque" | "instapay" | "cash";
export type FinancingPartnerStatus = "pending_upload" | "active";
export type FinancingRequestStatus =
  | "submitted"
  | "in_review"
  | "approved_by_bank"
  | "rejected_by_bank";
export type LedgerHolderType = "ceo" | "investor" | "sales_exec";
export type LedgerType =
  | "sale_profit_share"
  | "deposit"
  | "withdrawal"
  | "commission"
  | "salary"
  | "opex_offset";
export type LeadSource = "manual" | "link";
export type LeadStatus = "pending" | "ticket_created" | "closed";
export type MeetingStatus = "scheduled" | "cancelled";
export type MeetingResponse = "pending" | "accepted" | "declined";

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  // Egyptian permit tracking (migration 0019). All nullable: branches
  // seeded at provision time carry none of these until recorded.
  commercial_registration_no: string | null;
  tax_card_no: string | null;
  /**
   * The branch's VAT registration number (migration 0022) — the seller
   * identity on e-invoices and the Form 10 VAT return. Distinct from
   * tax_card_no, which is the income-tax identity.
   */
  tax_registration_no: string | null;
  trade_license_no: string | null;
  /** ISO date (yyyy-mm-dd). Trade license per Decree 323/1956 + Law 154/2019. */
  trade_license_expiry: string | null;
  /** True = premises under a residential building (2027 relocation mandate). Null = not assessed. */
  is_under_residential_building: boolean | null;
  created_at: string;
}

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  branch_id: string | null;
  // NOTE: there is no tenant_id here any more.
  //
  // Migration 0011 moved every showroom's rows into its own schema, so
  // the schema a profile row lives in IS the answer to "whose data is
  // this?" — a column recording it would be redundant at best and a
  // second, drift-prone source of truth at worst. Isolation is enforced
  // by GRANTs on separate tables rather than by a predicate over a
  // shared one.
  //
  // The session's showroom comes from the `felix_tenant` access-token
  // claim (see lib/tenant-claim.ts), which migration 0010's hook derives
  // from platform.tenant_users.
  phone: string | null;
  avatar_url: string | null;
  // Contact preferences for the 508.world router Worker's notifications
  // (meeting invites, 1-hour reminders, FELIX updates) — see migration
  // 0007. Self-editable; null means "do not send".
  notification_email: string | null;
  whatsapp_number: string | null;
  // Statutory employee data for Egypt's monthly NOSI social-insurance
  // filing — migration 0018. All nullable: rows predating the migration
  // and the demo fixtures carry nulls. national_id is CHECKed to exactly
  // 14 digits when present.
  national_id: string | null;
  social_insurance_number: string | null;
  /** ISO date (YYYY-MM-DD). */
  hire_date: string | null;
  /** Statutory wage basis for NOSI contributions — distinct from ad-hoc ledger payouts. */
  monthly_wage: number | null;
  employment_type: EmploymentType | null;
  created_at: string;
}

export type EmploymentType = "full_time" | "part_time";

// Metrics a manager can set a monthly target for (migration 0027). The
// actuals are counted from tables that already exist: 'calls' from
// lead_comments authored by the employee, 'new_leads' from leads
// carrying them as salesperson, 'deals_closed' from executed
// deal_tickets. Adding a metric here means adding a counting query on
// the employee profile page, or it renders as 0/N forever.
export type TargetMetric = "calls" | "new_leads" | "deals_closed";

export interface EmployeeTarget {
  id: string;
  profile_id: string;
  metric: TargetMetric;
  target_value: number;
  /** First day of the month the target covers (YYYY-MM-01). */
  period_month: string;
  /** Who last stated the number — pinned to the writer by RLS. */
  set_by: string | null;
  created_at: string;
}

// Where a car is advertised (migration 0029). One row per
// (vehicle, channel); the unique index makes posting state an upsert.
export type ListingChannel = "dubizzle" | "facebook" | "instagram" | "tiktok" | "website" | "other";
export type ListingStatus = "draft" | "posted" | "needs_update" | "removed";

export interface VehicleListing {
  id: string;
  vehicle_id: string;
  channel: ListingChannel;
  status: ListingStatus;
  url: string | null;
  note: string | null;
  /** Who last touched the listing — pinned to the writer by RLS. */
  posted_by: string | null;
  posted_at: string | null;
  created_at: string;
}

export type TenantStatus = "active" | "suspended";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  licensed_via: string | null;
  created_at: string;
}

export interface Investor {
  id: string;
  notes: string | null;
  created_at: string;
  profiles?: Profile;
}

export interface Vehicle {
  id: string;
  branch_id: string;
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
  description: string | null;
  inspection_photos: string[];
  // Mechanical identifiers for Egypt's traffic-authority ownership
  // transfer (migration 0021). Both nullable — recorded when legible.
  engine_number: string | null;
  plate_number: string | null;
  // CPA Decision 115/2021 windshield-sticker fields (migration 0025).
  // Origin is nullable free text; features is the structured amenities
  // list — never null, the column is `not null default '{}'` so no read
  // site needs a coalesce (the photos/client_note_points precedent).
  country_of_origin: string | null;
  features: string[];
  // ETA e-invoicing product code (migration 0026) — the EGS
  // (EG-{tax reg}-{internal code}) or GS1 code the showroom registered
  // for this vehicle class on the ETA portal. Nullable — stock is taken
  // in before the class is registered.
  item_code: string | null;
  purchase_price: number;
  // Sticker price and negotiation floor (migration 0028). Both nullable —
  // priced after intake. purchase_price above is the confidential cost;
  // these two are what the sales floor (and marketing) work with.
  asking_price: number | null;
  min_price: number | null;
  status: VehicleStatus;
  photos: string[];
  created_by: string | null;
  created_at: string;
  sold_at: string | null;
}

export interface VehicleEquitySplit {
  id: string;
  vehicle_id: string;
  holder_type: "ceo" | "investor";
  holder_id: string | null;
  amount_invested: number;
  percentage: number;
  created_at: string;
  investors?: Investor & { profiles?: Profile };
}

export interface VehicleExpense {
  id: string;
  vehicle_id: string;
  category: string;
  amount: number;
  note: string | null;
  created_by: string | null;
  is_ceo_override: boolean;
  // Input VAT for the Form 10 deduction (migration 0022). Since July 2023
  // deduction requires an e-invoice-backed expense — the supplier's tax ID
  // and invoice number tie this row to that document. All nullable.
  vat_amount: number | null;
  supplier_tax_id: string | null;
  supplier_invoice_no: string | null;
  created_at: string;
}

export interface OverheadConfig {
  branch_id: string;
  monthly_opex_amount: number;
  updated_at: string;
}

export interface Lead {
  id: string;
  branch_id: string | null;
  salesperson_id: string | null;
  client_name: string;
  phone_number: string;
  address: string | null;
  company_name: string | null;
  job_title: string | null;
  income: number | null;
  car_interest: string | null;
  source: LeadSource;
  status: LeadStatus;
  contact_time_preference: string | null;
  client_notes: string | null;
  /**
   * The bullets under `client_notes`.
   *
   * `client_notes` is the heading — who this person is, "married, three
   * kids". These are the separately-actionable requirements a salesperson
   * reads before dialling: "bad roads, needs an SUV", "wants seven seats",
   * "sport mode, German-built". They were previously flattened into the
   * paragraph above, where nobody could pick one out on a call.
   *
   * Never null — migration 0017 declares the column `not null default
   * '{}'` precisely so no read site needs a coalesce.
   */
  client_note_points: string[];
  /**
   * Buyer identity for the sale paperwork (migration 0020): the
   * e-invoice at or above EGP 25,000, the traffic-authority ownership
   * transfer, and AML due diligence. Null until staff record it — the
   * public referral form never collects it, and the DB CHECK requires
   * exactly 14 digits when present.
   */
  national_id: string | null;
  /** Free text; conceptually Egyptian by default but null until entered. */
  nationality: string | null;
  created_at: string;
  profiles?: Profile;
}

/**
 * Who put a buyer and a car together. `requested` is demand — the buyer
 * asked for it. `suggested` is a salesperson matching them to something on
 * the floor. The CEO's demand report must not add the two together.
 */
export type LeadInterestOrigin = "requested" | "suggested";
export type LeadInterestStatus = "open" | "shown" | "declined";

/**
 * A buyer's interest in one car, and what they will pay for it.
 *
 * `vehicle_id` null means they want something the showroom does not have;
 * `wanted_*` says what. Migration 0016's CHECK guarantees at least one of
 * the two is filled in, so a row always names a car.
 */
export interface LeadVehicleInterest {
  id: string;
  lead_id: string;
  vehicle_id: string | null;
  wanted_make: string | null;
  wanted_model: string | null;
  wanted_year: number | null;
  budget_amount: number | null;
  origin: LeadInterestOrigin;
  status: LeadInterestStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
  vehicles?: Vehicle | null;
  leads?: Lead | null;
}

export interface LeadComment {
  id: string;
  lead_id: string;
  author_id: string | null;
  contact_method: string | null;
  contact_time: string | null;
  body: string;
  created_at: string;
  profiles?: Profile;
}

export interface FinancingPartner {
  id: string;
  bank_name: string;
  product_name: string;
  rate: number | null;
  term_months: number | null;
  min_down_payment: number | null;
  contract_file_url: string | null;
  status: FinancingPartnerStatus;
  created_by: string | null;
  created_at: string;
}

export interface DealTicket {
  id: string;
  lead_id: string | null;
  vehicle_id: string;
  branch_id: string;
  salesperson_id: string;
  agreed_price: number;
  financing_type: FinancingType;
  financing_partner_id: string | null;
  down_payment: number | null;
  discount_amount: number;
  // Output VAT on the sale (migration 0022). Nullable: tickets predating
  // 0022 carry nulls. The rate is stored per transaction (percentage,
  // e.g. 14) because schedule-tax vehicles differ from the 14% standard;
  // price_includes_vat records whether agreed_price is VAT-inclusive.
  vat_rate: number | null;
  vat_amount: number | null;
  price_includes_vat: boolean | null;
  // Settlement channel (migration 0023). Egypt's CBE mandate and the
  // 2025 Finance Bill require car sales to settle through bank channels,
  // so the ticket records the channel, the transfer ref / cheque number,
  // and the showroom-side receiving bank. Nullable: tickets predating
  // 0023 carry nulls, and a ticket can be raised before settlement.
  settlement_method: SettlementMethod | null;
  settlement_reference: string | null;
  settlement_bank: string | null;
  status: DealStatus;
  financial_check_passed: boolean;
  discount_validated: boolean;
  rate_revalidated: boolean;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  executed_at: string | null;
  created_at: string;
  vehicles?: Vehicle;
  leads?: Lead;
  profiles?: Profile;
  financing_partners?: FinancingPartner;
  contracts?: Contract | Contract[];
}

export interface DealTicketEvent {
  id: string;
  deal_ticket_id: string;
  actor_id: string | null;
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
  profiles?: Profile;
}

export interface FinancingRequest {
  id: string;
  deal_ticket_id: string;
  financing_partner_id: string;
  status: FinancingRequestStatus;
  notes: string | null;
  supporting_doc_urls: string[];
  created_at: string;
  updated_at: string;
  financing_partners?: FinancingPartner;
}

export type EtaSubmissionStatus = "pending" | "submitted" | "accepted" | "rejected";

export interface Contract {
  id: string;
  deal_ticket_id: string;
  serial: string;
  pdf_url: string | null;
  generated_at: string;
  unlocked_at: string | null;
  // ETA e-invoice linkage (migration 0024) — the Egyptian Tax
  // Authority's own identifiers for the invoice behind this sale,
  // recorded by the accountant after manual submission on the portal.
  eta_uuid: string | null;
  eta_long_id: string | null;
  eta_submission_status: EtaSubmissionStatus | null;
  eta_submitted_at: string | null;
}

export interface CommissionTier {
  tier_index: number;
  cumulative_amount: number;
}

export interface LedgerEntry {
  id: string;
  holder_type: LedgerHolderType;
  holder_id: string | null;
  type: LedgerType;
  amount: number;
  ref_deal_ticket_id: string | null;
  ref_vehicle_id: string | null;
  note: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
  /**
   * The whole row as it stood before and after the mutation, captured by
   * `record_audit()` (migration 0003 §8). Null on the side that does not
   * exist: an insert has no `before_data`, a delete no `after_data`.
   *
   * These are what make the trail readable rather than merely present —
   * `buildLeadHistory()` diffs the pair to say which field moved and
   * where it moved to.
   */
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
  profiles?: { full_name: string } | null;
}

/**
 * One attendee as returned by `calendar_meetings()`. Deliberately only
 * name and role: the RPC exists so a salesperson can see who else is in
 * the room without being handed the staff directory (see 0006 §5).
 */
export interface MeetingAttendee {
  id: string;
  full_name: string;
  role: Role;
  response: MeetingResponse;
}

/** A row of `calendar_meetings(from, to)` — not a `meetings` table row. */
export interface CalendarMeeting {
  id: string;
  title: string;
  agenda: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  status: MeetingStatus;
  branch_id: string | null;
  branch_name: string | null;
  organizer_id: string;
  organizer_name: string | null;
  is_organizer: boolean;
  /** null when the caller is watching a meeting they were not invited to. */
  my_response: MeetingResponse | null;
  attendees: MeetingAttendee[];
}

/** A row of `calendar_invitable_people()` — who *this* caller may invite. */
export interface InvitablePerson {
  id: string;
  full_name: string;
  role: Role;
  branch_id: string | null;
}

export interface WaterfallPreview {
  sale_price: number;
  purchase_price: number;
  total_expenses: number;
  months_in_inventory: number;
  overhead_total: number;
  discount: number;
  net_profit: number;
  shares: {
    holder_type: "ceo" | "investor";
    holder_id: string | null;
    percentage: number;
    share: number;
  }[];
}

