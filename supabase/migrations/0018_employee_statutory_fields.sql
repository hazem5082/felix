-- ============================================================
-- 0018 — EMPLOYEE STATUTORY FIELDS (Egypt NOSI filing)
--
-- FELIX captured no statutory employee data, which blocks the monthly
-- social-insurance (NOSI) contribution filing. Five columns on
-- `profiles`, all NULLABLE so existing rows and the demo fixtures keep
-- working untouched:
--
--   national_id              Egyptian national ID. CHECK: NULL or
--                            exactly 14 digits.
--   social_insurance_number  the employee's NOSI registration number.
--                            Free text — formats vary by office and era.
--   hire_date                contract start date, the anchor for the
--                            first contribution month.
--   monthly_wage             the statutory wage BASIS for NOSI
--                            contributions. Deliberately distinct from
--                            ad-hoc ledger payouts (salary rows in
--                            ledger_entries record what was paid out,
--                            not what is declared to the authority).
--   employment_type          CHECK: NULL, 'full_time' or 'part_time'.
--
-- No RPC changes: profiles rows are minted by handle_new_user() from a
-- platform.staff_invitations row, and the statutory fields are written
-- afterwards through the ordinary CEO-session UPDATE path
-- (profiles_update_self policy + table-level `grant select, update on
-- profiles`, both of which cover new columns automatically). They are
-- contact/HR data, not privilege columns, so they stay outside
-- guard_profile_privilege_columns() for the same reason 0007's
-- notification_email does.
--
-- STRUCTURE MIRRORS 0014/0015 — same two targets (the DDL template for
-- future showrooms, every live t_<slug> for the ones already trading),
-- same anchored-and-verified substitutions on the template.
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
      '0018 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('  whatsapp_number     text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0018 PRECONDITION FAILED: the template has no profiles.whatsapp_number. Apply 0009 first.';
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

  -- 2a. the columns, in the profiles DDL
  c_col_from constant text := $p1$  whatsapp_number     text,
  created_at          timestamptz default now(),$p1$;
  c_col_to   constant text := $p2$  whatsapp_number     text,
  national_id         text,
  social_insurance_number text,
  hire_date           date,
  monthly_wage        numeric,
  employment_type     text,
  created_at          timestamptz default now(),$p2$;

  -- 2b. the constraints, at the tail of the profiles DDL
  c_chk_from constant text := $p3$  constraint profiles_whatsapp_number_check check (
    whatsapp_number is null
    or whatsapp_number ~ '^[+0-9() -]{6,32}$'
  )
);$p3$;
  c_chk_to   constant text := $p4$  constraint profiles_whatsapp_number_check check (
    whatsapp_number is null
    or whatsapp_number ~ '^[+0-9() -]{6,32}$'
  ),
  -- Statutory employee data for Egypt's monthly NOSI filing (0018).
  -- All nullable: rows predating 0018 and the demo fixtures carry
  -- nulls, and an account can be created before HR paperwork lands.
  constraint profiles_national_id_check check (
    national_id is null
    or national_id ~ '^[0-9]{14}$'
  ),
  constraint profiles_employment_type_check check (
    employment_type is null
    or employment_type in ('full_time','part_time')
  )
);$p4$;
begin
  if position('  national_id         text,' in v_tpl) > 0 then
    raise notice '0018: template already carries profiles.national_id — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0018: template anchor 2a (columns) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_chk_from, c_chk_to);
    if position(c_chk_to in v_tpl) = 0 then
      raise exception '0018: template anchor 2b (constraints) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0018$ select %L::text $felix_0018$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0018: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists`; constraints via drop-then-add
-- so a re-run converges instead of erroring. The drop-then-add also
-- sidesteps 0007's conname-guard bug (conname is not database-unique,
-- so an EXISTS probe against pg_constraint without a schema qualifier
-- silently skips every tenant after the first — see 0009's header).
-- No grants to touch: `grant select, update on profiles` is
-- table-level and covers new columns automatically.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0018: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.profiles add column if not exists national_id text', r.schema_name);
    execute format('alter table %I.profiles add column if not exists social_insurance_number text', r.schema_name);
    execute format('alter table %I.profiles add column if not exists hire_date date', r.schema_name);
    execute format('alter table %I.profiles add column if not exists monthly_wage numeric', r.schema_name);
    execute format('alter table %I.profiles add column if not exists employment_type text', r.schema_name);

    execute format(
      'alter table %I.profiles drop constraint if exists profiles_national_id_check',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.profiles add constraint profiles_national_id_check check (
        national_id is null
        or national_id ~ '^[0-9]{14}$'
      )
    $ddl$, r.schema_name);

    execute format(
      'alter table %I.profiles drop constraint if exists profiles_employment_type_check',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.profiles add constraint profiles_employment_type_check check (
        employment_type is null
        or employment_type in ('full_time','part_time')
      )
    $ddl$, r.schema_name);

    v_count := v_count + 1;
    raise notice '0018: % amended.', r.schema_name;
  end loop;

  raise notice '0018: % tenant schema(s) carry the statutory employee fields.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
-- ============================================================
do $$
declare
  r record;
  col text;
  v_bad text[] := '{}';
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array[
      'national_id', 'social_insurance_number', 'hire_date', 'monthly_wage', 'employment_type'
    ] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'profiles' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;

    foreach col in array array[
      'profiles_national_id_check', 'profiles_employment_type_check'
    ] loop
      if not exists (
        select 1
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = r.schema_name and t.relname = 'profiles' and c.conname = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0018 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  national_id         text,' in platform.tenant_ddl_template()) = 0
     or position('profiles_employment_type_check' in platform.tenant_ddl_template()) = 0 then
    raise exception '0018 VERIFY FAILED: template does not carry the statutory fields.';
  end if;

  raise notice '0018: verified — statutory employee fields live everywhere.';
end
$$;

notify pgrst, 'reload schema';

commit;
