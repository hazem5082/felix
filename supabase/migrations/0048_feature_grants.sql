-- ============================================================
-- 0048 — FEATURE GRANTS: THE CEO DECIDES WHO SEES WHICH HUB
--
-- Until now the navigation was a constant. src/components/layout/
-- nav-config.ts holds a Record<Role, NavKey[]>, and that table decided
-- for every showroom on the platform which tabs an accountant sees.
-- Real companies do not divide that cleanly: the accountant at a
-- four-person showroom IS the payroll clerk, and the CEO of that
-- showroom cannot say so without a code change.
--
-- WHAT THIS ADDS — one table per tenant schema:
--
--   feature_grants
--     profile_id  whose navigation this row edits
--     feature     which hub or tab
--     mode        'grant' — hand this person a hub they do not have
--                 'hide'  — remove a tab their role does carry
--     granted_by / granted_at / revoked_at / revoked_by / note
--
-- THE HONEST PART, AND THE WHOLE REASON THIS FILE IS NOT SHORTER
-- ---------------------------------------------------------------
-- A tab is not a permission. If "give the accountant the HR hub" only
-- edited a sidebar, the accountant would click it and land on a page
-- that renders nothing, because profiles_select, the attendance
-- policies and the payroll guard all key off is_hr(). A navigation
-- entry that leads to an empty screen is worse than no entry.
--
-- So mode='grant' is REAL AUTHORITY, enforced in Postgres. That is what
-- has_feature() below is for, and it is why the grantable set is
-- deliberately tiny:
--
--   feature_grants_grantable  CHECK (mode = 'hide' or feature = 'hr')
--
-- Exactly one feature can currently be GRANTED, because exactly one has
-- had its policies wired to consult the grant. Adding a second is a
-- migration that widens that CHECK *and* the policies in the same
-- commit — never one without the other. Anything else would be a
-- product promise the database does not keep.
--
-- mode='hide' is the opposite and says so out loud: it removes a tab
-- from the navigation and changes NO database authority whatsoever. The
-- role still holds everything it held; the person just stops seeing the
-- door. That is genuinely useful for decluttering a small showroom's
-- sidebar and it is genuinely not a security control, so the admin
-- screen labels it as such and nothing in this schema pretends
-- otherwise. 'account' and 'support' cannot be hidden — locking someone
-- out of their own profile and the help desk is never the intent.
--
-- HOW THE GRANT REACHES THE POLICIES: is_hr() IS REDEFINED
-- ---------------------------------------------------------
-- 0047, one migration ago, wrote:
--
--   is_hr()  ==  current_role_name() = 'hr'
--
-- and put it in seven places: profiles_select, profiles_update_self,
-- trusted_devices_select, the three attendance policies, and two arms
-- of guard_profile_privilege_columns(). This migration changes the
-- FUNCTION rather than the seven call sites:
--
--   is_hr()  ==  current_role_name() = 'hr' or has_feature('hr')
--
-- One substitution instead of seven, and every fence 0047 built —
-- including "HR may not touch a CEO's row" and "nobody sets their own
-- wage" — extends to a grantee automatically, which is exactly what
-- must happen and exactly what seven hand-edited policies would
-- eventually get wrong. It is the same move can_act_on_branch() already
-- makes for branch_grants (0030): the predicate answers "does this
-- session hold that authority", not "was that authority written on the
-- profile row".
--
-- The name now slightly under-describes it — is_hr() returns true for
-- an accountant holding an HR grant. §5(c) asserts the new body so the
-- semantics cannot quietly revert, and this paragraph is the warning to
-- the next reader.
--
-- WHY has_feature() IS SECURITY DEFINER
-- --------------------------------------
-- Both of 0037's reasons, unchanged. It names auth.uid(), and a policy
-- expression is evaluated AS THE TENANT ROLE, which has no USAGE on
-- schema auth — an invoker function inlined into a policy raises 42501
-- (the fault 0045 had to repair in the price-history path). And it
-- reads feature_grants from inside policies on OTHER tables, so without
-- the definer bypass it would drag feature_grants' own RLS into every
-- one of those plans. SECURITY DEFINER does not weaken the answer:
-- auth.uid() reads the request's JWT claim, not the database role, so
-- the caller is still the caller.
--
-- Assertion (f)'s SECURITY DEFINER count therefore goes 22 -> 23. §4
-- patches create_tenant_schema()'s own live source, 0045's technique.
--
-- NO DELETE. Revoking is `revoked_at = now()`, so who granted what to
-- whom and who took it back survives — the same reasoning branch_grants
-- (0030) records, and assertion (j) would refuse the grant regardless.
--
-- NO auth.uid() IN ANY POLICY ON THIS TABLE beyond the plain
-- `profile_id = auth.uid()` self-read that every other table here uses
-- safely. granted_by and revoked_by are stamped by the server action
-- from the authenticated session, not pinned by a WITH CHECK — 0046's
-- header explains why that pattern is banned.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor into the template's own convention first.
--
-- GATE. On 0047 (is_hr must exist to be redefined) and 0030 (the
-- branch_grants block supplies the anchors).
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
    raise exception '0048 PRECONDITION FAILED: platform.tenant_ddl_template() missing. Apply 0009 first.';
  end if;
  if position('create or replace function is_hr() returns boolean' in platform.tenant_ddl_template()) = 0 then
    raise exception '0048 PRECONDITION FAILED: the template has no is_hr(). Apply 0047 first.';
  end if;
  if position('  on branch_grants(profile_id, branch_id);' in platform.tenant_ddl_template()) = 0 then
    raise exception '0048 PRECONDITION FAILED: the template has no branch_grants block. Apply 0030 first.';
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

  -- 2a. the table, appended to the branch_grants block it is modelled on.
  c_tbl_from text := $a1$  on branch_grants(profile_id, branch_id);$a1$;
  c_tbl_to   text := $a2$  on branch_grants(profile_id, branch_id);

