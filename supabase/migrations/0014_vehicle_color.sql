-- ============================================================
-- 0014 — VEHICLE COLOUR
--
-- Adds vehicles.color and threads it through the one write path,
-- create_vehicle_with_equity_splits(). Colour is the first thing a buyer
-- asks about and the last thing anyone can recover once the car is sold,
-- so it belongs on the intake record rather than in a note.
--
-- NOT SOURCED FROM vPIC. The make/model pickers are backed by the NHTSA
-- vPIC API; that API has no colour endpoint (colour is not a VIN-derived
-- attribute — it is a build-sheet one). The picker is therefore a fixed
-- list in src/lib/nhtsa.ts alongside COMMON_TRIMS, and the column is a
-- plain nullable text with no CHECK: a showroom that trades a car in
-- "Nardo Grey" must be able to record it, and a constraint here would
-- turn that into a failed intake.
--
-- TWO TARGETS, BOTH REQUIRED
-- --------------------------
-- A schema-per-tenant column lands in two places or it is not landed:
--
--   1. platform.tenant_ddl_template() — so every FUTURE showroom is
--      provisioned with it. 0009 keeps the template as retrievable TEXT
--      precisely so a later migration can amend it; this file reads that
--      text, applies four anchored substitutions, and writes it back
--      rather than restating 3,000 lines of DDL it does not own.
--   2. Every EXISTING t_<slug> schema, discovered from platform.tenants.
--
-- Skip (1) and the column silently stops existing for the next showroom
-- licensed. Skip (2) and it never exists for the ones already trading.
--
-- EVERY SUBSTITUTION IS VERIFIED. replace() on a missing anchor is a
-- no-op that returns the input unchanged — it does not error. A template
-- amendment that quietly matched nothing would leave the function
-- syntactically valid and provision schemas missing the column, which
-- surfaces weeks later as "colour works on the old showrooms only". Each
-- replacement below therefore asserts the text actually changed.
--
-- THE RPC IS DROPPED, NOT JUST REPLACED. `create or replace function`
-- keys on the argument list, so adding p_color would leave the 9-argument
-- version in place beside the new 10-argument one. PostgREST resolves an
-- RPC by the names in the JSON body and refuses to choose between two
-- candidates it can both satisfy, so the old signature has to go or
-- vehicle intake starts failing with PGRST203.
--
-- Idempotent: re-running is safe. The template patch is skipped when the
-- new text is already present, and the per-schema DDL is add-column-if-
-- not-exists plus a drop/create pair.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0014 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0014 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- The anchors are quoted with distinct dollar tags because they contain
-- single quotes of their own (nullif(p_vin,'')). None of these tags
-- appears in 0009, so none of them can terminate the template early.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. the column, in the vehicles DDL
  c_col_from constant text := $a1$  trim            text,
  purchase_price  numeric     not null check (purchase_price > 0),$a1$;
  c_col_to   constant text := $a2$  trim            text,
  color           text,
  purchase_price  numeric     not null check (purchase_price > 0),$a2$;

  -- 2b. the RPC parameter
  c_sig_from constant text := $a3$  p_trim text,
  p_purchase_price numeric,$a3$;
  c_sig_to   constant text := $a4$  p_trim text,
  p_color text,
  p_purchase_price numeric,$a4$;

  -- 2c. the RPC insert
  c_ins_from constant text := $a5$  insert into vehicles (branch_id, vin, year, make, model, trim, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$a5$;
  c_ins_to   constant text := $a6$  insert into vehicles (branch_id, vin, year, make, model, trim, color, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$a6$;

  -- 2d. the grant
  c_gnt_from constant text := $a7$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, numeric, text[], jsonb)      to {{ROLE}};$a7$;
  c_gnt_to   constant text := $a8$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, numeric, text[], jsonb) to {{ROLE}};$a8$;
