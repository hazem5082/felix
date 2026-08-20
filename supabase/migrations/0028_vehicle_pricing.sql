-- ============================================================
-- 0028 — VEHICLE PRICING (sticker price and lowest offer)
--
-- Until now a vehicle carried exactly one number: purchase_price, the
-- acquisition cost. Every screen that needed "a price" reached for it —
-- including the CRM's vehicle pickers, which a sales executive uses all
-- day. No showroom shows its cost to the sales floor: the salesman's
-- numbers are the STICKER PRICE (what the shop asks) and the LOWEST
-- OFFER (the least it will accept). Cost is management's number.
--
-- Two nullable columns, because pricing happens after intake:
--
--   asking_price  the sticker / advertised price.
--   min_price     the negotiation floor. CHECKed to never exceed the
--                 asking price when both are set.
--
-- Both NULLABLE on purpose — stock is taken in before management prices
-- it, and a NOT NULL here would block intake exactly the way a NOT NULL
-- item_code would have in 0026. The app renders NULL as "not priced".
--
-- WHO MAY WRITE THEM — A COLUMN-LIMITED GRANT, THE 0024 PRECEDENT
-- ----------------------------------------------------------------
-- The tenant role holds no UPDATE on vehicles: every write goes through
-- SECURITY DEFINER RPCs, because a blanket UPDATE would let a crafted
-- PATCH set status='sold' with no ledger row behind it (0009 §6d's own
-- words). Pricing does not need an RPC's ceremony — it is two numeric
-- columns with no invariants beyond their CHECKs — so this migration
-- does what 0024 did for the contracts eta_* fields: grant UPDATE on
-- exactly these two columns. The existing vehicles_update policy
-- (is_ceo() or manager-on-own-branch), unreachable since 0009 for want
-- of a grant, becomes reachable for these two columns and nothing else.
-- status, purchase_price, vin and the rest stay exactly as writable as
-- they were: not at all.
--
-- THE INTAKE RPC IS NOT WIDENED. 0021/0025/0026 widened
-- create_vehicle_with_equity_splits() because their fields had no other
-- write path. These two now have one — the same column-limited UPDATE
-- the app's pricing form uses — so intake stays 17 arguments and the
-- app sets prices in a follow-up UPDATE when the intake form carries
-- them.
--
-- TWO TARGETS, BOTH REQUIRED (0014/0026/0027 — read those headers):
--   1. platform.tenant_ddl_template() — future showrooms.
--   2. Every existing t_<slug> schema, from platform.tenants.
--
-- Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0028 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0028 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The column anchor below quotes the vehicles DDL as 0026 left it.
  if position('  item_code       text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0028 PRECONDITION FAILED: the template has no vehicles.item_code. Apply 0026 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. the columns, directly under purchase_price so the three prices
  --     read as one block, plus the ordering CHECK. The anchor runs into
  --     the status line so it can only ever match the CREATE TABLE, not
  --     the RPC's column list (which names purchase_price too).
  c_col_from constant text := $p1$  purchase_price  numeric     not null check (purchase_price > 0),
  status          text        not null default 'in_stock' check (status in ('in_stock','reserved','sold')),$p1$;
  c_col_to   constant text := $p2$  purchase_price  numeric     not null check (purchase_price > 0),
  -- What the shop asks and the least it will take (0028). purchase_price
  -- above is management's confidential cost; these two are the numbers
  -- the sales floor works with. Nullable: priced after intake.
  asking_price    numeric     check (asking_price > 0),
  min_price       numeric     check (min_price > 0),
  constraint chk_vehicle_price_order
    check (asking_price is null or min_price is null or min_price <= asking_price),
  status          text        not null default 'in_stock' check (status in ('in_stock','reserved','sold')),$p2$;

  -- 2b. the grant, right after the SELECT grant whose comment explains
  --     why there is no blanket UPDATE. The column list IS the security
  --     boundary here — see the header.
  c_gnt_from constant text := $p3$grant select on vehicles to {{ROLE}};$p3$;
  c_gnt_to   constant text := $p4$grant select on vehicles to {{ROLE}};
-- 0028: pricing is the ONE direct write the tenant role holds on a
-- vehicle. Column-limited exactly as 0024 did for contracts.eta_*; the
-- vehicles_update policy (CEO, or a manager on their own branch) gates
-- the rows, this grant gates the columns, and everything else on the
-- row stays RPC-only.
grant update (asking_price, min_price) on vehicles to {{ROLE}};$p4$;
begin
  if position('  asking_price    numeric' in v_tpl) > 0 then
    raise notice '0028: template already carries vehicles.asking_price — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0028: template anchor 2a (columns) did not match. Template drifted from 0026.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0028: template anchor 2b (grant) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    -- Both anchors are prefixes of their replacements; a template that
    -- somehow carried two copies of either would have been amended twice.
    if (length(v_tpl) - length(replace(v_tpl, 'chk_vehicle_price_order', ''))) <> 23 then
      raise exception '0028: the template carries more than one price-order constraint.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'grant update (asking_price, min_price)', ''))) <> 38 then
      raise exception '0028: the template carries more than one pricing grant.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0028$ select %L::text $felix_0028$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0028: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0028: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.vehicles add column if not exists asking_price numeric check (asking_price > 0)', r.schema_name);
    execute format('alter table %I.vehicles add column if not exists min_price numeric check (min_price > 0)', r.schema_name);

    -- No `add constraint if not exists` in Postgres — guard by name.
    if not exists (
      select 1 from pg_constraint c
       join pg_class t      on t.oid = c.conrelid
       join pg_namespace ns on ns.oid = t.relnamespace
      where ns.nspname = r.schema_name and t.relname = 'vehicles'
        and c.conname = 'chk_vehicle_price_order'
    ) then
      execute format(
        'alter table %I.vehicles add constraint chk_vehicle_price_order '
        'check (asking_price is null or min_price is null or min_price <= asking_price)',
        r.schema_name
      );
    end if;

    -- Re-issuing a held column grant is a no-op, so no guard needed.
    execute format(
      'grant update (asking_price, min_price) on %I.vehicles to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0028: % amended.', r.schema_name;
  end loop;

  raise notice '0028: % tenant schema(s) carry sticker/min pricing.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
-- ============================================================
do $$
declare
  r record;
  v_bad text[] := '{}';
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles'
         and column_name in ('asking_price', 'min_price')
       having count(*) = 2
    ) then
      v_bad := v_bad || (r.schema_name || ' (columns)');
    end if;

    if not exists (
      select 1 from pg_constraint c
       join pg_class t      on t.oid = c.conrelid
       join pg_namespace ns on ns.oid = t.relnamespace
      where ns.nspname = r.schema_name and t.relname = 'vehicles'
        and c.conname = 'chk_vehicle_price_order'
    ) then
      v_bad := v_bad || (r.schema_name || ' (order check)');
    end if;

    -- The point of the exercise: the role may write these two columns…
    if not (has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'asking_price', 'update')
        and has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'min_price', 'update')) then
      v_bad := v_bad || (r.schema_name || ' (role cannot update prices)');
    end if;

    -- …and still not the columns the RPC ceremony exists to protect.
    if has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'status', 'update')
       or has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'purchase_price', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can update guarded columns!)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0028 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  asking_price    numeric' in platform.tenant_ddl_template()) = 0
     or position('grant update (asking_price, min_price) on vehicles' in platform.tenant_ddl_template()) = 0 then
    raise exception '0028 VERIFY FAILED: the template does not carry the pricing fields.';
  end if;

  raise notice '0028: verified — sticker/min pricing lives everywhere.';
end
$$;

notify pgrst, 'reload schema';

commit;
