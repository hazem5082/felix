-- ============================================================
-- 0021 — VEHICLE IDENTIFIERS (engine number, plate number, VIN format)
--
-- Egypt's traffic-authority ownership transfer wants the car's mechanical
-- identifiers, and FELIX only carried an unvalidated `vin`. Two new
-- columns on `vehicles`, both NULLABLE:
--
--   engine_number   the engine serial as stamped on the block. Free text,
--                   no CHECK — formats vary wildly by manufacturer and
--                   era, and a constraint would turn a legible stamp into
--                   a failed intake.
--   plate_number    the current registration plate. Free text for the
--                   same reason (Arabic letters + digits, old/new series,
--                   trader plates all coexist).
--
-- Plus a format CHECK on the existing `vin` column: NULL, or exactly 17
-- characters from the standard VIN alphabet — uppercase alphanumerics
-- excluding I, O and Q ('^[A-HJ-NPR-Z0-9]{17}$').
--
-- LEGACY VINs — WHY THE CONSTRAINT IS `NOT VALID` ON LIVE TENANTS
-- ---------------------------------------------------------------
-- vin has existed since 0001 with no validation, so live rows may hold
-- lowercase, short, or otherwise non-conforming values. The constraint is
-- therefore added NOT VALID on every existing tenant schema: Postgres
-- skips scanning existing rows at ADD time, so this migration cannot fail
-- on legacy data, while every subsequent INSERT is checked. (t_felix, the
-- only PostgREST-exposed tenant, was spot-checked and holds only
-- conforming 17-char VINs; the other schemas could not be inspected, so
-- NOT VALID is the safe posture everywhere.)
--
-- CAVEAT worth knowing: a NOT VALID CHECK is still enforced against
-- subsequent UPDATEs of a row — Postgres re-checks the whole new tuple
-- even when vin itself is untouched. So a legacy row with a junk VIN will
-- refuse e.g. a status flip to 'sold' until its vin is corrected or set
-- NULL in the same (or a prior) update. That is the intended endgame —
-- bad identifiers get fixed the next time the row matters — but if a
-- showroom needs bulk relief, clean the data and then optionally run
--   alter table t_<slug>.vehicles validate constraint vehicles_vin_format_check;
-- to promote the constraint to fully validated.
--
-- In the TEMPLATE (fresh schemas) the same constraint is added plainly
-- inside CREATE TABLE — a new showroom has no legacy rows to grandfather.
--
-- THE RPC IS WIDENED, 0015-STYLE. create_vehicle_with_equity_splits()
-- gains p_engine_number and p_plate_number. The 12-argument version is
-- DROPPED before the 14-argument one is created: `create or replace`
-- keys on the argument list, and PostgREST refuses to choose between two
-- overloads it can both satisfy (PGRST203). The grant moves with it.
--
-- TWO TARGETS, BOTH REQUIRED (same as 0014/0015 — read those headers):
--   1. platform.tenant_ddl_template() — future showrooms.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- EVERY SUBSTITUTION IS VERIFIED: replace() on a missing anchor is a
-- silent no-op, so each amendment asserts the new text actually landed.
--
-- ORDERING: assumes 0015 has been applied (the anchors below are the
-- exact text 0015 wrote); the precondition fails loudly otherwise.
--
-- Idempotent: re-running is safe. The template patch is skipped when the
-- new text is already present; columns are add-if-not-exists; the VIN
-- constraint is drop-then-add (which converges on re-run — note that a
-- re-run demotes a manually VALIDATEd constraint back to NOT VALID, a
-- cosmetic regression the next VALIDATE undoes); the RPC is a drop/create
-- pair.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0021 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0021 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  if position('  inspection_photos text[]    not null default ''{}'',' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0021 PRECONDITION FAILED: the template has no vehicles.inspection_photos. Apply 0015 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- Anchors are quoted with distinct dollar tags because they contain
-- single quotes of their own (nullif(p_vin,''), the VIN regex). None of
-- these tags appears in the template, so none can terminate it early.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. the columns, in the vehicles DDL
  c_col_from constant text := $a1$  inspection_photos text[]    not null default '{}',
  purchase_price  numeric     not null check (purchase_price > 0),$a1$;
  c_col_to   constant text := $a2$  inspection_photos text[]    not null default '{}',
  engine_number   text,
  plate_number    text,
  purchase_price  numeric     not null check (purchase_price > 0),$a2$;

  -- 2b. the VIN format constraint, at the tail of the vehicles DDL.
  --     Plain (validated) here: a freshly provisioned schema has no
  --     legacy rows, so it can enforce the format from day one. The
  --     anchor includes the sold_at line because `created_at ... now(),`
  --     alone also matches other tables; sold_at appears exactly once.
  c_chk_from constant text := $a3$  created_at      timestamptz default now(),
  sold_at         timestamptz
);$a3$;
  c_chk_to   constant text := $a4$  created_at      timestamptz default now(),
  sold_at         timestamptz,
  -- Standard VIN alphabet (0021): 17 chars, uppercase alphanumerics
  -- excluding I/O/Q. NULL stays allowed — used cars in this market
  -- sometimes lack a readable VIN. Existing tenants carry the same
  -- constraint added NOT VALID (see 0021 §3).
  constraint vehicles_vin_format_check check (
    vin is null
    or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'
  )
);$a4$;

  -- 2c. the RPC parameters
  c_sig_from constant text := $a5$  p_inspection_photos text[],
  p_purchase_price numeric,$a5$;
  c_sig_to   constant text := $a6$  p_inspection_photos text[],
  p_engine_number text,
  p_plate_number text,
  p_purchase_price numeric,$a6$;

  -- 2d. the RPC insert
  c_ins_from constant text := $a7$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$a7$;
  c_ins_to   constant text := $a8$  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())$a8$;

  -- 2e. the grant
  c_gnt_from constant text := $a9$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], numeric, text[], jsonb) to {{ROLE}};$a9$;
  c_gnt_to   constant text := $aa$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, numeric, text[], jsonb) to {{ROLE}};$aa$;
