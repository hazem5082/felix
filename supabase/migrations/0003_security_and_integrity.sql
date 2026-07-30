-- ============================================================
-- FILEX — Migration 0003: security hardening & data integrity
--
-- 0001 established the schema. This migration closes the holes an
-- audit of that schema found, and moves the invariants that lived
-- only in TypeScript down into the database where they belong.
--
-- HOW TO APPLY: paste into Supabase Dashboard > SQL Editor > New
-- query and Run. Idempotent — safe to re-run.
--
-- The ordering matters: helpers first, then guards, then policies.
-- ============================================================

-- pgcrypto must live in `extensions` because generate_contract_serial()
-- calls extensions.digest() explicitly. On a fresh/self-hosted Postgres
-- 0001 could land it in public and every ticket approval would fail.
create schema if not exists extensions;
do $$
begin
  if not exists (
    select 1 from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions'
  ) then
    if exists (select 1 from pg_extension where extname = 'pgcrypto') then
      alter extension pgcrypto set schema extensions;
    else
      create extension pgcrypto with schema extensions;
    end if;
  end if;
end $$;

-- ============================================================
-- 1. SHARED HELPERS
-- ============================================================

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

-- 0001's is_* helpers are `stable` but not `security definer`; they call
-- current_role_name(), which is. That works, but re-declaring them here
-- with an explicit search_path removes any ambiguity about resolution.
create or replace function is_investor() returns boolean as $$
  select current_role_name() = 'investor';
$$ language sql stable;

-- "Can this actor act on this branch?" — the check that was missing from
-- almost every write path in 0001. CEO and accountants are org-wide;
-- everyone else is confined to the branch on their profile.
create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $$
  select is_ceo()
      or is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = current_branch_id());
$$ language sql stable;

create or replace function can_read_branch(p_branch_id uuid) returns boolean as $$
  select is_ceo()
      or is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = current_branch_id());
$$ language sql stable;

-- ============================================================
-- 2. IDENTITY — the two total-compromise paths
-- ============================================================

-- 2a. Self-signup could name its own role.
--     0001 copied raw_user_meta_data->>'role' straight into profiles, so
--     anyone holding the public anon key could POST /auth/v1/signup with
--     {"data":{"role":"ceo"}} and land as CEO. Role and branch are now
--     assigned exclusively by an invitation row (created by a CEO) or by
--     the service-role provisioning path; anything else starts as the
--     least-privileged role.
create table if not exists staff_invitations (
  email       text        primary key,
  full_name   text        not null,
  role        text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor')),
  branch_id   uuid        references branches(id),
  invited_by  uuid        references profiles(id),
  accepted_at timestamptz,
  created_at  timestamptz default now()
);

create or replace function handle_new_user()
returns trigger as $$
declare
  inv staff_invitations%rowtype;
  v_role text := 'sales_exec';
  v_branch uuid := null;
  v_name text;
begin
  select * into inv from public.staff_invitations
   where lower(email) = lower(new.email) and accepted_at is null;

  if found then
    v_role := inv.role;
    v_branch := inv.branch_id;
    v_name := inv.full_name;
    update public.staff_invitations set accepted_at = now() where email = inv.email;
  else
    -- No invitation: metadata is untrusted, so it may supply a display
    -- name but never a role or a branch.
    v_name := coalesce(new.raw_user_meta_data->>'full_name', new.email);
  end if;

  insert into public.profiles (id, full_name, role, branch_id)
  values (new.id, v_name, v_role, v_branch)
  on conflict (id) do nothing;

  -- vehicle_equity_splits.holder_id has an FK to investors(id), but 0001
  -- never created that row for anyone — so funding an investor failed with
  -- a foreign-key violation. Provision it alongside the profile.
  if v_role = 'investor' then
    insert into public.investors (id) values (new.id) on conflict (id) do nothing;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill investors rows for anyone already provisioned as an investor.
insert into investors (id)
select p.id from profiles p
where p.role = 'investor'
  and not exists (select 1 from investors i where i.id = p.id);

-- 2b. profiles_update_self had no column restriction, so `update profiles
--     set role='ceo' where id = auth.uid()` passed both USING and WITH
--     CHECK. Every other policy in the system trusts profiles.role, so
--     this single hole handed any user the whole application.
create or replace function guard_profile_privilege_columns() returns trigger as $$
begin
  if (new.role is distinct from old.role or new.branch_id is distinct from old.branch_id)
     and not is_ceo() then
    raise exception 'Only the CEO can change a role or branch assignment (PRIVILEGE_LOCKED)';
  end if;
  -- Nobody may demote the last remaining CEO — that would lock the
  -- organisation out of its own administration screens permanently.
  if old.role = 'ceo' and new.role is distinct from 'ceo'
     and (select count(*) from profiles where role = 'ceo') <= 1 then
    raise exception 'Cannot remove the last CEO account (LAST_CEO)';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_guard_profile_privileges on profiles;
