-- ============================================================
-- 0004 — MULTI-TENANCY
--
-- FELIX stops being one showroom's app and becomes a licensed
-- product. Each licensed showroom is a tenant, reached at its own
-- subdomain (<slug>-felix.508.world), seeing only its own rows.
--
-- Design rationale, and why this is a `tenant_id` column rather
-- than the platform-wide "clone the tables per client" decision:
-- see the vault note `felix/Felix SaaS Multi-Tenancy Plan.md`.
--
-- Two properties this migration is built around:
--
--  1. It does not rewrite any of the ~50 policies from 0001/0003.
--     Postgres ORs permissive policies together but ANDs
--     RESTRICTIVE ones on top, so one restrictive policy per table
--     adds tenant isolation as a hard conjunct to every existing
--     rule at once. Nothing that was previously allowed becomes
--     allowed across tenants, and no existing rule had to be
--     re-audited to get there.
--
--  2. It does not change a single query in the app. tenant_id
--     defaults to current_tenant_id() on insert, so existing
--     INSERTs keep working and land in the right tenant.
--
-- The tenant is ALWAYS derived from the authenticated user's own
-- profile row — never from a subdomain, header, or parameter. A
-- request therefore cannot assert a tenant it does not belong to,
-- which is what makes the subdomain safe to treat as mere routing.
-- ============================================================

-- Run as one transaction. This migration alters 18 tables, changes a
-- primary key, and replaces 6 functions on a database that is already
-- serving live traffic (the platform Supabase project is shared with
-- partners.508.world). Postgres DDL is transactional, so an explicit
-- BEGIN/COMMIT means any failure anywhere below leaves the schema
-- exactly as it was rather than half-migrated.
begin;

-- ============================================================
-- 1. TENANTS
-- ============================================================
create table if not exists tenants (
  id            uuid        primary key default gen_random_uuid(),
  slug          text        not null unique
                            check (slug ~ '^[a-z0-9]+$'),
  name          text        not null,
  status        text        not null default 'active'
                            check (status in ('active','suspended')),
  -- Provenance: which 508.world brand this licence was sold under.
  -- The Agent Portal's `brands` table is in this same Supabase project
  -- (the platform shares one project, per `06 - Tech Stack & Rules`), so
  -- this could be a real FK. Kept as the brand slug in text instead, so
  -- FELIX's migrations can still be applied to a standalone project
  -- without the Agent Portal's schema present.
  licensed_via  text,
  created_at    timestamptz not null default now()
);

comment on table tenants is
  'One licensed FELIX showroom. Provisioned by partners.508.world on licence approval; never self-registered.';

-- The flagship tenant: felix.508.world itself, which owns all the
-- pre-existing demo data. Fixed UUID so the backfill below is
-- re-runnable and so seed scripts can reference it.
insert into tenants (id, slug, name, licensed_via)
values ('00000000-0000-0000-0000-0000000f31e0', 'felix', 'FELIX Flagship Showroom', '508.world')
on conflict (id) do nothing;

-- ============================================================
-- 2. tenant_id ON EVERY TENANT-SCOPED TABLE
--
-- Done as a loop so all 18 tables get an identical shape. Divergence
-- between tables is the thing most likely to leave a hole, so there is
-- deliberately no per-table hand-written variant.
--
-- Split from the policy/default pass in section 4 for a hard reason:
-- current_tenant_id() selects profiles.tenant_id, and Postgres validates
-- a SQL-language function body when the function is created — so the
-- column has to exist before the function, and the function has to exist
-- before any default or policy that calls it.
--
-- audit_log and staff_invitations stay NULLABLE: both are written on
-- paths where there is no authenticated user to derive a tenant from
-- (service-role provisioning, pre-signup invitations). A NULL tenant_id
-- fails the isolation policy, so those rows are invisible to every
-- tenant rather than visible to all of them.
-- ============================================================
create or replace function _tenant_scoped_tables(p_strict_only boolean default false)
returns text[] as $$
  select case when p_strict_only then
    array[
      'branches', 'profiles', 'investors', 'vehicles',
      'vehicle_equity_splits', 'vehicle_expenses', 'overhead_config',
      'leads', 'lead_comments', 'financing_partners', 'deal_tickets',
      'deal_ticket_events', 'financing_requests', 'contracts',
      'commission_tiers', 'ledger_entries'
    ]
  else
    array[
      'branches', 'profiles', 'investors', 'vehicles',
      'vehicle_equity_splits', 'vehicle_expenses', 'overhead_config',
      'leads', 'lead_comments', 'financing_partners', 'deal_tickets',
      'deal_ticket_events', 'financing_requests', 'contracts',
      'commission_tiers', 'ledger_entries',
      'audit_log', 'staff_invitations'
    ]
  end;
