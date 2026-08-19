// Hand-written types mirroring supabase/migrations/0001_init.sql.
// (No Supabase CLI access in this environment to auto-generate —
// keep this in sync manually if the schema changes.)

export type Role =
  | "ceo"
  | "accountant"
  | "branch_manager"
  | "sales_exec"
  | "investor";

export type VehicleStatus = "in_stock" | "reserved" | "sold";
export type DealStatus = "submitted" | "approved" | "rejected" | "executed";
export type FinancingType = "cash" | "installments";
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
  purchase_price: number;
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
  created_at: string;
  profiles?: Profile;
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

export interface Contract {
  id: string;
  deal_ticket_id: string;
  serial: string;
  pdf_url: string | null;
  generated_at: string;
  unlocked_at: string | null;
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
  created_at: string;
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

