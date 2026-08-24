-- ============================================================
-- 0057 — TEMPLATE ORDER: TWO FORWARD REFERENCES I SHIPPED
--
-- A DEFECT REPORT ABOUT MY OWN MIGRATIONS. 0048 and 0049 both appended
-- correct SQL to the tenant DDL template in the wrong PLACE, and the
-- result is that `platform.create_tenant_schema()` cannot create a
-- brand-new showroom at all. Reproduced before writing a line of this
-- file:
--
--   PROVISION FAILED [42883] function t_zzprobe.has_feature(unknown)
--   does not exist
--
-- Existing showrooms are entirely unaffected and no data is at risk:
-- the template is only ever read top to bottom when a NEW tenant is
-- provisioned. Every live schema already carries both objects, created
-- by 0048 §3 and 0049 §3 against tables that existed by then. This is a
-- bug that waits for the next paying customer to sign up.
--
-- THE TWO MOVES
-- --------------
--   1. has_feature() sat at ~99k, AFTER is_hr() at ~86.7k, which calls
--      it. is_hr() is `language sql`, so with check_function_bodies on
--      (the default) CREATE FUNCTION resolves the body immediately —
--      this does not degrade, it aborts. Moved to just before is_hr().
--
--   2. trg_audit_bonus_rules sat at ~228.7k, attached to bonus_rules,
--      which is created at ~242.6k. Moved to immediately after the
--      table. NOT the other way round: the trigger needs record_audit()
--      (~199.7k), so hoisting the table up to the trigger would trade
--      one forward reference for another.
--
-- Pure moves. No object is created, dropped or redefined. The template
-- ends exactly one newline shorter, and only because rejoining 0048's
-- comment to its function closes a blank line that 0053 opened between
-- them; §2 states that as arithmetic and refuses to write if the number
-- comes out any other way.
--
-- A THIRD THING, REPAIRED IN PASSING
-- -----------------------------------
-- 0053 anchored its own functions onto `create or replace function
-- has_feature(...)` and PREPENDED to it, which slid four unrelated
-- function definitions between 0048's comment block and the function
-- that comment describes. A reader arriving at that comment today finds
-- "Does this session hold a live grant for this feature?" sitting above
-- task_template_due(). Moving the comment back onto its function fixes
-- that as a side effect of fixing the order — which is the only reason
-- it is in this file rather than left alone.
--
-- WHY THIS CLASS OF BUG WAS INVISIBLE
-- ------------------------------------
-- Four of these exist in the template right now, written by three
-- different sessions, and not one was caught. Every verify section we
-- write tests PRESENCE — `position(x in template) > 0` — and none tests
-- ORDER. The only thing that reads the template sequentially is
-- create_tenant_schema(), and no migration has ever called it. So the
-- defect passes every check we run and surfaces on a customer's first
-- day.
--
-- §4 therefore does two things no migration here has done before:
--   (a) asserts POSITION, not presence, for all three ordered pairs;
--   (b) actually provisions a throwaway tenant from the amended
--       template inside a subtransaction and rolls it back. That is the
--       only check that proves the template as a WHOLE still executes,
--       and it is cheap. It should become standard for anything that
--       rewrites the template.
--
-- WHAT THE PROBE FOUND, AND WHAT THIS FILE DOES NOT FIX
-- ------------------------------------------------------
-- With both of my moves applied, provisioning gets further and then
-- fails on the NEXT forward reference, which belongs to 0050:
--
--   relation "overhead_months" does not exist (42P01)
--
-- The fee resolver declares `overhead_months%rowtype` at ~112.6k; the
-- table is created at ~233.3k. plpgsql resolves %ROWTYPE at CREATE
-- FUNCTION time under check_function_bodies, so it aborts just as a
-- `language sql` body would — worth recording, because it was
-- reasonable to assume plpgsql bodies are only checked at first call.
--
-- That is somebody else's migration and this file leaves it alone. The
-- probe therefore WARNS rather than fails when the blocker is not one
-- of the objects moved here: gating a correct fix on an unrelated
-- defect would leave both broken, and passing silently would let the
-- next reader think provisioning works. So SO LONG AS THAT WARNING
-- APPEARS, A NEW SHOWROOM STILL CANNOT BE PROVISIONED. Existing
-- showrooms remain unaffected throughout.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- normalises every anchor first.
--
-- NON-ASCII: 0048's comment block contains an em dash. §2 never retypes
-- that text — it locates the block by ASCII-only anchors and moves the
-- bytes it finds. Retyping it is how a "pure move" silently becomes an
-- edit.
--
-- GATE. On 0048 and 0049 (the blocks being moved) and 0056 (the last
-- template write before this one).
--
-- Idempotent: re-running is a no-op, and §2 decides that from the
-- positions themselves rather than from a marker string.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
declare
  v_tpl text;
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception '0057 PRECONDITION FAILED: platform.tenant_ddl_template() missing.';
  end if;
  v_tpl := platform.tenant_ddl_template();

  if position('create or replace function has_feature(p_feature text)' in v_tpl) = 0 then
    raise exception '0057 PRECONDITION FAILED: template has no has_feature(). Apply 0048 first.';
  end if;
  if position('create or replace function is_hr() returns boolean' in v_tpl) = 0 then
    raise exception '0057 PRECONDITION FAILED: template has no is_hr(). Apply 0047 first.';
  end if;
  if position('create table if not exists bonus_rules' in v_tpl) = 0 then
    raise exception '0057 PRECONDITION FAILED: template has no bonus_rules. Apply 0049 first.';
  end if;
  if position('drop trigger if exists trg_audit_bonus_rules' in v_tpl) = 0 then
    raise exception '0057 PRECONDITION FAILED: template has no bonus_rules audit trigger.';
  end if;
