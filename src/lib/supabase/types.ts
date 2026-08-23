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
// How the showroom came to have a car (migration 0032). 'purchase' is
// the default and what every row predating 0032 is. A 'trade_in' row is
// born only inside execute_vehicle_sale(); a 'consignment' row is
// somebody else's car, sold for commission, with no cap table on it.
export type AcquisitionType = "purchase" | "trade_in" | "consignment";
// What the house keeps on a consigned sale: a flat fee, or a percentage
// of the price the deal actually settled at.
export type CommissionType = "fixed" | "percent";
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
  /**
   * The attendance geofence (migration 0038). Postgres numerics arrive
   * over PostgREST as STRINGS, which is why these are widened rather
   * than typed `number` — `src/lib/geo.ts` coerces. Null latitude or
   * longitude means the branch has never been placed on the map, and
   * every punch against it stores `within_geofence: null` ("not
   * assessed") rather than false.
   */
  latitude: number | string | null;
  longitude: number | string | null;
  geofence_radius_m: number | string | null;
  created_at: string;
}

/**
 * One branch a profile may act on IN ADDITION to `profiles.branch_id`
 * (migration 0030). An "area manager" is a branch_manager holding several
 * of these; nobody's home branch moves.
 */
export interface BranchGrant {
  id: string;
  profile_id: string;
  branch_id: string;
  granted_by: string | null;
  note: string | null;
  /**
   * Non-null once revoked. The row is never deleted — §6f grants DELETE
   * on nothing, and "who could approve Heliopolis deals in March" must
   * stay answerable. Re-granting clears this back to null.
   */
  revoked_at: string | null;
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
  /**
   * Does this person owe a daily attendance punch (migration 0038)?
   * 'on_site' does, 'remote' does not. NOT NULL with an 'on_site'
   * default, so every profile predating the migration is on-site —
   * the truthful answer for a showroom floor.
   *
   * A PRIVILEGE column: guard_profile_privilege_columns() lets only the
   * CEO change it, because a self-service work mode would make the
   * attendance report opt-out.
   */
  work_mode: WorkMode;
  /**
   * firstname.lastname.<tenant>@felixmail.508.world — assigned once by
   * handle_new_user() (migration 0039) and immutable after: no UI
   * anywhere may offer to edit this, and the database would refuse the
   * write if one tried (guard_profile_privilege_columns()).
   */
  mail_address: string | null;
  created_at: string;
}

export type EmploymentType = "full_time" | "part_time";

// ── Attendance (migration 0038) ─────────────────────────────
//
// The punch stream and the phones allowed to write to it. The derived
// day — arrival, breaks, hours — is computed in src/lib/attendance.ts
// and stored nowhere.

export type WorkMode = "on_site" | "remote";
export type PunchKind = "in" | "break_start" | "break_end" | "out";
/** A punch taken on a phone, or a row a manager entered on someone's behalf. */
export type AttendanceSource = "device" | "adjustment";
export type TrustedDeviceStatus = "active" | "revoked";

