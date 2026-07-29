-- ============================================================
-- FILEX — Automotive Showroom Capital & Deal Management System
-- Migration 0001: schema, functions/triggers, waterfall engine, RLS
--
-- HOW TO APPLY: paste this whole file into Supabase Dashboard >
-- SQL Editor > New query, then click "Run". Safe to re-run
-- (uses IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- 1. BRANCHES
-- ============================================================
create table if not exists branches (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  address     text,
  created_at  timestamptz default now()
);

-- ============================================================
-- 2. PROFILES
--    Mirrors auth.users 1:1. Carries role + branch scope.
-- ============================================================
create table if not exists profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  full_name   text        not null,
  role        text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor')),
  branch_id   uuid        references branches(id),
  phone       text,
  avatar_url  text,
  created_at  timestamptz default now()
);

-- Auto-create a profile row when a new auth user signs up.
-- Role/branch/full_name are read from the signup call's user_metadata.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, role, branch_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'sales_exec'),
    nullif(new.raw_user_meta_data->>'branch_id','')::uuid
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Role helper functions (used throughout RLS policies) ────
create or replace function current_role_name() returns text as $$
  select role from public.profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public, extensions;

create or replace function current_branch_id() returns uuid as $$
  select branch_id from public.profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public, extensions;

create or replace function is_ceo() returns boolean as $$
  select current_role_name() = 'ceo';
$$ language sql stable;

create or replace function is_manager_or_above() returns boolean as $$
  select current_role_name() in ('ceo','branch_manager');
$$ language sql stable;

create or replace function is_accountant_or_above() returns boolean as $$
  select current_role_name() in ('ceo','accountant');
$$ language sql stable;

create or replace function is_staff() returns boolean as $$
  select current_role_name() in ('ceo','accountant','branch_manager','sales_exec');
$$ language sql stable;

-- ============================================================
-- 3. INVESTORS (1:1 with a profiles row where role='investor')
-- ============================================================
create table if not exists investors (
  id          uuid        primary key references profiles(id) on delete cascade,
  notes       text,
  created_at  timestamptz default now()
);

-- ============================================================
-- 4. VEHICLES
-- ============================================================
create table if not exists vehicles (
  id              uuid        primary key default gen_random_uuid(),
  branch_id       uuid        not null references branches(id),
  vin             text        unique,
  year            int         not null,
  make            text        not null,
  model           text        not null,
  trim            text,
  purchase_price  numeric     not null check (purchase_price > 0),
  status          text        not null default 'in_stock' check (status in ('in_stock','reserved','sold')),
  photos          text[]      not null default '{}',
  created_by      uuid        references profiles(id),
  created_at      timestamptz default now(),
  sold_at         timestamptz
);

create index if not exists idx_vehicles_branch on vehicles(branch_id);
create index if not exists idx_vehicles_status on vehicles(status);

-- ============================================================
-- 5. VEHICLE EQUITY SPLITS (immutable once vehicle is sold)
-- ============================================================
create table if not exists vehicle_equity_splits (
  id                uuid        primary key default gen_random_uuid(),
  vehicle_id        uuid        not null references vehicles(id) on delete cascade,
  holder_type       text        not null check (holder_type in ('ceo','investor')),
  holder_id         uuid        references investors(id),
  amount_invested   numeric     not null check (amount_invested >= 0),
  percentage        numeric     not null check (percentage >= 0 and percentage <= 100),
  created_at        timestamptz default now(),
  constraint holder_id_matches_type check (
    (holder_type = 'ceo' and holder_id is null) or
    (holder_type = 'investor' and holder_id is not null)
  )
);

create index if not exists idx_equity_splits_vehicle on vehicle_equity_splits(vehicle_id);
create index if not exists idx_equity_splits_holder on vehicle_equity_splits(holder_id);

create or replace function check_equity_splits_sum() returns trigger as $$
declare
  total numeric;
