-- ============================================================
-- 0049 — THE SALES BONUS LADDER
--
-- "Sell three cars this month, get X. Sell eight, get Y." Every
-- showroom runs some version of this and FELIX has had nowhere to put
-- it: commission_tiers (0001) is a PER-DEAL percentage of profit, paid
-- on the ticket, and employee_targets (0027) is an aspiration with no
-- money attached. Neither answers "how much does Karim earn this month
-- for volume alone", which is the number HR is actually asked for.
--
-- WHAT THIS ADDS
-- ---------------
--   bonus_rules      one row per rung: min_units -> bonus_amount.
--   monthly_sales_units(from, to)
--                    how many cars each salesperson executed in a
--                    window. Counted, never stored.
--
-- A LADDER, NOT A TABLE OF FIFTEEN NUMBERS
-- -----------------------------------------
-- The rule is "the highest ACTIVE rung whose min_units is at or below
-- what you sold". Three rungs (3 -> 2 000, 8 -> 6 000, 12 -> 12 000)
-- express the same scheme as fifteen rows and survive a mid-year
-- revision without HR retyping twelve unchanged numbers. Fifteen is the
-- ceiling because that is the ceiling the showroom asked for, and it is
-- a CHECK rather than a convention so a fat-fingered 150 is refused at
-- the database rather than becoming an unreachable rung nobody notices.
--
-- The ladder is NOT cumulative: earning rung 3 does not also pay rungs
-- 1 and 2. Stated here because it is the one thing about a bonus scheme
-- that everybody assumes differently, and the resolver in
-- src/lib/bonus.ts is tested against this sentence.
--
-- NO PAYOUT ROWS, DELIBERATELY
-- -----------------------------
-- This migration adds no bonus_payouts table and writes nothing to
-- ledger_entries. What a rung is worth and whether it has been PAID are
-- different facts with different lifecycles, and inventing a payment
-- record that no accounting screen reconciles would be worse than
-- having none: it would look authoritative and drift from the ledger on
-- the first month somebody paid in cash. The HR screen computes what is
-- owed and the accountant pays it through the ledger paths that already
-- exist. If payouts are wanted as records later, they are a table of
-- their own with the accountant's policies on them.
--
-- WHY monthly_sales_units() IS SECURITY DEFINER, AND WHAT IT REFUSES
-- -------------------------------------------------------------------
-- HR must see the unit count and must NOT see the deal. 0047 kept HR
-- out of is_staff() precisely so that agreed_price, discount_amount,
-- the trade-in allowance and the vehicle cost stay invisible to
-- payroll — and deal_tickets_select is built on is_staff(). A plain
-- query would therefore return HR nothing at all.
--
-- So the count is a definer function that returns TWO COLUMNS: a
-- profile id and an integer. No price, no vehicle, no customer. It
-- bypasses RLS to count rows it will never show, which is the narrowest
-- possible shape for the question being asked.
--
-- It is not open to everyone. CEO, HR and the accountant get the whole
-- showroom; a branch manager gets the branches can_read_branch() admits
-- (their own plus grants); everybody else gets exactly one row — their
-- own. That last arm is the point of showing a salesperson the ladder
-- at all. An investor gets nothing: they are outside capital, and a
-- per-employee productivity feed is not part of a cap table.
--
-- Assertion (f)'s SECURITY DEFINER count goes 23 -> 24. §4 patches
-- create_tenant_schema()'s own live source, 0045's technique.
--
-- WHO EDITS THE LADDER: is_ceo() or is_hr(). Since 0048 that second
-- predicate also admits a grantee, so "the accountant also runs
-- payroll" works here with no further change — which is the whole
-- reason 0048 changed the function rather than the policies.
--
-- WHO READS IT: everyone with a profile. A bonus scheme nobody can see
-- is not an incentive, and there is nothing confidential about the
-- rungs — the confidential part is what any individual earned, and that
-- lives in monthly_sales_units()'s role gate, not here.
--
-- NO DELETE. Retiring a rung is `active = false`, so a scheme that
-- changes in June can still explain what May paid. Assertion (j) would
-- refuse the grant regardless.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor into the template's own convention first.
--
-- GATE. On 0046 (the company_settings block supplies the anchors) and
-- 0048 (has_feature must exist, since is_hr() now calls it).
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
    raise exception '0049 PRECONDITION FAILED: platform.tenant_ddl_template() missing. Apply 0009 first.';
  end if;
  if position('  constraint uniq_company_settings unique (singleton)' in platform.tenant_ddl_template()) = 0 then
    raise exception '0049 PRECONDITION FAILED: the template has no company_settings. Apply 0046 first.';
  end if;
  if position('create or replace function has_feature' in platform.tenant_ddl_template()) = 0 then
    raise exception '0049 PRECONDITION FAILED: the template has no has_feature(). Apply 0048 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int := 0;

  c_tbl_from text := $a1$  constraint uniq_company_settings unique (singleton)
);$a1$;
  c_tbl_to   text := $a2$  constraint uniq_company_settings unique (singleton)
);

