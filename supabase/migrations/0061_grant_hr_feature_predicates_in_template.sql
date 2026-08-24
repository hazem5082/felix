-- ============================================================
-- 0061 — THE TEMPLATE NEVER GRANTS is_hr() / has_feature()
--
-- Found by provisioning the second demo showroom (demo2): five seed
-- scenes failed with "permission denied for function" the moment an
-- RLS policy evaluated is_hr() or has_feature() as the signed-in
-- tenant role. Measured live:
--
--     t_felix  felix_felix  CAN execute is_hr, has_feature
--     t_demo2  felix_demo2  CANNOT — proacl {postgres=X/postgres}
--
-- and the template's own grant block (the `grant execute on function
-- …() to {{ROLE}};` run) lists the 0003-era predicate family but
-- neither of the two added later. 0047 (is_hr) and 0048 (has_feature)
-- each granted EXECUTE per-schema in their §3 amend loops — which is
-- why the flagship works — but neither added the grant line to the
-- template, so every showroom provisioned from it is born with two
-- predicates its own role may not call. The same class of bug as the
-- 0048–0059 ordering saga: the amend loop masks what the template
-- lacks, and only a brand-new schema tells the truth.
--
-- Fix: splice the two grant lines into the template's grant block, and
-- re-grant across every existing tenant schema (idempotent; t_felix
-- already has them, t_demo2 is the one being repaired).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. TEMPLATE: two grant lines after the predicate grant block
-- ------------------------------------------------------------
do $$
declare
  v_tpl    text;
  v_break  text;
  v_anchor constant text := 'grant execute on function vehicle_branch(uuid)';
  v_pos    int;
  v_semi   int;
  v_add    text;
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception '0061 PRECONDITION FAILED: platform.tenant_ddl_template() not found.';
  end if;
  v_tpl := platform.tenant_ddl_template();

  if position('grant execute on function is_hr()' in v_tpl) > 0
     and position('grant execute on function has_feature(text)' in v_tpl) > 0 then
    raise notice '0061: template already grants is_hr()/has_feature() — skipping the splice.';
    return;
  end if;

  if position('create or replace function is_hr() returns boolean' in v_tpl) = 0
     or position('create or replace function has_feature(p_feature text)' in v_tpl) = 0 then
    raise exception '0061 PRECONDITION FAILED: template lacks is_hr()/has_feature() definitions — apply 0047/0048/0057 first.';
  end if;

  -- Anchor on the last line of the predicate grant block. Single-line
  -- anchor on purpose: the live template is CRLF while repo files are LF
  -- (see 0056's header), and a one-line anchor is immune to that.
  if (length(v_tpl) - length(replace(v_tpl, v_anchor, ''))) <> length(v_anchor) then
    raise exception '0061 ABORTED: expected exactly one %, template drifted.', quote_literal(v_anchor);
  end if;

  -- The template's own line-break flavour, measured rather than assumed.
  v_break := case when position(chr(13) || chr(10) in v_tpl) > 0
                  then chr(13) || chr(10) else chr(10) end;

  v_pos  := position(v_anchor in v_tpl);
  v_semi := v_pos + position(';' in substr(v_tpl, v_pos)) - 1;
  if v_semi < v_pos then
    raise exception '0061 ABORTED: no statement terminator after the anchor.';
  end if;

  -- Same shape as the block being extended: unqualified names (the
  -- template executes with its search_path pinned to the new schema)
  -- and the {{ROLE}} placeholder create_tenant_schema substitutes.
  v_add := v_break
        || 'grant execute on function is_hr()                    to {{ROLE}};' || v_break
        || 'grant execute on function has_feature(text)          to {{ROLE}};';

  v_tpl := left(v_tpl, v_semi) || v_add || substr(v_tpl, v_semi + 1);

  -- Verbatim the write-back 0056/0057/0058 use, dollar-quoting included.
  execute format(
    'create or replace function platform.tenant_ddl_template() returns text '
    'language sql immutable set search_path = pg_catalog '
    'as $felix_0061$ select %L::text $felix_0061$', v_tpl);
  revoke all on function platform.tenant_ddl_template() from public;

  if platform.tenant_ddl_template() <> v_tpl then
    raise exception '0061 ABORTED: template did not round-trip through the rewrite.';
  end if;

  raise notice '0061: spliced is_hr()/has_feature() grants into the template (break=%)',
    case when v_break = chr(13) || chr(10) then 'CRLF' else 'LF' end;
end $$;

-- ------------------------------------------------------------
-- 2. EXISTING SCHEMAS: idempotent re-grant
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regprocedure(format('%I.is_hr()', r.schema_name)) is not null then
      execute format('grant execute on function %I.is_hr() to %I', r.schema_name, r.role_name);
    end if;
    if to_regprocedure(format('%I.has_feature(text)', r.schema_name)) is not null then
      execute format('grant execute on function %I.has_feature(text) to %I', r.schema_name, r.role_name);
    end if;
    raise notice '0061: granted is_hr()/has_feature() to % in %', r.role_name, r.schema_name;
  end loop;
end $$;

-- ============================================================
-- VERIFICATION
-- ============================================================

-- (a) Every existing tenant role can now execute both predicates.
do $$
declare
  r record;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if not has_function_privilege(r.role_name, format('%I.is_hr()', r.schema_name), 'execute') then
      raise exception '0061 VERIFY FAILED: % cannot execute %.is_hr()', r.role_name, r.schema_name;
    end if;
    if not has_function_privilege(r.role_name, format('%I.has_feature(text)', r.schema_name), 'execute') then
      raise exception '0061 VERIFY FAILED: % cannot execute %.has_feature(text)', r.role_name, r.schema_name;
    end if;
  end loop;
  raise notice '0061 (a): every tenant role executes is_hr() and has_feature().';
end $$;

-- (b) The probe discipline (see 0056–0059): a brand-new schema, built
-- from the just-spliced template, must be born with the grants — text
-- assertions alone are exactly what missed this bug for two weeks.
-- Provision, assert, then unwind through the 0060 lifecycle.
do $$
declare
  c_slug constant text := 'zz0061probe';
  v jsonb;
begin
  if exists (select 1 from platform.tenants where slug = c_slug) then
    raise exception '0061 VERIFY BLOCKED: leftover probe tenant % exists — clean it up before re-running.', c_slug;
  end if;

  v := platform.provision_tenant(c_slug, 'Probe 0061', 'probe0061@probe.invalid', 'Probe CEO', 'Probe Branch', '0061-verify');

  if not has_function_privilege('felix_' || c_slug, format('t_%s.is_hr()', c_slug), 'execute') then
    raise exception '0061 VERIFY FAILED: a fresh schema still lacks the is_hr() grant';
  end if;
  if not has_function_privilege('felix_' || c_slug, format('t_%s.has_feature(text)', c_slug), 'execute') then
    raise exception '0061 VERIFY FAILED: a fresh schema still lacks the has_feature(text) grant';
  end if;

  v := platform.suspend_tenant(c_slug);
  v := platform.delete_tenant(c_slug);

  if to_regnamespace('t_' || c_slug) is not null
     or exists (select 1 from pg_roles where rolname = 'felix_' || c_slug)
     or exists (select 1 from platform.tenants where slug = c_slug) then
    raise exception '0061 VERIFY FAILED: probe tenant % did not unwind cleanly', c_slug;
  end if;

  raise notice '0061 (b): a fresh schema is born with both grants; probe unwound cleanly.';
end $$;

commit;