create trigger trg_guard_profile_privileges
  before update on profiles
  for each row execute function guard_profile_privilege_columns();

-- Keep the investors row in step when a CEO changes someone's role.
create or replace function sync_investor_row() returns trigger as $$
begin
  if new.role = 'investor' then
    insert into public.investors (id) values (new.id) on conflict (id) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_sync_investor_row on profiles;
create trigger trg_sync_investor_row
  after insert or update of role on profiles
  for each row execute function sync_investor_row();

-- ============================================================
-- 3. DEAL TICKETS — the approval gate
-- ============================================================

-- 3a. Sign constraints. 0001 checked agreed_price > 0 but left discount
--     and down_payment unconstrained, so a negative discount added
--     phantom profit that was then paid out in immutable ledger rows.
alter table deal_tickets drop constraint if exists deal_tickets_discount_sane;
alter table deal_tickets add constraint deal_tickets_discount_sane
  check (discount_amount >= 0 and discount_amount <= agreed_price);

alter table deal_tickets drop constraint if exists deal_tickets_down_payment_sane;
alter table deal_tickets add constraint deal_tickets_down_payment_sane
  check (down_payment is null or (down_payment >= 0 and down_payment <= agreed_price));

alter table overhead_config drop constraint if exists overhead_config_non_negative;
alter table overhead_config add constraint overhead_config_non_negative
  check (monthly_opex_amount >= 0);

alter table financing_partners drop constraint if exists financing_partners_rate_sane;
alter table financing_partners add constraint financing_partners_rate_sane
  check (rate is null or (rate >= 0 and rate <= 100));

alter table financing_partners drop constraint if exists financing_partners_term_sane;
alter table financing_partners add constraint financing_partners_term_sane
  check (term_months is null or (term_months > 0 and term_months <= 480));

-- 3b. A ticket must start life as 'submitted' and may only advance through
--     legal transitions. 0001's approval trigger was BEFORE UPDATE only,
--     so a ticket could simply be INSERTed with status='approved' —
--     skipping the three-flag checklist entirely — or even 'executed'.
create or replace function guard_deal_ticket_status() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'submitted' then
      raise exception 'A new deal ticket must start as submitted (got %)', new.status;
    end if;
    if new.financial_check_passed or new.discount_validated or new.rate_revalidated then
      raise exception 'Review flags cannot be pre-set on a new deal ticket';
    end if;
    return new;
  end if;

  -- Only a reviewer may move the ticket or touch the review flags.
  if (new.status is distinct from old.status
      or new.financial_check_passed is distinct from old.financial_check_passed
      or new.discount_validated    is distinct from old.discount_validated
      or new.rate_revalidated      is distinct from old.rate_revalidated)
     and not is_manager_or_above() then
    raise exception 'Only a branch manager or the CEO can review a deal ticket (REVIEW_LOCKED)';
  end if;

  -- A reviewer must be scoped to the ticket's branch.
  if new.status is distinct from old.status and not can_act_on_branch(old.branch_id) then
    raise exception 'Not authorized to review a deal ticket for this branch';
  end if;

  -- Commercial terms freeze once the ticket leaves review.
  if old.status <> 'submitted'
     and (new.agreed_price   is distinct from old.agreed_price
       or new.discount_amount is distinct from old.discount_amount
       or new.vehicle_id      is distinct from old.vehicle_id
       or new.branch_id       is distinct from old.branch_id
       or new.salesperson_id  is distinct from old.salesperson_id) then
    raise exception 'Commercial terms are locked once a ticket has been reviewed (TERMS_LOCKED)';
  end if;

  -- Legal transitions only.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'submitted' and new.status in ('approved','rejected'))
      or (old.status = 'approved'  and new.status in ('executed','rejected'))
    ) then
      raise exception 'Illegal deal ticket transition: % -> %', old.status, new.status;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_guard_deal_ticket_status on deal_tickets;
create trigger trg_guard_deal_ticket_status
  before insert or update on deal_tickets
  for each row execute function guard_deal_ticket_status();

-- 3c. An installments deal with a NULL partner slipped past 0001's gate,
--     because the check was conditional on the partner being non-null.
create or replace function enforce_financing_partner_active() returns trigger as $$
begin
  if new.financing_type = 'installments' then
    if new.financing_partner_id is null then
      raise exception 'An installments deal requires a financing partner';
    end if;
    if not exists (
      select 1 from financing_partners
      where id = new.financing_partner_id and status = 'active'
    ) then
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