$$ language sql immutable;

do $$
declare
  t text;
begin
  foreach t in array _tenant_scoped_tables() loop
    execute format(
      'alter table %I add column if not exists tenant_id uuid references tenants(id)', t);

    -- Everything that existed before this migration belongs to the flagship.
    --
    -- Triggers are suspended for the backfill. Not cosmetic: audit_log's
    -- immutability trigger rejects UPDATE outright, the sold-vehicle locks
    -- on splits/expenses reject any edit to an already-sold car, and the
    -- deal-ticket status guard calls is_manager_or_above() — which is false
    -- for the migration's own session and would abort. None of those rules
    -- are about tenant_id; they would just veto a column that did not exist
    -- when they were written. Suspending them also keeps record_audit() from
    -- logging one audit row per backfilled row.
    execute format('alter table %I disable trigger user', t);
    execute format(
      'update %I set tenant_id = %L where tenant_id is null',
      t, '00000000-0000-0000-0000-0000000f31e0');
    execute format('alter table %I enable trigger user', t);

    execute format(
      'create index if not exists idx_%s_tenant on %I(tenant_id)', t, t);
  end loop;
end $$;

-- ============================================================
-- 3. current_tenant_id()
--
-- The single source of truth for "which tenant is this request?".
-- SECURITY DEFINER so it can read profiles without tripping the
-- restrictive policy that this very function powers — the same
-- pattern current_role_name() already uses in 0001.
-- ============================================================
create or replace function current_tenant_id() returns uuid as $$
  select tenant_id from public.profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public, extensions;

grant execute on function current_tenant_id() to authenticated;

-- ============================================================
-- 4. DEFAULTS, ISOLATION POLICIES, NOT NULL
--
-- The insert default is what keeps this migration from touching a
-- single query in the app: existing INSERTs omit tenant_id and land in
-- the caller's own tenant.
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array _tenant_scoped_tables() loop
    execute format(
      'alter table %I alter column tenant_id set default current_tenant_id()', t);

    -- The isolation conjunct. RESTRICTIVE => ANDed with every existing
    -- permissive policy on this table, so none of the ~50 policies from
    -- 0001/0003 had to be rewritten or re-audited.
    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format(
      'create policy %I on %I as restrictive for all to authenticated '
      'using (tenant_id = current_tenant_id()) '
      'with check (tenant_id = current_tenant_id())',
      t || '_tenant_isolation', t);
  end loop;

  foreach t in array _tenant_scoped_tables(true) loop
    execute format('alter table %I alter column tenant_id set not null', t);
  end loop;
end $$;

-- ============================================================
-- 4. PER-TENANT UNIQUENESS
--
-- Two tables keyed on something that is only unique *within* a
-- showroom. Left alone, the second tenant to be provisioned would
-- collide with the first.
-- ============================================================

-- commission_tiers was keyed on tier_index alone, so tier 1 could
-- only exist once across the whole platform.
alter table commission_tiers drop constraint if exists commission_tiers_pkey;
alter table commission_tiers add primary key (tenant_id, tier_index);

-- overhead_config is keyed on branch_id, and branches are already
-- tenant-scoped, so it cannot collide — no change needed.

-- staff_invitations stays keyed on email: auth.users.email is
-- globally unique, so one email genuinely cannot be invited into
-- two tenants. Keeping the PK as-is preserves handle_new_user()'s
-- email-only lookup.

-- ============================================================
-- 5. TENANTS VISIBILITY
--
-- A user may read their own tenant row (the app shows the showroom
-- name in the shell) and nothing else. All writes are service-role
-- only — provisioning, never self-service.
-- ============================================================
alter table tenants enable row level security;

