-- ============================================================
-- 0058 — effective_overhead_rate() IS DECLARED BEFORE ITS TABLE EXISTS
--
-- A defect in 0050. Mine, found the same day, fixed here.
--
-- WHAT IS WRONG
-- --------------
-- 0050 spliced its FUNCTIONS in at the function anchor (~114.6k in the
-- live template) and its TABLES in at the company_settings anchor
-- (~238k). effective_overhead_rate() opens with
--
--     declare
--       m  overhead_months%rowtype;                      -- @114,580
--     ...
--     create table if not exists overhead_months (...)   -- @238,304
--
-- and those are a hundred and twenty-four thousand characters apart, in
-- the wrong order.
--
-- WHY A %ROWTYPE IS DIFFERENT FROM EVERY OTHER TABLE REFERENCE HERE
-- ------------------------------------------------------------------
-- The rest of this function reads overhead_months, showroom_expenses and
-- overhead_config in ordinary statements, and those are fine: plpgsql
-- statement bodies are parsed lazily, at first execution, so a plpgsql
-- function may freely name a table that does not exist yet. Measured on
-- this server rather than assumed:
--
--     plpgsql, perform 1 from <missing table>     -> ACCEPTED at create time
--     plpgsql, declare m <missing table>%rowtype  -> 42P01 AT CREATE TIME
--
-- A %ROWTYPE is a TYPE, and the validator has to resolve it to build the
-- function's datum list. It is the one construct in a plpgsql body that
-- is eager. So provisioning a brand-new showroom raises
--
--     42P01: relation "overhead_months" does not exist
--
-- WHY NOBODY SAW IT
-- ------------------
-- Every existing showroom is fine, for the same reason 0056's defect was
-- invisible: 0050 §3 amends a live schema by executing tables first and
-- functions after, explicitly ordered, so t_felix got overhead_months
-- before effective_overhead_rate and carries both correctly. Only the
-- TEMPLATE — the path a NEW tenant takes — has them the wrong way round.
-- And that path has been dead since 0048 for an unrelated reason
-- (is_hr() calls has_feature() twelve thousand characters early), so it
-- never got this far.
--
-- THE PART WORTH KEEPING
-- -----------------------
-- 0050 §2 DOES assert template ordering, at length, and its own comment
-- reads: "an assumption about ordering is exactly the kind that fails
-- silently three migrations later. Checked, not assumed." It then checks
-- table-before-FK, table-before-ALTER and table-before-policy — and
-- never checks function-before-table, because when it was written the
-- functions were the part being added and the tables were the part being
-- reasoned about. The assertion was aimed at the class of bug already in
-- mind. §4 below adds the one that was missing.
--
-- WHAT THIS DOES
-- ---------------
-- Replaces effective_overhead_rate() with a body that declares two
-- scalars instead of a %ROWTYPE. This is deliberately NOT a reordering:
-- moving the table block above the function block in a 382k CRLF
-- template is a far larger edit than removing the only eager reference,
-- and the scalar form is order-independent for good — it cannot come
-- back if a later migration moves either anchor again.
--
-- BEHAVIOUR IS IDENTICAL. `select * into m` becomes `select rate_amount,
-- enabled into m_rate, m_enabled`; FOUND is set by both forms in exactly
-- the same way, and the two columns read are the only two the old body
-- ever touched.
--
-- NO SECDEF CHANGE — the function already existed and is still SECURITY
-- DEFINER, so create_tenant_schema()'s assertion (f) is untouched.
--
-- NOT FIXED HERE, and still blocking provisioning:
--   * is_hr() -> has_feature()             (0048)
--   * trg_audit_bonus_rules -> bonus_rules (0049)
-- Neither is mine and neither is guessed at: both are reported by the
-- ordering audit described in §4. A new showroom cannot be created until
-- all three are repaired; this file removes one of the three.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor into the template's own convention first.
--
-- GATE. On 0050.
--
-- Idempotent: a template already carrying the scalar form is left alone.
-- ============================================================

