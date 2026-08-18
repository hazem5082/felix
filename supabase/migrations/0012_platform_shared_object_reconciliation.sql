-- ============================================================
-- 0012 — RECONCILE THE SHARED PLATFORM OBJECTS WITH LIVE REALITY
--
-- 0008-0011 were applied against the shared "Agentic" Supabase project on
-- 2026-08-06 and immediately took down A-Star, Calendar and the Agent
-- Portal at once. Both other products patched the LIVE DATABASE directly
-- to recover:
--
--   * A-Star migration 0006 (fix_postgrest_schema_sync) and Calendar
--     migration 0005 (patch_sync_postgrest_schemas) rewrote
--     platform.sync_postgrest_schemas() so it stops replacing the
--     exposed-schema list with FELIX's tenant schemas alone.
--   * A-Star migration 0007 (provisioning_intents) and Calendar migration
--     0006 (calendar_provisioning_intents) recomposed the
--     on_auth_user_created WHEN clause so FELIX's invitation check no
--     longer fires on their own service-role-created accounts.
--
-- Those patches live in the other products' repositories, not this one.
-- This file exists so FELIX's OWN migration set converges on the same
-- fixed state those patches already established live — so that reapplying
-- 0001-0011 from scratch (disaster recovery, a fresh environment, a
-- staging rebuild) cannot reintroduce either outage silently.
--
-- PREEMPTS THE PLANNED NUMBERING. 0008's header earmarked "0012" for a
-- per-schema migration runner and "0013" for proving the access-token hook
-- end to end. This file takes the 0012 slot instead because it fixes a
-- live, repeatable outage; the runner and the hook-proof each shift down
-- by one whenever they are written.
--
-- WHY THIS FILE DOES NOT HARDCODE "astar" / "calendar" INTO THE TRIGGER
-- -----------------------------------------------------------------
-- Section 2 below (the schema-exposure base set) DOES name astar and
-- calendar explicitly — that mirrors Calendar migration 0005 exactly, and
-- the base set is deliberately shared, append-only state: "the next
-- product must ADD to the base array, never replace an entry" (Calendar
-- 0005's own comment). A schema either needs to be served by PostgREST or
-- it does not; there is no way to discover that from the catalog alone,
-- so naming it here is correct, not a shortcut.
--
-- Section 3 (the trigger) is different: it does NOT hardcode which
-- products have a provisioning-intent guard. It discovers every schema
-- that defines an is_provisioning_email(text) returns boolean function via
-- the catalog, composes the WHEN clause as the conjunction of whichever of
-- those guards are already live, and self-verifies the result — the exact
-- technique Calendar migration 0006 used to avoid deleting A-Star's guard.
-- Generalising it here means a FOURTH product's guard survives this file
-- without anyone editing FELIX again, which is the improvement Calendar
-- 0006's own header proposed ("a single registry... until that exists,
-- step 3 is the contract").
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.sync_postgrest_schemas()') is null then
    raise exception
      '0012 PRECONDITION FAILED: platform.sync_postgrest_schemas() does not exist. Apply 0008 first.';
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgname = 'on_auth_user_created'
       and t.tgrelid = 'auth.users'::regclass
       and not t.tgisinternal
  ) then
    raise exception
      '0012 PRECONDITION FAILED: on_auth_user_created is missing from auth.users. Do not let this file recreate it blind — find out who dropped it, since auth.users currently has no invitation check at all.';
  end if;
end $$;

-- Same reasoning as Calendar 0005/0006: pg_get_functiondef/pg_get_triggerdef
-- omit a schema qualification for anything already on search_path, so what
-- this file parses would depend on the session that runs it. Pinning to
-- pg_catalog makes the rendering identical everywhere.
set local search_path = pg_catalog;

-- ============================================================
-- 2. SCHEMA EXPOSURE — restore the shared base set
--
-- Replaces 0008's version, which built the exposed-schema list from
-- platform.tenants alone and therefore dropped public, graphql_public,
-- astar and calendar on every provision/suspend/resume. This is FELIX's
-- own copy of the fix Calendar 0005 already applied live; it exists here
-- so the FILE this repository ships matches what is actually running.
-- ============================================================
create or replace function platform.sync_postgrest_schemas()
returns text as $fn$
declare
  v_base    text;
  v_tenants text;
  v_schemas text;