-- 3d. The ticket's branch must match its vehicle's branch. Without this a
--     salesperson could raise a ticket on another branch's car and have
--     their own manager approve it.
create or replace function enforce_ticket_matches_vehicle() returns trigger as $$
declare
  v_branch uuid;
  v_status text;
begin
  select branch_id, status into v_branch, v_status from vehicles where id = new.vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;
  if new.branch_id is distinct from v_branch then
    raise exception 'Deal ticket branch must match the vehicle''s branch';
  end if;
  if tg_op = 'INSERT' and v_status = 'sold' then
    raise exception 'Cannot raise a deal ticket against a vehicle that is already sold';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_ticket_matches_vehicle on deal_tickets;
create trigger trg_ticket_matches_vehicle
  before insert or update on deal_tickets
  for each row execute function enforce_ticket_matches_vehicle();

-- Only one live (approved-but-unexecuted) ticket per vehicle, so two
-- managers cannot settle the same car concurrently.
create unique index if not exists uniq_active_ticket_per_vehicle
  on deal_tickets(vehicle_id) where status = 'approved';

-- 3e. Approval also has to run on INSERT-time defence; keep the original
--     checklist assertion but scope the reviewer properly.
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
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
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
-- 4. EQUITY SPLITS — the cap table
-- ============================================================

-- One row per holder per vehicle. 0001 allowed a double-click during
-- intake to create two rows for the same investor, who was then paid twice.
create unique index if not exists uniq_split_investor_per_vehicle
  on vehicle_equity_splits(vehicle_id, holder_id) where holder_id is not null;
create unique index if not exists uniq_split_ceo_per_vehicle
  on vehicle_equity_splits(vehicle_id) where holder_type = 'ceo';

-- The sum-to-100 rule lived only in TypeScript, so a hand-crafted RPC call
-- could strand profit (under 100) and an UPDATE could double a payout
-- (over 100 — 0001's trigger was INSERT-only). A DEFERRABLE constraint
-- trigger lets a multi-row intake reach 100 before it is judged, and then
-- enforces it at COMMIT for every path, including direct SQL.
create or replace function check_equity_splits_sum() returns trigger as $$
declare
  v_vehicle uuid := coalesce(new.vehicle_id, old.vehicle_id);
  total numeric;
  n int;
begin
  select coalesce(sum(percentage),0), count(*) into total, n
    from vehicle_equity_splits where vehicle_id = v_vehicle;

  -- All rows removed (vehicle being deleted) — nothing to assert.
  if n = 0 then return null; end if;

  if abs(total - 100) > 0.01 then
    raise exception 'Equity splits for vehicle % must sum to 100%% (currently %)', v_vehicle, total;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_check_equity_splits on vehicle_equity_splits;
create constraint trigger trg_check_equity_splits
  after insert or update or delete on vehicle_equity_splits
  deferrable initially deferred
  for each row execute function check_equity_splits_sum();

-- "Immutable once sold" now actually covers INSERT too.
create or replace function prevent_split_edit_after_sale() returns trigger as $$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id) and status = 'sold'
  ) then
    raise exception 'Cannot modify equity splits after the vehicle has been sold';
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_lock_splits on vehicle_equity_splits;
create trigger trg_lock_splits
  before insert or update or delete on vehicle_equity_splits
  for each row execute function prevent_split_edit_after_sale();

-- ============================================================
-- 5. VEHICLES & EXPENSES
-- ============================================================

-- A sold vehicle must stay sold. 0001 let a manager flip it back to
-- in_stock and run the whole sale again, writing a second full set of
-- profit-share rows that no policy can reverse.
create or replace function guard_vehicle_status() returns trigger as $$
begin
  if old.status = 'sold' and new.status is distinct from 'sold' then
    raise exception 'A sold vehicle cannot be returned to inventory (SOLD_FINAL)';
  end if;
  if old.status = 'sold'
     and (new.purchase_price is distinct from old.purchase_price
       or new.branch_id      is distinct from old.branch_id
       or new.vin            is distinct from old.vin) then
    raise exception 'A sold vehicle''s cost basis is locked (SOLD_FINAL)';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_guard_vehicle_status on vehicles;
create trigger trg_guard_vehicle_status
  before update on vehicles
  for each row execute function guard_vehicle_status();

-- is_ceo_override permanently locks a row from non-CEO edits, so it was a
-- privilege the client should never have been able to grant itself. 0001's
-- lock trigger was UPDATE-only, leaving INSERT wide open.
create or replace function lock_ceo_override_expense() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.is_ceo_override and not is_ceo() then
      raise exception 'Only the CEO can record a CEO-override expense (CEO_OVERRIDE)';
    end if;
    new.created_by := coalesce(new.created_by, auth.uid());
    return new;
  end if;

  if old.is_ceo_override and not is_ceo() then
    raise exception 'This expense entry was CEO-overridden and is locked from further edits (CEO_OVERRIDE)';
  end if;
  if new.is_ceo_override and not old.is_ceo_override and not is_ceo() then
    raise exception 'Only the CEO can mark an expense as a CEO override (CEO_OVERRIDE)';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_lock_ceo_override on vehicle_expenses;