begin
  select coalesce(sum(percentage),0) into total from vehicle_equity_splits where vehicle_id = new.vehicle_id;
  if total > 100.01 then
    raise exception 'Equity splits for vehicle % exceed 100%% (currently %)', new.vehicle_id, total;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_check_equity_splits on vehicle_equity_splits;
create trigger trg_check_equity_splits
  after insert on vehicle_equity_splits
  for each row execute function check_equity_splits_sum();

create or replace function prevent_split_edit_after_sale() returns trigger as $$
begin
  if exists (select 1 from vehicles where id = coalesce(new.vehicle_id, old.vehicle_id) and status = 'sold') then
    raise exception 'Cannot modify equity splits after the vehicle has been sold';
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_lock_splits on vehicle_equity_splits;
create trigger trg_lock_splits
  before update or delete on vehicle_equity_splits
  for each row execute function prevent_split_edit_after_sale();

-- ============================================================
-- 6. VEHICLE EXPENSES (CEO override → locked audit rule)
-- ============================================================
create table if not exists vehicle_expenses (
  id                uuid        primary key default gen_random_uuid(),
  vehicle_id        uuid        not null references vehicles(id) on delete cascade,
  category          text        not null,
  amount            numeric     not null check (amount > 0),
  note              text,
  created_by        uuid        references profiles(id),
  is_ceo_override   boolean     not null default false,
  created_at        timestamptz default now()
);

create index if not exists idx_vehicle_expenses_vehicle on vehicle_expenses(vehicle_id);

create or replace function lock_ceo_override_expense() returns trigger as $$
begin
  if old.is_ceo_override and not is_ceo() then
    raise exception 'This expense entry was CEO-overridden and is locked from further edits (CEO_OVERRIDE)';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_lock_ceo_override on vehicle_expenses;
create trigger trg_lock_ceo_override
  before update on vehicle_expenses
  for each row execute function lock_ceo_override_expense();

-- ============================================================
-- 7. OVERHEAD CONFIG (per-branch monthly OpEx, CEO-set)
-- ============================================================
create table if not exists overhead_config (
  branch_id            uuid        primary key references branches(id),
  monthly_opex_amount  numeric     not null default 0,
  updated_at           timestamptz default now()
);

-- ============================================================
-- 8. LEADS / CRM
-- ============================================================
create table if not exists leads (
  id                        uuid        primary key default gen_random_uuid(),
  branch_id                 uuid        references branches(id),
  salesperson_id            uuid        references profiles(id),
  client_name               text        not null,
  phone_number              text        not null,
  address                   text,
  company_name              text,
  job_title                 text,
  income                    numeric,
  car_interest              text,
  source                    text        not null default 'manual' check (source in ('manual','link')),
  status                    text        not null default 'pending' check (status in ('pending','ticket_created','closed')),
  contact_time_preference   text,
  client_notes              text,
  created_at                timestamptz default now()
);

create index if not exists idx_leads_branch on leads(branch_id);
create index if not exists idx_leads_salesperson on leads(salesperson_id);

create table if not exists lead_comments (
  id              uuid        primary key default gen_random_uuid(),
  lead_id         uuid        not null references leads(id) on delete cascade,
  author_id       uuid        references profiles(id),
  contact_method  text,
  contact_time    timestamptz,
  body            text        not null,
  created_at      timestamptz default now()
);

create index if not exists idx_lead_comments_lead on lead_comments(lead_id);

-- ============================================================
-- 9. FINANCING PARTNERS (bank contract upload gate)
-- ============================================================
create table if not exists financing_partners (
  id                  uuid        primary key default gen_random_uuid(),
  bank_name           text        not null,
  product_name        text        not null,
  rate                numeric,
  term_months         int,
  min_down_payment    numeric,
  contract_file_url   text,
  status              text        not null default 'pending_upload' check (status in ('pending_upload','active')),
  created_by          uuid        references profiles(id),
  created_at          timestamptz default now()
);