begin
  if position('  engine_number   text,' in v_tpl) > 0 then
    raise notice '0021: template already carries vehicles.engine_number — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0021: template anchor 2a (columns) did not match. Template drifted from 0015.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_chk_from, c_chk_to);
    if position(c_chk_to in v_tpl) = 0 then
      raise exception '0021: template anchor 2b (vin constraint) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sig_from, c_sig_to);
    if position(c_sig_to in v_tpl) = 0 then
      raise exception '0021: template anchor 2c (parameters) did not match. Template drifted from 0015.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ins_from, c_ins_to);
    if position(c_ins_to in v_tpl) = 0 then
      raise exception '0021: template anchor 2d (insert) did not match. Template drifted from 0015.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0021: template anchor 2e (grant) did not match. Template drifted from 0015.';
    end if;
    v_done := v_done + 1;

    -- The 12-argument grant must be gone, not merely joined by a
    -- 14-argument one: a leftover would grant on a function the new
    -- template never creates, and provisioning would abort.
    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0021: the 12-argument grant survived the amendment.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0014.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0021$ select %L::text $felix_0021$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0021: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists`; the VIN constraint via
-- drop-then-add NOT VALID (drop-then-add so a re-run converges, and it
-- sidesteps the conname-guard pitfall 0018 §3 documents; NOT VALID so
-- legacy non-conforming VINs cannot fail the migration — see header).
-- The RPC is dropped at its 12-argument signature and recreated with 14,
-- with the grant re-issued, exactly as 0015 did at 10→12.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0021: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.vehicles add column if not exists engine_number text', r.schema_name);
    execute format('alter table %I.vehicles add column if not exists plate_number text', r.schema_name);

    execute format(
      'alter table %I.vehicles drop constraint if exists vehicles_vin_format_check',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.vehicles add constraint vehicles_vin_format_check check (
        vin is null
        or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'
      ) not valid
    $ddl$, r.schema_name);

    -- Drop the old signature before creating the new one, or PostgREST
    -- sees two overloads and returns PGRST203 on every intake.
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], numeric, text[], jsonb)',
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

        insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, purchase_price, photos, created_by)
        values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
                nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
                nullif(p_engine_number,''), nullif(p_plate_number,''),
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
      'grant execute on function %I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, numeric, text[], jsonb) to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0021: % amended.', r.schema_name;
  end loop;

  raise notice '0021: % tenant schema(s) carry engine/plate numbers and the VIN format check.', v_count;
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

    foreach col in array array['engine_number', 'plate_number'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'vehicles' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;

    -- Schema-qualified probe on purpose: conname alone is not
    -- database-unique across t_<slug> schemas (0018 §3).
    if not exists (
      select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = r.schema_name
         and t.relname = 'vehicles'
         and c.conname = 'vehicles_vin_format_check'
    ) then
      v_bad := v_bad || (r.schema_name || ' (vin constraint)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, numeric, text[], jsonb)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (0015 rpc survived)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0021 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  engine_number   text,' in platform.tenant_ddl_template()) = 0
     or position('p_plate_number text,' in platform.tenant_ddl_template()) = 0
     or position('vehicles_vin_format_check' in platform.tenant_ddl_template()) = 0 then
    raise exception '0021 VERIFY FAILED: template does not carry the identifier fields.';
  end if;

  raise notice '0021: verified — engine/plate numbers and the VIN format check live everywhere.';
end
$$;

-- PostgREST caches the schema; without this the new parameters are
-- rejected as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