create trigger trg_lock_ceo_override
  before insert or update on vehicle_expenses
  for each row execute function lock_ceo_override_expense();

-- Expenses on a sold vehicle would silently change a cost basis that has
-- already been paid out.
create or replace function prevent_expense_after_sale() returns trigger as $$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id) and status = 'sold'
  ) then
    raise exception 'Cannot change expenses after the vehicle has been sold';
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_expense_after_sale on vehicle_expenses;
create trigger trg_expense_after_sale
  before insert or update or delete on vehicle_expenses
  for each row execute function prevent_expense_after_sale();

-- ============================================================
-- 6. FINANCING
-- ============================================================

-- The upload gate only tested for NULL, so contract_file_url = '-' was
-- enough to activate a partner. Require a real absolute URL.
create or replace function enforce_financing_partner_upload_gate() returns trigger as $$
begin
  if new.status = 'active' then
    if new.contract_file_url is null or new.contract_file_url !~ '^https://[^/]+/.+' then
      raise exception 'A financing partner cannot be activated without an uploaded bank contract file';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_financing_partner_gate on financing_partners;
create trigger trg_financing_partner_gate
  before insert or update on financing_partners
  for each row execute function enforce_financing_partner_upload_gate();

drop trigger if exists trg_financing_requests_updated_at on financing_requests;
create trigger trg_financing_requests_updated_at
  before update on financing_requests
  for each row execute function set_updated_at();

-- ============================================================
-- 7. THE WATERFALL
-- ============================================================

-- Both the preview and the commit need identical inputs, or a manager
-- approves one number and books another. This single source of truth is
-- SECURITY DEFINER so every role — including a sales_exec, who cannot read
-- vehicle_expenses or overhead_config — sees the true figures instead of
-- silently getting zeros. It takes an explicit as-of timestamp so the
-- preview and the execution agree on months_in_inventory.
create or replace function compute_sale_waterfall(
  p_vehicle_id uuid,
  p_agreed_price numeric,
  p_discount numeric default 0,
  p_as_of timestamptz default now()
) returns jsonb as $$
declare
  v vehicles%rowtype;
  months_in_inventory numeric;
  overhead_total numeric;
  total_expenses numeric;
  net_profit numeric;
  shares jsonb;
  allocated numeric;
  remainder numeric;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  if not (is_ceo() or is_accountant_or_above()
          or v.branch_id = current_branch_id()
          or exists (select 1 from vehicle_equity_splits s
                      where s.vehicle_id = v.id and s.holder_id = auth.uid())) then
    raise exception 'Not authorized to view this vehicle''s waterfall';
  end if;

  months_in_inventory := greatest(extract(epoch from (p_as_of - v.created_at)) / (30*86400), 0);

  select coalesce(sum(amount),0) into total_expenses
    from vehicle_expenses where vehicle_id = v.id;

  select coalesce(monthly_opex_amount,0) * months_in_inventory into overhead_total
    from overhead_config where branch_id = v.branch_id;
  overhead_total := round(coalesce(overhead_total, 0), 2);

  net_profit := round(
    p_agreed_price - v.purchase_price - total_expenses - overhead_total - coalesce(p_discount,0), 2);

  select coalesce(jsonb_agg(jsonb_build_object(
    'holder_type', s.holder_type,
    'holder_id',   s.holder_id,
    'percentage',  s.percentage,
    'share',       round(net_profit * s.percentage / 100, 2)
  ) order by s.holder_type, s.holder_id), '[]'::jsonb) into shares
  from vehicle_equity_splits s where s.vehicle_id = v.id;

  -- Per-holder round() leaves a cent or two unallocated. Push the residual
  -- onto the CEO line so the shares always sum exactly to net_profit.
  select coalesce(sum((e->>'share')::numeric), 0) into allocated
    from jsonb_array_elements(shares) e;
  remainder := round(net_profit - allocated, 2);

  if remainder <> 0 and jsonb_array_length(shares) > 0 then
    select jsonb_agg(
      case when (e->>'holder_type') = 'ceo'
        then jsonb_set(e, '{share}', to_jsonb(round((e->>'share')::numeric + remainder, 2)))
        else e end
    ) into shares
    from jsonb_array_elements(shares) e;
  end if;

  return jsonb_build_object(
    'sale_price',          p_agreed_price,
    'purchase_price',      v.purchase_price,
    'total_expenses',      total_expenses,
    'months_in_inventory', round(months_in_inventory, 2),
    'overhead_total',      overhead_total,
    'discount',            coalesce(p_discount, 0),
    'net_profit',          net_profit,
    'shares',              shares
  );