end
$$;

-- ============================================================
-- 2. MOVE THE TWO BLOCKS
--
-- Both moves are cut-then-paste on the template text: locate the block
-- by anchors, delete it, re-insert it at the correct anchor. Nothing is
-- retyped, so the em dash in 0048's comment and the CRLF endings
-- survive byte for byte.
-- ============================================================
do $mig$
declare
  v_tpl   text := platform.tenant_ddl_template();
  v_nl    text;
  v_len0  int;
  v_from  int;
  v_to    int;
  v_block text;
  v_moves int := 0;
  -- How much SHORTER the template is entitled to end up. A move is
  -- length-neutral, with one exception accounted for below.
  v_expect int := 0;

  -- ── Move 1: has_feature() -> before is_hr() ────────────────
  c_cmt_start text := $a1$-- 0048. Does this session hold a live grant for this feature?$a1$;
  c_cmt_end   text := $a2$-- mode is checked explicitly: a 'hide' row must never confer anything.$a2$;
  c_fn_start  text := $a3$create or replace function has_feature(p_feature text) returns boolean as $fn$$a3$;
  c_fn_end    text := $a4$$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;$a4$;
  c_hr_anchor text := $a5$-- 0047. The employment relationship, not the sales operation.$a5$;

  -- ── Move 2: bonus trigger -> after the bonus_rules table ───
  --    All ASCII, so this one is safe to state literally.
  c_trg text := $b1$-- What the bonus scheme was, and when it changed, is exactly the kind of