-- ------------------------------------------------------------
-- 1-quater. THE SALES BONUS LADDER (0049)
--
-- One row per rung. The rule is "the highest ACTIVE rung whose
-- min_units is at or below the cars you executed this calendar month",
-- and it is NOT cumulative — see the migration header, which is the
-- only place that sentence is written down.
--
-- Fifteen is a CHECK, not a convention: a rung above the showroom's
-- stated ceiling is unreachable and would sit in the table looking
-- like policy.
-- ------------------------------------------------------------
create table if not exists bonus_rules (
  id           uuid        primary key default gen_random_uuid(),
  min_units    int         not null,
  bonus_amount numeric     not null,
  active       boolean     not null default true,
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references profiles(id),
  constraint bonus_rules_min_units_check check (min_units between 1 and 15),
  constraint bonus_rules_amount_check    check (bonus_amount >= 0),
  constraint uniq_bonus_rule_units       unique (min_units)
);$a2$;

  c_fn_from text := $b1$create or replace function has_feature(p_feature text) returns boolean as $fn$$b1$;
  c_fn_to   text := $b2$-- 0049. How many cars each salesperson EXECUTED in a window.
--
-- SECURITY DEFINER because HR must see the count and must never see the
-- deal: deal_tickets_select is built on is_staff(), and 0047 kept HR
-- out of is_staff() on purpose so that price, discount, trade-in
-- allowance and vehicle cost stay invisible to payroll. This returns a
-- profile id and an integer and nothing else — it bypasses RLS to count
-- rows it will never show.
--
-- The gate is inside the function rather than on a policy, because
-- there is no row here to attach a policy to. CEO / HR / accountant see
-- the showroom; a branch manager sees the branches can_read_branch()
-- admits; everyone else sees their own single row, which is what makes
-- the ladder visible to the person climbing it. An investor sees
-- nothing.
--
-- 'executed' is the only status counted: a submitted or approved ticket
-- is not a sale, and a bonus that pays on approval would pay on tickets
-- that are later rejected.
create or replace function monthly_sales_units(p_from timestamptz, p_to timestamptz)
returns table (profile_id uuid, units bigint) as $fn$
declare
  v_role text := {{SCHEMA}}.current_role_name();
begin
  if v_role is null or v_role = 'investor' then
    return;
  end if;

  if {{SCHEMA}}.is_ceo() or {{SCHEMA}}.is_hr() or {{SCHEMA}}.is_accountant_or_above() then
    return query
      select t.salesperson_id, count(*)::bigint
        from {{SCHEMA}}.deal_tickets t
       where t.status = 'executed'
         and t.salesperson_id is not null
         and t.executed_at >= p_from
         and t.executed_at <  p_to
       group by t.salesperson_id;
  elsif {{SCHEMA}}.is_manager_or_above() then
    return query
      select t.salesperson_id, count(*)::bigint
        from {{SCHEMA}}.deal_tickets t
       where t.status = 'executed'
         and t.salesperson_id is not null
         and t.executed_at >= p_from
         and t.executed_at <  p_to
         and {{SCHEMA}}.can_read_branch(t.branch_id)
       group by t.salesperson_id;
  else
    return query
      select t.salesperson_id, count(*)::bigint
        from {{SCHEMA}}.deal_tickets t
       where t.status = 'executed'
         and t.salesperson_id = auth.uid()
         and t.executed_at >= p_from
         and t.executed_at <  p_to
       group by t.salesperson_id;
  end if;
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;