end;
$$ language plpgsql stable security definer set search_path = public, extensions;

grant execute on function compute_sale_waterfall(uuid, numeric, numeric, timestamptz) to authenticated;

-- Keep the original name working for the existing UI call site.
create or replace function preview_vehicle_sale_waterfall(
  p_vehicle_id uuid,
  p_agreed_price numeric,
  p_discount numeric default 0
) returns jsonb as $$
  select compute_sale_waterfall(p_vehicle_id, p_agreed_price, p_discount, now());
$$ language sql stable security definer set search_path = public, extensions;

grant execute on function preview_vehicle_sale_waterfall(uuid, numeric, numeric) to authenticated;

-- ── Commission ──────────────────────────────────────────────
-- commission_tiers has existed since 0001 and nothing has ever read it;
-- the 'commission' ledger type was likewise dead. Semantics implemented
-- here: tiers form a CUMULATIVE ladder keyed by the salesperson's count of
-- executed sales in the calendar month. Reaching tier N entitles them to
-- cumulative_amount(N) for the month, so a given sale pays the difference
-- between the new tier and the previous one. With the seeded ladder
-- (tier_index * 6000) that is a flat 6,000 per unit, but the table can
-- express any accelerating schedule.
create or replace function commission_for_sale(p_salesperson_id uuid, p_as_of timestamptz)
returns numeric as $$
declare
  units int;
  max_tier int;
  cur numeric;
  prev numeric;
begin
  select count(*) into units
    from deal_tickets
   where salesperson_id = p_salesperson_id
     and status = 'executed'
     and executed_at >= date_trunc('month', p_as_of)
     and executed_at <  date_trunc('month', p_as_of) + interval '1 month';

  if units = 0 then return 0; end if;

  select max(tier_index) into max_tier from commission_tiers;
  if max_tier is null then return 0; end if;

  select cumulative_amount into cur  from commission_tiers where tier_index = least(units, max_tier);
  select cumulative_amount into prev from commission_tiers where tier_index = least(units, max_tier) - 1;

  return greatest(coalesce(cur,0) - coalesce(prev,0), 0);
end;
$$ language plpgsql stable security definer set search_path = public, extensions;

-- ── Execution ───────────────────────────────────────────────
create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)
returns jsonb as $$
declare
  t deal_tickets%rowtype;
  v vehicles%rowtype;
  w jsonb;
  net_profit numeric;
  share_row jsonb;
  commission numeric;
  v_as_of timestamptz := now();