drop policy if exists "tenants_select_own" on tenants;
create policy "tenants_select_own" on tenants for select to authenticated
  using (id = current_tenant_id());

-- ============================================================
-- 6. IDENTITY — tenant assignment at signup
--
-- 0003 established that role and branch may only come from an
-- invitation row, never from user-supplied metadata. tenant_id now
-- rides the same rail, for the same reason: if metadata could name
-- a tenant, anyone with the anon key could sign up into someone
-- else's showroom.
-- ============================================================
create or replace function handle_new_user()
returns trigger as $$
declare
  inv staff_invitations%rowtype;
  v_role text := 'sales_exec';
  v_branch uuid := null;
  v_tenant uuid := null;
  v_name text;
begin
  select * into inv from public.staff_invitations
   where lower(email) = lower(new.email) and accepted_at is null;

  if found then
    v_role := inv.role;
    v_branch := inv.branch_id;
    v_tenant := inv.tenant_id;
    v_name := inv.full_name;
    update public.staff_invitations set accepted_at = now() where email = inv.email;
  else
    v_name := coalesce(new.raw_user_meta_data->>'full_name', new.email);
  end if;

  -- No invitation means no showroom to belong to. profiles.tenant_id is
  -- NOT NULL, so this would fail anyway — but as a bare constraint
  -- violation that reads like a bug. Raised explicitly instead, because
  -- it is the intended answer: FELIX has no self-signup. Every account
  -- is created either by provisioning or by a CEO inviting a colleague,
  -- and an uninvited signup must not quietly land in some showroom.
  if v_tenant is null then
    raise exception 'No invitation exists for % — FELIX accounts are created by invitation only (NO_INVITATION)', new.email;
  end if;

  insert into public.profiles (id, full_name, role, branch_id, tenant_id)
  values (new.id, v_name, v_role, v_branch, v_tenant)
  on conflict (id) do nothing;

  if v_role = 'investor' then
    insert into public.investors (id, tenant_id) values (new.id, v_tenant)
      on conflict (id) do nothing;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- investors rows are created by two triggers; both must carry the
-- tenant of the profile they mirror.
create or replace function sync_investor_row() returns trigger as $$
begin
  if new.role = 'investor' then
    insert into public.investors (id, tenant_id) values (new.id, new.tenant_id)
      on conflict (id) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_sync_investor_row on profiles;
create trigger trg_sync_investor_row
  after insert or update of role on profiles
  for each row execute function sync_investor_row();

-- tenant_id joins role and branch_id as a privileged column. Nobody
-- may move themselves — or anyone else — between showrooms; that
-- would be a self-service cross-tenant read.
create or replace function guard_profile_privilege_columns() returns trigger as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'A profile cannot be moved between tenants (TENANT_LOCKED)';
  end if;

  if (new.role is distinct from old.role or new.branch_id is distinct from old.branch_id)
     and not is_ceo() then
    raise exception 'Only the CEO can change a role or branch assignment (PRIVILEGE_LOCKED)';
  end if;

  -- Last-CEO protection is per tenant now: 0003 counted CEOs across
  -- the whole table, so once a second showroom existed, tenant A
  -- could have demoted its own last CEO while the count stayed >1.
  if old.role = 'ceo' and new.role is distinct from 'ceo'
     and (select count(*) from profiles
           where role = 'ceo' and tenant_id = old.tenant_id) <= 1 then
    raise exception 'Cannot remove the last CEO account (LAST_CEO)';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_guard_profile_privileges on profiles;
create trigger trg_guard_profile_privileges
  before update on profiles
  for each row execute function guard_profile_privilege_columns();

-- ============================================================
-- 7. SECURITY DEFINER RPCs — the real cross-tenant risk
--
-- Every function below runs as its owner and therefore bypasses
-- RLS entirely, restrictive policies included. They all take an id
-- as a parameter, so without an explicit check a user could pass a
-- *different tenant's* vehicle or ticket id and have the function
-- happily operate on it. 0003 added the equivalent branch checks
-- for exactly this reason; these are the tenant-level counterpart.
-- ============================================================

-- compute_sale_waterfall: reads another tenant's cost basis, expenses
-- and full cap table. Guarded before the existing branch/equity check.
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

  if v.tenant_id is distinct from current_tenant_id() then
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

