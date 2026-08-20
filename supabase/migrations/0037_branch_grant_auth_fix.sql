-- ============================================================
-- 0037 — FIX: can_read_branch/can_act_on_branch cannot see auth.uid()
--
-- THE BUG
-- -------
-- 0030 widened can_read_branch(p_branch_id) and can_act_on_branch(p_branch_id)
-- with a branch_grants lookup keyed on `g.profile_id = auth.uid()`. Both
-- functions are, and remain, PLAIN `language sql stable` — not SECURITY
-- DEFINER — on purpose: 0030's header explains at length why it avoided a
-- 21st SECURITY DEFINER function for this. A plain function runs with the
-- CALLING role's own privileges, and `auth.uid()` is a schema-qualified
-- call: resolving it needs USAGE on schema `auth`, not just EXECUTE on the
-- function.
--
-- Every SECURITY DEFINER helper in this file (current_role_name,
-- current_branch_id, is_ceo, ...) already called auth.uid() successfully,
-- because SECURITY DEFINER runs as the function's OWNER — a role that has
-- always had schema-auth access. No plain function had ever needed to
-- resolve `auth.uid()` under the CALLER's own privileges before 0030. The
-- tenant role ({{ROLE}}) was never granted USAGE on schema auth directly —
-- it never had to be.
--
-- The result: every predicate that flows through can_read_branch or
-- can_act_on_branch — vehicles, deal_tickets, installment_plans, cheques,
-- receipts, stock_transfers, vehicle_price_history, eta_submissions,
-- consignment_payouts — returns a Postgres error ("permission denied for
-- schema auth ... during inlining of can_read_branch") for every session,
-- every role, CEO included, regardless of whether the branch_grants arm was
-- ever going to matter for that row: SQL-language function inlining
-- substitutes the whole body into the policy expression, and privilege
-- resolution on the substituted text happens before any short-circuit on
-- the OR. Supabase-js swallows the error into `{data: null, error}`, and
-- every page that follows the house convention of `(data as T[]) ?? []`
-- renders an empty table instead of a 500 — which is why this reached a
-- live demo as "EGP 0" everywhere rather than a stack trace.
--
-- We reproduced it directly (not guessed): minted a real GoTrue session
-- for the demo CEO, queried `vehicles` under RLS, and got
-- `{code: "42501", message: "permission denied for schema auth"}`. A
-- direct SQL repro (SET LOCAL ROLE felix_felix; select * from vehicles)
-- reproduces the identical error with `where: SQL function
-- "can_read_branch" during inlining`. `has_schema_privilege('felix_felix',
-- 'auth', 'USAGE')` is false; `authenticated`'s is true. Attempting to
-- GRANT USAGE ON SCHEMA auth directly (as the migration role, `postgres`)
-- silently no-ops: `postgres` holds plain USAGE on schema auth (`U`), not
-- `U*` (WITH GRANT OPTION) — auth is owned by supabase_admin, and Postgres
-- downgrades an ungranted GRANT to a no-op WARNING rather than an error,
-- which is why this drift is invisible until something calls it under RLS.
--
-- THE FIX
-- -------
-- One new SECURITY DEFINER helper, `has_branch_grant(p_branch_id)`, in the
-- exact shape current_role_name/current_branch_id already use: a single,
-- narrow lookup, owned by a role that has schema-auth access regardless of
-- what the tenant role holds. can_read_branch/can_act_on_branch stay
-- PLAIN — their classification does not change, only what they call — so
-- 0030's own reasoning ("read and write scope are the same rule by
-- coincidence, not by definition. Policies name whichever one they mean")
-- still holds, and this migration is a one-function addition rather than a
-- reclassification of two.
--
-- That is a real, deliberate change to the count in assertion (f) of
-- platform.create_tenant_schema() — 0009 says so explicitly: "A migration
-- that legitimately changes this number should change this line in the
-- same commit." 20 becomes 21. Section 4 below does exactly that, patched
-- against the function's own live source rather than retyped by hand, so
-- there is no risk of transcribing 250 lines of unrelated plpgsql wrong.
--
-- SCOPE: every existing tenant (today, only t_felix) is repaired in the
-- same transaction the template is amended in, so a schema provisioned
-- five minutes from now and the one provisioned two years ago carry the
-- identical fix.
-- ============================================================

begin;

do $migration$
declare
  v_tpl          text;
  v_done         int := 0;

  c_fn_from      text;
  c_fn_to        text;

  c_can_act_from text;
  c_can_act_to   text;

  c_can_read_from text;
  c_can_read_to   text;

  c_gnt_from     text;
  c_gnt_to       text;

  v_nl           text := chr(10);
  r              record;
  v_ddl          text;
  v_n            int;
begin
  v_tpl := platform.tenant_ddl_template();

  -- §1. Insert has_branch_grant() immediately before can_act_on_branch —
  --     the function it exists to serve, so a reader meets the helper
  --     before the two call sites that use it.
  c_fn_from := $t1$create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      -- 0030: and any branch this profile has been granted. Additive —
      -- with branch_grants empty this arm is false and the function is
      -- the one 0009 wrote.
      --
      -- `revoked_at is null` is load-bearing. Without it a revoked grant
      -- still authorises, and nothing anywhere would report it.
      --
      -- The null guard is kept for symmetry with the line above rather
      -- than out of necessity: `g.branch_id = null` matches no row, so
      -- the exists() is already false for a null branch.
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$t1$;

  c_fn_to := $t2$-- 0037: the one place in this file a PLAIN (non-SECURITY-DEFINER)
-- function needs the calling session's identity against a table the
-- tenant role itself may not have every privilege chased through
-- (auth.uid() is schema-qualified — resolving it needs USAGE on schema
-- auth, and the tenant role was never granted that directly, only ever
-- reaching auth.uid() through a SECURITY DEFINER owner as every other
-- helper here does). This is that helper: one narrow lookup, in the
-- exact shape current_role_name()/current_branch_id() already use, so
-- can_act_on_branch/can_read_branch below can stay PLAIN and simply
-- call it rather than resolving auth.uid() themselves.
create or replace function has_branch_grant(p_branch_id uuid) returns boolean as $fn$
  select exists (
    select 1 from {{SCHEMA}}.branch_grants g
     where g.profile_id = auth.uid()
       and g.branch_id  = p_branch_id
       and g.revoked_at is null
  );
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;

create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      -- 0030: and any branch this profile has been granted. Additive —
      -- with branch_grants empty this arm is false and the function is
      -- the one 0009 wrote. Routed through has_branch_grant() (0037)
      -- rather than resolving auth.uid() here — see that function's
      -- header for why.
      or (p_branch_id is not null and {{SCHEMA}}.has_branch_grant(p_branch_id));
$fn$ language sql stable;$t2$;

  v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
  if position(c_fn_to in v_tpl) = 0 then
    raise exception '0037: template anchor 1 (can_act_on_branch + new helper) did not match. Template drifted from 0030.';
  end if;
  v_done := v_done + 1;

  -- §2. can_read_branch — textually identical shape, same fix.
  c_can_read_from := $t3$create or replace function can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      -- 0030: a grant confers read as well as act. See the file header
      -- for why there is no read-only grant.
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$t3$;

  c_can_read_to := $t4$create or replace function can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      -- 0030: a grant confers read as well as act. See the file header
      -- for why there is no read-only grant. Routed through
      -- has_branch_grant() (0037) — see that function's header.
      or (p_branch_id is not null and {{SCHEMA}}.has_branch_grant(p_branch_id));
$fn$ language sql stable;$t4$;

  v_tpl := replace(v_tpl, c_can_read_from, c_can_read_to);
  if position(c_can_read_to in v_tpl) = 0 then
    raise exception '0037: template anchor 2 (can_read_branch) did not match. Template drifted from 0030.';
  end if;
  v_done := v_done + 1;

  -- §3. grant execute — inserted right after can_read_branch's own
  --     grant line, matching 0009's per-function grant convention.
  c_gnt_from := $t5$grant execute on function can_act_on_branch(uuid)         to {{ROLE}};
grant execute on function can_read_branch(uuid)           to {{ROLE}};$t5$;

  c_gnt_to := $t6$grant execute on function can_act_on_branch(uuid)         to {{ROLE}};
grant execute on function can_read_branch(uuid)           to {{ROLE}};
grant execute on function has_branch_grant(uuid)          to {{ROLE}};$t6$;

  v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
  if position(c_gnt_to in v_tpl) = 0 then
    raise exception '0037: template anchor 3 (grants) did not match. Template drifted from 0009.';
  end if;
  v_done := v_done + 1;

  if v_done <> 3 then
    raise exception '0037: expected 3 template substitutions, made %', v_done;
  end if;

  -- auth.uid() must no longer appear OUTSIDE a security-definer function
  -- in the template. Every SECURITY DEFINER function in this file is
  -- pinned with `set search_path`, so this is a reasonable proxy: a bare
  -- `auth.uid()` should now occur exactly once — inside has_branch_grant()
  -- itself — everywhere the string `security definer` does not appear on
  -- the same statement. Cheap approximation, not a parser; good enough as
  -- a drift trip-wire.
  if (length(v_tpl) - length(replace(v_tpl, 'g.profile_id = auth.uid()', ''))) <>
     length('g.profile_id = auth.uid()') then
    raise exception '0037: expected exactly one remaining "g.profile_id = auth.uid()" (inside has_branch_grant), found a different count. Template drifted.';
  end if;

  execute format(
    'create or replace function platform.tenant_ddl_template() returns text '
    'language sql immutable set search_path = pg_catalog '
    'as $felix_0037$ select %L::text $felix_0037$',
    v_tpl
  );
  revoke all on function platform.tenant_ddl_template() from public;

  raise notice '0037: template amended (% substitutions).', v_done;

  -- §4. Apply to every existing tenant schema.
  for r in select schema_name, role_name from platform.tenants loop
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute format($f$
      create or replace function %I.has_branch_grant(p_branch_id uuid) returns boolean as $fn$
        select exists (
          select 1 from %I.branch_grants g
           where g.profile_id = auth.uid()
             and g.branch_id  = p_branch_id
             and g.revoked_at is null
        );
      $fn$ language sql stable security definer set search_path = %I, extensions;
    $f$, r.schema_name, r.schema_name, r.schema_name);

    execute format($f$
      create or replace function %I.can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
        select %I.is_ceo()
            or %I.is_accountant_or_above()
            or (p_branch_id is not null and p_branch_id = %I.current_branch_id())
            or (p_branch_id is not null and %I.has_branch_grant(p_branch_id));
      $fn$ language sql stable;
    $f$, r.schema_name, r.schema_name, r.schema_name, r.schema_name, r.schema_name);

    execute format($f$
      create or replace function %I.can_read_branch(p_branch_id uuid) returns boolean as $fn$
        select %I.is_ceo()
            or %I.is_accountant_or_above()
            or (p_branch_id is not null and p_branch_id = %I.current_branch_id())
            or (p_branch_id is not null and %I.has_branch_grant(p_branch_id));
      $fn$ language sql stable;
    $f$, r.schema_name, r.schema_name, r.schema_name, r.schema_name, r.schema_name);

    execute format('grant execute on function %I.has_branch_grant(uuid) to %I', r.schema_name, r.role_name);

    perform set_config('search_path', 'pg_catalog', true);
  end loop;

  raise notice '0037: % tenant schema(s) repaired.', (select count(*) from platform.tenants);

  -- §5. platform.create_tenant_schema()'s embedded assertion (f) expects
  --     exactly 20 SECURITY DEFINER functions. It is now 21. Patched
  --     against the function's OWN live source — never hand-retyped —
  --     so a 250-line function with no relationship to this bug cannot
  --     silently drift from what is actually deployed.
  select p.prosrc into v_ddl
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_ddl is null then
    raise exception '0037: platform.create_tenant_schema() not found.';
  end if;

  v_n := length(v_ddl) - length(replace(v_ddl, 'expected 20 SECURITY DEFINER functions', ''));
  if v_n <> length('expected 20 SECURITY DEFINER functions') then
    raise exception '0037: expected exactly one "expected 20 SECURITY DEFINER functions" in create_tenant_schema(), found a different count. Function drifted from 0009.';
  end if;

  v_ddl := replace(v_ddl, 'expected 20 SECURITY DEFINER functions', 'expected 21 SECURITY DEFINER functions');
  v_ddl := replace(v_ddl, 'if n <> 20 then', 'if n <> 21 then');

  execute format(
    'create or replace function platform.create_tenant_schema(p_slug text) returns text language plpgsql security definer set search_path = pg_catalog, platform as %L',
    v_ddl
  );

  raise notice '0037: platform.create_tenant_schema() now asserts 21 SECURITY DEFINER functions.';
end
$migration$;

-- ============================================================
-- SELF-VERIFY
-- ============================================================
do $verify$
declare
  r      record;
  v_bad  text[] := '{}';
  v_n    int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'has_branch_grant' and p.prosecdef
    ) then
      v_bad := v_bad || (r.schema_name || ' (has_branch_grant missing or not SECURITY DEFINER)');
    end if;

    if not has_function_privilege(r.role_name, format('%I.has_branch_grant(uuid)', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (role cannot execute has_branch_grant)');
    end if;

    select count(*) into v_n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if v_n <> 21 then
      v_bad := v_bad || format('%s (expected 21 SECURITY DEFINER functions, found %s)', r.schema_name, v_n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0037 VERIFY FAILED: %', array_to_string(v_bad, '; ');
  end if;

  raise notice '0037: verified — every showroom can read its own branches again.';
end
$verify$;

commit;