create or replace function enforce_financing_partner_upload_gate() returns trigger as $$
begin
  if new.status = 'active' and new.contract_file_url is null then
    raise exception 'A financing partner cannot be activated until its bank contract file is uploaded';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_financing_partner_gate on financing_partners;
create trigger trg_financing_partner_gate
  before insert or update on financing_partners
  for each row execute function enforce_financing_partner_upload_gate();

-- ============================================================
-- 10. DEAL TICKETS (the approval workflow)
-- ============================================================
create table if not exists deal_tickets (
  id                        uuid        primary key default gen_random_uuid(),
  lead_id                   uuid        references leads(id),
  vehicle_id                uuid        not null references vehicles(id),
  branch_id                 uuid        not null references branches(id),
  salesperson_id            uuid        not null references profiles(id),
  agreed_price              numeric     not null check (agreed_price > 0),
  financing_type            text        not null check (financing_type in ('cash','installments')),
  financing_partner_id      uuid        references financing_partners(id),
  down_payment              numeric,
  discount_amount           numeric     not null default 0,
  status                    text        not null default 'submitted' check (status in ('submitted','approved','rejected','executed')),
  financial_check_passed    boolean     not null default false,
  discount_validated        boolean     not null default false,
  rate_revalidated          boolean     not null default false,
  rejection_reason          text,
  reviewed_by               uuid        references profiles(id),
  reviewed_at               timestamptz,
  executed_at               timestamptz,
  created_at                timestamptz default now()
);

create index if not exists idx_deal_tickets_branch on deal_tickets(branch_id);
create index if not exists idx_deal_tickets_salesperson on deal_tickets(salesperson_id);
create index if not exists idx_deal_tickets_status on deal_tickets(status);

create or replace function enforce_financing_partner_active() returns trigger as $$
begin
  if new.financing_type = 'installments' and new.financing_partner_id is not null then
    if not exists (select 1 from financing_partners where id = new.financing_partner_id and status = 'active') then
      raise exception 'Selected financing partner is not active yet (bank contract not uploaded)';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_deal_ticket_financing_gate on deal_tickets;
create trigger trg_deal_ticket_financing_gate
  before insert or update on deal_tickets
  for each row execute function enforce_financing_partner_active();

create table if not exists deal_ticket_events (
  id               uuid        primary key default gen_random_uuid(),
  deal_ticket_id   uuid        not null references deal_tickets(id) on delete cascade,
  actor_id         uuid        references profiles(id),
  from_status      text,
  to_status        text        not null,
  note             text,
  created_at       timestamptz default now()
);

create index if not exists idx_deal_ticket_events_ticket on deal_ticket_events(deal_ticket_id);

create or replace function log_deal_ticket_status_change() returns trigger as $$
begin
  if (tg_op = 'INSERT') or (old.status is distinct from new.status) then
    insert into deal_ticket_events (deal_ticket_id, actor_id, from_status, to_status, note)
    values (
      new.id, auth.uid(),
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      case when new.status = 'rejected' then new.rejection_reason else null end
    );
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_log_deal_ticket on deal_tickets;
create trigger trg_log_deal_ticket
  after insert or update on deal_tickets
  for each row execute function log_deal_ticket_status_change();