-- commission_for_sale: counted units and read the tier ladder across
-- every tenant. With per-tenant ladders (section 4) an unscoped
-- lookup would also have become ambiguous, not just leaky.
create or replace function commission_for_sale(p_salesperson_id uuid, p_as_of timestamptz)
returns numeric as $$
declare
  units int;
  max_tier int;
  cur numeric;
  prev numeric;
  v_tenant uuid := current_tenant_id();
begin
  select count(*) into units
    from deal_tickets
   where salesperson_id = p_salesperson_id
     and tenant_id = v_tenant
     and status = 'executed'
     and executed_at >= date_trunc('month', p_as_of)
     and executed_at <  date_trunc('month', p_as_of) + interval '1 month';

  if units = 0 then return 0; end if;

  select max(tier_index) into max_tier from commission_tiers where tenant_id = v_tenant;
  if max_tier is null then return 0; end if;

  select cumulative_amount into cur  from commission_tiers
    where tenant_id = v_tenant and tier_index = least(units, max_tier);
  select cumulative_amount into prev from commission_tiers
    where tenant_id = v_tenant and tier_index = least(units, max_tier) - 1;

  return greatest(coalesce(cur,0) - coalesce(prev,0), 0);
end;
$$ language plpgsql stable security definer set search_path = public, extensions;