begin
  -- ---- schemas that must survive every resync -------------------------
  -- public          : the Agent Portal's registry (brands, module_requests,
  --                   agents) and the legacy shared tenants table
  -- graphql_public  : Supabase default; dropping it breaks pg_graphql
  -- astar           : A-Star Track          (A-Star migration 0001)
  -- calendar        : Calendar              (Calendar migration 0001)
  -- platform        : FELIX's own control plane
  --
  -- Filtered by to_regnamespace so a schema absent in some environment
  -- (e.g. a FELIX-only sandbox) is skipped rather than announced —
  -- announcing a schema that does not exist makes PostgREST log a fatal
  -- config error and can refuse to serve at all.
  --
  -- ADDING THE NEXT PRODUCT: insert its schema into this array, next to
  -- the others — never in place of one. Shared state across FELIX, A-Star
  -- and Calendar; see Calendar migration 0005.
  select string_agg(s, ', ' order by ord)
    into v_base
    from unnest(array['public', 'graphql_public', 'astar', 'calendar', 'platform'])
         with ordinality as t(s, ord)
   where to_regnamespace(s) is not null;

  -- ---- FELIX's registry-driven part, unchanged in spirit --------------
  select string_agg(schema_name, ', ' order by schema_name)
    into v_tenants
    from platform.tenants
   where status = 'active'
     and to_regnamespace(schema_name) is not null;

  v_schemas := v_base || coalesce(', ' || v_tenants, '');

  execute format(
    'alter role authenticator set pgrst.db_schemas = %L', v_schemas);

  -- Transactional: delivered on COMMIT, so a rolled-back provisioning
  -- never tells PostgREST about a schema that does not exist.
  notify pgrst, 'reload config';
  notify pgrst, 'reload schema';

  return v_schemas;
end;
$fn$ language plpgsql security definer set search_path = pg_catalog, platform;

comment on function platform.sync_postgrest_schemas() is
  'Recomputes PostgREST''s exposed-schema list and reloads it in place. Called at the end of every FELIX provision, suspend and resume. Always includes public, graphql_public, astar, calendar and platform (when present) IN ADDITION to the active tenant schemas — omitting them took down the Agent Portal, A-Star and Calendar on 2026-08-06. SHARED OBJECT: the next product must ADD to the base array, never replace an entry.';

-- Restore/refresh service now, rather than waiting for the next FELIX
-- provisioning run to notice. Outside a transaction is not required here
-- (unlike 0008) because this call sits INSIDE this migration's own
-- transaction, which is fine: worst case a failed COMMIT leaves the
-- previous (already-broken) config in place rather than a half-applied
-- fix, and the final call after COMMIT (bottom of this file) covers the
-- normal case.
select platform.sync_postgrest_schemas();

-- ============================================================
-- 3. THE SIGNUP TRIGGER — recompose instead of replace
--
-- 0010 unconditionally ran:
--
--   drop trigger if exists on_auth_user_created on auth.users;
--   ...
--   create trigger on_auth_user_created after insert on auth.users
--     for each row execute function platform.handle_new_user();
--
-- with no WHEN clause at all, discarding whatever product guards were
-- already composed onto it. This section puts them back — discovered from
-- the catalog, not hardcoded, so a product added after this migration is
-- picked up without editing FELIX again.
-- ============================================================
do $$
declare
  v_def       text;
  v_fn_before text;
  v_head      text;
  v_tail      text;
  v_when      text;
  v_norm      text;
  v_residue   text;
  v_newwhen   text;
  v_newdef    text;
  v_known     text[];         -- every schema with an is_provisioning_email(text)
  v_existing  text[] := '{}'; -- guards actually present in the live clause
  v_final     text[];
  v_sorted    text[];
  v_pos_when  integer;
  v_pos_exec  integer;
  s           text;
