-- ============================================================
-- 0059 — task_template_due() MUST PIN ITS search_path
--
-- The second defect in 0053, and like the first it is invisible to
-- every existing showroom and fatal to a new one.
--
-- WHAT IS WRONG
-- --------------
-- create_tenant_schema() assertion (e) says: the ONLY functions in a
-- tenant schema without a pinned search_path are the inlinable role
-- predicates, and it names them in `c_unpinned`:
--
--   is_ceo, is_manager_or_above, is_accountant_or_above, is_staff,
--   is_investor, is_hr, can_act_on_branch, can_read_branch
--
-- 0053 added a ninth unpinned function, task_template_due(), and did not
-- add it to that list — so provisioning a new showroom now dies at the
-- assertions with
--
--   Tenant schema t_xxx: 1 function(s) carry no pinned search_path and
--   are not one of the eight inlinable predicates
--
-- 0053's header argued that pinning this function "buys nothing", and
-- that argument is correct about SAFETY: it names nothing in schema auth
-- and nothing schema-local, so it cannot trip the inlining trap that
-- 0037 and 0045 exist to explain. But it was the wrong conclusion,
-- because the assertion is not asking "is this function safe unpinned".
-- It is asking "did somebody DECIDE this function should be unpinned",
-- and the answer for task_template_due was no — it was an omission
-- wearing a justification.
--
-- WHY PIN IT RATHER THAN WIDEN THE LIST
-- --------------------------------------
-- Two ways to make the assertion pass, and they are not equivalent.
--
--   Widen c_unpinned. Edits the shared provisioner, and grows an
--   allowlist by one every time anybody adds a helper — which is the
--   erosion assertion (e)'s own comment warns about in those words:
--   "give every function a search_path" degrading into "give most of
--   them one".
--
--   Pin the function. Touches nothing but the object 0053 introduced,
--   leaves the assertion exactly as strict as it was, and puts this
--   function in the majority that the assertion protects — so if a later
--   edit ever makes its body name something schema-local, the pin is
--   already there.
--
-- The cost is inlining, and here it is nothing worth having: the only
-- caller is materialise_tasks(), a SECURITY DEFINER that already pins
-- its own path, and the call is per-row over task_templates — a table
-- with as many rows as the showroom has standing instructions.
--
-- AND NOT BY DERIVING ASSERTION (e)
-- ----------------------------------
-- It has been suggested that (e) should count unpinned functions the way
-- 0053 derived the SECURITY DEFINER count in (f). It should NOT, and the
-- two are opposites despite looking alike:
--
--   (f) counts a FACT — how many definers the schema carries. Deriving
--       it is right, and hard-coding it is what made 0048 abort.
--   (e) enforces a POLICY — which functions are PERMITTED to be
--       unpinned. Deriving that from what exists turns an allowlist into
--       a rubber stamp: every future unpinned function would bless
--       itself, which is precisely the omission that produced this file.
--
-- A check that adapts to what it finds cannot detect anything. (e) stays
-- a list, and this migration adds nothing to it.
--
-- SCOPE: the template, and every provisioned schema. No table, no
-- policy, no grant, no SECDEF change — the function stays SECURITY
-- INVOKER and its body is not rewritten, only its configuration.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- normalises before matching.
--
-- GATE. On 0053.
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
    raise exception '0059 PRECONDITION FAILED: platform.tenant_ddl_template() missing.';
  end if;
  if position('create or replace function task_template_due' in platform.tenant_ddl_template()) = 0 then
    raise exception '0059 PRECONDITION FAILED: the template has no task_template_due(). Apply 0053 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  c_from text := $a1$$fn$ language sql immutable;$a1$;
  c_to   text := $a2$$fn$ language sql immutable set search_path = {{SCHEMA}}, extensions;$a2$;
  v_n    int;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_from := replace(replace(c_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_to   := replace(replace(c_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position(c_to in v_tpl) > 0 then
    raise notice '0059: template already pins task_template_due — skipping.';
  else
    -- Exactly one unpinned `language sql immutable` in the whole
    -- template, and it is this function. Asserted rather than assumed:
    -- a second one would mean this replace hits the wrong object.
    v_n := (length(v_tpl) - length(replace(v_tpl, c_from, ''))) / length(c_from);
    if v_n <> 1 then
      raise exception
        '0059: expected exactly one unpinned "language sql immutable" in the template, found %.', v_n;
    end if;

    v_tpl := replace(v_tpl, c_from, c_to);
    if position(c_to in v_tpl) = 0 then
      raise exception '0059: template anchor did not match. Template drifted from 0053.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0059$ select %L::text $felix_0059$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0059: template amended — task_template_due now pins its search_path.';
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- ALTER FUNCTION rather than CREATE OR REPLACE: the body is not
-- changing and rewriting it would risk drifting from the template's
-- copy for no reason.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name from platform.tenants order by slug loop
    if to_regprocedure(format('%I.task_template_due(text, int, int, date)', r.schema_name)) is null then
      raise notice '0059: %.task_template_due missing — skipping.', r.schema_name;
      continue;
    end if;

    execute format(
      'alter function %I.task_template_due(text, int, int, date) set search_path = %I, extensions',
      r.schema_name, r.schema_name);

    v_count := v_count + 1;
    raise notice '0059: % pinned.', r.schema_name;
  end loop;

  raise notice '0059: % tenant schema(s) amended.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — the property assertion (e) checks, checked here
-- ============================================================
do $$
declare
  r     record;
  v_bad text[] := '{}';
  n     int;
  c_unpinned constant text[] := array[
    'is_ceo', 'is_manager_or_above', 'is_accountant_or_above', 'is_staff',
    'is_investor', 'is_hr', 'can_act_on_branch', 'can_read_branch'];
begin
  for r in select schema_name from platform.tenants loop
    if to_regprocedure(format('%I.task_template_due(text, int, int, date)', r.schema_name)) is null then
      continue;
    end if;

    -- (a) this function pins, and pins THIS schema.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.proname = 'task_template_due'
       and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                    where cfg like 'search_path=%' and cfg ~ ('\m' || r.schema_name || '\M'));
    if n <> 1 then
      v_bad := v_bad || (r.schema_name || ' (task_template_due does not pin this schema)');
    end if;

    -- (b) it is still SECURITY INVOKER — pinning must not have been
    --     mistaken for elevating.
    if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                where ns.nspname = r.schema_name and p.proname = 'task_template_due' and p.prosecdef) then
      v_bad := v_bad || (r.schema_name || ' (task_template_due became SECURITY DEFINER)');
    end if;

    -- (c) assertion (e)'s own question, asked here: nothing outside the
    --     allowlist is unpinned any more.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name
       and p.proname <> all(c_unpinned)
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                        where cfg like 'search_path=%');
    if n > 0 then
      v_bad := v_bad || format('%s (%s function(s) still unpinned and not allowlisted)', r.schema_name, n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0059 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('$fn$ language sql immutable set search_path = {{SCHEMA}}, extensions;'
              in platform.tenant_ddl_template()) = 0 then
    raise exception '0059 VERIFY FAILED: template does not pin task_template_due.';
  end if;

  raise notice '0059: verified — no tenant schema carries an unpinned function outside the allowlist.';
end
$$;

-- ============================================================
-- 5. END-STATE PROBE — advisory, never fatal
--
-- The only honest test of provisioning is provisioning. This builds a
-- throwaway tenant inside a subtransaction and unwinds it.
--
-- It CANNOT fail this migration, and that is deliberate. At the time of
-- writing, provisioning also depends on 0058 (0050's overhead_months
-- %ROWTYPE), which belongs to another migration and may not be applied
-- yet. Gating a correct fix on somebody else's outstanding defect would
-- leave both unfixed; passing silently would let the next reader believe
-- provisioning works because this file went green. So it reports, loudly
-- and every run, and decides nothing.
-- ============================================================
do $probe$
declare
  v_msg text;
begin
  begin
    perform platform.provision_tenant(
      'zz0059probe', 'Probe', 'zz0059probe@example.invalid', 'Probe CEO', 'Branch', 'manual');
    raise exception 'FELIX_0059_PROBE_OK';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg = 'FELIX_0059_PROBE_OK' then
        raise notice '0059 PROBE: a new showroom provisions cleanly.';
      elsif v_msg ~ 'task_template_due|unpinned' then
        raise exception '0059 PROBE FAILED on something this file owns: %', v_msg;
      else
        raise warning
          '0059 PROBE: provisioning still fails for a reason outside this file — %. This migration is correct; that blocker is not fixed here.', v_msg;
      end if;
  end;
end
$probe$;

commit;

notify pgrst, 'reload schema';
