-- ============================================================
-- 0027 — EMPLOYEE TARGETS
--
-- One table: what a manager expects of an employee this month, stated
-- as a number. "Call thirty clients", "bring in ten leads", "close
-- three deals". The employee profile page reads it next to what the
-- CRM actually recorded and renders the difference.
--
-- WHY A TABLE AND NOT COLUMNS ON profiles
-- ---------------------------------------
-- A target is per-metric and per-month. Columns on profiles would hold
-- exactly one number forever, overwrite history every time it is
-- revised, and leave "did they hit October?" unanswerable. A row per
-- (employee, metric, month) keeps the history the profile page's trend
-- table needs, and the unique index below makes writing this month's
-- number an upsert rather than a duplicate.
--
-- WHAT A TARGET COUNTS AGAINST — DELIBERATELY NOTHING NEW
-- -------------------------------------------------------
-- The actuals already exist and this migration adds no second copy of
-- them:
--
--   'calls'         lead_comments authored by the employee — the CRM's
--                   contact log, one row per call/WhatsApp/visit.
--   'new_leads'     leads carrying the employee as salesperson_id.
--   'deals_closed'  deal_tickets executed with the employee as
--                   salesperson_id.
--
-- The metric CHECK is the contract between this table and the app's
-- counting queries; a metric nobody counts would render as 0/N forever.
--
-- set_by IS WHO LAST STATED THE NUMBER. The insert/update policies pin
-- it to auth.uid(), so a revised target always names its reviser — and
-- the audit trigger keeps the before/after pair, because a target
-- quietly lowered after a bad month is exactly the kind of edit that
-- must not be invisible.
--
-- VISIBILITY. The employee sees their own targets (that is the point
-- of a target), the branch manager their branch's, the CEO everything.
-- Writing is manager-or-above, branch-scoped through profiles: the
-- subquery runs under the caller's own RLS, and profiles_select already
-- confines a manager to their own staff.
--
-- STRUCTURE MIRRORS 0016 — the last migration to add a whole table.
-- Same two targets (the DDL template for showrooms not yet provisioned,
-- every live t_<slug> for the ones already trading), same
-- anchored-and-verified substitutions, same per-tenant search_path in
-- §3 because FK targets, policy expressions and the trigger's function
-- are resolved and frozen at CREATE time.
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
      '0027 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('create table if not exists lead_vehicle_interests' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0027 PRECONDITION FAILED: the template has no lead_vehicle_interests. Apply 0016 first.';
  end if;

  -- Every anchor below quotes text 0016 spliced in; 0026 is the batch
  -- ordering gate, so a database that skipped the compliance batch
  -- fails here rather than three anchors deep.
  if position('  item_code' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0027 PRECONDITION FAILED: the template has no vehicles.item_code. Apply 0026 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. the table, immediately after lead_vehicle_interests' unique
  --     index so it lands at the end of §8 (LEADS / CRM) — targets are
  --     read against CRM activity, and this keeps the reader's eye on
  --     both halves of the comparison at once.
  c_tbl_from constant text := $a1$create unique index if not exists uniq_lead_interest_vehicle
  on lead_vehicle_interests(lead_id, vehicle_id) where vehicle_id is not null;$a1$;
  c_tbl_to   constant text := $a2$create unique index if not exists uniq_lead_interest_vehicle
  on lead_vehicle_interests(lead_id, vehicle_id) where vehicle_id is not null;

-- ------------------------------------------------------------
-- 8c. EMPLOYEE TARGETS  (0027)
--
-- What a manager expects of an employee in a given month, per metric.
-- The actuals live where they always lived (lead_comments, leads,
-- deal_tickets); this row is only the expectation, so the profile page
-- can render expectation against record.
--
-- period_month = the first day of the month the target covers. The
--                CHECK pins it to day 1 so "October" has exactly one
--                spelling and the unique index below can mean what it
--                says.
-- set_by       = who last stated the number. Pinned to auth.uid() by
--                the write policies; history is in audit_log.
-- ------------------------------------------------------------
create table if not exists employee_targets (
  id            uuid        primary key default gen_random_uuid(),
  profile_id    uuid        not null references profiles(id) on delete cascade,
  metric        text        not null check (metric in ('calls','new_leads','deals_closed')),
  target_value  int         not null check (target_value > 0),
  period_month  date        not null check (extract(day from period_month) = 1),
  set_by        uuid        references profiles(id),
  created_at    timestamptz default now()
);

create index if not exists idx_employee_targets_profile on employee_targets(profile_id);

-- One number per employee per metric per month: revising a target is an
-- UPDATE (audited), never a second row that leaves two answers.
create unique index if not exists uniq_employee_target_metric_month
  on employee_targets(profile_id, metric, period_month);$a2$;

  -- 2b. RLS
  c_rls_from constant text := $a3$alter table lead_vehicle_interests enable row level security;$a3$;
  c_rls_to   constant text := $a4$alter table lead_vehicle_interests enable row level security;
alter table employee_targets       enable row level security;$a4$;

  -- 2c. the policies, after lead_vehicle_interests' four
  c_pol_from constant text := $a5$drop policy if exists "lead_vehicle_interests_delete" on lead_vehicle_interests;
create policy "lead_vehicle_interests_delete" on lead_vehicle_interests for delete
  using (is_manager_or_above());$a5$;
  c_pol_to   constant text := $a6$drop policy if exists "lead_vehicle_interests_delete" on lead_vehicle_interests;
create policy "lead_vehicle_interests_delete" on lead_vehicle_interests for delete
  using (is_manager_or_above());

-- ------------------------------------------------------------
-- 5j-ter. EMPLOYEE TARGETS — 0027
--
-- An employee reads their own targets — a target nobody can see is a
-- number in a drawer. A manager reads and writes their branch's, the
-- CEO everything. The branch scope rides the profiles subquery, which
-- runs under the caller's own RLS: profiles_select already confines a
-- manager to their own staff, so this predicate cannot say more than
-- that policy allows.
-- ------------------------------------------------------------
drop policy if exists "employee_targets_select" on employee_targets;
create policy "employee_targets_select" on employee_targets for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id())));