export interface TrustedDevice {
  id: string;
  profile_id: string;
  /**
   * SHA-256 of a random secret the app planted on the phone — never of
   * anything the browser volunteered. See src/lib/device.ts for why a
   * web app cannot bind to hardware and what this does buy.
   */
  device_hash: string;
  /** "iPhone · Safari". Attacker-controlled text: render, never trust. */
  label: string | null;
  platform: string | null;
  status: TrustedDeviceStatus;
  enrolled_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface AttendanceEventRow {
  id: string;
  profile_id: string;
  /** The branch being attended — not a copy of the profile's home branch. */
  branch_id: string;
  kind: PunchKind;
  occurred_at: string;
  latitude: number | string | null;
  longitude: number | string | null;
  accuracy_m: number | string | null;
  /**
   * Distance from the branch pin and the verdict, both computed by
   * `stamp_attendance_geofence()` on insert. Anything the client sends
   * for these two is discarded before it is stored — they are the
   * database's answer, never the phone's claim.
   */
  distance_m: number | string | null;
  within_geofence: boolean | null;
  device_id: string | null;
  source: AttendanceSource;
  recorded_by: string | null;
  /** Mandatory for an adjustment, by CHECK constraint. */
  reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
}

// ── Mail (migration 0039) ───────────────────────────────────
//
// 'internal' never touches the 508.world Worker — see mail-send.ts and
// the migration's own file header. sender_profile_id is null for
// exactly 'inbound'; mail_recipients is the internal fan-out only, kept
// separate from to_addresses/cc_addresses (the full display list,
// internal and external mixed) so an external address never needs a
// profile row that does not exist.

export type MailDirection = "internal" | "outbound" | "inbound";
export type MailSendStatus = "sent" | "skipped" | "failed";
export type MailRecipientKind = "to" | "cc";

export interface MailMessage {
  id: string;
  sender_profile_id: string | null;
  direction: MailDirection;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;
  thread_key: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  send_status: MailSendStatus | null;
  send_error: string | null;
  occurred_at: string;
  created_at: string;
  // A message with no human sender — FraudRadar's VIN-mismatch alert,
  // today (migration 0042). Only service_role can ever set this true;
  // see the migration header for why the grant, not RLS, is what
  // enforces that. Rendered with its own colour/icon in mail-client.tsx.
  is_system: boolean;
}

/**
 * The company that owns this showroom group — its legal identity, its
 * letterhead and its tax numbers (migration 0046). Exactly ONE row per
 * tenant schema, enforced by a unique singleton column.
 *
 * Every field is nullable and the ROW ITSELF may be absent: the tenant
 * template is pure DDL and cannot seed it, so it comes into existence
 * the first time a CEO saves the form. Readers fall back to the tenant
 * name from platform.tenants until then.
 *
 * Distinct from branches.tax_registration_no (0022), which is the
 * per-branch e-invoice seller identity. This is the level above it.
 */
export interface CompanySettings {
  id: string;
  legal_name: string | null;
  trade_name: string | null;
  logo_url: string | null;
  tax_id: string | null;
  commercial_registration: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface MailRecipient {
  id: string;
  message_id: string;
  profile_id: string;
  kind: MailRecipientKind;
  is_read: boolean;
  created_at: string;
}

export interface MailAttachment {
  id: string;
  message_id: string;
  filename: string;
  /** Claimed at upload time — never trust this over file-sniff.ts's own read. */
  mime_type: string | null;
  size_bytes: number;
  r2_key: string;
  is_inline: boolean;
  content_id: string | null;
  created_at: string;
}

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
  // VIN-decoded details (migration 0040) — captured automatically from
  // the NHTSA vPIC decode at intake (lib/vin-decode.ts). All nullable:
  // decode coverage varies by market, and rows predating this migration
  // or taken in without a VIN carry nulls throughout.
  body_type: string | null;
  engine_info: string | null;
  drive_type: string | null;
  doors: number | null;
  plant_country: string | null;
  // ETA e-invoicing product code (migration 0026) — the EGS
  // (EG-{tax reg}-{internal code}) or GS1 code the showroom registered
  // for this vehicle class on the ETA portal. Nullable — stock is taken
  // in before the class is registered.
  item_code: string | null;
  // How the showroom came to have this car (migration 0032). 'purchase'
  // for every row that predates it — until 0032 there was no other way
  // to hold one. 'trade_in' rows are minted only inside
  // execute_vehicle_sale(); 'consignment' rows are taken in at intake.
  acquisition_type: AcquisitionType;
  // The consignor, and the terms the house is selling on. All nullable:
  // a purchase has none. When acquisition_type is 'consignment' the
  // intake RPC guarantees the name and both commission fields are set —
  // grey rows taken in before 0032 may still carry nulls, which the
  // payout math reads as a zero commission rather than inventing one.
  consignor_name: string | null;
  consignor_phone: string | null;
  consignor_national_id: string | null;
  consignment_commission_type: CommissionType | null;
  consignment_commission_value: number | null;
  // The reading at intake (migration 0036) — the second question every
  // used-car buyer asks. Updatable with no decrease guard: cars get
  // driven, and a lower reading after a correction is real, not a
  // rollback to police. Nullable: nothing backfilled it for stock taken
  // in before this migration, including 0032's trade-ins.
  odometer_km: number | null;
  // Free text — who or where this car came from ("مزاد القاهرة",
  // "عميل — أحمد فؤاد", a fleet company). Nullable for the same reason.
  acquisition_source: string | null;
  // Zero, and only zero, when acquisition_type is 'consignment': a
  // consigned car deploys no capital. The DB CHECK says the same.
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

// Branch-to-branch stock movement (migration 0035). 'requested' is the
// only insertable value; guard_stock_transfer_status() confines every
// later transition to requested->accepted, requested->cancelled, or the
// one compensating accepted->requested a failed accept may need.
export type StockTransferStatus = "requested" | "accepted" | "cancelled";

export interface StockTransfer {
  id: string;
  vehicle_id: string;
  from_branch_id: string;
  to_branch_id: string;
  status: StockTransferStatus;
  requested_by: string | null;
  /** Stamped by the database the moment status leaves 'requested'. */
  decided_by: string | null;
  note: string | null;
  requested_at: string;
  decided_at: string | null;
  // Joined by transfer-actions.ts's loadVehicleTransfers() for the panel.
  from_branch?: Pick<Branch, "id" | "name">;
  to_branch?: Pick<Branch, "id" | "name">;
}

/**
 * One row per price change (migration 0036) — a plain trigger on
 * `vehicles` writes these; nothing in the app inserts them directly.
 * `branch_id` is denormalised off the vehicle at write time so the
 * SELECT policy is a scalar `can_read_branch(branch_id)` rather than a
 * per-row subquery into `vehicles` — the 0033 receivables-book pattern.
 */
export interface VehiclePriceHistory {
  id: string;
  vehicle_id: string;
  branch_id: string;
  asking_price: number | null;
  min_price: number | null;
  changed_by: string | null;
  changed_at: string;
  profiles?: Pick<Profile, "full_name"> | null;
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

/**
 * The person, as opposed to the enquiry (migration 0031).
 *
 * `leads` is one salesperson's work on one occasion and it ends
 * (ticket_created, closed); this row outlives it and is shared across
 * every branch in the group, which is the point — the same man walking
 * into two showrooms used to become two unrelated records with no way to
 * answer "what has he bought from us before".
 *
 * Readable org-wide by any staff member (customers_select is `is_staff()`
 * with no branch predicate). The sensitive rows it hangs off — leads,
 * deal_tickets, contracts, ledger_entries — keep their branch-scoped
 * policies, so a colleague at another branch can see that this person is
 * known and nothing about what he paid.
 */
export interface Customer {
  id: string;
  full_name: string;
  /** The dedupe key: 14 digits, or null until somebody collects it. Unique. */
  national_id: string | null;
  /**
   * Every number this person has been recorded under, as typed, plus the
   * canonical `0…` form that makes them findable. Never null — the column
   * is `not null default '{}'`.
   */
  phone_numbers: string[];
  address: string | null;
  nationality: string | null;
  /** The customer-level scrap, distinct from `Lead.client_notes`, which is about one enquiry. */
  notes: string | null;
  created_at: string;
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
  /**
   * The durable identity behind this enquiry (migration 0031).
   *
   * Null on three kinds of row and all three are legitimate: leads from
   * the public referral form (which never runs the link step — see
   * lib/customer-link.ts), leads saved while the link lookup was failing,
   * and every row in a deployment whose database has not had 0031 applied
   * yet. Read it as `?? null` and render around its absence.
   */
  customer_id: string | null;
  created_at: string;
  profiles?: Profile;
  customers?: Customer | null;
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
  // The trade-in leg (migration 0032) — تبديل. The buyer's old car,
  // described and appraised on the ticket that sells them the new one.
  // All nullable: most tickets have no trade-in, and every ticket
  // predating 0032 has none. execute_vehicle_sale() turns these into a
  // `vehicles` row the moment the sale settles, and nothing else reads
  // them. The odometer lives here rather than on the vehicle because an
  // odometer belongs on every car and that column arrives later; until
  // then it is folded into the created vehicle's description.
  trade_in_make: string | null;
  trade_in_model: string | null;
  trade_in_year: number | null;
  trade_in_color: string | null;
  trade_in_vin: string | null;
  trade_in_odometer_km: number | null;
  trade_in_allowance: number | null;
  trade_in_notes: string | null;
  // Never null — `not null default '{}'`, the photos/features precedent.
  trade_in_photos: string[];
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

/**
 * One attempt at filing this sale's e-invoice with the Egyptian Tax
 * Authority (migration 0034).
 *
 * 0024 gave `contracts` four slots for the identifiers a human read off
 * the portal. This is the other half: the queue and the audit of
 * submissions FELIX made itself, with the document it sent and the
 * answer it got, so "what exactly did we file, when, by whom, and
 * against which authority" is answerable years later.
 *
 * A contract may have many rows here, but at most one that is not
 * rejected or failed — see `uniq_eta_submission_live` in 0034.
 */
export type EtaSubmissionRowStatus =
  | "queued"
  | "submitted"
  | "accepted"
  | "rejected"
  | "failed";

/** Which authority a submission was made against. `mock` files nothing. */
export type EtaSubmissionMode = "mock" | "preprod" | "production";

export interface EtaSubmission {
  id: string;
  contract_id: string;
  deal_ticket_id: string;
  status: EtaSubmissionRowStatus;
  mode: EtaSubmissionMode;
  /** The exact ETA document that was sent. Null until built. */
  request_payload: Record<string, unknown> | null;
  /** The authority's answer, verbatim. */
  response_payload: Record<string, unknown> | null;
  eta_submission_id: string | null;
  eta_uuid: string | null;
  eta_long_id: string | null;
  error_detail: string | null;
  /**
   * Issue codes from the builder (`EtaWarningCode` in lib/eta/document.ts)
   * — never null, the column is `not null default '{}'`. "We filed this
   * with a placeholder product code" lives here.
   */
  warnings: string[];
  attempt: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * What the showroom owes the owner of a consigned car once it has sold
 * it (migration 0032).
 *
 * Deliberately NOT a ledger_entries row: the ledger is the house's own
 * wallet — CEO, investors, sales executives — and a consignor is an
 * outside creditor. Booking them there would make every profit report
 * count somebody else's money as the group's.
 *
 * Written only inside execute_vehicle_sale(). The accountant marks it
 * paid; nothing deletes it.
 */
export interface ConsignmentPayout {
  id: string;
  vehicle_id: string;
  deal_ticket_id: string;
  // Copied off the vehicle at execution rather than joined: the name on
  // the cheque is the name that was agreed on the day.
  consignor_name: string;
  amount_due: number;
  commission_amount: number;
  paid_at: string | null;
  settlement_method: SettlementMethod | null;
  settlement_reference: string | null;
  note: string | null;
  created_at: string;
  vehicles?: Vehicle;
  deal_tickets?: DealTicket;
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

// ── The in-house receivable book (migration 0033) ───────────
//
// What the showroom is owed by its own customers, as opposed to what a
// bank is owed. A deal ticket with financing_type 'installments' and NO
// financing_partner_id is the showroom's own book — تقسيط مباشر — and an
// InstallmentPlan hangs off exactly that shape (a trigger enforces it).

export type InstallmentPlanStatus = "active" | "settled" | "defaulted";

export interface InstallmentPlan {
  id: string;
  deal_ticket_id: string;
  /**
   * Denormalised from the ticket so every RLS predicate on this table is
   * a scalar can_read_branch() call rather than a subquery on
   * deal_tickets. A trigger pins it to the ticket's own branch, so the
   * copy cannot drift from the source.
   */
  branch_id: string;
  /** The financed amount, i.e. AFTER the down payment. */
  principal: number;
  /**
   * FLAT annual rate as a percentage, NOT reducing-balance:
   * interest = principal x (rate / 100) x (months / 12), computed once
   * on the whole principal for the whole term. Null means interest-free.
   */
  annual_flat_rate: number | null;
  months: number;
  /** ISO date (yyyy-mm-dd). The FIRST instalment falls on this day. */
  start_date: string;
  monthly_amount: number;
  total_payable: number;
  /** نقل الملكية بعد السداد — the papers stay with the showroom. */
  ownership_retained: boolean;
  /** 'defaulted' is a human's judgement; nothing computes it. */
  status: InstallmentPlanStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  installment_lines?: InstallmentLine[];
  deal_tickets?: DealTicket;
}

export interface InstallmentLine {
  id: string;
  plan_id: string;
  seq: number;
  /** ISO date (yyyy-mm-dd). */
  due_date: string;
  amount_due: number;
  amount_paid: number;
  paid_at: string | null;
}

export type ChequeStatus =
  | "in_safe"
  | "deposited"
  | "cleared"
  | "bounced"
  | "returned_to_customer";

export interface Cheque {
  id: string;
  branch_id: string;
  deal_ticket_id: string | null;
  plan_id: string | null;
  cheque_number: string;
  bank_name: string;
  /** Who the bank will pursue — often a relative's or a company's book. */
  drawer_name: string;
  amount: number;
  /** ISO date (yyyy-mm-dd). */
  due_date: string;
  status: ChequeStatus;
  /** Stamped by the database on every move, never by the client. */
  status_changed_at: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** How money taken at the counter arrived. 0023's channel values. */
export type ReceiptMethod = "cash" | "bank_transfer" | "cheque" | "instapay";

export interface Receipt {
  id: string;
  branch_id: string;
  deal_ticket_id: string | null;
  plan_id: string | null;
  amount: number;
  method: ReceiptMethod;
  reference: string | null;
  payer_name: string | null;
  note: string | null;
  received_by: string;
  received_at: string;
}

/**
 * What execute_vehicle_sale() returns (migration 0032).
 *
 * A superset of the preview: the same keys, plus the salesperson's
 * commission, the id of any vehicle the trade-in leg created, and — on
 * a consigned sale — the three keys that describe a commission rather
 * than a waterfall. The consignment branch never calls
 * compute_sale_waterfall() at all, so `shares` comes back empty and
 * `net_profit` IS the house commission.
 *
 * Every extra key is optional because the preview RPC
 * (preview_vehicle_sale_waterfall) returns the plain waterfall shape
 * and is unchanged by 0032.
 */
export interface SaleResult extends WaterfallPreview {
  commission?: number;
  trade_in_vehicle_id?: string | null;
  acquisition_type?: AcquisitionType;
  consignment_commission?: number;
  consignment_amount_due?: number;
}

