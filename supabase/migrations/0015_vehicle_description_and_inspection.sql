-- ============================================================
-- 0015 — VEHICLE DESCRIPTION + INSPECTION PHOTOS
--
-- Two more intake fields, threaded through the same single write path as
-- 0014's colour:
--
--   description        free text. Modifications are the reason it exists —
--                      aftermarket rims, a spoiler, body work, a respray.
--                      These change what the car is worth and are invisible
--                      in year/make/model/trim, so today they get written
--                      into a note nobody reads, or lost.
--   inspection_photos  the intake condition report, kept SEPARATE from
--                      vehicles.photos. photos is the sale gallery — the
--                      flattering set that goes on a listing. Inspection
--                      shots are evidence of the car's state on the day it
--                      was taken in, which is what you need when a buyer
--                      disputes a scratch four months later. Merging them
--                      destroys that distinction permanently, and no later
--                      migration can separate them again.
--
-- Both optional: a showroom taking in a clean stock car should not have to
-- invent content to complete an intake.
--
-- STRUCTURE MIRRORS 0014 EXACTLY — read that file's header first. Same two
-- targets (the DDL template for future showrooms, every live t_<slug> for
-- the ones already trading), same anchored-and-verified substitutions, same
-- drop-then-create on the RPC because `create or replace function` keys on
-- the argument list and PostgREST refuses to choose between two overloads
-- it can both satisfy (PGRST203).
--
-- ORDERING: this file assumes 0014 has been applied — it rewrites 0014's
-- 10-argument RPC into a 12-argument one and its precondition block fails
-- loudly rather than silently skipping if colour is not there yet.
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
      '0015 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('color           text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0015 PRECONDITION FAILED: the template has no vehicles.color. Apply 0014 first.';
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

  -- 2a. the columns, in the vehicles DDL
  c_col_from constant text := $a1$  color           text,
  purchase_price  numeric     not null check (purchase_price > 0),$a1$;
  c_col_to   constant text := $a2$  color           text,
  description     text,
  inspection_photos text[]    not null default '{}',
  purchase_price  numeric     not null check (purchase_price > 0),$a2$;

  -- 2b. the RPC parameters
  c_sig_from constant text := $a3$  p_color text,
  p_purchase_price numeric,$a3$;
  c_sig_to   constant text := $a4$  p_color text,
  p_description text,
  p_inspection_photos text[],
  p_purchase_price numeric,$a4$;

  -- 2c. the RPC insert
  c_ins_from constant text := $a5$  insert into vehicles (branch_id, vin, year, make, model, trim, color, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$a5$;
  c_ins_to   constant text := $a6$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$a6$;

  -- 2d. the grant
  c_gnt_from constant text := $a7$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, numeric, text[], jsonb) to {{ROLE}};$a7$;
  c_gnt_to   constant text := $a8$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], numeric, text[], jsonb) to {{ROLE}};$a8$;
begin
  if position('  description     text,' in v_tpl) > 0 then
    raise notice '0015: template already carries vehicles.description — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0015: template anchor 2a (columns) did not match. Template drifted from 0014.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sig_from, c_sig_to);
    if position(c_sig_to in v_tpl) = 0 then
      raise exception '0015: template anchor 2b (parameters) did not match. Template drifted from 0014.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ins_from, c_ins_to);
    if position(c_ins_to in v_tpl) = 0 then
      raise exception '0015: template anchor 2c (insert) did not match. Template drifted from 0014.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0015: template anchor 2d (grant) did not match. Template drifted from 0014.';
    end if;
    v_done := v_done + 1;

    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0015: the 10-argument grant survived the amendment.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0015$ select %L::text $felix_0015$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0015: template amended (% substitutions).', v_done;
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
      raise notice '0015: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.vehicles add column if not exists description text', r.schema_name);
    execute format(
      'alter table %I.vehicles add column if not exists inspection_photos text[] not null default ''{}''',
      r.schema_name
    );

    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, numeric, text[], jsonb)',
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
        p_description text,
        p_inspection_photos text[],
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

        insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, purchase_price, photos, created_by)
        values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
                nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
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
      'grant execute on function %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], numeric, text[], jsonb) to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0015: % amended.', r.schema_name;
  end loop;

  raise notice '0015: % tenant schema(s) carry description + inspection_photos.', v_count;
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
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles' and column_name = 'description'
    ) then
      v_bad := v_bad || (r.schema_name || ' (description)');
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles' and column_name = 'inspection_photos'
    ) then
      v_bad := v_bad || (r.schema_name || ' (inspection_photos)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], numeric, text[], jsonb)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (0014 rpc survived)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0015 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  description     text,' in platform.tenant_ddl_template()) = 0
     or position('p_inspection_photos text[],' in platform.tenant_ddl_template()) = 0 then
    raise exception '0015 VERIFY FAILED: template does not carry the new fields.';
  end if;

  raise notice '0015: verified — description + inspection photos live everywhere.';
end
$$;

notify pgrst, 'reload schema';

commit;
