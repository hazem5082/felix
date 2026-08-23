-- ============================================================
-- 0041 — VIN RE-DECODE: OPEN THE FIVE 0040 COLUMNS TO UPDATE
--
-- 0040 shipped body_type/engine_info/drive_type/doors/plant_country as
-- intake-only: set once by create_vehicle_with_equity_splits(), no
-- standalone UPDATE grant — deliberately mirroring engine_number/
-- plate_number (0021), which carry none either.
--
-- That was the wrong call for these five specifically. engine_number and
-- plate_number are typed once from paperwork and rarely revisited. These
-- five exist ONLY because a VIN got decoded, and every car already in
-- stock before this feature existed — which is all of it — was intaken
-- with no VIN decode to run. There was no screen where "decode this
-- car's VIN" could ever land, so the columns are silently NULL for the
-- entire existing fleet and nothing in the app can fix that. A showroom
-- opening an old car's page and finding this section simply missing is
-- not a grey-import edge case; it is every car intaken before today.
--
-- WHAT THIS ADDS
-- --------------
-- `grant update (body_type, engine_info, drive_type, doors,
-- plant_country) on vehicles to {{ROLE}}` — the exact column-limited
-- shape 0028 used for asking_price/min_price and 0036 for odometer_km.
-- vehicles_update (CEO, or a manager on their own branch) already gates
-- the ROWS; this grant gates the COLUMNS. Nothing else on the row
-- becomes writable — status, purchase_price, vin and the rest stay
-- exactly as unreachable as 0028's header first said.
--
-- No table, no RPC, no policy change: vehicles_update already exists
-- (0001/0009) and already admits exactly the actors this feature should.
-- The app-side "Decode VIN" button on the vehicle detail page (added
-- alongside this migration) calls this UPDATE directly, the same way
-- pricing-form.tsx and the odometer field do — no RPC ceremony for a
-- column-limited write an existing policy already scopes correctly.
--
-- TWO TARGETS, BOTH REQUIRED (0021/0036/0040 — read those headers):
--   1. platform.tenant_ddl_template() — showrooms not yet provisioned.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- LINE ENDINGS. Single-line anchor, CRLF/LF-agnostic — no embedded
-- newline to disagree about (0036's header explains why that matters).
--
-- GATE. On 0040 — the migration that created these five columns.
--
-- Idempotent: `grant` is naturally re-runnable.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0041 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0041 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  if position('body_type             text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0041 PRECONDITION FAILED: the template has no vehicles.body_type. Apply 0040 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  c_gnt_from constant text := $a1$grant update (odometer_km) on vehicles to {{ROLE}};$a1$;
  c_gnt_to   constant text := $a2$grant update (odometer_km) on vehicles to {{ROLE}};
-- VIN re-decode (0041) — see the file header for why these five, and
-- only these five, are opened. vehicles_update already gates the rows.
grant update (body_type, engine_info, drive_type, doors, plant_country) on vehicles to {{ROLE}};$a2$;
begin
  if position('grant update (body_type, engine_info, drive_type, doors, plant_country) on vehicles' in v_tpl) > 0 then
    raise notice '0041: template already grants the VIN re-decode columns — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0041: template anchor 2a (grant) did not match. Template drifted from 0036.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0041$ select %L::text $felix_0041$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0041: template amended.';
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0041: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles' and column_name = 'body_type'
    ) then
      raise notice '0041: %.vehicles has no body_type — skipping (0040 not applied here).', r.schema_name;
      continue;
    end if;

    execute format(
      'grant update (body_type, engine_info, drive_type, doors, plant_country) on %I.vehicles to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0041: % amended.', r.schema_name;
  end loop;

  raise notice '0041: % tenant schema(s) can now re-decode an existing vehicle''s VIN.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
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
    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles' and column_name = 'body_type'
    ) then
      continue;
    end if;

    foreach col in array array['body_type', 'engine_info', 'drive_type', 'doors', 'plant_country'] loop
      if not has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, col, 'update') then
        v_bad := v_bad || (r.schema_name || ' (role cannot update ' || col || ')');
      end if;
    end loop;

    -- The guarded columns must still be exactly as unreachable as ever —
    -- this migration must not have widened anything else by accident.
    if has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'status', 'update')
       or has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'purchase_price', 'update')
       or has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'vin', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can update a guarded vehicles column!)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0041 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('grant update (body_type, engine_info, drive_type, doors, plant_country) on vehicles' in platform.tenant_ddl_template()) = 0 then
    raise exception '0041 VERIFY FAILED: the template does not grant the VIN re-decode columns.';
  end if;

  raise notice '0041: verified — an existing vehicle''s VIN can now be (re-)decoded from its detail page.';
end
$$;

notify pgrst, 'reload schema';

commit;