begin
  if not is_manager_or_above() then
    raise exception 'Only a branch manager or CEO can execute a sale';
  end if;

  select * into t from deal_tickets where id = p_deal_ticket_id for update;
  if not found then
    raise exception 'Deal ticket not found';
  end if;

  -- Missing from 0001: SECURITY DEFINER bypasses the branch filter in RLS,
  -- so without this a manager could settle any branch's ticket.
  if not can_act_on_branch(t.branch_id) then
    raise exception 'Not authorized to execute a sale for this branch';
  end if;

  if t.status <> 'approved' then
    raise exception 'Deal ticket must be approved before it can be executed (current status: %)', t.status;
  end if;

  select * into v from vehicles where id = t.vehicle_id for update;
  if v.status = 'sold' then
    raise exception 'Vehicle already sold';
  end if;

  -- Belt and braces against a double-post if two managers race.
  if exists (select 1 from ledger_entries
             where ref_deal_ticket_id = t.id and type = 'sale_profit_share') then
    raise exception 'This sale has already been posted to the ledger';
  end if;

  w := compute_sale_waterfall(v.id, t.agreed_price, t.discount_amount, v_as_of);
  net_profit := (w->>'net_profit')::numeric;

  for share_row in select * from jsonb_array_elements(w->'shares') loop
    insert into ledger_entries (holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
    values (
      share_row->>'holder_type',
      case when share_row->>'holder_type' = 'ceo' then null
           else (share_row->>'holder_id')::uuid end,
      'sale_profit_share',
      (share_row->>'share')::numeric,
      t.id, v.id,
      format('Profit share from sale of %s %s %s (VIN %s)', v.year, v.make, v.model, coalesce(v.vin,'—'))
    );
  end loop;

  update vehicles     set status = 'sold',     sold_at = v_as_of where id = v.id;
  update deal_tickets set status = 'executed', executed_at = v_as_of where id = t.id;

  -- Commission is only earned on a profitable sale, and is booked after
  -- the ticket flips to 'executed' so this unit counts toward the tier.
  if net_profit > 0 then
    commission := commission_for_sale(t.salesperson_id, v_as_of);
    if commission > 0 then
      insert into ledger_entries (holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
      values ('sales_exec', t.salesperson_id, 'commission', commission, t.id, v.id,
              format('Commission for %s %s %s', v.year, v.make, v.model));
    end if;
  end if;

  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
  values (auth.uid(), 'execute_vehicle_sale', 'deal_ticket', t.id, w || jsonb_build_object('commission', coalesce(commission,0)));

  return w || jsonb_build_object('commission', coalesce(commission, 0));
end;
$$ language plpgsql security definer set search_path = public, extensions;

grant execute on function execute_vehicle_sale(uuid) to authenticated;

-- Vehicle intake: managers may take in stock, but the cap table stays a
-- CEO instrument. 0001 let a manager write splits through this SECURITY
-- DEFINER function even though equity_splits_write is CEO-only.
create or replace function create_vehicle_with_equity_splits(
  p_branch_id uuid,
  p_vin text,
  p_year int,
  p_make text,
  p_model text,
  p_trim text,
  p_purchase_price numeric,
  p_photos text[],
  p_splits jsonb
) returns uuid as $$
declare
  v_id uuid;
  split jsonb;
  total numeric := 0;
  non_ceo int := 0;
begin
  if not (is_ceo() or (is_manager_or_above() and p_branch_id = current_branch_id())) then
    raise exception 'Not authorized to intake a vehicle for this branch';
  end if;

  select coalesce(sum((s->>'percentage')::numeric), 0),
         count(*) filter (where s->>'holder_type' <> 'ceo')
    into total, non_ceo
  from jsonb_array_elements(coalesce(p_splits,'[]'::jsonb)) s;

  if abs(total - 100) > 0.01 then
    raise exception 'Equity splits must sum to 100%% (got %)', total;
  end if;

  -- A manager may fund a car entirely from company equity; allocating a
  -- stake to an outside investor is the CEO's decision.
  if non_ceo > 0 and not is_ceo() then
    raise exception 'Only the CEO can allocate investor equity on a vehicle';
  end if;

  insert into vehicles (branch_id, vin, year, make, model, trim, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())
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
-- 8. UNIVERSAL AUDIT TRAIL
--    0001 wrote exactly one audit_log row, from execute_vehicle_sale.
--    Every other mutation was invisible. This captures them all.
-- ============================================================

alter table audit_log add column if not exists before_data jsonb;
alter table audit_log add column if not exists after_data  jsonb;

create or replace function record_audit() returns trigger as $$
declare
  v_entity uuid;
begin
  v_entity := case
    when tg_op = 'DELETE' then (to_jsonb(old)->>'id')::uuid
    else (to_jsonb(new)->>'id')::uuid
  end;

  insert into audit_log (actor_id, action, entity_type, entity_id, detail, before_data, after_data)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity,
    jsonb_build_object('table', tg_table_name, 'op', tg_op),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$ language plpgsql security definer set search_path = public, extensions;

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'vehicles','vehicle_equity_splits','vehicle_expenses','deal_tickets',
    'financing_partners','financing_requests','overhead_config',
    'commission_tiers','ledger_entries','profiles','branches','investors','leads'
  ] loop
    execute format('drop trigger if exists trg_audit_%1$s on %1$I', tbl);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on %1$I
         for each row execute function record_audit()', tbl);
  end loop;
end $$;

-- The audit trail is append-only, even for the CEO.
create or replace function reject_audit_mutation() returns trigger as $$
begin
  raise exception 'The audit log is append-only';
end;
$$ language plpgsql;

drop trigger if exists trg_audit_immutable on audit_log;
create trigger trg_audit_immutable
  before update or delete on audit_log
  for each row execute function reject_audit_mutation();

-- ============================================================
-- 9. RATE LIMITING
--    There is no KV/Durable Object binding in this deployment, so the
--    counter lives in Postgres. Called from the login and public
--    referral paths via the service-role client.
-- ============================================================

create table if not exists rate_limit_buckets (
  bucket_key   text        primary key,
  window_start timestamptz not null default now(),
  hits         int         not null default 0
);

create index if not exists idx_rate_limit_window on rate_limit_buckets(window_start);

create or replace function consume_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) returns jsonb as $$
declare
  b rate_limit_buckets%rowtype;
  now_ts timestamptz := now();