-- ------------------------------------------------------------
-- 8-bis. FEATURE GRANTS (0048)
--
-- Which hubs this person sees beyond their role's default, and which
-- of their role's defaults they do not. See the migration header for
-- why 'grant' is real database authority and 'hide' is cosmetic — the
-- two CHECKs below are that distinction made unbypassable.
-- ------------------------------------------------------------
create table if not exists feature_grants (
  id          uuid        primary key default gen_random_uuid(),
  profile_id  uuid        not null references profiles(id) on delete cascade,
  feature     text        not null,
  mode        text        not null default 'grant',
  granted_by  uuid        references profiles(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid        references profiles(id),
  note        text,
  constraint feature_grants_mode_check check (mode in ('grant','hide')),
  -- The full navigation vocabulary. A key absent here cannot be
  -- addressed at all, which is what keeps a typo in the admin screen
  -- from silently doing nothing.
  constraint feature_grants_feature_check check (feature in (
    'hr','ceoDashboard','inventory','crm','deals','marketing',
    'accountant','investor','calendar','employees','attendance','mail','support','account')),
  -- ONLY features whose POLICIES consult has_feature() may be granted.
  -- Widening this list without wiring the policies in the same
  -- migration hands somebody a tab onto an empty page.
  constraint feature_grants_grantable check (mode = 'hide' or feature = 'hr'),
  -- Nobody may be locked out of their own profile or the help desk.
  constraint feature_grants_hideable check (
    mode <> 'hide' or feature not in ('account','support'))
);

-- The lookup every page load makes: this profile's live rows.
create index if not exists idx_feature_grants_profile on feature_grants(profile_id);

-- One live row per (profile, feature). revoked_at is part of the index
-- predicate rather than the key, so re-granting after a revoke opens a
-- fresh row and the revoked one stays as history — the opposite of
-- branch_grants, and deliberately: a grant and a hide of the same
-- feature must never be live at once, which a reused row could not
-- express when the mode changes.
create unique index if not exists uniq_feature_grant_live
  on feature_grants(profile_id, feature) where revoked_at is null;$a2$;

  -- 2b. has_feature(), beside the branch-grant lookup it is modelled on.
  c_fn_from text := $b1$create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$$b1$;
  c_fn_to   text := $b2$-- 0048. Does this session hold a live grant for this feature?
--
-- SECURITY DEFINER for both of has_branch_grant()'s reasons: it names
-- auth.uid(), which a policy evaluated as the tenant role may not do
-- (no USAGE on schema auth — the 42501 that 0045 had to repair), and it
-- is read from policies on OTHER tables, where invoker semantics would
-- drag feature_grants' own RLS into every plan. auth.uid() reads the
-- JWT claim rather than the database role, so the caller is still the
-- caller.
--
-- mode is checked explicitly: a 'hide' row must never confer anything.
create or replace function has_feature(p_feature text) returns boolean as $fn$
  select exists (
    select 1 from {{SCHEMA}}.feature_grants g
     where g.profile_id = auth.uid()
       and g.feature    = p_feature
       and g.mode       = 'grant'
       and g.revoked_at is null
  );
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;

create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$$b2$;

  -- 2c. is_hr() learns about the grant. One substitution instead of
  --     seven policy edits — see the migration header.
  c_hr_from text := $c1$create or replace function is_hr() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() = 'hr';
$fn$ language sql stable;$c1$;
  c_hr_to   text := $c2$-- 0048. "Does this session hold HR authority", by role OR by grant —
-- not "is the word hr written on the profile row". The name now
-- under-describes it on purpose: every one of 0047's seven call sites
-- (four policies, two attendance write policies and both arms of the
-- privilege guard) means the former, so folding the grant in here
-- extends all seven at once, including the two that RESTRICT what HR
-- may do. Editing seven policies instead is how a grantee eventually
-- ends up able to set their own wage.
--
-- Same construction can_act_on_branch() uses for branch_grants (0030).
create or replace function is_hr() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() = 'hr'
      or {{SCHEMA}}.has_feature('hr');
$fn$ language sql stable;$c2$;

  -- 2d. RLS on.
  c_rls_from text := $d1$alter table branch_grants          enable row level security;$d1$;
  c_rls_to   text := $d2$alter table branch_grants          enable row level security;
alter table feature_grants         enable row level security;$d2$;

  -- 2e. policies.
  c_pol_from text := $e1$drop policy if exists "branch_grants_select" on branch_grants;$e1$;
  c_pol_to   text := $e2$-- ------------------------------------------------------------
-- 5u. FEATURE GRANTS — 0048
--
-- READ: your own rows, plus the CEO's view of everyone's. The self-read
-- is not a courtesy — has_feature() is SECURITY DEFINER and does not
-- need it, but the app reads this table directly to build the sidebar,
-- and a person must be able to see which hubs they hold.
--
-- WRITE: is_ceo(), nothing weaker. Deciding who administers payroll is
-- not a branch-level decision, and a branch manager who could grant
-- themselves 'hr' would be granting themselves every profile in the
-- company plus the wage column.
--
-- NO DELETE POLICY and §6 grants none: revoking is an UPDATE that sets
-- revoked_at, so the history of who widened whose reach survives.
-- ------------------------------------------------------------
drop policy if exists "feature_grants_select" on feature_grants;
create policy "feature_grants_select" on feature_grants for select
  using (profile_id = auth.uid() or is_ceo());

drop policy if exists "feature_grants_insert" on feature_grants;
create policy "feature_grants_insert" on feature_grants for insert
  with check (is_ceo());

drop policy if exists "feature_grants_update" on feature_grants;
create policy "feature_grants_update" on feature_grants for update
  using (is_ceo()) with check (is_ceo());

drop policy if exists "branch_grants_select" on branch_grants;$e2$;

  -- 2f. the audit trigger. Who was handed the payroll hub, when, and
  --     who took it back are questions that must survive the row.
  c_trg_from text := $f1$drop trigger if exists trg_audit_branch_grants on branch_grants;$f1$;
  c_trg_to   text := $f2$drop trigger if exists trg_audit_feature_grants on feature_grants;
create trigger trg_audit_feature_grants
  after insert or update or delete on feature_grants
  for each row execute function record_audit();

drop trigger if exists trg_audit_branch_grants on branch_grants;$f2$;

  -- 2g. grants.
  c_gnt_from text := $g1$grant select, insert, update on branch_grants to {{ROLE}};$g1$;
  c_gnt_to   text := $g2$grant select, insert, update on branch_grants to {{ROLE}};

-- 0048. Same shape and the same reasoning: everyone reads their own
-- rows so the sidebar can be built, the CEO writes, nobody deletes.
grant select, insert, update on feature_grants to {{ROLE}};
grant select, insert, update, delete on feature_grants to service_role;$g2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_tbl_from := replace(replace(c_tbl_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_from  := replace(replace(c_fn_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_to    := replace(replace(c_fn_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_hr_from  := replace(replace(c_hr_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_hr_to    := replace(replace(c_hr_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_from := replace(replace(c_trg_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_to   := replace(replace(c_trg_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists feature_grants' in v_tpl) > 0 then
    raise notice '0048: template already carries feature_grants — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2a (table) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2b (has_feature) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_hr_from, c_hr_to);
    if position(c_hr_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2c (is_hr) did not match. Template drifted from 0047.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2d (rls) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2e (policies) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2f (audit trigger) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0048: template anchor 2g (grants) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists feature_grants', ''))) <>
       length('create table if not exists feature_grants') then
      raise exception '0048: the template does not carry exactly one feature_grants table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function has_feature', ''))) <>
       length('create or replace function has_feature') then
      raise exception '0048: the template does not carry exactly one has_feature().';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0048$ select %L::text $felix_0048$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0048: template amended (% substitutions).', v_done;
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
create table if not exists feature_grants (
  id          uuid        primary key default gen_random_uuid(),
  profile_id  uuid        not null references profiles(id) on delete cascade,
  feature     text        not null,
  mode        text        not null default 'grant',
  granted_by  uuid        references profiles(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid        references profiles(id),
  note        text
);

-- No `add constraint if not exists` in Postgres, so drop-then-add
-- converges on a re-run (0018's lesson).
alter table feature_grants drop constraint if exists feature_grants_mode_check;
alter table feature_grants add constraint feature_grants_mode_check check (mode in ('grant','hide'));
alter table feature_grants drop constraint if exists feature_grants_feature_check;
alter table feature_grants add constraint feature_grants_feature_check check (feature in (
  'hr','ceoDashboard','inventory','crm','deals','marketing',
  'accountant','investor','calendar','employees','attendance','mail','support','account'));
alter table feature_grants drop constraint if exists feature_grants_grantable;
alter table feature_grants add constraint feature_grants_grantable check (mode = 'hide' or feature = 'hr');
alter table feature_grants drop constraint if exists feature_grants_hideable;
alter table feature_grants add constraint feature_grants_hideable check (
  mode <> 'hide' or feature not in ('account','support'));

create index if not exists idx_feature_grants_profile on feature_grants(profile_id);
drop index if exists uniq_feature_grant_live;
create unique index uniq_feature_grant_live
  on feature_grants(profile_id, feature) where revoked_at is null;

alter table feature_grants enable row level security;

drop policy if exists "feature_grants_select" on feature_grants;
create policy "feature_grants_select" on feature_grants for select
  using (profile_id = auth.uid() or is_ceo());

drop policy if exists "feature_grants_insert" on feature_grants;
create policy "feature_grants_insert" on feature_grants for insert
  with check (is_ceo());

drop policy if exists "feature_grants_update" on feature_grants;
create policy "feature_grants_update" on feature_grants for update
  using (is_ceo()) with check (is_ceo());

drop trigger if exists trg_audit_feature_grants on feature_grants;
create trigger trg_audit_feature_grants
  after insert or update or delete on feature_grants
  for each row execute function record_audit();

-- See the migration header. SECURITY DEFINER for has_branch_grant()'s
-- two reasons; mode is checked so a 'hide' row confers nothing.
create or replace function has_feature(p_feature text) returns boolean as $fn$
  select exists (
    select 1 from {{SCHEMA}}.feature_grants g
     where g.profile_id = auth.uid()
       and g.feature    = p_feature
       and g.mode       = 'grant'
       and g.revoked_at is null
  );
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;

-- 0048 redefines is_hr(): HR authority now comes from the role OR from
-- a live grant, so all seven of 0047's call sites — including the two
-- that RESTRICT what HR may do — extend to a grantee at once.
create or replace function is_hr() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() = 'hr'
      or {{SCHEMA}}.has_feature('hr');
$fn$ language sql stable;
$ddl$;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0048: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    v_ddl := replace(c_ddl, '{{SCHEMA}}', quote_ident(r.schema_name));
    execute v_ddl;

    execute format('grant select, insert, update on %I.feature_grants to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update, delete on %I.feature_grants to service_role', r.schema_name);
    execute format('revoke all on table %I.feature_grants from public, anon, authenticated', r.schema_name);
    execute format('grant execute on function %I.has_feature(text) to %I', r.schema_name, r.role_name);

    v_count := v_count + 1;
    raise notice '0048: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0048: % tenant schema(s) can grant hubs per person.', v_count;
end
$mig$;

-- ============================================================
-- 4. RAISE ASSERTION (f) 22 -> 23
--
-- has_feature() is the twenty-third SECURITY DEFINER function in a
-- tenant schema. 0045's technique: patch create_tenant_schema()'s OWN
-- live source rather than a hand-retyped copy.
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
    raise exception '0048: platform.create_tenant_schema() not found.';
  end if;

  v_expected := substring(v_src from 'expected ([0-9]+) SECURITY DEFINER functions')::int;

  -- >= rather than = 23. A later migration raises this number again, and
  -- testing for the exact literal made a second run of THIS file fall
  -- through to the 22 -> 23 rewrite, find no 22, and abort — a file that
  -- claims to be idempotent failing on its own second run.
  if v_expected >= 23 then
    raise notice '0048: create_tenant_schema() already asserts % — skipping.', v_expected;
  else
    v_n := length(v_src) - length(replace(v_src, 'expected 22 SECURITY DEFINER functions', ''));
    if v_n <> length('expected 22 SECURITY DEFINER functions') then
      raise exception
        '0048: expected exactly one "expected 22 SECURITY DEFINER functions" in create_tenant_schema(). Function drifted from 0045.';
    end if;

    v_src := replace(v_src, 'expected 22 SECURITY DEFINER functions', 'expected 23 SECURITY DEFINER functions');
    v_src := replace(v_src, 'if n <> 22 then', 'if n <> 23 then');

    execute format(
      'create or replace function platform.create_tenant_schema(p_slug text) returns text '
      'language plpgsql security definer set search_path = pg_catalog, platform as %L',
      v_src
    );
    raise notice '0048: platform.create_tenant_schema() now asserts 23 SECURITY DEFINER functions.';
  end if;
end
$mig$;

-- ============================================================
-- 5. SELF-VERIFY
-- ============================================================
do $$
declare
  r          record;
  v_bad      text[] := '{}';
  v_src      text;
  n          int;
  v_expected int;
begin
  -- The SECURITY DEFINER count is read from the provisioner rather than
  -- hard-coded, because migrations land in whatever order the operator
  -- runs them and a later one legitimately raises this number. §4 above
  -- has just set it to 23; if 0050 or anything after has already raised
  -- it further, the schemas below will carry that higher figure and a
  -- literal 23 here would report a failure that is not one. (0045 and
  -- 0037 hard-coded theirs; this is the same assertion made
  -- order-independent.)
  select substring(p.prosrc from 'expected ([0-9]+) SECURITY DEFINER functions')::int
    into v_expected
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_expected is null then
    raise exception '0048 VERIFY FAILED: create_tenant_schema() states no SECURITY DEFINER count.';
  end if;

  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    -- (a) the table, with RLS on
    if to_regclass(format('%I.feature_grants', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (feature_grants missing)');
      continue;
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'feature_grants' and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (feature_grants has RLS disabled)');
    end if;

    -- (b) the grantable CHECK is present. This is THE constraint that
    --     keeps a navigation entry from outrunning the authority behind
    --     it; without it the admin screen could hand out any key in the
    --     vocabulary and half of them would open an empty page.
    if not exists (
      select 1 from pg_constraint pc
       where pc.conrelid = format('%I.feature_grants', r.schema_name)::regclass
         and pc.conname = 'feature_grants_grantable'
    ) then
      v_bad := v_bad || (r.schema_name || ' (feature_grants_grantable CHECK missing)');
    end if;

    -- (c) is_hr() consults the grant, and has_feature() is a definer
    v_src := pg_get_functiondef(to_regprocedure(format('%I.is_hr()', r.schema_name)));
    if coalesce(position('has_feature' in v_src), 0) = 0 then
      v_bad := v_bad || (r.schema_name || ' (is_hr does not consult has_feature — grants would be cosmetic)');
    end if;
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.proname = 'has_feature' and p.prosecdef;
    if n <> 1 then
      v_bad := v_bad || (r.schema_name || ' (has_feature missing or not SECURITY DEFINER)');
    end if;

    -- (d) the tenant role can call it and read the table, and holds no
    --     delete — assertion (j)'s ceiling, restated for the one table
    --     this migration adds.
    if not has_function_privilege(r.role_name,
         format('%I.has_feature(text)', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (tenant role cannot execute has_feature)');
    end if;
    if has_table_privilege(r.role_name,
         format('%I.feature_grants', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (tenant role holds DELETE on feature_grants)');
    end if;

    -- (e) as many SECURITY DEFINER functions as the provisioner expects
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> v_expected then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, expected %s)',
                               r.schema_name, n, v_expected);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0048 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists feature_grants' in platform.tenant_ddl_template()) = 0 then
    raise exception '0048 VERIFY FAILED: template does not carry feature_grants.';
  end if;
  if position('feature_grants_grantable' in platform.tenant_ddl_template()) = 0 then
    raise exception '0048 VERIFY FAILED: template does not carry the grantable CHECK.';
  end if;
  -- At least 23: this migration's own has_feature() must be counted, and
  -- a later migration raising the figure further is not a regression.
  if v_expected < 23 then
    raise exception
      '0048 VERIFY FAILED: create_tenant_schema() asserts % SECURITY DEFINER functions — has_feature() is not counted, so the next provision would fail.',
      v_expected;
  end if;

  raise notice '0048: verified — the CEO can hand out the HR hub, and only the hub whose policies were wired for it.';
end
$$;

commit;

notify pgrst, 'reload schema';