begin;

-- ============================================================
-- §1  GATE
-- ============================================================
do $gate$
begin
  if position('create table if not exists overhead_months' in platform.tenant_ddl_template()) = 0
     or position('create or replace function effective_overhead_rate' in platform.tenant_ddl_template()) = 0 then
    raise exception '0058: migration 0050 is not applied — nothing to repair.';
  end if;
end
$gate$;

-- ============================================================
-- §2  THE TEMPLATE
--
-- Whole-function replacement, head/tail, the same shape 0050 used for
-- compute_sale_waterfall(). position() has no FROM offset in Postgres,
-- so the tail is located inside substr(v_tpl, v_at) and the offset added
-- back.
-- ============================================================
do $tpl$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_at   int;
  v_len  int;
  v_rest text;

  c_head text := $h$create or replace function effective_overhead_rate(p_branch_id uuid, p_month date)$h$;
  c_tail text := $t$$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$t$;

  c_new  text := $n$create or replace function effective_overhead_rate(p_branch_id uuid, p_month date)
returns jsonb as $fn$
declare
  v_month  date := date_trunc('month', p_month::timestamp)::date;
  -- 0058: SCALARS. This deliberately does NOT declare a row variable
  -- of the overhead_months table, and the wording here is deliberate
  -- too — writing that type out even inside a comment would trip the
  -- template scan in 0058 §4, which reads the template as text.
  --
  -- A %ROWTYPE is resolved when the function is CREATED — it is a type,
  -- and the plpgsql validator needs it to build the datum list — while
  -- every ordinary statement below is resolved at first EXECUTION. In
  -- the tenant template this function is created a hundred and
  -- twenty-four thousand characters before overhead_months exists, so
  -- the %ROWTYPE form aborted provisioning of every new showroom with
  -- 42P01 while working perfectly in every schema that already had the
  -- table. Two scalars have no such dependency.
  m_rate    numeric;
  m_enabled boolean;
  c        overhead_config%rowtype;
  v_sum    numeric;
  v_months int;