begin
  insert into rate_limit_buckets (bucket_key, window_start, hits)
  values (p_key, now_ts, 0)
  on conflict (bucket_key) do nothing;

  select * into b from rate_limit_buckets where bucket_key = p_key for update;

  if b.window_start < now_ts - make_interval(secs => p_window_seconds) then
    update rate_limit_buckets
       set window_start = now_ts, hits = 1
     where bucket_key = p_key;
    return jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'retry_after', 0);
  end if;

  if b.hits >= p_limit then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after', ceil(extract(epoch from (b.window_start + make_interval(secs => p_window_seconds) - now_ts)))
    );
  end if;

  update rate_limit_buckets set hits = hits + 1 where bucket_key = p_key;
  return jsonb_build_object('allowed', true, 'remaining', p_limit - b.hits - 1, 'retry_after', 0);
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- Housekeeping for abandoned buckets.
create or replace function prune_rate_limit_buckets() returns void as $$
  delete from rate_limit_buckets where window_start < now() - interval '1 day';
$$ language sql security definer set search_path = public, extensions;

alter table rate_limit_buckets enable row level security;
-- No policies: reachable only through the service-role client.

alter table staff_invitations enable row level security;
drop policy if exists "staff_invitations_ceo" on staff_invitations;
create policy "staff_invitations_ceo" on staff_invitations for all to authenticated
  using (is_ceo()) with check (is_ceo());

-- ============================================================
-- 10. RLS CORRECTIONS
-- ============================================================

-- PROFILES — self-service is limited to contact details by the trigger in
-- section 2b; the CEO manages roles and branches.
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select to authenticated
  using (
    id = auth.uid()
    or is_ceo()
    or is_accountant_or_above()
    or (is_manager_or_above() and (branch_id = current_branch_id() or branch_id is null))
  );

drop policy if exists "profiles_insert" on profiles;
create policy "profiles_insert" on profiles for insert to authenticated
  with check (is_ceo());

drop policy if exists "profiles_delete" on profiles;
create policy "profiles_delete" on profiles for delete to authenticated
  using (is_ceo() and id <> auth.uid());

-- INVESTORS — branch managers run vehicle intake, so they need the picker.
drop policy if exists "investors_select" on investors;
create policy "investors_select" on investors for select to authenticated
  using (id = auth.uid() or is_ceo() or is_accountant_or_above() or is_manager_or_above());

-- VEHICLES — accountants own the cost base org-wide, so they must see it.
drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select to authenticated
  using (
    is_ceo()
    or is_accountant_or_above()
    or branch_id = current_branch_id()
    or exists (
      select 1 from vehicle_equity_splits ves
      where ves.vehicle_id = vehicles.id and ves.holder_id = auth.uid()
    )
  );

-- EQUITY SPLITS — a manager sees their own branch's cap table, not every
-- branch's confidential funding structure.
drop policy if exists "equity_splits_select" on vehicle_equity_splits;
create policy "equity_splits_select" on vehicle_equity_splits for select to authenticated
  using (
    is_ceo()
    or is_accountant_or_above()
    or holder_id = auth.uid()
    or (is_manager_or_above() and exists (
      select 1 from vehicles v
      where v.id = vehicle_equity_splits.vehicle_id and v.branch_id = current_branch_id()))
  );

-- VEHICLE EXPENSES — scoped to the vehicle's branch on every verb.
drop policy if exists "vehicle_expenses_select" on vehicle_expenses;
create policy "vehicle_expenses_select" on vehicle_expenses for select to authenticated
  using (exists (
    select 1 from vehicles v where v.id = vehicle_expenses.vehicle_id and can_read_branch(v.branch_id)));

drop policy if exists "vehicle_expenses_insert" on vehicle_expenses;
create policy "vehicle_expenses_insert" on vehicle_expenses for insert to authenticated
  with check (
    (is_accountant_or_above() or is_manager_or_above())
    and exists (select 1 from vehicles v where v.id = vehicle_id and can_act_on_branch(v.branch_id)));

drop policy if exists "vehicle_expenses_update" on vehicle_expenses;
create policy "vehicle_expenses_update" on vehicle_expenses for update to authenticated
  using (
    (is_accountant_or_above() or is_manager_or_above())
    and exists (select 1 from vehicles v where v.id = vehicle_expenses.vehicle_id and can_act_on_branch(v.branch_id)));

-- DEAL TICKETS — the accountant's own nav points at /deals, but 0001 gave
-- them no read path, so the page was permanently empty.
drop policy if exists "deal_tickets_select" on deal_tickets;
create policy "deal_tickets_select" on deal_tickets for select to authenticated
  using (
    is_ceo()
    or is_accountant_or_above()
    or (is_manager_or_above() and branch_id = current_branch_id())
    or salesperson_id = auth.uid()
  );