begin
  -- ---- 3a. read the live definition ------------------------------------
  select pg_get_triggerdef(t.oid), p.oid::regprocedure::text
    into v_def, v_fn_before
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where t.tgname = 'on_auth_user_created'
     and t.tgrelid = 'auth.users'::regclass
     and not t.tgisinternal;

  raise notice '0012: ORIGINAL DEFINITION (keep this to roll back): %', v_def;

  -- ---- 3b. split it, preserving everything this file does not own -----
  -- Timing, events, FOR EACH ROW and the target function are SPLICED from
  -- the live definition rather than retyped.
  v_pos_when := position(' WHEN (' in v_def);
  v_pos_exec := position(' EXECUTE ' in v_def);

  if v_pos_exec = 0 then
    raise exception
      '0012 FAILED: the trigger definition contains no EXECUTE clause, so it cannot be parsed. Refusing to guess. Definition: %', v_def;
  end if;

  if v_pos_when > 0 and v_pos_when > v_pos_exec then
    raise exception
      '0012 FAILED: unrecognised trigger definition — WHEN appears after EXECUTE. Refusing to guess. Definition: %', v_def;
  end if;

  if v_pos_when > 0 then
    v_head := left(v_def, v_pos_when - 1);
    v_when := substr(v_def, v_pos_when + 1, v_pos_exec - v_pos_when - 1);
  else
    -- This is the state 0010 leaves the trigger in on a fresh sequential
    -- apply: no WHEN clause at all. Not an error — just nothing to parse.
    v_head := left(v_def, v_pos_exec - 1);
    v_when := '';
  end if;
  v_tail := substr(v_def, v_pos_exec + 1);

  if v_fn_before !~ 'handle_new_user' then
    raise exception
      '0012 FAILED: on_auth_user_created currently calls %, not a *.handle_new_user — refusing to touch a trigger this file does not recognise.', v_fn_before;
  end if;

  -- ---- 3c. discover every product guard that COULD be here ------------
  -- Matched on argument/return TYPES, never on a rendered argument string
  -- (pg_get_function_identity_arguments includes parameter names, and
  -- every product's function is declared with the same parameter name —
  -- see Calendar migration 0006's note on this exact trap).
  select coalesce(array_agg(n.nspname::text order by n.nspname), '{}')
    into v_known
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'is_provisioning_email'
     and p.pronargs = 1
     and p.proargtypes[0] = 'pg_catalog.text'::regtype
     and p.prorettype     = 'pg_catalog.bool'::regtype;

  -- ---- 3d. recognise the live clause, or REFUSE ------------------------
  -- Normalise the rendering before matching: pg_get_triggerdef upper-cases
  -- keywords, adds redundant parentheses, and casts new.email (varchar,
  -- not text) inconsistently across server versions.
  v_norm := lower(v_when);
  v_norm := regexp_replace(v_norm, '^\s*when\s*', '');
  v_norm := regexp_replace(v_norm, '[[:space:]]', '', 'g');
  v_norm := replace(v_norm, '((new.email))::text', 'new.email');
  v_norm := replace(v_norm, '(new.email)::text',   'new.email');
  v_norm := replace(v_norm, 'new.email::text',     'new.email');

  v_residue := v_norm;
  foreach s in array v_known loop
    if strpos(v_residue, 'not(' || s || '.is_provisioning_email(new.email))') > 0 then
      v_existing := v_existing || s;
      v_residue := replace(v_residue,
        'not(' || s || '.is_provisioning_email(new.email))', '');
    elsif strpos(v_residue, 'not' || s || '.is_provisioning_email(new.email)') > 0 then
      v_existing := v_existing || s;
      v_residue := replace(v_residue,
        'not' || s || '.is_provisioning_email(new.email)', '');
    end if;
  end loop;

  -- Whatever is left must be nothing but glue: AND, parentheses,
  -- whitespace. Anything else is a condition this file does not
  -- understand and must not silently discard.
  v_residue := regexp_replace(v_residue, '\mand\M', '', 'g');
  v_residue := regexp_replace(v_residue, '[()[:space:]]', '', 'g');

  if v_residue <> '' then
    raise exception
      E'0012 REFUSING TO PROCEED: the WHEN clause on on_auth_user_created contains a condition this migration does not recognise, and rebuilding the trigger would DELETE it.\n  Unrecognised residue: %\n  Full definition: %\n  Work out who owns that condition and compose with them by hand.',
      v_residue, v_def;
  end if;

  -- ---- 3e. compose ------------------------------------------------------
  -- Every schema this database knows has a provisioning-intent guard gets
  -- one, whether or not it was already present in the live clause — this
  -- is the difference from Calendar 0006 (which only added ITS OWN guard
  -- and left absent-but-known guards out on purpose, since adding a guard
  -- on another product's behalf was, for that file, a unilateral change).
  -- Here it is not unilateral: FELIX owns this trigger, and a schema that
  -- defines is_provisioning_email(text) exists specifically so FELIX's
  -- signup check will skip it.
  v_final := v_known;
  select array_agg(g order by g) into v_sorted from unnest(v_final) as g;
  v_final := v_sorted;

  v_newwhen := '';
  foreach s in array v_final loop
    v_newwhen := v_newwhen
      || case when v_newwhen = '' then '' else ' and ' end
      || 'not ' || quote_ident(s) || '.is_provisioning_email(new.email)';
  end loop;

  if v_newwhen = '' then
    v_newdef := v_head || ' ' || v_tail;
  else
    v_newdef := v_head || ' WHEN (' || v_newwhen || ') ' || v_tail;
  end if;

  raise notice '0012: NEW DEFINITION: %', v_newdef;

  drop trigger if exists on_auth_user_created on auth.users;
  execute v_newdef;

  raise notice '0012: trigger recomposed with % product guard(s): %; target function unchanged (%).',
    array_length(v_final, 1), array_to_string(v_final, ', '), v_fn_before;
end $$;

-- ============================================================
-- 4. SELF-VERIFICATION (platform standing rule: atomic AND self-asserting)
-- ============================================================
do $$
declare
  v_fail      text[] := '{}';
  v_setconfig text[];
  v_setting   text := '';
  v_entry     text;
  v_def       text;
  s           text;
  v_known     text[];
begin
  -- ---- 4a. schema exposure ---------------------------------------------
  select r.setconfig into v_setconfig
    from pg_db_role_setting r
    join pg_roles g on g.oid = r.setrole
   where g.rolname = 'authenticator'
   order by (r.setdatabase = 0) desc
   limit 1;

  if v_setconfig is not null then
    foreach v_entry in array v_setconfig loop
      if lower(v_entry) like 'pgrst.db_schemas=%' then
        v_setting := substr(v_entry, length('pgrst.db_schemas=') + 1);
      end if;
    end loop;
  end if;

  if v_setconfig is null or btrim(v_setting) = '' then
    v_fail := v_fail || 'authenticator has no pgrst.db_schemas setting at all after the resync'::text;
  else
    foreach s in array array['public', 'graphql_public', 'platform'] loop
      if not exists (
        select 1 from unnest(string_to_array(v_setting, ',')) as e(schema_name)
         where btrim(e.schema_name) = s
      ) then
        v_fail := v_fail || (s || ' is missing from the exposed-schema list');
      end if;
    end loop;

    foreach s in array array['astar', 'calendar', 't_felix'] loop
      if to_regnamespace(s) is not null and not exists (
        select 1 from unnest(string_to_array(v_setting, ',')) as e(schema_name)
         where btrim(e.schema_name) = s
      ) then
        v_fail := v_fail || (s || ' exists but is missing from the exposed-schema list — that product would be down');
      end if;
    end loop;
  end if;

  -- ---- 4b. the trigger ---------------------------------------------------
  select pg_get_triggerdef(t.oid) into v_def
    from pg_trigger t
   where t.tgname = 'on_auth_user_created'
     and t.tgrelid = 'auth.users'::regclass
     and not t.tgisinternal;

  if v_def is null then
    v_fail := v_fail ||
      'trigger was not recreated — auth.users has NO invitation check right now, restore it immediately from the ORIGINAL DEFINITION printed above'::text;
  else
    if strpos(v_def, 'handle_new_user') = 0 then
      v_fail := v_fail || 'trigger no longer calls handle_new_user — FELIX identity bootstrap is gone'::text;
    end if;

    if strpos(v_def, 'raw_user_meta_data') > 0 then
      v_fail := v_fail ||
        'trigger is keyed on client-writable user_metadata — refuse; anyone hitting /auth/v1/signup could set it'::text;
    end if;

    if strpos(lower(v_def), ' or ') > 0 then
      v_fail := v_fail ||
        'the WHEN clause contains OR — product guards must be ANDed, or one product''s intent bypasses every other guard'::text;
    end if;

    -- Every discoverable guard must actually be in the recomposed clause.
    select coalesce(array_agg(n.nspname::text order by n.nspname), '{}')
      into v_known
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'is_provisioning_email'
       and p.pronargs = 1
       and p.proargtypes[0] = 'pg_catalog.text'::regtype
       and p.prorettype     = 'pg_catalog.bool'::regtype;

    foreach s in array v_known loop
      if strpos(v_def, s || '.is_provisioning_email') = 0 then
        v_fail := v_fail || format(
          '%s.is_provisioning_email exists but is not in the recomposed trigger — %s provisioning would fail with NO_INVITATION',
          s, s);
      end if;
    end loop;
  end if;

  if array_length(v_fail, 1) > 0 then
    raise exception '0012 FAILED verification: % (exposed schemas: %)',
      array_to_string(v_fail, '; '), coalesce(nullif(btrim(v_setting), ''), 'NULL');
  end if;

  raise notice '0012 applied: exposed schemas now %; trigger guards %.',
    v_setting, coalesce(nullif(v_def, ''), '(none)');
end $$;

commit;

-- Deliberately outside the transaction, same reasoning as 0008: reaching
-- out to a running PostgREST is an operational retry, not a reason the
-- schema fix above should roll back.
select platform.sync_postgrest_schemas();

-- ============================================================
-- ROLLBACK
-- ============================================================
-- Use the "ORIGINAL DEFINITION" line §3a printed for the trigger, and the
-- function body 0008 shipped for platform.sync_postgrest_schemas() (see
-- that file) for sync_postgrest_schemas(). Do NOT retype either from
-- memory — the trigger's WHEN clause is shared state between FELIX,
-- A-Star and Calendar, and a retyped version is how another product's
-- guard disappears.
-- ============================================================