-- ============================================================
-- 11. FINANCING REQUESTS
--     Ticket-based tracker for bank installment approval —
--     intentionally NOT an auto-amortization calculator since
--     bank terms vary too much; the source-of-truth is the
--     uploaded bank contract file on financing_partners.
-- ============================================================
create table if not exists financing_requests (
  id                      uuid        primary key default gen_random_uuid(),
  deal_ticket_id          uuid        not null references deal_tickets(id) on delete cascade,
  financing_partner_id    uuid        not null references financing_partners(id),
  status                  text        not null default 'submitted' check (status in ('submitted','in_review','approved_by_bank','rejected_by_bank')),
  notes                   text,
  supporting_doc_urls     text[]      not null default '{}',
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

create index if not exists idx_financing_requests_ticket on financing_requests(deal_ticket_id);

-- ============================================================
-- 12. CONTRACTS (cryptographic serial + vault lock)
-- ============================================================
create table if not exists contracts (
  id               uuid        primary key default gen_random_uuid(),
  deal_ticket_id   uuid        not null unique references deal_tickets(id) on delete cascade,
  serial           text        not null unique,
  pdf_url          text,
  generated_at     timestamptz default now(),
  unlocked_at      timestamptz
);

create or replace function generate_contract_serial(p_deal_ticket_id uuid, p_vin text) returns text as $$
declare
  raw text;
  digest_hex text;
  yr text := to_char(now(), 'YYYY');
begin
  raw := p_deal_ticket_id::text || '|' || coalesce(p_vin,'') || '|' || extract(epoch from clock_timestamp())::text;
  digest_hex := encode(extensions.digest(raw, 'sha256'), 'hex');
  return 'FILEX-' || yr || '-' || upper(substr(digest_hex,1,4)) || '-' || upper(substr(digest_hex,5,4)) || '-' || upper(substr(digest_hex,9,4));
end;
$$ language plpgsql set search_path = public, extensions;

-- Approving a ticket requires all 3 checklist flags, then mints
-- the contract (unlocked immediately — this row's mere existence
-- is what gates sales-exec visibility; no row = still locked).
create or replace function handle_deal_ticket_approval() returns trigger as $$
declare
  v_vin text;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if not (new.financial_check_passed and new.discount_validated and new.rate_revalidated) then
      raise exception 'Cannot approve: financial check, discount validation, and rate revalidation must all pass first';
    end if;
    select vin into v_vin from vehicles where id = new.vehicle_id;
    insert into contracts (deal_ticket_id, serial, unlocked_at)
    values (new.id, generate_contract_serial(new.id, v_vin), now())
    on conflict (deal_ticket_id) do nothing;
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_deal_ticket_approval on deal_tickets;
create trigger trg_deal_ticket_approval
  before update on deal_tickets
  for each row execute function handle_deal_ticket_approval();

-- ============================================================
-- 13. COMMISSION TIERS (org-level, replaces old localStorage)
-- ============================================================
create table if not exists commission_tiers (
  tier_index          int         primary key check (tier_index between 1 and 10),
  cumulative_amount   numeric     not null
);

-- ============================================================
-- 14. LEDGER ENTRIES (unified CEO / investor / salesperson wallet)
-- ============================================================
create table if not exists ledger_entries (
  id                    uuid        primary key default gen_random_uuid(),
  holder_type           text        not null check (holder_type in ('ceo','investor','sales_exec')),
  holder_id             uuid,
  type                  text        not null check (type in ('sale_profit_share','deposit','withdrawal','commission','salary','opex_offset')),
  amount                numeric     not null,
  ref_deal_ticket_id    uuid        references deal_tickets(id),
  ref_vehicle_id        uuid        references vehicles(id),
  note                  text,
  created_at            timestamptz default now(),
  constraint holder_id_required_unless_ceo check (
    (holder_type = 'ceo') or (holder_id is not null)
  )
);

create index if not exists idx_ledger_holder on ledger_entries(holder_type, holder_id);

-- ============================================================
-- 15. AUDIT LOG
-- ============================================================
create table if not exists audit_log (
  id            uuid        primary key default gen_random_uuid(),
  actor_id      uuid        references profiles(id),
  action        text        not null,
  entity_type   text,
  entity_id     uuid,
  detail        jsonb,
  created_at    timestamptz default now()
);

-- ============================================================
-- 15b. ATOMIC VEHICLE INTAKE (vehicle + equity splits together)
-- ============================================================
create or replace function create_vehicle_with_equity_splits(
  p_branch_id uuid,
  p_vin text,
  p_year int,
  p_make text,
  p_model text,
  p_trim text,
  p_purchase_price numeric,
  p_photos text[],
  p_splits jsonb -- [{holder_type, holder_id, amount_invested, percentage}, ...]
) returns uuid as $$
declare
  v_id uuid;
  split jsonb;
begin
  if not (is_ceo() or (is_manager_or_above() and p_branch_id = current_branch_id())) then
    raise exception 'Not authorized to intake a vehicle for this branch';
  end if;

  insert into vehicles (branch_id, vin, year, make, model, trim, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), p_purchase_price, coalesce(p_photos,'{}'), auth.uid())
  returning id into v_id;

  for split in select * from jsonb_array_elements(p_splits) loop
    insert into vehicle_equity_splits (vehicle_id, holder_type, holder_id, amount_invested, percentage)
    values (
      v_id,
      split->>'holder_type',
      nullif(split->>'holder_id','')::uuid,
      (split->>'amount_invested')::numeric,
      (split->>'percentage')::numeric
    );
  end loop;

  return v_id;