drop policy if exists "deal_tickets_insert" on deal_tickets;
create policy "deal_tickets_insert" on deal_tickets for insert to authenticated
  with check (
    is_staff()
    and (salesperson_id = auth.uid() or is_manager_or_above())
    and status = 'submitted'
  );

drop policy if exists "deal_ticket_events_select" on deal_ticket_events;
create policy "deal_ticket_events_select" on deal_ticket_events for select to authenticated
  using (exists (
    select 1 from deal_tickets t where t.id = deal_ticket_events.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

drop policy if exists "contracts_select" on contracts;
create policy "contracts_select" on contracts for select to authenticated
  using (exists (
    select 1 from deal_tickets t where t.id = contracts.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

-- FINANCING REQUESTS — readable by the accountant, writable only within
-- the parent ticket's branch.
drop policy if exists "financing_requests_select" on financing_requests;
create policy "financing_requests_select" on financing_requests for select to authenticated
  using (exists (
    select 1 from deal_tickets t where t.id = financing_requests.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

drop policy if exists "financing_requests_insert" on financing_requests;
create policy "financing_requests_insert" on financing_requests for insert to authenticated
  with check (exists (
    select 1 from deal_tickets t where t.id = deal_ticket_id
    and (is_staff() and (t.salesperson_id = auth.uid() or can_act_on_branch(t.branch_id)))));

drop policy if exists "financing_requests_update" on financing_requests;
create policy "financing_requests_update" on financing_requests for update to authenticated
  using (
    (is_accountant_or_above() or is_manager_or_above())
    and exists (select 1 from deal_tickets t
                 where t.id = financing_requests.deal_ticket_id and can_act_on_branch(t.branch_id)));

-- LEAD COMMENTS — mirror the parent lead's visibility and pin authorship.
drop policy if exists "lead_comments_insert" on lead_comments;
create policy "lead_comments_insert" on lead_comments for insert to authenticated
  with check (
    is_staff()
    and author_id = auth.uid()
    and exists (
      select 1 from leads l where l.id = lead_id
      and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
           or l.salesperson_id = auth.uid())));

-- LEDGER — the accountant keeps the books, so they must be able to read
-- them. 0001 let them INSERT rows they could never see.
drop policy if exists "ledger_entries_select" on ledger_entries;
create policy "ledger_entries_select" on ledger_entries for select to authenticated
  using (
    is_ceo()
    or is_accountant_or_above()
    or (holder_type = 'investor'   and holder_id = auth.uid())
    or (holder_type = 'sales_exec' and holder_id = auth.uid())
  );

-- COMMISSION TIERS — org-wide schedule, so CEO-only. A branch manager
-- could previously rewrite every salesperson's pay in every branch.
drop policy if exists "commission_tiers_write" on commission_tiers;
create policy "commission_tiers_write" on commission_tiers for all to authenticated
  using (is_ceo()) with check (is_ceo());

-- AUDIT LOG — now that it captures every mutation, an unscoped investor
-- read would expose the whole company's books.
drop policy if exists "audit_log_select" on audit_log;
create policy "audit_log_select" on audit_log for select to authenticated
  using (is_ceo() or is_accountant_or_above());

-- ============================================================
-- 11. INDEXES for the queries the app actually issues
-- ============================================================

create index if not exists idx_ledger_type_created  on ledger_entries(type, created_at desc);
create index if not exists idx_ledger_ref_ticket    on ledger_entries(ref_deal_ticket_id);
create index if not exists idx_ledger_ref_vehicle   on ledger_entries(ref_vehicle_id);
create index if not exists idx_deal_tickets_vehicle on deal_tickets(vehicle_id);
create index if not exists idx_deal_tickets_lead    on deal_tickets(lead_id);
create index if not exists idx_deal_tickets_created on deal_tickets(created_at desc);
create index if not exists idx_audit_log_created    on audit_log(created_at desc);
create index if not exists idx_audit_log_entity     on audit_log(entity_type, entity_id);
create index if not exists idx_audit_log_actor      on audit_log(actor_id);
create index if not exists idx_profiles_branch      on profiles(branch_id);
create index if not exists idx_profiles_role        on profiles(role);
create index if not exists idx_vehicles_created     on vehicles(created_at desc);
create index if not exists idx_leads_created        on leads(created_at desc);
create index if not exists idx_leads_status         on leads(status);

-- Free-text search over the columns the list screens filter on.
create index if not exists idx_vehicles_search on vehicles
  using gin (to_tsvector('simple', coalesce(make,'') || ' ' || coalesce(model,'') || ' ' || coalesce(vin,'')));
create index if not exists idx_leads_search on leads
  using gin (to_tsvector('simple', coalesce(client_name,'') || ' ' || coalesce(phone_number,'')));

-- ============================================================
-- DONE. Re-run anytime — every statement is idempotent.
-- ============================================================