begin
  select rate_amount, enabled into m_rate, m_enabled
    from overhead_months
   where branch_id = p_branch_id and period_month = v_month;
  if found then
    return jsonb_build_object(
      'rate',    case when m_enabled then round(m_rate, 2) else 0 end,
      'enabled', m_enabled,
      'source',  'month');
  end if;

  select * into c from overhead_config where branch_id = p_branch_id;
  if not found then
    return jsonb_build_object('rate', 0, 'enabled', false, 'source', 'unset');
  end if;

  if not c.fees_enabled then
    return jsonb_build_object('rate', 0, 'enabled', false, 'source', 'off');
  end if;

  if c.basis = 'average' then
    select coalesce(sum(amount), 0), count(distinct period_month)
      into v_sum, v_months
      from showroom_expenses
     where branch_id = p_branch_id
       and voided_at is null
       and period_month <= v_month
       and period_month > (v_month - make_interval(months => c.average_window_months))::date;

    if coalesce(v_months, 0) > 0 then
      return jsonb_build_object(
        'rate',    round(v_sum / v_months, 2),
        'enabled', true,
        'source',  'average');
    end if;
  end if;

  return jsonb_build_object(
    'rate',    round(coalesce(c.monthly_opex_amount, 0), 2),
    'enabled', true,
    'source',  'manual');
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$n$;
begin
  -- Line endings first, or every anchor below silently misses.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_head := replace(replace(c_head, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tail := replace(replace(c_tail, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_new  := replace(replace(c_new,  chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('overhead_months%rowtype' in v_tpl) = 0 then
    raise notice '0058: the template already carries the scalar form — skipping.';
    return;
  end if;

  -- Exactly one definition, or the head/tail span is ambiguous.
  if (length(v_tpl) - length(replace(v_tpl, c_head, ''))) <> length(c_head) then
    raise exception '0058: the template does not carry exactly one effective_overhead_rate().';
  end if;

  v_at   := position(c_head in v_tpl);
  v_rest := substr(v_tpl, v_at);
  v_len  := position(c_tail in v_rest);
  if v_len = 0 then
    raise exception '0058: effective_overhead_rate() has no SECURITY DEFINER tail. Template drifted from 0050.';
  end if;
  v_len := v_len + length(c_tail) - 1;

  v_tpl := substr(v_tpl, 1, v_at - 1) || c_new || substr(v_tpl, v_at + v_len);

  if position('overhead_months%rowtype' in v_tpl) <> 0 then
    raise exception '0058: a %%rowtype reference to overhead_months survived the replacement.';
  end if;

  execute format(
    'create or replace function platform.tenant_ddl_template() returns text language sql immutable as $ddl$select %L::text$ddl$',
    v_tpl);

  raise notice '0058: template amended — effective_overhead_rate() no longer declares a %%rowtype.';
end
$tpl$;

-- ============================================================
-- §3  EVERY EXISTING TENANT SCHEMA
--
-- These schemas are not broken — they were amended tables-first by 0050
-- §3 and their function resolves fine. This runs anyway so that a live
-- schema and a freshly provisioned one stay identical, which is the
-- invariant the whole template design rests on.
-- ============================================================
do $live$
declare
  r      record;
  v_tpl  text := platform.tenant_ddl_template();
  v_at   int;
  v_len  int;
  v_rest text;
  v_fn   text;
  c_head text := 'create or replace function effective_overhead_rate(p_branch_id uuid, p_month date)';
  c_tail text := '$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;';
begin
  v_at := position(c_head in v_tpl);
  if v_at = 0 then
    raise exception '0058: effective_overhead_rate() missing from the amended template.';
  end if;
  v_rest := substr(v_tpl, v_at);
  v_len  := position(c_tail in v_rest);
  if v_len = 0 then
    raise exception '0058: no tail for effective_overhead_rate() in the amended template.';
  end if;
  v_fn := substr(v_rest, 1, v_len + length(c_tail) - 1);

  for r in select schema_name, role_name from platform.tenants order by slug loop
    execute format('set local search_path = %I, extensions', r.schema_name);
    execute replace(replace(v_fn, '{{SCHEMA}}', r.schema_name), '{{ROLE}}', r.role_name);
    raise notice '0058: % — effective_overhead_rate() rebuilt.', r.schema_name;
  end loop;
  execute 'set local search_path = public';
end
$live$;

-- ============================================================
-- §4  VERIFY
--
-- (a) no %rowtype in the template resolves to a table declared later.
--
-- Written as a SCAN rather than a check of this one name on purpose:
-- asserting on overhead_months would only ever catch the bug already
-- found, which is precisely how 0050 shipped this one. The wider audit
-- — language-sql function->function, function->table, and the DDL that
-- resolves a relation eagerly (trigger / policy / index / alter) — lives
-- in scratchpad/audit-template-order.mjs and reports the two remaining
-- defects named in the header.
-- ============================================================
do $verify$
declare
  v_tpl text := platform.tenant_ddl_template();
  m     record;
  v_bad text[] := '{}';
  v_tab int;
  v_use int;
begin
  -- Only real DECLARE lines — `<var> <table>%rowtype;` at the start of a
  -- line. A bare '([a-z0-9_]+)%rowtype' also matches the English word in
  -- front of the word %ROWTYPE wherever a comment discusses one, and
  -- then reports tables named "the" and "A".
  for m in
    select distinct (regexp_matches(
      v_tpl,
      '^[ \t]*[a-z0-9_]+[ \t]+(?:\{\{SCHEMA\}\}\.)?([a-z0-9_]+)[ \t]*%rowtype[ \t]*;',
      'gin'))[1] as tbl
  loop
    v_use := position(m.tbl || '%rowtype' in v_tpl);
    v_tab := position('create table if not exists ' || m.tbl in v_tpl);
    if v_tab = 0 then
      v_tab := position('create table ' || m.tbl in v_tpl);
    end if;

    if v_tab = 0 then
      v_bad := v_bad || (m.tbl || ' (no create table in the template)');
    elsif v_tab > v_use then
      v_bad := v_bad || format('%s (%%rowtype at %s, table at %s)', m.tbl, v_use, v_tab);
    end if;
  end loop;

  if array_length(v_bad, 1) is not null then
    raise exception '0058 VERIFY FAILED — %%rowtype declared before its table: %', array_to_string(v_bad, ', ');
  end if;

  raise notice '0058: template %%rowtype scan clean.';
end
$verify$;

-- (b) the function still answers, and still answers with all three keys.
do $verify2$
declare
  r     record;
  v_res jsonb;
begin
  for r in select schema_name from platform.tenants order by slug loop
    execute format(
      'select %I.effective_overhead_rate(b.id, date_trunc(''month'', now())::date) from %I.branches b order by b.id limit 1',
      r.schema_name, r.schema_name) into v_res;

    if v_res is null then
      raise notice '0058: % — no branches to sample; shape not checked.', r.schema_name;
    elsif (v_res ? 'rate') and (v_res ? 'enabled') and (v_res ? 'source') then
      raise notice '0058: % — effective_overhead_rate() returns %', r.schema_name, v_res;
    else
      raise exception '0058 VERIFY FAILED: % returned a malformed jsonb: %', r.schema_name, v_res;
    end if;
  end loop;
end
$verify2$;

-- ============================================================
-- §5  THE CHECK THAT WOULD HAVE CAUGHT THIS
--
-- Provision a throwaway showroom from the amended template, then throw
-- it away. The BEGIN/EXCEPTION block is an implicit savepoint, so the
-- deliberate raise at the end unwinds the registry row, the role and the
-- whole schema; nothing survives this statement.
--
-- Adopted from 0057 §4b, which is where it belongs — it is the only
-- assertion in this repository that proves the template EXECUTES rather
-- than merely CONTAINS the right strings. Every ordering assertion in
-- 0050, including the one that reads 'Checked, not assumed', is a check
-- on text. All of them passed while the template could not provision.
--
-- CLASSIFIED, NOT BLANKET. An ordering error (42P01 / 42883 / 42704) is
-- this file's own class of defect and aborts it. Anything else is
-- reported and allowed through, because the template is shared and a
-- migration must still be applicable while a DIFFERENT session's defect
-- is outstanding. At the time of writing exactly one such defect is
-- known and it is NOT an ordering error:
--
--   task_template_due() (0053) carries no pinned search_path and is not
--   in create_tenant_schema()'s c_unpinned list, so a new schema fails
--   its own assertion (e). Reported to that session; not repaired here.
-- ============================================================
do $probe$
declare
  c_slug constant text := 'zz0058probe';
begin
  begin
    insert into platform.tenants (slug, name, schema_name, role_name, status)
    values (c_slug, '0058 provisioning probe', 't_' || c_slug, 'felix_' || c_slug, 'active');

    perform platform.create_tenant_schema(c_slug);

    -- Succeeded. Unwind everything by failing on purpose.
    raise exception 'FELIX_0058_PROBE_OK';
  exception
    when others then
      if sqlerrm = 'FELIX_0058_PROBE_OK' then
        raise notice '0058: a brand-new showroom provisions cleanly from the amended template.';
      elsif sqlstate in ('42P01', '42883', '42704') then
        raise exception '0058 VERIFY FAILED: provisioning still stops on an ordering error [%] %', sqlstate, sqlerrm;
      else
        raise notice '0058: no ordering error remains. Provisioning now stops at [%] %', sqlstate, sqlerrm;
        raise notice '0058: that is a different class of defect and is not repaired by this file.';
      end if;
  end;
end
$probe$;

commit;