create or replace function has_feature(p_feature text) returns boolean as $fn$$b2$;

  c_rls_from text := $c1$alter table company_settings       enable row level security;$c1$;
  c_rls_to   text := $c2$alter table company_settings       enable row level security;
alter table bonus_rules            enable row level security;$c2$;

  c_pol_from text := $d1$drop policy if exists "company_settings_select" on company_settings;$d1$;
  c_pol_to   text := $d2$-- ------------------------------------------------------------
-- 5v. THE BONUS LADDER — 0049
--
-- READ: anyone with a profile. A scheme nobody can see is not an
-- incentive. What an INDIVIDUAL earned is the confidential part and it
-- is gated inside monthly_sales_units(), not here.
--
-- WRITE: is_ceo() or is_hr(). Since 0048 is_hr() also admits a CEO-
-- granted holder of the HR hub, so "the accountant also runs payroll"
-- needs no change here.
--
-- NO DELETE POLICY and §6 grants none: retiring a rung is active=false,
-- so a scheme revised in June can still explain what May paid.
-- ------------------------------------------------------------
drop policy if exists "bonus_rules_select" on bonus_rules;
create policy "bonus_rules_select" on bonus_rules for select
  using (current_role_name() is not null);

drop policy if exists "bonus_rules_insert" on bonus_rules;
create policy "bonus_rules_insert" on bonus_rules for insert
  with check (is_ceo() or is_hr());

drop policy if exists "bonus_rules_update" on bonus_rules;
create policy "bonus_rules_update" on bonus_rules for update
  using (is_ceo() or is_hr()) with check (is_ceo() or is_hr());

drop policy if exists "company_settings_select" on company_settings;$d2$;

  c_trg_from text := $e1$drop trigger if exists trg_audit_feature_grants on feature_grants;$e1$;
  c_trg_to   text := $e2$-- What the bonus scheme was, and when it changed, is exactly the kind of
-- number that gets quietly revised after a good month.
drop trigger if exists trg_audit_bonus_rules on bonus_rules;
create trigger trg_audit_bonus_rules
  after insert or update or delete on bonus_rules
  for each row execute function record_audit();

drop trigger if exists trg_audit_feature_grants on feature_grants;$e2$;

  c_gnt_from text := $f1$grant select, insert, update, delete on company_settings to service_role;$f1$;
  c_gnt_to   text := $f2$grant select, insert, update, delete on company_settings to service_role;

