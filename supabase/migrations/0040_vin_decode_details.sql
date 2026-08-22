-- ============================================================
-- 0040 — VIN-DECODED VEHICLE DETAILS
--
-- Intake asks for a VIN today but does nothing with it beyond a format
-- check (0021). This migration gives the intake form somewhere to put
-- what a VIN decode (src/lib/vin-decode.ts, against NHTSA's free vPIC
-- API) actually returns for a recognised VIN:
--
--   vehicles.body_type       e.g. "Sedan", "Sport Utility Vehicle"
--   vehicles.engine_info     free text, e.g. "2.0L 4-Cyl, Gasoline"
--   vehicles.drive_type      e.g. "FWD/Front Wheel Drive"
--   vehicles.doors           integer door count
--   vehicles.plant_country   the assembly country vPIC reports — used to
--                            suggest vehicles.country_of_origin (0025),
--                            not to replace it; a showroom can still type
--                            a different origin and this column is left
--                            exactly as decoded either way.
--
-- WHY FIVE NULLABLE FREE-FORM COLUMNS, NO CHECKS
-- -----------------------------------------------
-- Same reasoning 0021 gives for engine_number/plate_number: formats vary
-- by manufacturer, decode coverage varies by market — most of this
-- showroom's actual stock is grey-import/GCC/JDM/EU-spec cars that vPIC,
-- a US-centric database, was never told about — and a CHECK would turn a
-- partial or absent decode into a failed intake. A VIN decode that comes
-- back empty is the ordinary case for this market, not an error.
--
-- WHY NO COLOUR, NO TOP SPEED
-- ---------------------------
-- Neither is encoded in a VIN. vPIC has no colour endpoint (nhtsa.ts's
-- own header says so — colour is a build-sheet attribute); top speed is
-- a trim-level spec-sheet fact no free VIN-keyed API supplies. Adding
-- columns for data no honest source fills would be worse than leaving
-- them off. vehicles.color (0014) already covers the former as free text.
--
-- WHY NO UPDATE GRANT
-- --------------------
-- These describe what the VIN decoded to at intake, not a fact a person
-- watches change over time the way an odometer reading does (0036's
-- grant update (odometer_km)). They are set once, by
-- create_vehicle_with_equity_splits(), exactly like engine_number and
-- plate_number (0021) — neither of which carries a standalone UPDATE
-- grant either. A showroom that needs to correct one does so the same
-- way it corrects those: a service-role data fix.
--
-- THE RPC WIDENING: 25 → 30, 0036's SHAPE
-- -----------------------------------------
-- create_vehicle_with_equity_splits() gains p_body_type, p_engine_info,
-- p_drive_type, p_doors and p_plant_country, appended after
-- p_acquisition_source — the last parameter 0036 left. No new validation
-- branches: all five are optional at every acquisition mode, same as
-- odometer_km and acquisition_source were. The function is DROPPED at
-- the 25-argument signature before the 30-argument one is created —
-- `create or replace` keys on the argument list, and PostgREST refuses
-- to choose between two overloads it can both satisfy (PGRST203 — every
-- migration in this series that has widened this RPC repeats the same
-- drop for the same reason).
--
-- TWO TARGETS, BOTH REQUIRED (0021/0032/0036 — read those headers):
--   1. platform.tenant_ddl_template() — showrooms not yet provisioned.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- LINE ENDINGS. The live platform.tenant_ddl_template() text is CRLF —
-- built from SQL-Editor pastes of CRLF files — while this file is LF.
-- §2 reads the template's own convention and rewrites every anchor and
-- every replacement into it, flattening to LF first so it works whether
-- this file arrives as LF or is converted to CRLF by the operator's
-- applier. Same shape as 0030–0036 §2.
--
-- ANCHOR CHOICE. Both substitutions land on the `vehicles` DDL block and
-- the intake RPC — the same two regions 0036 amended, immediately after
-- its own additions (odometer_km / acquisition_source, p_odometer_km /
-- p_acquisition_source). Nothing here touches a region 0037, 0038 or
-- 0039 amended — neither migration touches `vehicles` or this RPC (both
-- were checked before this file was written: 0037 is branch_grants/RLS
-- inlining, 0038 is attendance/device-trust, 0039 is mail).
--
-- GATE. On 0036 — the last migration to touch `vehicles` or the intake
-- RPC.
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
      '0040 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0040 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- 0036's exact addition — the marker this migration gates on and
  -- splices immediately after.
  if position('acquisition_source    text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0040 PRECONDITION FAILED: the template has no vehicles.acquisition_source. Apply 0036 first.';
  end if;

  if position('p_acquisition_source text' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0040 PRECONDITION FAILED: the template has no 0036-shaped create_vehicle_with_equity_splits(). Apply 0036 first.';
  end if;
end
$$;

-- ============================================================
-- 0-bis. THE REWRITTEN RPC, ONCE
--
-- Parked here so §2 (the template) and §3 (every live schema) install
-- byte-identical text — 0032/0036's discipline for this same function.
-- `on commit drop` takes it away with the transaction.
--
-- {{SCHEMA}} is left as the template's own placeholder: §2 splices this
-- in verbatim, §3 substitutes the tenant's schema name before executing.
-- ============================================================
create temp table felix_0040_fn (name text primary key, body text) on commit drop;

insert into felix_0040_fn (name, body) values (
'create_vehicle_with_equity_splits',
$fnbody$create or replace function create_vehicle_with_equity_splits(
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
  p_item_code text,
  p_acquisition_type text,
  p_consignor_name text,
  p_consignor_phone text,
  p_consignor_national_id text,
  p_consignment_commission_type text,
  p_consignment_commission_value numeric,
  p_purchase_price numeric,
  p_photos text[],
  p_splits jsonb,
  p_odometer_km numeric,
  p_acquisition_source text,
  -- 0040. Appended after p_acquisition_source — the last parameter of
  -- 0036's 25-argument version. All five are optional at every
  -- acquisition mode: a VIN decode either fills them or it does not,
  -- and a car with no readable VIN records none of them, same as it
  -- always could not carry engine/plate numbers.
  p_body_type text,
  p_engine_info text,
  p_drive_type text,
  p_doors int,
  p_plant_country text
) returns uuid as $fn$
declare
  v_id uuid;
  split jsonb;
  total numeric := 0;
  non_ceo int := 0;
  v_holder uuid;
  v_mode text := coalesce(nullif(btrim(coalesce(p_acquisition_type, '')), ''), 'purchase');
  v_cost numeric;
begin
  if not exists (select 1 from branches where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;

  -- ROLE + BRANCH check (0001). KEEP VERBATIM.
  if not (is_ceo() or (is_manager_or_above() and p_branch_id = current_branch_id())) then
    raise exception 'Not authorized to intake a vehicle for this branch';
  end if;

  if v_mode not in ('purchase', 'consignment') then
    raise exception 'Unknown acquisition type % — expected purchase or consignment', v_mode;
  end if;

  if v_mode = 'consignment' then
    if nullif(btrim(coalesce(p_consignor_name, '')), '') is null then
      raise exception 'A consignment needs the consignor''s name';
    end if;

    if p_consignment_commission_type is null
       or p_consignment_commission_type not in ('fixed', 'percent') then
      raise exception 'A consignment needs a commission type of fixed or percent';
    end if;

    if p_consignment_commission_value is null or p_consignment_commission_value < 0 then
      raise exception 'A consignment needs a commission value of zero or more';
    end if;

    if p_consignment_commission_type = 'percent' and p_consignment_commission_value > 100 then
      raise exception 'A percentage commission cannot exceed 100%%';
    end if;

    if jsonb_array_length(coalesce(p_splits, '[]'::jsonb)) > 0 then
      raise exception 'A consigned vehicle has no equity splits — the showroom does not own it';
    end if;

    v_cost := 0;
  else
    v_cost := p_purchase_price;

    select coalesce(sum((s->>'percentage')::numeric), 0),
           count(*) filter (where s->>'holder_type' <> 'ceo')
      into total, non_ceo
    from jsonb_array_elements(coalesce(p_splits,'[]'::jsonb)) s;

    if abs(total - 100) > 0.01 then
      raise exception 'Equity splits must sum to 100%% (got %)', total;
    end if;

    if non_ceo > 0 and not is_ceo() then
      raise exception 'Only the CEO can allocate investor equity on a vehicle';
    end if;
  end if;

  -- body_type/engine_info/drive_type/doors/plant_country (0040) join the
  -- tail of the column list, right before created_by — the VIN-decoded
  -- facts about the car, alongside odometer_km/acquisition_source's own
  -- optional-facts-at-intake block. nullif() collapses '' to NULL; doors
  -- passes through as-is (nullable int, no CHECK — see the file header).
  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, item_code, acquisition_type, consignor_name, consignor_phone, consignor_national_id, consignment_commission_type, consignment_commission_value, purchase_price, photos, odometer_km, acquisition_source, body_type, engine_info, drive_type, doors, plant_country, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          nullif(p_country_of_origin,''), coalesce(p_features,'{}'), nullif(p_item_code,''),
          v_mode,
          case when v_mode = 'consignment' then nullif(btrim(coalesce(p_consignor_name,'')),'') end,
          case when v_mode = 'consignment' then nullif(btrim(coalesce(p_consignor_phone,'')),'') end,
          case when v_mode = 'consignment' then nullif(btrim(coalesce(p_consignor_national_id,'')),'') end,
          case when v_mode = 'consignment' then p_consignment_commission_type end,
          case when v_mode = 'consignment' then p_consignment_commission_value end,
          v_cost, coalesce(p_photos,'{}'),
          p_odometer_km,
          nullif(btrim(coalesce(p_acquisition_source,'')),''),
          nullif(btrim(coalesce(p_body_type,'')),''),
          nullif(btrim(coalesce(p_engine_info,'')),''),
          nullif(btrim(coalesce(p_drive_type,'')),''),
          p_doors,
          nullif(btrim(coalesce(p_plant_country,'')),''),
          auth.uid())
  returning id into v_id;

  for split in select * from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) loop
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
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;
  v_at   int;
  v_len  int;
  v_rest text;

  c_intake_new text;

  -- 2a. vehicles: the five new columns, directly under 0036's own
  --     odometer/source block.
  c_veh_from text := $a1$  odometer_km          numeric     check (odometer_km >= 0),
  acquisition_source    text,
  -- 0009 wrote `check (purchase_price > 0)` inline here, which auto-named$a1$;
  c_veh_to   text := $a2$  odometer_km          numeric     check (odometer_km >= 0),
  acquisition_source    text,
  -- VIN-DECODED DETAILS (0040) — captured automatically from the NHTSA
  -- vPIC decode at intake when the car carries a recognisable VIN. Free
  -- text/no CHECK, same reasoning as engine_number/plate_number (0021):
  -- decode coverage varies by market and a constraint would turn a
  -- partial or absent decode into a failed intake. Not standalone-
  -- updatable — see the file header.
  body_type             text,
  engine_info           text,
  drive_type            text,
  doors                 int,
  plant_country         text,
  -- 0009 wrote `check (purchase_price > 0)` inline here, which auto-named$a2$;

  -- 2b. the RPC parameters, after 0036's own tail.
  c_sig_from text := $b1$  p_odometer_km numeric,
  p_acquisition_source text
) returns uuid as $fn$$b1$;
  c_sig_to   text := $b2$  p_odometer_km numeric,
  p_acquisition_source text,
  p_body_type text,
  p_engine_info text,
  p_drive_type text,
  p_doors int,
  p_plant_country text
) returns uuid as $fn$$b2$;

  -- 2c. the grant — 25 arguments become 30.
  c_gnt_from text := $c1$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text) to {{ROLE}};$c1$;
  c_gnt_to   text := $c2$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text, text, text, text, int, text) to {{ROLE}};$c2$;

  c_intake_head constant text := $d1$create or replace function create_vehicle_with_equity_splits($d1$;
  c_fn_tail     constant text := $d2$$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$d2$;
begin
  select body into c_intake_new from felix_0040_fn where name = 'create_vehicle_with_equity_splits';

  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_veh_from     := replace(replace(c_veh_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_veh_to       := replace(replace(c_veh_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_sig_from     := replace(replace(c_sig_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_sig_to       := replace(replace(c_sig_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from     := replace(replace(c_gnt_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to       := replace(replace(c_gnt_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_intake_new   := replace(replace(c_intake_new,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('body_type             text,' in v_tpl) > 0 then
    raise notice '0040: template already carries VIN-decoded vehicle details — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_veh_from, c_veh_to);
    if position(c_veh_to in v_tpl) = 0 then
      raise exception '0040: template anchor 2a (vehicles columns) did not match. Template drifted from 0036.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sig_from, c_sig_to);
    if position(c_sig_to in v_tpl) = 0 then
      raise exception '0040: template anchor 2b (RPC parameters) did not match. Template drifted from 0036.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0040: template anchor 2c (intake grant) did not match. Template drifted from 0036.';
    end if;
    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0040: the 25-argument intake grant survived the amendment.';
    end if;
    v_done := v_done + 1;

    -- ── the function span ───────────────────────────────────
    v_at := position(c_intake_head in v_tpl);
    if v_at = 0 then
      raise exception '0040: create_vehicle_with_equity_splits() not found in the template. Template drifted from 0026.';
    end if;
    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_fn_tail in v_rest);
    if v_len = 0 then
      raise exception '0040: create_vehicle_with_equity_splits() has no SECURITY DEFINER tail. Template drifted from 0026.';
    end if;
    v_len  := v_len + length(c_fn_tail) - 1;
    v_tpl  := substr(v_tpl, 1, v_at - 1) || c_intake_new || substr(v_tpl, v_at + v_len);
    v_done := v_done + 1;

    -- The 25-argument body must be gone with its grant, or PostgREST
    -- would face two overloads at every intake (PGRST203).
    if position('p_odometer_km numeric,' || v_nl || '  p_acquisition_source text' || v_nl || ') returns uuid' in v_tpl) > 0 then
      raise exception '0040: the 25-argument intake signature survived the span replacement.';
    end if;

    if (length(v_tpl) - length(replace(v_tpl, 'body_type             text,', ''))) <>
       length('body_type             text,') then
      raise exception '0040: the template does not carry exactly one vehicles.body_type.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0040$ select %L::text $felix_0040$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0040: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r            record;
  v_count      int := 0;
  c_intake_new text;
begin
  select body into c_intake_new from felix_0040_fn where name = 'create_vehicle_with_equity_splits';

  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0040: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute 'alter table vehicles add column if not exists body_type text';
    execute 'alter table vehicles add column if not exists engine_info text';
    execute 'alter table vehicles add column if not exists drive_type text';
    execute 'alter table vehicles add column if not exists doors int';
    execute 'alter table vehicles add column if not exists plant_country text';

    -- The 25-argument intake must be DROPPED before the 30-argument one
    -- is created: `create or replace` keys on the argument list, and
    -- PostgREST refuses to choose between two overloads it can both
    -- satisfy (PGRST203).
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits('
      'uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text)',
      r.schema_name
    );

    execute replace(c_intake_new, '{{SCHEMA}}', quote_ident(r.schema_name));

    execute format(
      'grant execute on function %I.create_vehicle_with_equity_splits('
      'uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text, text, text, text, int, text) to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0040: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0040: % tenant schema(s) carry VIN-decoded vehicle details.', v_count;
end
$mig$;

-- ============================================================
-- 4. BACKFILL
--
-- None. All five columns are nullable with no default; every row that
-- already existed simply carries NULL — it was taken in before this
-- migration ever ran a decode, and there is no source of truth to
-- backfill from. Nothing here computes a stand-in for facts nobody
-- captured at the time.
-- ============================================================

-- ============================================================
-- 5. SELF-VERIFY
-- ============================================================
do $$
declare
  r     record;
  col   text;
  v_bad text[] := '{}';
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array['body_type', 'engine_info', 'drive_type', 'doors', 'plant_country'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'vehicles' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;

    -- None of the five is meant to be standalone-updatable by the tenant
    -- role — see the file header. A grant here would be a silent widening
    -- nobody decided on.
    foreach col in array array['body_type', 'engine_info', 'drive_type', 'doors', 'plant_country'] loop
      if has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, col, 'update') then
        v_bad := v_bad || (r.schema_name || ' (role can update ' || col || '!)');
      end if;
    end loop;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text, text, text, text, int, text)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (30-arg intake rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (25-arg intake rpc survived — PGRST203)');
    end if;

    if (select prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = r.schema_name and p.proname = 'create_vehicle_with_equity_splits')
       not like '%p_plant_country%' then
      v_bad := v_bad || (r.schema_name || ' (create_vehicle_with_equity_splits not rewritten)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0040 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('body_type             text,' in platform.tenant_ddl_template()) = 0
     or position('p_plant_country text' in platform.tenant_ddl_template()) = 0 then
    raise exception '0040 VERIFY FAILED: the template does not carry VIN-decoded vehicle details.';
  end if;

  raise notice '0040: verified — every vehicle can carry its VIN-decoded body type, engine, drivetrain, doors and plant country.';
end
$$;

-- PostgREST caches the schema; without this the new columns and the
-- widened RPC signature are rejected as unknown until the next unrelated
-- reload.
notify pgrst, 'reload schema';

commit;
