-- ============================================================
-- 0026 — VEHICLE E-INVOICE ITEM CODE (ETA e-invoicing)
--
-- Egypt's e-invoicing system (ETA) requires every invoice line item to
-- carry a product code — GS1 (GTIN) or the local EGS scheme, where an
-- EGS code has the shape EG-{seller tax registration}-{internal item
-- code} mapped to a GPC classification. For a dealership each vehicle
-- is an invoice line item, so the code the showroom registered for the
-- vehicle's class on the ETA portal lives on the vehicle row:
--
--   item_code  the EGS or GS1 code. Free text, NULLABLE — stock is
--              taken in before the class is registered on the portal,
--              and a constraint would block intake.
--
-- THE RPC IS WIDENED, 0025-STYLE. create_vehicle_with_equity_splits()
-- gains p_item_code, placed after p_features. The 16-argument version
-- is DROPPED before the 17-argument one is created: `create or replace`
-- keys on the argument list, and PostgREST refuses to choose between
-- two overloads it can both satisfy (PGRST203). The grant moves with
-- it. Convention carried over from 0021/0025: nullif() collapses ""
-- to NULL.
--
-- TWO TARGETS, BOTH REQUIRED (same as 0014/0015/0021/0025 — read those
-- headers):
--   1. platform.tenant_ddl_template() — future showrooms.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- EVERY SUBSTITUTION IS VERIFIED: replace() on a missing anchor is a
-- silent no-op, so each amendment asserts the new text actually landed.
--
-- ORDERING: assumes 0025 has been applied (the anchors below are the
-- exact text 0025 wrote); the precondition fails loudly otherwise.
--
-- Idempotent: re-running is safe. The template patch is skipped when the
-- new text is already present; the column is add-if-not-exists; the RPC
-- is a drop/create pair.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0026 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0026 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  if position('  country_of_origin text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0026 PRECONDITION FAILED: the template has no vehicles.country_of_origin. Apply 0025 first.';
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

  -- 2a. the column, in the vehicles DDL — with the other e-invoice-
  --     facing intake fields, after features, before purchase_price.
  c_col_from constant text := $b1$  country_of_origin text,
  features        text[]      not null default '{}',
  purchase_price  numeric     not null check (purchase_price > 0),$b1$;
  c_col_to   constant text := $b2$  country_of_origin text,
  features        text[]      not null default '{}',
  item_code       text,
  purchase_price  numeric     not null check (purchase_price > 0),$b2$;

  -- 2b. the RPC parameters
  c_sig_from constant text := $b3$  p_country_of_origin text,
  p_features text[],
  p_purchase_price numeric,$b3$;
  c_sig_to   constant text := $b4$  p_country_of_origin text,
  p_features text[],
  p_item_code text,
  p_purchase_price numeric,$b4$;

  -- 2c. the RPC insert
  c_ins_from constant text := $b5$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          nullif(p_country_of_origin,''), coalesce(p_features,'{}'),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$b5$;
  c_ins_to   constant text := $b6$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, item_code, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          nullif(p_country_of_origin,''), coalesce(p_features,'{}'), nullif(p_item_code,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$b6$;

  -- 2d. the grant
  c_gnt_from constant text := $b7$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], numeric, text[], jsonb) to {{ROLE}};$b7$;
  c_gnt_to   constant text := $b8$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, numeric, text[], jsonb) to {{ROLE}};$b8$;
begin
  if position('  item_code       text,' in v_tpl) > 0 then
    raise notice '0026: template already carries vehicles.item_code — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0026: template anchor 2a (column) did not match. Template drifted from 0025.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sig_from, c_sig_to);
    if position(c_sig_to in v_tpl) = 0 then
      raise exception '0026: template anchor 2b (parameters) did not match. Template drifted from 0025.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ins_from, c_ins_to);
    if position(c_ins_to in v_tpl) = 0 then
      raise exception '0026: template anchor 2c (insert) did not match. Template drifted from 0025.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0026: template anchor 2d (grant) did not match. Template drifted from 0025.';
    end if;
    v_done := v_done + 1;

    -- The 16-argument grant must be gone, not merely joined by a
    -- 17-argument one: a leftover would grant on a function the new
    -- template never creates, and provisioning would abort.
    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0026: the 16-argument grant survived the amendment.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0014.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0026$ select %L::text $felix_0026$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0026: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Column via `add column if not exists`. The RPC is dropped at its
-- 16-argument signature and recreated with 17, with the grant
-- re-issued, exactly as 0025 did at 14→16.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0026: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.vehicles add column if not exists item_code text', r.schema_name);

    -- Drop the old signature before creating the new one, or PostgREST
    -- sees two overloads and returns PGRST203 on every intake.
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], numeric, text[], jsonb)',
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
        p_item_code text,
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

        insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, item_code, purchase_price, photos, created_by)
        values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
                nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
                nullif(p_engine_number,''), nullif(p_plate_number,''),
                nullif(p_country_of_origin,''), coalesce(p_features,'{}'), nullif(p_item_code,''),
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
      'grant execute on function %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, numeric, text[], jsonb) to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0026: % amended.', r.schema_name;
  end loop;

  raise notice '0026: % tenant schema(s) carry item_code.', v_count;
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
  v_bad text[] := '{}';
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles' and column_name = 'item_code'
    ) then
      v_bad := v_bad || (r.schema_name || ' (item_code)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, numeric, text[], jsonb)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (0025 rpc survived)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0026 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  item_code       text,' in platform.tenant_ddl_template()) = 0
     or position('p_item_code text,' in platform.tenant_ddl_template()) = 0 then
    raise exception '0026 VERIFY FAILED: template does not carry the item_code field.';
  end if;

  raise notice '0026: verified — item_code lives everywhere.';
end
$$;

-- PostgREST caches the schema; without this the new parameter is
-- rejected as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