-- 0049. The ladder: read by everyone, written by CEO/HR under policy,
-- deleted by nobody.
grant select, insert, update on bonus_rules to {{ROLE}};
grant select, insert, update, delete on bonus_rules to service_role;
-- The count behind the ladder. The function gates itself by role; this
-- grant only says a tenant session may ask.
grant execute on function monthly_sales_units(timestamptz, timestamptz) to {{ROLE}};$f2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_tbl_from := replace(replace(c_tbl_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_from  := replace(replace(c_fn_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_to    := replace(replace(c_fn_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_from := replace(replace(c_trg_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_to   := replace(replace(c_trg_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists bonus_rules' in v_tpl) > 0 then
    raise notice '0049: template already carries bonus_rules — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0049: template anchor 2a (table) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0049: template anchor 2b (monthly_sales_units) did not match. Template drifted from 0048.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0049: template anchor 2c (rls) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0049: template anchor 2d (policies) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0049: template anchor 2e (audit trigger) did not match. Template drifted from 0048.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0049: template anchor 2f (grants) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists bonus_rules', ''))) <>
       length('create table if not exists bonus_rules') then
      raise exception '0049: the template does not carry exactly one bonus_rules table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function monthly_sales_units', ''))) <>
       length('create or replace function monthly_sales_units') then
      raise exception '0049: the template does not carry exactly one monthly_sales_units().';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0049$ select %L::text $felix_0049$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0049: template amended (% substitutions).', v_done;
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
  v_ddl   text;
  c_ddl constant text := $ddl$
create table if not exists bonus_rules (
  id           uuid        primary key default gen_random_uuid(),
  min_units    int         not null,
  bonus_amount numeric     not null,
  active       boolean     not null default true,
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references profiles(id)
);

alter table bonus_rules drop constraint if exists bonus_rules_min_units_check;
alter table bonus_rules add constraint bonus_rules_min_units_check check (min_units between 1 and 15);
alter table bonus_rules drop constraint if exists bonus_rules_amount_check;
alter table bonus_rules add constraint bonus_rules_amount_check check (bonus_amount >= 0);
drop index if exists uniq_bonus_rule_units;
create unique index uniq_bonus_rule_units on bonus_rules(min_units);

alter table bonus_rules enable row level security;

drop policy if exists "bonus_rules_select" on bonus_rules;
create policy "bonus_rules_select" on bonus_rules for select
  using (current_role_name() is not null);

drop policy if exists "bonus_rules_insert" on bonus_rules;
create policy "bonus_rules_insert" on bonus_rules for insert
  with check (is_ceo() or is_hr());

drop policy if exists "bonus_rules_update" on bonus_rules;
create policy "bonus_rules_update" on bonus_rules for update
  using (is_ceo() or is_hr()) with check (is_ceo() or is_hr());

drop trigger if exists trg_audit_bonus_rules on bonus_rules;
create trigger trg_audit_bonus_rules
  after insert or update or delete on bonus_rules
  for each row execute function record_audit();

-- See the migration header for why this is a definer returning two
-- columns rather than a query HR could run themselves.
create or replace function monthly_sales_units(p_from timestamptz, p_to timestamptz)
returns table (profile_id uuid, units bigint) as $fn$
declare
  v_role text := {{SCHEMA}}.current_role_name();
begin
  if v_role is null or v_role = 'investor' then
    return;
  end if;

  if {{SCHEMA}}.is_ceo() or {{SCHEMA}}.is_hr() or {{SCHEMA}}.is_accountant_or_above() then
    return query
      select t.salesperson_id, count(*)::bigint
        from {{SCHEMA}}.deal_tickets t
       where t.status = 'executed'
         and t.salesperson_id is not null
         and t.executed_at >= p_from
         and t.executed_at <  p_to
       group by t.salesperson_id;
  elsif {{SCHEMA}}.is_manager_or_above() then
    return query
      select t.salesperson_id, count(*)::bigint
        from {{SCHEMA}}.deal_tickets t
       where t.status = 'executed'
         and t.salesperson_id is not null
         and t.executed_at >= p_from
         and t.executed_at <  p_to
         and {{SCHEMA}}.can_read_branch(t.branch_id)
       group by t.salesperson_id;
  else
    return query
      select t.salesperson_id, count(*)::bigint
        from {{SCHEMA}}.deal_tickets t
       where t.status = 'executed'
         and t.salesperson_id = auth.uid()
         and t.executed_at >= p_from
         and t.executed_at <  p_to
       group by t.salesperson_id;
  end if;
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;
$ddl$;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      raise notice '0049: %.deal_tickets missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    v_ddl := replace(c_ddl, '{{SCHEMA}}', quote_ident(r.schema_name));
    execute v_ddl;

    execute format('grant select, insert, update on %I.bonus_rules to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update, delete on %I.bonus_rules to service_role', r.schema_name);
    execute format('revoke all on table %I.bonus_rules from public, anon, authenticated', r.schema_name);
    execute format(
      'grant execute on function %I.monthly_sales_units(timestamptz, timestamptz) to %I',
      r.schema_name, r.role_name);

    v_count := v_count + 1;
    raise notice '0049: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0049: % tenant schema(s) carry a bonus ladder.', v_count;
end
$mig$;

-- ============================================================
-- 4. RAISE ASSERTION (f) 23 -> 24
-- ============================================================
do $mig$
declare
  v_src      text;
  v_n        int;
  v_expected int;
begin
  select p.prosrc into v_src
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_src is null then
    raise exception '0049: platform.create_tenant_schema() not found.';
  end if;

  v_expected := substring(v_src from 'expected ([0-9]+) SECURITY DEFINER functions')::int;

  -- >= rather than = 24 — see 0048 §4 for the second-run failure this
  -- avoids.
  if v_expected >= 24 then
    raise notice '0049: create_tenant_schema() already asserts % — skipping.', v_expected;
  else
    v_n := length(v_src) - length(replace(v_src, 'expected 23 SECURITY DEFINER functions', ''));
    if v_n <> length('expected 23 SECURITY DEFINER functions') then
      raise exception
        '0049: expected exactly one "expected 23 SECURITY DEFINER functions" in create_tenant_schema(). Function drifted from 0048.';
    end if;

    v_src := replace(v_src, 'expected 23 SECURITY DEFINER functions', 'expected 24 SECURITY DEFINER functions');
    v_src := replace(v_src, 'if n <> 23 then', 'if n <> 24 then');

    execute format(
      'create or replace function platform.create_tenant_schema(p_slug text) returns text '
      'language plpgsql security definer set search_path = pg_catalog, platform as %L',
      v_src
    );
    raise notice '0049: platform.create_tenant_schema() now asserts 24 SECURITY DEFINER functions.';
  end if;
end
$mig$;

-- ============================================================
-- 5. BACKFILL
--
-- None. A bonus scheme is a business decision, and inventing rungs
-- would put numbers in front of a salesperson that nobody at the
-- showroom agreed to pay. The table stays empty until HR fills it, and
-- the screen says so rather than showing a zero ladder.
-- ============================================================

-- ============================================================
-- 6. SELF-VERIFY
-- ============================================================
do $$
declare
  r          record;
  v_bad      text[] := '{}';
  n          int;
  v_expected int;
begin
  -- Read from the provisioner rather than hard-coded — see 0048 §5 for
  -- why: migrations land in whatever order the operator runs them, and a
  -- later one raising this number must not make THIS file's re-run
  -- report a failure that is not one.
  select substring(p.prosrc from 'expected ([0-9]+) SECURITY DEFINER functions')::int
    into v_expected
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_expected is null then
    raise exception '0049 VERIFY FAILED: create_tenant_schema() states no SECURITY DEFINER count.';
  end if;

  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.bonus_rules', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (bonus_rules missing)');
      continue;
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'bonus_rules' and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (bonus_rules has RLS disabled)');
    end if;

    -- The fifteen-rung ceiling is policy, not decoration.
    if not exists (
      select 1 from pg_constraint pc
       where pc.conrelid = format('%I.bonus_rules', r.schema_name)::regclass
         and pc.conname = 'bonus_rules_min_units_check'
    ) then
      v_bad := v_bad || (r.schema_name || ' (bonus_rules_min_units_check missing)');
    end if;

    -- The counter exists, is a definer, and pins its search_path.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.proname = 'monthly_sales_units'
       and p.prosecdef
       and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                    where cfg like 'search_path=%');
    if n <> 1 then
      v_bad := v_bad || (r.schema_name || ' (monthly_sales_units missing, not definer, or unpinned)');
    end if;

    if not has_function_privilege(r.role_name,
         format('%I.monthly_sales_units(timestamptz, timestamptz)', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (tenant role cannot execute monthly_sales_units)');
    end if;
    if has_table_privilege(r.role_name, format('%I.bonus_rules', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (tenant role holds DELETE on bonus_rules)');
    end if;

    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> v_expected then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, expected %s)',
                               r.schema_name, n, v_expected);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0049 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists bonus_rules' in platform.tenant_ddl_template()) = 0 then
    raise exception '0049 VERIFY FAILED: template does not carry bonus_rules.';
  end if;
  -- At least 24: monthly_sales_units() must be counted. A later
  -- migration raising the figure further is not a regression.
  if v_expected < 24 then
    raise exception
      '0049 VERIFY FAILED: create_tenant_schema() asserts % SECURITY DEFINER functions — monthly_sales_units() is not counted, so the next provision would fail.',
      v_expected;
  end if;

  raise notice '0049: verified — HR can set a bonus ladder and read unit counts without ever seeing a price.';
end
$$;

commit;

notify pgrst, 'reload schema';
