-- ============================================================
-- 0062 — service_role CANNOT UPDATE vehicles IN A FRESH SCHEMA
--
-- Reproduced live on t_demo2 (provisioned 2026-08-24):
--
--     set local role service_role;
--     update t_demo2.vehicles set odometer_km = 100 where …;
--     -> ERROR: permission denied for function is_ceo
--        WHERE: PL/pgSQL function guard_stock_transfer_move() line 3 at IF
--
-- guard_stock_transfer_move() is a NON-definer trigger on vehicles whose
-- first IF names is_ceo(). A trigger body runs as the role performing
-- the DML, and the permission check happens when the IF's expression is
-- PLANNED — short-circuiting cannot save a caller who lacks EXECUTE, so
-- every service-role UPDATE of vehicles fails, whatever columns it
-- touches. is_ceo() is `language sql` SECURITY INVOKER and itself calls
-- current_role_name(), so service_role needs EXECUTE on both.
--
-- Semantics of granting them: as service_role, auth.uid() is null, so
-- current_role_name() is null and `not is_ceo()` is null — the guard's
-- branch-move checks are skipped, i.e. service_role is treated like the
-- CEO. That is strictly more capable than today (today it cannot update
-- the row AT ALL) and service_role already bypasses RLS by design; the
-- guard exists to constrain end users, who are unaffected.
--
-- Same fix shape as 0061, same discovery: only provisioning a fresh
-- showroom (demo2) exposed it — the flagship's seed data was written
-- before this trigger existed there, and nothing since had made
-- service_role touch a vehicles row on a young schema.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. TEMPLATE: service_role grants after the {{ROLE}} grant block
-- ------------------------------------------------------------
do $$
declare
  v_tpl    text;
  v_break  text;
  v_anchor constant text := 'grant execute on function has_feature(text)';
  v_pos    int;
  v_semi   int;
  v_add    text;
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception '0062 PRECONDITION FAILED: platform.tenant_ddl_template() not found.';
  end if;
  v_tpl := platform.tenant_ddl_template();

  if position('grant execute on function is_ceo()' in v_tpl) > 0
     and position('to service_role' in v_tpl) > 0
     and position('grant execute on function current_role_name()' in v_tpl) > 0
     and (length(v_tpl) - length(replace(v_tpl, 'grant execute on function is_ceo()', '')))
         / length('grant execute on function is_ceo()') >= 2 then
    raise notice '0062: template already carries the service_role grants — skipping the splice.';
    return;
  end if;

  -- 0061's own splice is the anchor: exactly one has_feature grant line.
  if (length(v_tpl) - length(replace(v_tpl, v_anchor, ''))) <> length(v_anchor) then
    raise exception '0062 ABORTED: expected exactly one %, apply 0061 first / template drifted.', quote_literal(v_anchor);
  end if;

  v_break := case when position(chr(13) || chr(10) in v_tpl) > 0
                  then chr(13) || chr(10) else chr(10) end;

  v_pos  := position(v_anchor in v_tpl);
  v_semi := v_pos + position(';' in substr(v_tpl, v_pos)) - 1;
  if v_semi < v_pos then
    raise exception '0062 ABORTED: no statement terminator after the anchor.';
  end if;

  v_add := v_break
        || '-- Non-definer trigger bodies run as the DML''s role, and planning an IF' || v_break
        || '-- that names is_ceo() demands EXECUTE even when it would short-circuit.' || v_break
        || '-- service_role (seeding, imports, admin tooling) updates vehicles too.'   || v_break
        || 'grant execute on function is_ceo()                    to service_role;'    || v_break
        || 'grant execute on function current_role_name()         to service_role;';

  v_tpl := left(v_tpl, v_semi) || v_add || substr(v_tpl, v_semi + 1);

  execute format(
    'create or replace function platform.tenant_ddl_template() returns text '
    'language sql immutable set search_path = pg_catalog '
    'as $felix_0062$ select %L::text $felix_0062$', v_tpl);
  revoke all on function platform.tenant_ddl_template() from public;

  if platform.tenant_ddl_template() <> v_tpl then
    raise exception '0062 ABORTED: template did not round-trip through the rewrite.';
  end if;

  raise notice '0062: spliced service_role is_ceo()/current_role_name() grants into the template.';
end $$;

-- ------------------------------------------------------------
-- 2. EXISTING SCHEMAS: idempotent re-grant
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select schema_name from platform.tenants loop
    execute format('grant execute on function %I.is_ceo() to service_role', r.schema_name);
    execute format('grant execute on function %I.current_role_name() to service_role', r.schema_name);
    raise notice '0062: granted is_ceo()/current_role_name() to service_role in %', r.schema_name;
  end loop;
end $$;

-- ============================================================
-- VERIFICATION
-- ============================================================

-- (a) Every existing schema.
do $$
declare
  r record;
begin
  for r in select schema_name from platform.tenants loop
    if not has_function_privilege('service_role', format('%I.is_ceo()', r.schema_name), 'execute')
       or not has_function_privilege('service_role', format('%I.current_role_name()', r.schema_name), 'execute') then
      raise exception '0062 VERIFY FAILED: service_role still lacks the predicates in %', r.schema_name;
    end if;
  end loop;
  raise notice '0062 (a): service_role executes is_ceo()/current_role_name() in every tenant schema.';
end $$;

-- (b) A fresh schema is born with the grants (probe discipline, 0056–0061).
do $$
declare
  c_slug constant text := 'zz0062probe';
  v jsonb;
begin
  if exists (select 1 from platform.tenants where slug = c_slug) then
    raise exception '0062 VERIFY BLOCKED: leftover probe tenant % exists — clean it up before re-running.', c_slug;
  end if;

  v := platform.provision_tenant(c_slug, 'Probe 0062', 'probe0062@probe.invalid', 'Probe CEO', 'Probe Branch', '0062-verify');

  if not has_function_privilege('service_role', format('t_%s.is_ceo()', c_slug), 'execute')
     or not has_function_privilege('service_role', format('t_%s.current_role_name()', c_slug), 'execute') then
    raise exception '0062 VERIFY FAILED: a fresh schema still lacks the service_role grants';
  end if;

  v := platform.suspend_tenant(c_slug);
  v := platform.delete_tenant(c_slug);

  if to_regnamespace('t_' || c_slug) is not null
     or exists (select 1 from pg_roles where rolname = 'felix_' || c_slug)
     or exists (select 1 from platform.tenants where slug = c_slug) then
    raise exception '0062 VERIFY FAILED: probe tenant % did not unwind cleanly', c_slug;
  end if;

  raise notice '0062 (b): a fresh schema is born with the service_role grants; probe unwound cleanly.';
end $$;

commit;