end;
$$ language plpgsql security definer set search_path = public, extensions;

grant execute on function create_vehicle_with_equity_splits(uuid, text, int, text, text, text, numeric, text[], jsonb) to authenticated;

-- ============================================================
-- 16. WATERFALL ENGINE
-- ============================================================

-- Read-only preview — powers the animated waterfall UI before
-- a manager actually executes the sale.
create or replace function preview_vehicle_sale_waterfall(
  p_vehicle_id uuid,
  p_agreed_price numeric,
  p_discount numeric default 0
) returns jsonb as $$
declare
  v vehicles%rowtype;
  months_in_inventory numeric;
  overhead_total numeric;
  total_expenses numeric;
  net_profit numeric;
  shares jsonb;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  months_in_inventory := greatest(extract(epoch from (now() - v.created_at)) / (30*86400), 0);

  select coalesce(sum(amount),0) into total_expenses from vehicle_expenses where vehicle_id = v.id;

  select coalesce(monthly_opex_amount,0) * months_in_inventory into overhead_total
  from overhead_config where branch_id = v.branch_id;
  overhead_total := coalesce(overhead_total, 0);

  net_profit := p_agreed_price - v.purchase_price - total_expenses - overhead_total - coalesce(p_discount,0);

  select coalesce(jsonb_agg(jsonb_build_object(
    'holder_type', s.holder_type,
    'holder_id', s.holder_id,
    'percentage', s.percentage,
    'share', round(net_profit * s.percentage / 100, 2)
  )), '[]'::jsonb) into shares
  from vehicle_equity_splits s where s.vehicle_id = v.id;

  return jsonb_build_object(
    'sale_price', p_agreed_price,
    'purchase_price', v.purchase_price,
    'total_expenses', total_expenses,
    'months_in_inventory', round(months_in_inventory, 2),
    'overhead_total', round(overhead_total, 2),
    'discount', coalesce(p_discount, 0),
    'net_profit', round(net_profit, 2),
    'shares', shares
  );
end;
$$ language plpgsql stable;

grant execute on function preview_vehicle_sale_waterfall(uuid, numeric, numeric) to authenticated;

-- Executes the sale: this is the piece the old app never had —
-- it only had a read-only "what-if" modal. This actually persists
-- the ledger entries, flips vehicle status, and closes the ticket.
create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)
returns jsonb as $$
declare
  t deal_tickets%rowtype;
  v vehicles%rowtype;
  months_in_inventory numeric;
  overhead_total numeric;
  total_expenses numeric;
  net_profit numeric;
  split_row vehicle_equity_splits%rowtype;
  share numeric;