-- execute_vehicle_sale: the most damaging of the three. Unscoped, a
-- manager could settle another showroom's approved ticket, posting
-- real ledger entries against that showroom's investors.
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

  if t.tenant_id is distinct from current_tenant_id() then
    raise exception 'Deal ticket not found';
  end if;

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
    insert into ledger_entries (tenant_id, holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
    values (
      t.tenant_id,
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
      insert into ledger_entries (tenant_id, holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
      values (t.tenant_id, 'sales_exec', t.salesperson_id, 'commission', commission, t.id, v.id,
              format('Commission for %s %s %s', v.year, v.make, v.model));
    end if;
  end if;

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (t.tenant_id, auth.uid(), 'execute_vehicle_sale', 'deal_ticket', t.id,
          w || jsonb_build_object('commission', coalesce(commission,0)));

  return w || jsonb_build_object('commission', coalesce(commission, 0));
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- create_vehicle_with_equity_splits: p_branch_id and every
-- holder_id arrive from the client. Without the checks below a
-- manager could book stock into another showroom's branch, or
-- assign equity to an investor who belongs to a different showroom.
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
  v_tenant uuid := current_tenant_id();
  v_holder uuid;
begin
  if v_tenant is null then
    raise exception 'No tenant on the acting profile';
  end if;

  if not exists (select 1 from branches
                  where id = p_branch_id and tenant_id = v_tenant) then
    raise exception 'Branch not found';
  end if;

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

  insert into vehicles (tenant_id, branch_id, vin, year, make, model, trim, purchase_price, photos, created_by)
  values (v_tenant, p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())
  returning id into v_id;

  for split in select * from jsonb_array_elements(p_splits) loop
    v_holder := nullif(split->>'holder_id','')::uuid;

    if v_holder is not null
       and not exists (select 1 from investors
                        where id = v_holder and tenant_id = v_tenant) then
      raise exception 'Investor not found';
    end if;

    insert into vehicle_equity_splits (tenant_id, vehicle_id, holder_type, holder_id, amount_invested, percentage)
    values (
      v_tenant,
      v_id,
      split->>'holder_type',
      v_holder,
      (split->>'amount_invested')::numeric,
      (split->>'percentage')::numeric
    );
  end loop;

  return v_id;
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- record_audit() writes audit_log from a generic trigger. It runs as
-- SECURITY DEFINER, so the column default (current_tenant_id()) is
-- still evaluated in the acting user's session context — correct as
-- written. Explicitly noted because it is the one insert path here
-- deliberately left alone.

-- ============================================================
-- 8. PROVISIONING
--
-- The only supported way a tenant comes into existence. Called by
-- the 508.world Worker with the service-role key after a licence
-- request is approved on partners.508.world.
--
-- Idempotent on slug so a retried approval (network timeout on an
-- otherwise-successful call) reuses the tenant instead of failing
-- or creating a duplicate showroom.
--
-- Deliberately does NOT create the CEO auth user: that needs the
-- Auth admin API, not SQL. The caller creates the user and relies
-- on the staff_invitations row written here to give that user the
-- right role and tenant when handle_new_user() fires.
-- ============================================================
create or replace function provision_tenant(
  p_slug text,
  p_name text,
  p_ceo_email text,
  p_ceo_full_name text,
  p_first_branch_name text default 'Main Showroom',
  p_licensed_via text default '508.world'
) returns jsonb as $$
declare
  v_tenant tenants%rowtype;
  v_branch_id uuid;
  v_created boolean := false;
begin
  select * into v_tenant from tenants where slug = p_slug;

  if not found then
    insert into tenants (slug, name, licensed_via)
    values (p_slug, p_name, p_licensed_via)
    returning * into v_tenant;
    v_created := true;
  end if;

  -- Baseline rows a showroom cannot function without. Each guarded
  -- so a retry is a no-op rather than a second branch.
  select id into v_branch_id from branches
   where tenant_id = v_tenant.id order by created_at limit 1;

  if v_branch_id is null then
    insert into branches (tenant_id, name)
    values (v_tenant.id, p_first_branch_name)
    returning id into v_branch_id;

    insert into overhead_config (tenant_id, branch_id, monthly_opex_amount)
    values (v_tenant.id, v_branch_id, 0)
    on conflict (branch_id) do nothing;
  end if;

  -- Same flat 6,000-per-unit ladder the flagship was seeded with;
  -- the tenant's CEO can reshape it from the Accountant Hub.
  insert into commission_tiers (tenant_id, tier_index, cumulative_amount)
  select v_tenant.id, i, i * 6000
  from generate_series(1, 10) i
  on conflict (tenant_id, tier_index) do nothing;

  -- The invitation is what makes the about-to-be-created auth user a
  -- CEO of this tenant. Without it they would land as a tenant-less
  -- sales_exec and see nothing.
  insert into staff_invitations (tenant_id, email, full_name, role, branch_id)
  values (v_tenant.id, lower(p_ceo_email), p_ceo_full_name, 'ceo', v_branch_id)
  on conflict (email) do update
    set tenant_id = excluded.tenant_id,
        full_name = excluded.full_name,
        role      = excluded.role,
        branch_id = excluded.branch_id,
        accepted_at = null
    where staff_invitations.accepted_at is null;

  return jsonb_build_object(
    'tenant_created', v_created,
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'status', v_tenant.status
    ),
    'branch_id', v_branch_id,
    'ceo_email', lower(p_ceo_email)
  );
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- Service role only. Never granted to `authenticated` or `anon`:
-- provisioning is a licensing action, not a self-service one.
revoke all on function provision_tenant(text, text, text, text, text, text) from public;

-- ============================================================
-- 9. BACKFILL SANITY
--
-- The flagship tenant must own exactly the pre-existing demo data.
-- A NULL here after this migration means a table was missed in
-- section 3, which would silently hide rows from the flagship.
-- ============================================================
do $$
declare
  n bigint;
begin
  select count(*) into n from profiles where tenant_id is null;
  if n > 0 then
    raise exception 'Backfill incomplete: % profiles without a tenant', n;
  end if;

  select count(*) into n from vehicles where tenant_id is null;
  if n > 0 then
    raise exception 'Backfill incomplete: % vehicles without a tenant', n;
  end if;

  -- Every tenant-scoped table must carry the isolation policy. A table
  -- that gained tenant_id but no policy would be readable across
  -- showrooms while looking, from the schema alone, perfectly fine.
  select count(*) into n
    from unnest(array[
      'branches','profiles','investors','vehicles','vehicle_equity_splits',
      'vehicle_expenses','overhead_config','leads','lead_comments',
      'financing_partners','deal_tickets','deal_ticket_events',
      'financing_requests','contracts','commission_tiers','ledger_entries',
      'audit_log','staff_invitations'
    ]) tbl
   where not exists (
     select 1 from pg_policies
      where schemaname = 'public' and tablename = tbl
        and policyname = tbl || '_tenant_isolation'
   );
  if n > 0 then
    raise exception '% tenant-scoped tables are missing their isolation policy', n;
  end if;
end $$;

commit;