-- set_by = auth.uid() in WITH CHECK, on insert AND update: the row
-- always names whoever last stated the number, and nobody can file a
-- target under a colleague's name.
drop policy if exists "employee_targets_insert" on employee_targets;
create policy "employee_targets_insert" on employee_targets for insert
  with check (
    set_by = auth.uid()
    and (is_ceo() or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id()))));

drop policy if exists "employee_targets_update" on employee_targets;
create policy "employee_targets_update" on employee_targets for update
  using (
    is_ceo() or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id())))
  with check (
    set_by = auth.uid()
    and (is_ceo() or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id()))));

-- Manager+, and §6d withholds the DELETE grant regardless — reachable
-- only through the service role's data-repair path, like every other
-- delete policy in this schema.
drop policy if exists "employee_targets_delete" on employee_targets;
create policy "employee_targets_delete" on employee_targets for delete
  using (is_manager_or_above());$a6$;

  -- 2d. the audit trigger, after lead_vehicle_interests'
  c_trg_from constant text := $a7$drop trigger if exists trg_audit_lead_vehicle_interests on lead_vehicle_interests;
create trigger trg_audit_lead_vehicle_interests
  after insert or update or delete on lead_vehicle_interests
  for each row execute function record_audit();$a7$;
  c_trg_to   constant text := $a8$drop trigger if exists trg_audit_lead_vehicle_interests on lead_vehicle_interests;
create trigger trg_audit_lead_vehicle_interests
  after insert or update or delete on lead_vehicle_interests
  for each row execute function record_audit();

-- Audited for the same reason lead_vehicle_interests is: the row is
-- revised in place, and a target quietly lowered after a bad month is
-- an edit that must leave a trace.
drop trigger if exists trg_audit_employee_targets on employee_targets;
create trigger trg_audit_employee_targets
  after insert or update or delete on employee_targets
  for each row execute function record_audit();$a8$;

  -- 2e. the grants — tenant role and service_role stated together,
  --     matching 0016's final shape in one substitution.
  c_gnt_from constant text := $a9$grant select, insert, update, delete on lead_vehicle_interests to service_role;$a9$;
  c_gnt_to   constant text := $b1$grant select, insert, update, delete on lead_vehicle_interests to service_role;