begin
  if not is_manager_or_above() then
    raise exception 'Only a branch manager or CEO can execute a sale';
  end if;

  select * into t from deal_tickets where id = p_deal_ticket_id for update;
  if not found then
    raise exception 'Deal ticket not found';
  end if;
  if t.status <> 'approved' then
    raise exception 'Deal ticket must be approved before it can be executed (current status: %)', t.status;
  end if;

  select * into v from vehicles where id = t.vehicle_id for update;
  if v.status = 'sold' then
    raise exception 'Vehicle already sold';
  end if;

  months_in_inventory := greatest(extract(epoch from (now() - v.created_at)) / (30*86400), 0);

  select coalesce(sum(amount),0) into total_expenses from vehicle_expenses where vehicle_id = v.id;

  select coalesce(monthly_opex_amount,0) * months_in_inventory into overhead_total
  from overhead_config where branch_id = v.branch_id;
  overhead_total := coalesce(overhead_total, 0);

  net_profit := t.agreed_price - v.purchase_price - total_expenses - overhead_total - coalesce(t.discount_amount,0);

  for split_row in select * from vehicle_equity_splits where vehicle_id = v.id loop
    share := round(net_profit * split_row.percentage / 100, 2);
    insert into ledger_entries (holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
    values (
      split_row.holder_type,
      case when split_row.holder_type = 'ceo' then null else split_row.holder_id end,
      'sale_profit_share', share, t.id, v.id,
      format('Profit share from sale of %s %s %s (VIN %s)', v.year, v.make, v.model, coalesce(v.vin,'—'))
    );
  end loop;

  update vehicles set status = 'sold', sold_at = now() where id = v.id;
  update deal_tickets set status = 'executed', executed_at = now() where id = t.id;

  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    auth.uid(), 'execute_vehicle_sale', 'deal_ticket', t.id,
    jsonb_build_object('net_profit', net_profit, 'overhead_total', overhead_total, 'total_expenses', total_expenses)
  );

  return jsonb_build_object('net_profit', net_profit, 'overhead_total', overhead_total, 'total_expenses', total_expenses);
end;
$$ language plpgsql security definer set search_path = public, extensions;

grant execute on function execute_vehicle_sale(uuid) to authenticated;

-- ============================================================
-- 17. ROW LEVEL SECURITY
-- ============================================================
alter table branches               enable row level security;
alter table profiles               enable row level security;
alter table investors              enable row level security;
alter table vehicles                enable row level security;
alter table vehicle_equity_splits   enable row level security;
alter table vehicle_expenses        enable row level security;
alter table overhead_config         enable row level security;
alter table leads                   enable row level security;
alter table lead_comments           enable row level security;
alter table financing_partners      enable row level security;
alter table deal_tickets            enable row level security;
alter table deal_ticket_events      enable row level security;
alter table financing_requests      enable row level security;
alter table contracts               enable row level security;
alter table commission_tiers        enable row level security;
alter table ledger_entries          enable row level security;
alter table audit_log               enable row level security;

-- BRANCHES: everyone authenticated can read; only CEO manages
drop policy if exists "branches_select" on branches;
create policy "branches_select" on branches for select to authenticated using (true);
drop policy if exists "branches_write" on branches;
create policy "branches_write" on branches for all to authenticated using (is_ceo()) with check (is_ceo());

-- PROFILES: self, or manager+ can read; self can update own row
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select to authenticated
  using (id = auth.uid() or is_manager_or_above() or is_accountant_or_above());
drop policy if exists "profiles_update_self" on profiles;
create policy "profiles_update_self" on profiles for update to authenticated
  using (id = auth.uid() or is_ceo()) with check (id = auth.uid() or is_ceo());

-- INVESTORS: self, CEO
drop policy if exists "investors_select" on investors;
create policy "investors_select" on investors for select to authenticated
  using (id = auth.uid() or is_ceo() or is_accountant_or_above());
drop policy if exists "investors_write" on investors;
create policy "investors_write" on investors for all to authenticated
  using (is_ceo()) with check (is_ceo());

-- VEHICLES: own branch, or CEO all, or investor with equity in it
drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select to authenticated
  using (
    is_ceo()
    or branch_id = current_branch_id()
    or exists (
      select 1 from vehicle_equity_splits ves
      where ves.vehicle_id = vehicles.id and ves.holder_id = auth.uid()
    )
  );
drop policy if exists "vehicles_insert" on vehicles;
create policy "vehicles_insert" on vehicles for insert to authenticated
  with check (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));
