-- ============================================================
-- 0019 — BRANCH LICENSING (Egyptian permit tracking)
--
-- Adds five nullable columns to `branches`:
--
--   commercial_registration_no     the branch's commercial registration
--   tax_card_no                    the tax card number
--   trade_license_no               trade license (Ministry of Trade
--                                  Decree 323/1956 + Public
--                                  Establishments Law 154/2019)
--   trade_license_expiry           when that license lapses
--   is_under_residential_building  showrooms under residential buildings
--                                  must relocate by 2027; null means the
--                                  premises have not been assessed yet
--
-- All five are nullable on purpose. A showroom licensed before this
-- migration has none of these recorded, and provisioning plants a bare
-- 'Main Branch' row (0009 §7) that must keep succeeding with only a
-- name. A NOT NULL here would turn every existing branch row and every
-- future provisioning into a failure.
--
-- No RPC changes: nothing writes branches through a function —
-- provisioning INSERTs the seed row directly and the branches_write
-- policy (CEO-only) covers any future direct write. So unlike 0014/0015
-- there is no drop-and-recreate of a function and no grant to move; the
-- table-level grants from 0009 §6 already cover new columns.
--
-- TWO TARGETS, BOTH REQUIRED (same as 0014 — read that header first):
--   1. platform.tenant_ddl_template() — future showrooms.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- EVERY SUBSTITUTION IS VERIFIED: replace() on a missing anchor is a
-- silent no-op, so each amendment asserts the new text actually landed.
--
-- Idempotent: re-running is safe. The template patch is skipped when the
-- new text is already present, and the per-schema DDL is
-- add-column-if-not-exists.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0019 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0019 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- One anchor only: the tail of the branches CREATE TABLE. The anchor
-- includes the `address` line because `created_at  timestamptz default
-- now()` alone also matches the investors table; `  address     text,`
-- (this exact spacing) appears nowhere else in the template — leads'
-- address column is aligned differently.
-- ============================================================
do $mig$
declare
  v_tpl text := platform.tenant_ddl_template();

  c_col_from constant text := $a1$  address     text,
  created_at  timestamptz default now()
);
$a1$;
  c_col_to   constant text := $a2$  address     text,
  commercial_registration_no    text,
  tax_card_no                   text,
  trade_license_no              text,
  trade_license_expiry          date,
  is_under_residential_building boolean,
  created_at  timestamptz default now()
);

comment on column branches.trade_license_expiry is
  'Expiry of the trade license issued under Ministry of Trade Decree 323/1956 and Public Establishments Law 154/2019. Null until the showroom records it.';

comment on column branches.is_under_residential_building is
  'True when the branch premises sit under a residential building, which the 2027 relocation mandate requires the showroom to leave. Null means not yet assessed.';
$a2$;
begin
  if position('commercial_registration_no' in v_tpl) > 0 then
    raise notice '0019: template already carries branch licensing columns — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0019: template anchor (branches DDL tail) did not match. Template drifted from 0009.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0014.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0019$ select %L::text $felix_0019$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0019: template amended.';
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
    if to_regclass(format('%I.branches', r.schema_name)) is null then
      raise notice '0019: %.branches missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.branches add column if not exists commercial_registration_no text', r.schema_name);
    execute format('alter table %I.branches add column if not exists tax_card_no text', r.schema_name);
    execute format('alter table %I.branches add column if not exists trade_license_no text', r.schema_name);
    execute format('alter table %I.branches add column if not exists trade_license_expiry date', r.schema_name);
    execute format('alter table %I.branches add column if not exists is_under_residential_building boolean', r.schema_name);

    execute format(
      'comment on column %I.branches.trade_license_expiry is %L',
      r.schema_name,
      'Expiry of the trade license issued under Ministry of Trade Decree 323/1956 and Public Establishments Law 154/2019. Null until the showroom records it.'
    );
    execute format(
      'comment on column %I.branches.is_under_residential_building is %L',
      r.schema_name,
      'True when the branch premises sit under a residential building, which the 2027 relocation mandate requires the showroom to leave. Null means not yet assessed.'
    );

    v_count := v_count + 1;
    raise notice '0019: % amended.', r.schema_name;
  end loop;

  raise notice '0019: % tenant schema(s) carry branch licensing columns.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Provisioning failures in this architecture are silent and late, so the
-- migration proves its own result rather than trusting section 3.
-- ============================================================
do $$
declare
  r record;
  col text;
  v_bad text[] := '{}';
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.branches', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array[
      'commercial_registration_no',
      'tax_card_no',
      'trade_license_no',
      'trade_license_expiry',
      'is_under_residential_building'
    ] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'branches' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0019 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('is_under_residential_building boolean' in platform.tenant_ddl_template()) = 0 then
    raise exception '0019 VERIFY FAILED: template does not carry the branch licensing columns.';
  end if;

  raise notice '0019: verified — branch licensing columns live on every tenant schema and in the template.';
end
$$;

-- PostgREST caches the schema; without this the new columns are invisible
-- to selects until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