-- employees/actions.ts upserts a target (insert + update under the
-- unique index); the profile page reads. No DELETE, matching every
-- other table in 6d — a target that was a mistake is overwritten, and
-- the audit trail is the reason it is not erased.
grant select, insert, update on employee_targets to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on employee_targets to service_role;$b1$;
begin
  if position('create table if not exists employee_targets' in v_tpl) > 0 then
    raise notice '0027: template already carries employee_targets — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0027: template anchor 2a (table) did not match. Template drifted from 0016.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0027: template anchor 2b (rls) did not match. Template drifted from 0016.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0027: template anchor 2c (policies) did not match. Template drifted from 0016.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0027: template anchor 2d (audit trigger) did not match. Template drifted from 0016.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0027: template anchor 2e (grants) did not match. Template drifted from 0016.';
    end if;
    v_done := v_done + 1;

    -- Every anchor above is a prefix of its replacement, so `replace`
    -- would fire twice if the template ever carried two copies.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists employee_targets', ''))) <> 43 then
      raise exception '0027: the template carries more than one employee_targets table.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0027$ select %L::text $felix_0027$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0027: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0016 §3:
-- the FK targets, the policy expressions and the trigger's function are
-- resolved and frozen HERE, and each showroom's must bind to its own.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_ddl constant text := $ddl$
create table if not exists employee_targets (
  id            uuid        primary key default gen_random_uuid(),
  profile_id    uuid        not null references profiles(id) on delete cascade,
  metric        text        not null check (metric in ('calls','new_leads','deals_closed')),
  target_value  int         not null check (target_value > 0),
  period_month  date        not null check (extract(day from period_month) = 1),
  set_by        uuid        references profiles(id),
  created_at    timestamptz default now()
);

create index if not exists idx_employee_targets_profile on employee_targets(profile_id);

create unique index if not exists uniq_employee_target_metric_month
  on employee_targets(profile_id, metric, period_month);

alter table employee_targets enable row level security;

drop policy if exists "employee_targets_select" on employee_targets;
create policy "employee_targets_select" on employee_targets for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id())));

drop policy if exists "employee_targets_insert" on employee_targets;
create policy "employee_targets_insert" on employee_targets for insert
  with check (
    set_by = auth.uid()
    and (is_ceo() or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id()))));

drop policy if exists "employee_targets_update" on employee_targets;
create policy "employee_targets_update" on employee_targets for update
  using (
    is_ceo() or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id())))
  with check (
    set_by = auth.uid()
    and (is_ceo() or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = employee_targets.profile_id
         and p.branch_id = current_branch_id()))));

drop policy if exists "employee_targets_delete" on employee_targets;
create policy "employee_targets_delete" on employee_targets for delete
  using (is_manager_or_above());

drop trigger if exists trg_audit_employee_targets on employee_targets;
create trigger trg_audit_employee_targets
  after insert or update or delete on employee_targets
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- profiles is the FK target and record_audit() must exist; checking
    -- profiles tells a half-provisioned tenant from a complete one.
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0027: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- §6b's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards — these three statements are
    -- what makes the table reachable, and by exactly whom.
    execute format(
      'grant select, insert, update on %I.employee_targets to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.employee_targets to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.employee_targets from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0027: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0027: % tenant schema(s) carry employee_targets.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — structure, isolation, lockdown, and that every
-- policy bound to THIS schema's predicates.
-- ============================================================
do $$
declare
  r       record;
  v_bad   text[] := '{}';
  n       int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.employee_targets', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'employee_targets'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'employee_targets';
    if n <> 4 then
      v_bad := v_bad || format('%s (%s policies, expected 4)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's helpers.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'employee_targets'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    if not has_table_privilege(
         r.role_name, format('%I.employee_targets', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (role has no select)');
    end if;

    if not has_table_privilege(
         'service_role', format('%I.employee_targets', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.employee_targets', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.employee_targets', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege)');
    end if;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'employee_targets'
         and t.tgname = 'trg_audit_employee_targets' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (no audit trigger)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0027 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists employee_targets' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert, update on employee_targets' in platform.tenant_ddl_template()) = 0
     or position('on employee_targets to service_role' in platform.tenant_ddl_template()) = 0 then
    raise exception '0027 VERIFY FAILED: the template does not carry the new table.';
  end if;

  raise notice '0027: verified — targets can be set and read everywhere.';
end
$$;

notify pgrst, 'reload schema';

commit;