drop policy if exists "vehicles_update" on vehicles;
create policy "vehicles_update" on vehicles for update to authenticated
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));
drop policy if exists "vehicles_delete" on vehicles;
create policy "vehicles_delete" on vehicles for delete to authenticated using (is_ceo());

-- VEHICLE EQUITY SPLITS: CEO writes; investor/accountant/manager can read
drop policy if exists "equity_splits_select" on vehicle_equity_splits;
create policy "equity_splits_select" on vehicle_equity_splits for select to authenticated
  using (
    is_ceo() or is_accountant_or_above() or is_manager_or_above()
    or holder_id = auth.uid()
  );
drop policy if exists "equity_splits_write" on vehicle_equity_splits;
create policy "equity_splits_write" on vehicle_equity_splits for all to authenticated
  using (is_ceo()) with check (is_ceo());

-- VEHICLE EXPENSES: accountant/manager/ceo read+write (trigger enforces override lock)
drop policy if exists "vehicle_expenses_select" on vehicle_expenses;
create policy "vehicle_expenses_select" on vehicle_expenses for select to authenticated
  using (is_accountant_or_above() or is_manager_or_above());
drop policy if exists "vehicle_expenses_insert" on vehicle_expenses;
create policy "vehicle_expenses_insert" on vehicle_expenses for insert to authenticated
  with check (is_accountant_or_above() or is_manager_or_above());
drop policy if exists "vehicle_expenses_update" on vehicle_expenses;
create policy "vehicle_expenses_update" on vehicle_expenses for update to authenticated
  using (is_accountant_or_above() or is_manager_or_above());
drop policy if exists "vehicle_expenses_delete" on vehicle_expenses;
create policy "vehicle_expenses_delete" on vehicle_expenses for delete to authenticated using (is_ceo());

-- OVERHEAD CONFIG: manager+ read, CEO writes
drop policy if exists "overhead_config_select" on overhead_config;
create policy "overhead_config_select" on overhead_config for select to authenticated
  using (is_manager_or_above() or is_accountant_or_above());
drop policy if exists "overhead_config_write" on overhead_config;
create policy "overhead_config_write" on overhead_config for all to authenticated
  using (is_ceo()) with check (is_ceo());

-- LEADS: sales_exec own, manager/ceo branch/all
drop policy if exists "leads_select" on leads;
create policy "leads_select" on leads for select to authenticated
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()) or salesperson_id = auth.uid());
drop policy if exists "leads_insert" on leads;
create policy "leads_insert" on leads for insert to authenticated
  with check (is_staff() and (salesperson_id = auth.uid() or is_manager_or_above()));
drop policy if exists "leads_update" on leads;
create policy "leads_update" on leads for update to authenticated
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()) or salesperson_id = auth.uid());
drop policy if exists "leads_delete" on leads;
create policy "leads_delete" on leads for delete to authenticated using (is_manager_or_above());

-- LEAD COMMENTS: follow parent lead's visibility
drop policy if exists "lead_comments_select" on lead_comments;
create policy "lead_comments_select" on lead_comments for select to authenticated
  using (exists (
    select 1 from leads l where l.id = lead_comments.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id()) or l.salesperson_id = auth.uid())
  ));
drop policy if exists "lead_comments_insert" on lead_comments;
create policy "lead_comments_insert" on lead_comments for insert to authenticated
  with check (is_staff());

-- FINANCING PARTNERS: all staff read (to pick on a deal), accountant/ceo write
drop policy if exists "financing_partners_select" on financing_partners;
create policy "financing_partners_select" on financing_partners for select to authenticated using (is_staff());
drop policy if exists "financing_partners_write" on financing_partners;
create policy "financing_partners_write" on financing_partners for all to authenticated
  using (is_accountant_or_above()) with check (is_accountant_or_above());

