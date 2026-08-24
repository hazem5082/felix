-- ============================================================
-- 0056 — 0053'S AUDIT TRIGGER IS DECLARED BEFORE ITS TABLE EXISTS
--
-- A defect in 0053, found the same day, fixed here rather than left.
--
-- WHAT IS WRONG
-- --------------
-- 0053 spliced its tables in after bonus_rules (offset ~244k in the live
-- template) and its audit trigger in before trg_audit_bonus_rules
-- (~229k). Those two anchors are fifteen thousand characters apart and
-- in the WRONG ORDER, so the template reads:
--
--     drop trigger if exists trg_audit_task_templates on task_templates;   -- @229224
--     ...
--     create table if not exists task_templates (...)                       -- @244331
--
-- `drop trigger IF EXISTS` forgives a missing TRIGGER. It does not
-- forgive a missing TABLE — the relation still has to be resolved — so
-- provisioning a brand-new showroom raises
--
--     42P01: relation "task_templates" does not exist
--
-- WHY NOBODY SAW IT
-- ------------------
-- Every existing showroom is fine. 0053 §4 amends a live schema by
-- executing tables, functions, RLS, policies and triggers in that
-- order, explicitly sorted — so t_felix got its table before its
-- trigger and carries both correctly. Only the TEMPLATE, which is the
-- path a NEW tenant takes, has them the wrong way round. And that path
-- was already failing earlier for two unrelated reasons (see the note
-- at the bottom), so it never got as far as this one.
--
-- The lesson, which is the reason this file exists rather than a quiet
-- edit: an anchored template migration must check the ORDER of what it
-- splices, not just that each anchor matched. Six anchors matched
-- exactly once in 0053 and the result was still wrong. §3 below adds
-- the assertion that would have caught it.
--
-- WHAT THIS DOES
-- ---------------
-- Moves the trigger block, verbatim, to sit immediately after the
-- day_reports index at the end of 0053's own table block. Nothing else
-- changes: no table, no function, no policy, no grant, and no tenant
-- schema — every provisioned schema already has this right.
--
-- NO SECDEF CHANGE, so create_tenant_schema()'s assertion (f) is not
-- touched.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor into the template's own convention first.
--
-- GATE. On 0053.
--
-- Idempotent: re-running is safe, and a template already in the right
-- order is left alone.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception '0056 PRECONDITION FAILED: platform.tenant_ddl_template() missing.';
  end if;
  if position('create table if not exists tasks (' in platform.tenant_ddl_template()) = 0 then
    raise exception '0056 PRECONDITION FAILED: the template has no tasks table. Apply 0053 first.';
  end if;
end
$$;

-- ============================================================
-- 2. MOVE THE TRIGGER BLOCK
-- ============================================================
do $mig$
declare
  v_tpl   text := platform.tenant_ddl_template();
  v_nl    text;
  v_tbl   int;
  v_trg   int;

  -- The block 0053 wrote, verbatim. Moved as one piece; not rewritten.
  c_block text := $a1$-- Who changed the standing instructions, and when. A recurring duty
-- quietly retired the week somebody stopped doing it is exactly the
-- kind of edit this table exists to catch.
--
-- tasks itself is NOT audited, deliberately: it would write a row for
-- every tick of every checkbox in the showroom, every day, and the task
-- row already carries completed_at and completed_by. day_reports is not
-- audited for the same reason it exists — it IS the record.
drop trigger if exists trg_audit_task_templates on task_templates;
create trigger trg_audit_task_templates
  after insert or update or delete on task_templates
  for each row execute function record_audit();$a1$;

  -- The last line of 0053's table block: the trigger lands after this.
  c_after text := $b1$create index if not exists idx_day_reports_branch_day on day_reports(branch_id, day);$b1$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_block := replace(replace(c_block, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_after := replace(replace(c_after, chr(13)||chr(10), chr(10)), chr(10), v_nl);

  v_tbl := position('create table if not exists task_templates (' in v_tpl);
  v_trg := position('create trigger trg_audit_task_templates' in v_tpl);

  if v_tbl = 0 or v_trg = 0 then
    raise exception '0056: expected both the task_templates table and its audit trigger in the template.';
  end if;

  if v_trg > v_tbl then
    raise notice '0056: trigger already follows its table — skipping.';
  else
    if position(c_block in v_tpl) = 0 then
      raise exception '0056: the trigger block did not match verbatim. Template drifted from 0053.';
    end if;
    if position(c_after in v_tpl) = 0 then
      raise exception '0056: anchor (day_reports index) did not match. Template drifted from 0053.';
    end if;

    -- Lift it out, with the blank line 0053 left behind it, then put it
    -- back after the table block.
    v_tpl := replace(v_tpl, c_block || v_nl || v_nl, '');
    if position('create trigger trg_audit_task_templates' in v_tpl) > 0 then
      raise exception '0056: the trigger block was not removed cleanly.';
    end if;

    v_tpl := replace(v_tpl, c_after, c_after || v_nl || v_nl || c_block);

    -- Exactly one of each, still.
    if (length(v_tpl) - length(replace(v_tpl, 'create trigger trg_audit_task_templates', ''))) <>
       length('create trigger trg_audit_task_templates') then
      raise exception '0056: the template does not carry exactly one trg_audit_task_templates.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0056$ select %L::text $felix_0056$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0056: trigger moved below its table.';
  end if;
end
$mig$;

-- ============================================================
-- 3. SELF-VERIFY — the ORDER, not just the anchors
--
-- This is the assertion 0053 should have carried. An anchored splice
-- can match perfectly and still land in the wrong place, and the only
-- thing that catches that is checking the property you actually wanted.
-- ============================================================
do $$
declare
  v_tpl text := platform.tenant_ddl_template();
  v_tbl int := position('create table if not exists task_templates (' in v_tpl);
  v_trg int := position('create trigger trg_audit_task_templates' in v_tpl);
  v_drp int := position('drop trigger if exists trg_audit_task_templates' in v_tpl);
begin
  if v_tbl = 0 or v_trg = 0 or v_drp = 0 then
    raise exception '0056 VERIFY FAILED: task_templates table or its trigger is missing from the template.';
  end if;
  if v_drp < v_tbl then
    raise exception
      '0056 VERIFY FAILED: `drop trigger ... on task_templates` (@%) still precedes the table (@%).', v_drp, v_tbl;
  end if;
  if v_trg < v_tbl then
    raise exception
      '0056 VERIFY FAILED: `create trigger` (@%) still precedes the table (@%).', v_trg, v_tbl;
  end if;

  raise notice '0056: verified — task_templates is created at % and its trigger at %.', v_tbl, v_trg;
end
$$;

-- ============================================================
-- 4. WHAT THIS DOES NOT FIX
--
-- Provisioning a new showroom is still broken by two forward references
-- this file deliberately leaves alone, both older and neither ours:
--
--   is_hr()@88373 is `language sql` and calls has_feature()@100982.
--     `language sql` resolves names at CREATE time, so CREATE FUNCTION
--     is_hr fails first. Introduced by 0048.
--
--   trg_audit_bonus_rules is declared on bonus_rules before that table
--     is created — the same defect this file fixes for task_templates.
--     Introduced by 0049.
--
-- Both are one-line-ish moves in the same template. They are not fixed
-- here because they belong to other migrations and nobody asked; the
-- audit that finds them lives in this session's scratchpad and is
-- described in the project notes.
-- ============================================================

commit;

notify pgrst, 'reload schema';