-- number that gets quietly revised after a good month.
drop trigger if exists trg_audit_bonus_rules on bonus_rules;
create trigger trg_audit_bonus_rules
  after insert or update or delete on bonus_rules
  for each row execute function record_audit();$b1$;
  c_tbl_end text := $b2$  constraint uniq_bonus_rule_units       unique (min_units)
);$b2$;
begin
  v_nl   := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  v_len0 := length(v_tpl);

  c_trg     := replace(replace(c_trg,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_end := replace(replace(c_tbl_end, chr(13)||chr(10), chr(10)), chr(10), v_nl);

  -- ── MOVE 1 ────────────────────────────────────────────────
  if position(c_fn_start in v_tpl) < position(c_hr_anchor in v_tpl) then
    raise notice '0057: has_feature() already precedes is_hr() — skipping move 1.';
  else
    -- (a) the orphaned comment block, comment-start through
    --     comment-end inclusive plus the blank line after it.
    v_from  := position(c_cmt_start in v_tpl);
    v_to    := position(c_cmt_end in v_tpl) + length(c_cmt_end);
    if v_from = 0 or v_to <= v_from then
      raise exception '0057: could not locate 0048''s comment block.';
    end if;
    v_block := substr(v_tpl, v_from, v_to - v_from);
    v_tpl   := replace(v_tpl, v_block || v_nl || v_nl, '');
    if position(c_cmt_start in v_tpl) > 0 then
      raise exception '0057: the comment block did not lift cleanly.';
    end if;

    -- (b) the function itself, start through its own terminator.
    v_from := position(c_fn_start in v_tpl);
    v_to   := position(c_fn_end in substr(v_tpl, v_from)) + v_from - 1 + length(c_fn_end);
    if v_from = 0 or v_to <= v_from then
      raise exception '0057: could not locate has_feature()''s body.';
    end if;
    v_block := v_block || v_nl || substr(v_tpl, v_from, v_to - v_from);
    v_tpl   := replace(v_tpl, substr(v_tpl, v_from, v_to - v_from) || v_nl || v_nl, '');
    if position(c_fn_start in v_tpl) > 0 then
      raise exception '0057: has_feature() did not lift cleanly.';
    end if;

    -- (c) put both back immediately above is_hr()'s own comment.
    v_tpl := replace(v_tpl, c_hr_anchor, v_block || v_nl || v_nl || c_hr_anchor);
    if position(c_fn_start in v_tpl) = 0
       or position(c_fn_start in v_tpl) > position(c_hr_anchor in v_tpl) then
      raise exception '0057: has_feature() did not land before is_hr().';
    end if;

    -- EXACTLY ONE NEWLINE SHORTER, and here is the whole of why.
    -- Lifting took the comment with its blank line and the function
    -- with its blank line: four newlines. Putting them back joins the
    -- comment to the function with ONE newline instead of two, because
    -- the blank line between them was never 0048's — 0053 opened it by
    -- prepending four functions to this anchor. So three newlines go
    -- back. Stated as arithmetic rather than waved at, because "the
    -- length changed a bit" is how a move quietly becomes an edit.
    v_expect := v_expect - length(v_nl);
    v_moves  := v_moves + 1;
  end if;

  -- ── MOVE 2 ────────────────────────────────────────────────
  if position('create table if not exists bonus_rules' in v_tpl)
     < position('drop trigger if exists trg_audit_bonus_rules' in v_tpl) then
    raise notice '0057: the bonus trigger already follows its table — skipping move 2.';
  else
    if position(c_trg in v_tpl) = 0 then
      raise exception '0057: could not locate the bonus_rules audit trigger block.';
    end if;
    v_tpl := replace(v_tpl, c_trg || v_nl || v_nl, '');
    if position(c_trg in v_tpl) > 0 then
      raise exception '0057: the trigger block did not lift cleanly.';
    end if;

    v_tpl := replace(v_tpl, c_tbl_end, c_tbl_end || v_nl || v_nl || c_trg);
    if position(c_trg in v_tpl) < position('create table if not exists bonus_rules' in v_tpl) then
      raise exception '0057: the trigger did not land after its table.';
    end if;
    v_moves := v_moves + 1;
  end if;

  if v_moves = 0 then
    raise notice '0057: template already ordered correctly — nothing to do.';
    return;
  end if;

  -- A MOVE ADDS AND REMOVES NO SQL. The only permitted difference is
  -- the single newline accounted for above; anything else means a block
  -- was duplicated or eaten, and then this must not be written at all.
  if length(v_tpl) <> v_len0 + v_expect then
    raise exception
      '0057: template length went % -> %, expected % — refusing to write a move that is not a move.',
      v_len0, length(v_tpl), v_len0 + v_expect;
  end if;

  execute format(
    'create or replace function platform.tenant_ddl_template() returns text '
    'language sql immutable set search_path = pg_catalog '
    'as $felix_0057$ select %L::text $felix_0057$', v_tpl);
  revoke all on function platform.tenant_ddl_template() from public;
  raise notice '0057: template reordered (% move(s)), % -> % chars.', v_moves, v_len0, length(v_tpl);
end
$mig$;

-- ============================================================
-- 3. EXISTING TENANT SCHEMAS
--
-- Nothing to do, and that is the point. Order matters only while the
-- template is being EXECUTED; every live schema already holds
-- has_feature(), is_hr(), bonus_rules and trg_audit_bonus_rules,
-- created in dependency order by 0048 §3 and 0049 §3 against tables
-- that already existed. §4 re-checks that rather than assuming it.
-- ============================================================

-- ============================================================
-- 4. SELF-VERIFY
-- ============================================================
do $$
declare
  v_tpl text := platform.tenant_ddl_template();
  r     record;
  v_bad text[] := '{}';
begin
  -- (a) POSITION, not presence. The check nobody was making.
  if position('create or replace function has_feature(p_feature text)' in v_tpl)
     > position('create or replace function is_hr() returns boolean' in v_tpl) then
    v_bad := v_bad || 'has_feature() is still defined after is_hr(), which calls it';
  end if;
  if position('create table if not exists feature_grants' in v_tpl)
     > position('create or replace function has_feature(p_feature text)' in v_tpl) then
    v_bad := v_bad || 'has_feature() now precedes the feature_grants table it reads';
  end if;
  if position('create table if not exists bonus_rules' in v_tpl)
     > position('drop trigger if exists trg_audit_bonus_rules' in v_tpl) then
    v_bad := v_bad || 'the bonus_rules trigger is still declared before its table';
  end if;
  if position('create or replace function record_audit()' in v_tpl)
     > position('drop trigger if exists trg_audit_bonus_rules' in v_tpl) then
    v_bad := v_bad || 'the bonus_rules trigger now precedes record_audit()';
  end if;
  if position('create table if not exists feature_grants' in v_tpl)
     > position('drop trigger if exists trg_audit_feature_grants' in v_tpl) then
    v_bad := v_bad || 'the feature_grants trigger is declared before its table';
  end if;

  -- (b) exactly one of each, so a botched move cannot leave a copy.
  if (length(v_tpl) - length(replace(v_tpl, 'create or replace function has_feature', ''))) <>
     length('create or replace function has_feature') then
    v_bad := v_bad || 'the template does not carry exactly one has_feature()';
  end if;
  if (length(v_tpl) - length(replace(v_tpl, 'create trigger trg_audit_bonus_rules', ''))) <>
     length('create trigger trg_audit_bonus_rules') then
    v_bad := v_bad || 'the template does not carry exactly one trg_audit_bonus_rules';
  end if;
  if (length(v_tpl) - length(replace(v_tpl, $q$-- 0048. Does this session hold a live grant$q$, ''))) <>
     length($q$-- 0048. Does this session hold a live grant$q$) then
    v_bad := v_bad || 'the template does not carry exactly one copy of 0048''s comment';
  end if;

  -- (c) every LIVE schema still has all four objects. The move cannot
  --     have touched them, which is exactly why it is worth proving.
  for r in select schema_name from platform.tenants loop
    if to_regnamespace(r.schema_name) is null then continue; end if;
    if to_regprocedure(format('%I.has_feature(text)', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' lost has_feature()');
    end if;
    if to_regprocedure(format('%I.is_hr()', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' lost is_hr()');
    end if;
    if to_regclass(format('%I.bonus_rules', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' lost bonus_rules');
    end if;
    if not exists (
      select 1 from pg_trigger tg
        join pg_class c      on c.oid = tg.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name
         and tg.tgname = 'trg_audit_bonus_rules'
         and not tg.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' lost trg_audit_bonus_rules');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0057 VERIFY FAILED: %', array_to_string(v_bad, '; ');
  end if;
end
$$;

-- ============================================================
-- 4b. THE CHECK THAT WOULD HAVE CAUGHT THIS
--
-- Provision a throwaway showroom from the amended template, then throw
-- it away. The BEGIN/EXCEPTION block is an implicit savepoint, so the
-- deliberate raise at the end rolls back the registry row, the role and
-- the whole schema; nothing survives this statement.
--
-- This is the only assertion in the repository that proves the template
-- EXECUTES rather than merely contains the right strings, and it is the
-- one that would have caught 0048, 0049, 0053 and 0056's defect on the
-- day each was written. Anything that rewrites the template should end
-- with it.
-- ============================================================
do $$
declare
  c_slug constant text := 'zz0057probe';
begin
  begin
    insert into platform.tenants (slug, name, schema_name, role_name, status)
    values (c_slug, '0057 provisioning probe', 't_' || c_slug, 'felix_' || c_slug, 'active');

    perform platform.create_tenant_schema(c_slug);

    -- Succeeded. Unwind everything by failing on purpose.
    raise exception 'FELIX_0057_PROBE_OK';
  exception
    when others then
      if sqlerrm = 'FELIX_0057_PROBE_OK' then
        raise notice '0057: a brand-new showroom provisions cleanly from the amended template.';

      -- MINE. Anything naming an object this file moved means the move
      -- is wrong, and nothing should be written.
      elsif sqlerrm like '%has_feature%'
         or sqlerrm like '%is_hr%'
         or sqlerrm like '%bonus_rules%'
         or sqlerrm like '%trg_audit_bonus_rules%' then
        raise exception
          '0057 VERIFY FAILED: the move did not fix it: % (%)', sqlerrm, sqlstate;

      -- SOMEBODY ELSE'S. Reported loudly and NOT treated as this
      -- migration's failure.
      --
      -- Refusing to apply here would gate a correct fix on an unrelated
      -- defect in another migration, and leave BOTH broken. Passing
      -- silently would be worse: it would let the next reader believe
      -- provisioning works because 0057 went green. So it warns, names
      -- the blocker, and lets the fix land.
      --
      -- Known outstanding at the time of writing: 0050's fee resolver
      -- declares `overhead_months%rowtype` at ~112.6k while the table is
      -- created at ~233.3k. plpgsql resolves %ROWTYPE at CREATE FUNCTION
      -- time when check_function_bodies is on, so it aborts exactly like
      -- a `language sql` body would.
      else
        raise warning
          '0057: this migration''s two forward references ARE fixed, but provisioning a NEW showroom still fails for an unrelated reason: % (%). Existing showrooms are unaffected. Whoever owns that object needs a migration of their own.',
          sqlerrm, sqlstate;
      end if;
  end;
end
$$;

-- Belt and braces: the probe rolls itself back, but a registry row for
-- it surviving would mean the subtransaction did not unwind and the
-- next operator would find a phantom tenant.
do $$
begin
  if exists (select 1 from platform.tenants where slug = 'zz0057probe')
     or to_regnamespace('t_zz0057probe') is not null then
    raise exception '0057 VERIFY FAILED: the provisioning probe left residue behind.';
  end if;
  raise notice '0057: verified — order fixed, nothing added, nothing left behind.';
end
$$;

commit;

notify pgrst, 'reload schema';