-- DEAL TICKETS: sales_exec own, manager/ceo branch/all
drop policy if exists "deal_tickets_select" on deal_tickets;
create policy "deal_tickets_select" on deal_tickets for select to authenticated
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()) or salesperson_id = auth.uid());
drop policy if exists "deal_tickets_insert" on deal_tickets;
create policy "deal_tickets_insert" on deal_tickets for insert to authenticated
  with check (is_staff() and (salesperson_id = auth.uid() or is_manager_or_above()));
drop policy if exists "deal_tickets_update" on deal_tickets;
create policy "deal_tickets_update" on deal_tickets for update to authenticated
  using (
    is_ceo()
    or (is_manager_or_above() and branch_id = current_branch_id())
    or (salesperson_id = auth.uid() and status = 'submitted')
  );

-- DEAL TICKET EVENTS: read-only audit trail, follows parent ticket visibility, no client inserts
drop policy if exists "deal_ticket_events_select" on deal_ticket_events;
create policy "deal_ticket_events_select" on deal_ticket_events for select to authenticated
  using (exists (
    select 1 from deal_tickets t where t.id = deal_ticket_events.deal_ticket_id
    and (is_ceo() or (is_manager_or_above() and t.branch_id = current_branch_id()) or t.salesperson_id = auth.uid())
  ));

-- FINANCING REQUESTS: follow parent ticket visibility
drop policy if exists "financing_requests_select" on financing_requests;
create policy "financing_requests_select" on financing_requests for select to authenticated
  using (exists (
    select 1 from deal_tickets t where t.id = financing_requests.deal_ticket_id
    and (is_ceo() or (is_manager_or_above() and t.branch_id = current_branch_id()) or t.salesperson_id = auth.uid())
  ));
drop policy if exists "financing_requests_insert" on financing_requests;
create policy "financing_requests_insert" on financing_requests for insert to authenticated with check (is_staff());
drop policy if exists "financing_requests_update" on financing_requests;
create policy "financing_requests_update" on financing_requests for update to authenticated
  using (is_accountant_or_above() or is_manager_or_above());

-- CONTRACTS: row only exists once approved (this is the lock); visible to
-- the ticket's own salesperson, branch manager, or CEO. No client writes.
drop policy if exists "contracts_select" on contracts;
create policy "contracts_select" on contracts for select to authenticated
  using (exists (
    select 1 from deal_tickets t where t.id = contracts.deal_ticket_id
    and (is_ceo() or (is_manager_or_above() and t.branch_id = current_branch_id()) or t.salesperson_id = auth.uid())
  ));

-- COMMISSION TIERS: staff read, manager+ writes
drop policy if exists "commission_tiers_select" on commission_tiers;
create policy "commission_tiers_select" on commission_tiers for select to authenticated using (is_staff());
drop policy if exists "commission_tiers_write" on commission_tiers;
create policy "commission_tiers_write" on commission_tiers for all to authenticated
  using (is_manager_or_above()) with check (is_manager_or_above());

-- LEDGER ENTRIES: CEO sees all; investor/sales_exec see only their own;
-- manual entry types insertable by accountant+ (profit-share rows are
-- only ever created by the security-definer execute_vehicle_sale()).
drop policy if exists "ledger_entries_select" on ledger_entries;
create policy "ledger_entries_select" on ledger_entries for select to authenticated
  using (
    is_ceo()
    or (holder_type = 'investor' and holder_id = auth.uid())
    or (holder_type = 'sales_exec' and holder_id = auth.uid())
  );
drop policy if exists "ledger_entries_insert" on ledger_entries;
create policy "ledger_entries_insert" on ledger_entries for insert to authenticated
  with check (is_accountant_or_above() and type <> 'sale_profit_share');

-- AUDIT LOG: CEO, accountant, and investors can read (per spec); no client writes
drop policy if exists "audit_log_select" on audit_log;
create policy "audit_log_select" on audit_log for select to authenticated
  using (is_ceo() or is_accountant_or_above() or current_role_name() = 'investor');

-- ============================================================
-- DONE. Re-run anytime — every statement is idempotent.
-- ============================================================