begin
  if position(c_col_to in v_tpl) > 0 then
    raise notice '0014: template already carries vehicles.color — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0014: template anchor 2a (vehicles.color column) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sig_from, c_sig_to);
    if position(c_sig_to in v_tpl) = 0 then
      raise exception '0014: template anchor 2b (p_color parameter) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ins_from, c_ins_to);
    if position(c_ins_to in v_tpl) = 0 then
      raise exception '0014: template anchor 2c (vehicles insert) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0014: template anchor 2d (execute grant) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    -- The 9-argument grant must be gone, not merely joined by a 10-argument
    -- one: a leftover would grant on a function the new template never
    -- creates, and provisioning would abort on "function does not exist".
    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0014: the 9-argument grant survived the amendment.';
    end if;

    -- `set search_path = pg_catalog` is carried over verbatim from 0009.
    -- create-or-replace keeps existing privileges, but 0009's
    -- `revoke all ... from public` is re-issued below rather than assumed.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0014$ select %L::text $felix_0014$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0014: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- search_path is set per schema and the DDL is unqualified, which is the
-- same mechanism create_tenant_schema() uses (0009 §"THE MECHANISM").
-- The function body is restated in full here because a plpgsql body is
-- stored as source text — there is no way to "add a parameter" to an
-- existing one.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0014: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.vehicles add column if not exists color text', r.schema_name);

    -- Drop the old signature before creating the new one, or PostgREST
    -- sees two overloads and returns PGRST203 on every intake.
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, numeric, text[], jsonb)',
      r.schema_name
    );

    execute format($ddl$
      create or replace function %1$I.create_vehicle_with_equity_splits(
        p_branch_id uuid,
        p_vin text,
        p_year int,
        p_make text,
        p_model text,
        p_trim text,
        p_color text,
        p_purchase_price numeric,
        p_photos text[],
        p_splits jsonb
      ) returns uuid as $fn$
      declare
        v_id uuid;
        split jsonb;
        total numeric := 0;
        non_ceo int := 0;
        v_holder uuid;
      begin
        if not exists (select 1 from branches where id = p_branch_id) then
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
          raise exception 'Equity splits must sum to 100%%%% (got %%)', total;
        end if;

        if non_ceo > 0 and not is_ceo() then
          raise exception 'Only the CEO can allocate investor equity on a vehicle';
        end if;

        insert into vehicles (branch_id, vin, year, make, model, trim, color, purchase_price, photos, created_by)
        values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
                p_purchase_price, coalesce(p_photos,'{}'), auth.uid())
        returning id into v_id;

        for split in select * from jsonb_array_elements(p_splits) loop
          v_holder := nullif(split->>'holder_id','')::uuid;

          if v_holder is not null
             and not exists (select 1 from investors where id = v_holder) then
            raise exception 'Investor not found';
          end if;

          insert into vehicle_equity_splits (vehicle_id, holder_type, holder_id, amount_invested, percentage)
          values (
            v_id,
            split->>'holder_type',
            v_holder,
            (split->>'amount_invested')::numeric,
            (split->>'percentage')::numeric
          );
        end loop;

        return v_id;
      end;
      $fn$ language plpgsql security definer set search_path = %1$I, extensions;
    $ddl$, r.schema_name);

    execute format(
      'grant execute on function %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, numeric, text[], jsonb) to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0014: % amended.', r.schema_name;
  end loop;

  raise notice '0014: % tenant schema(s) carry vehicles.color.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Provisioning failures in this architecture are silent and late, so the
-- migration proves its own result rather than trusting that section 3
-- reached every schema.
-- ============================================================
do $$
declare
  r record;
  v_bad text[] := '{}';
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles' and column_name = 'color'
    ) then
      v_bad := v_bad || (r.schema_name || ' (column)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, numeric, text[], jsonb)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (old rpc survived)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0014 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('color           text,' in platform.tenant_ddl_template()) = 0 then
    raise exception '0014 VERIFY FAILED: template does not carry vehicles.color.';
  end if;

  raise notice '0014: verified — colour is live on every tenant schema and in the template.';
end
$$;

-- PostgREST caches the schema; without this the new parameter is rejected
-- as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
