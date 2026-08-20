-- ============================================================
-- 0025 — VEHICLE ORIGIN & FEATURES (CPA Decision 115/2021)
--
-- Egypt's Consumer Protection Agency Decision 115/2021 requires every
-- displayed vehicle to carry a windshield sticker naming the country of
-- origin and a standardized feature/amenities list, with the price
-- inclusive of tax. FELIX carried only a free-text `description`. Two
-- new columns on `vehicles`:
--
--   country_of_origin  where the car was manufactured. Free text,
--                      NULLABLE — grey imports and older stock arrive
--                      with paperwork that names it inconsistently, and
--                      a constraint would block intake.
--   features           the structured amenities list, one entry per
--                      feature ("sunroof", "leather seats"), the array
--                      style of the existing `photos`/`inspection_photos`
--                      columns: text[] NOT NULL DEFAULT '{}', so no read
--                      site ever needs a coalesce (the 0017
--                      client_note_points precedent).
--
-- THE RPC IS WIDENED, 0021-STYLE. create_vehicle_with_equity_splits()
-- gains p_country_of_origin and p_features, placed after p_plate_number.
-- The 14-argument version is DROPPED before the 16-argument one is
-- created: `create or replace` keys on the argument list, and PostgREST
-- refuses to choose between two overloads it can both satisfy
-- (PGRST203). The grant moves with it. Conventions carried over from
-- 0021: nullif() for the text argument, coalesce(p_features,'{}') for
-- the array — exactly how p_photos is handled.
--
-- TWO TARGETS, BOTH REQUIRED (same as 0014/0015/0021 — read those
-- headers):
--   1. platform.tenant_ddl_template() — future showrooms.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- EVERY SUBSTITUTION IS VERIFIED: replace() on a missing anchor is a
-- silent no-op, so each amendment asserts the new text actually landed.
--
-- ORDERING: assumes 0021 has been applied (the anchors below are the
-- exact text 0021 wrote); the precondition fails loudly otherwise.
--
-- Idempotent: re-running is safe. The template patch is skipped when the
-- new text is already present; columns are add-if-not-exists; the RPC is
-- a drop/create pair.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0025 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0025 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  if position('  engine_number   text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0025 PRECONDITION FAILED: the template has no vehicles.engine_number. Apply 0021 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- Anchors are quoted with distinct dollar tags because they contain
-- single quotes of their own (nullif(p_vin,''), the array defaults).
-- None of these tags appears in the template, so none can terminate it
-- early.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. the columns, in the vehicles DDL — placed with the other
  --     sticker-facing intake fields, just before purchase_price.
  c_col_from constant text := $b1$  engine_number   text,
  plate_number    text,
  purchase_price  numeric     not null check (purchase_price > 0),$b1$;
  c_col_to   constant text := $b2$  engine_number   text,
  plate_number    text,
  country_of_origin text,
  features        text[]      not null default '{}',
  purchase_price  numeric     not null check (purchase_price > 0),$b2$;

  -- 2b. the RPC parameters
  c_sig_from constant text := $b3$  p_engine_number text,
  p_plate_number text,
  p_purchase_price numeric,$b3$;
  c_sig_to   constant text := $b4$  p_engine_number text,
  p_plate_number text,
  p_country_of_origin text,
  p_features text[],
  p_purchase_price numeric,$b4$;

  -- 2c. the RPC insert
  c_ins_from constant text := $b5$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$b5$;
  c_ins_to   constant text := $b6$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          nullif(p_country_of_origin,''), coalesce(p_features,'{}'),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$b6$;

  -- 2d. the grant
  c_gnt_from constant text := $b7$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, numeric, text[], jsonb) to {{ROLE}};$b7$;
  c_gnt_to   constant text := $b8$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], numeric, text[], jsonb) to {{ROLE}};$b8$;
begin
  if position('  country_of_origin text,' in v_tpl) > 0 then
    raise notice '0025: template already carries vehicles.country_of_origin — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0025: template anchor 2a (columns) did not match. Template drifted from 0021.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sig_from, c_sig_to);
    if position(c_sig_to in v_tpl) = 0 then
      raise exception '0025: template anchor 2b (parameters) did not match. Template drifted from 0021.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ins_from, c_ins_to);
    if position(c_ins_to in v_tpl) = 0 then
      raise exception '0025: template anchor 2c (insert) did not match. Template drifted from 0021.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0025: template anchor 2d (grant) did not match. Template drifted from 0021.';
    end if;
    v_done := v_done + 1;

    -- The 14-argument grant must be gone, not merely joined by a
    -- 16-argument one: a leftover would grant on a function the new
    -- template never creates, and provisioning would abort.
    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0025: the 14-argument grant survived the amendment.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0014.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0025$ select %L::text $felix_0025$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0025: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists` (the features default
-- backfills existing rows to '{}' — no coalesce needed anywhere). The
-- RPC is dropped at its 14-argument signature and recreated with 16,
-- with the grant re-issued, exactly as 0021 did at 12→14.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0025: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.vehicles add column if not exists country_of_origin text', r.schema_name);
    execute format(
      'alter table %I.vehicles add column if not exists features text[] not null default ''{}''',
      r.schema_name
    );

    -- Drop the old signature before creating the new one, or PostgREST
    -- sees two overloads and returns PGRST203 on every intake.
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, numeric, text[], jsonb)',
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
        p_engine_number text,
        p_plate_number text,
        p_country_of_origin text,
        p_features text[],
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

        insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, purchase_price, photos, created_by)
        values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
                nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
                nullif(p_engine_number,''), nullif(p_plate_number,''),
                nullif(p_country_of_origin,''), coalesce(p_features,'{}'),
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
      'grant execute on function %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], numeric, text[], jsonb) to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0025: % amended.', r.schema_name;
  end loop;

  raise notice '0025: % tenant schema(s) carry country_of_origin and features.', v_count;
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
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array['country_of_origin', 'features'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'vehicles' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], numeric, text[], jsonb)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (0021 rpc survived)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0025 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  country_of_origin text,' in platform.tenant_ddl_template()) = 0
     or position('p_features text[],' in platform.tenant_ddl_template()) = 0 then
    raise exception '0025 VERIFY FAILED: template does not carry the origin/features fields.';
  end if;

  raise notice '0025: verified — country_of_origin and features live everywhere.';
end
$$;

-- PostgREST caches the schema; without this the new parameters are
-- rejected as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
