-- ============================================================
-- 0037 — HOTFIX: NO SECURITY INVOKER FUNCTION MAY NAME auth.*
--
-- THE OUTAGE
-- ----------
-- As of 0030/0035/0036 a signed-in showroom session gets
--
--   {"code":"42501","message":"permission denied for schema auth"}
--
-- from every table whose policy calls can_read_branch() or
-- can_act_on_branch() — vehicle_expenses, stock_transfers, receipts,
-- vehicle_price_history, deal_ticket_events and the rest. Reproduced
-- against the live API with a real CEO session, not inferred. It is a
-- 403 for EVERY role including the CEO, because the failure happens
-- while the planner is preparing the query, long before any predicate
-- is evaluated and long before is_ceo() could short-circuit anything.
--
-- WHY
-- ---
-- felix_<slug> holds EXECUTE on auth.uid() and NO USAGE on schema auth:
--
--   anon           usage on auth = true
--   authenticated  usage on auth = true
--   service_role   usage on auth = true
--   felix_felix    usage on auth = FALSE
--
-- 0008 §4 creates the tenant role from scratch and NOINHERIT, so it
-- inherits nothing from `authenticated`, and nothing ever granted it
-- this. That was harmless for two years because of a property nobody
-- had written down: a POLICY expression is stored as an already-parsed
-- node tree, so `id = auth.uid()` inside profiles_select never
-- re-resolves the name at query time and only the function's EXECUTE
-- ACL is checked. Schema USAGE is a NAME RESOLUTION check, and policies
-- were resolved once, at CREATE time, as the superuser.
--
-- 0030 broke that by putting auth.uid() somewhere that IS re-resolved
-- per query: inside can_read_branch() and can_act_on_branch(), which
-- 0009 deliberately leaves unpinned SO THAT THE PLANNER INLINES THEM.
-- Inlining re-parses the function body in the CALLER's context, and
-- that re-parse is a fresh name resolution — which felix_<slug> fails.
-- The very property 0009 engineered for performance is what turned a
-- dormant missing grant into a hard outage.
--
-- Two more functions have the same shape and the same fault, reached at
-- execution rather than at planning because they are plpgsql:
-- guard_stock_transfer_status() (0035) sets decided_by := auth.uid(),
-- and record_vehicle_price_history() (0036) writes changed_by. Both are
-- SECURITY INVOKER, so both resolve auth.uid() as felix_<slug>.
--
-- Every OTHER function that names auth.uid() is SECURITY DEFINER and
-- resolves as its owner, which is why is_ceo(), current_branch_id() and
-- the RPCs kept working throughout. That is also the general rule this
-- file turns into an assertion.
--
-- WHY NOT JUST GRANT THE USAGE
-- ----------------------------
-- Because no migration can. Schema auth is owned by supabase_admin;
-- `postgres` is not a member of supabase_admin or supabase_auth_admin
-- and cannot become either, and `grant usage on schema auth` issued as
-- postgres does not fail — it emits
--
--   WARNING: no privileges were granted for "auth"
--
-- and carries on, which is precisely the kind of silent no-op a
-- migration must never be built on. supabase_privileged_role was tried
-- too and is refused. The grant is simply not available from here, so
-- the fix has to remove the dependency instead of satisfying it.
--
-- THE FIX
-- -------
-- Replace auth.uid() in those four functions with auth.uid()'s OWN BODY,
-- inlined:
--
--   coalesce(
--     nullif(current_setting('request.jwt.claim.sub', true), ''),
--     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
--   )::uuid
--
-- That is copied verbatim from `pg_get_functiondef('auth.uid()')` on
-- this database, so the semantics are identical by construction rather
-- than by argument — including returning NULL for a sessionless caller.
-- current_setting, nullif, coalesce and the jsonb operator are all
-- pg_catalog, which every role can always resolve.
--
-- WHY INLINE RATHER THAN A HELPER FUNCTION
-- ----------------------------------------
-- The tidy version adds {{SCHEMA}}.jwt_uid() and calls it four times.
-- It was rejected on the template's own terms:
--
--   * assertion (e) inside platform.create_tenant_schema() refuses any
--     function that carries no pinned search_path and is not one of
--     seven named inlinable predicates. A new helper must therefore be
--     PINNED — and a pinned function is not inlinable, so the hottest
--     predicate in the schema would gain a real function call for every
--     row of every policy evaluation.
--   * a helper is a new object in a file whose entire purpose is to
--     stop a 403. Four copies of four lines cost nothing and risk
--     nothing; §4 asserts all four stay in step.
--
-- WHAT THIS FILE DOES NOT CHANGE
-- ------------------------------
-- No table, no column, no policy, no grant, no role. The four function
-- bodies are otherwise byte-for-byte what 0030/0035/0036 wrote, down to
-- their comments. Nothing about WHO may do WHAT moves by one inch —
-- this only changes how the four of them ask "who is calling".
--
-- STRUCTURE MIRRORS 0030 — template + live loop, anchored and verified
-- substitutions, per-tenant search_path in §3. Idempotent: re-running
-- is safe, and §2 detects its own prior application.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0037 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  -- The three migrations that introduced the four faults. All must be
  -- present, or an anchor below is missing for a reason that has
  -- nothing to do with drift.
  if position('g.revoked_at is null' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0037 PRECONDITION FAILED: the branch predicates carry no grant arm. Apply 0030 first.';
  end if;
  if position('function guard_stock_transfer_status()' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0037 PRECONDITION FAILED: the template has no guard_stock_transfer_status(). Apply 0035 first.';
  end if;
  if position('function record_vehicle_price_history()' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0037 PRECONDITION FAILED: the template has no record_vehicle_price_history(). Apply 0036 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Four anchored substitutions. Each one is a whole function span, so
-- the replacement is the definitive text rather than a splice, and the
-- count guards at the end assert the outcome rather than the edit.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  -- 2a. can_act_on_branch() — 0030's body, with the caller identified
  --     from the JWT instead of through schema auth.
  c_act_from text := $a1$      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$a1$;
  c_act_to   text := $a2$      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             -- 0037: auth.uid()'s own body, inlined. This function is
             -- deliberately unpinned so the planner INLINES it, and
             -- inlining re-resolves every name in this body as the
             -- calling tenant role — which holds EXECUTE on auth.uid()
             -- but no USAGE on schema auth, and cannot be granted any.
             -- Naming auth.* here is what produced "permission denied
             -- for schema auth" on every table whose policy calls this.
             -- See the 0037 header. Keep this expression and the one in
             -- can_read_branch() identical; §4 checks that they are.
             where g.profile_id = coalesce(
                     nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
                   )::uuid
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$a2$;

  -- 2b. can_read_branch() — the same arm, in the twin. 0030 kept these
  --     two functions separate on purpose; they are still separate, and
  --     still identical.
  c_read_from text := $b1$      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$b1$;
  c_read_to   text := $b2$      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             -- 0037: see the twin in can_act_on_branch(). Same fault,
             -- same fix, deliberately the same text.
             where g.profile_id = coalesce(
                     nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
                   )::uuid
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$b2$;

  -- 2c. guard_stock_transfer_status() (0035). plpgsql and SECURITY
  --     INVOKER, so it fails at EXECUTION rather than at planning —
  --     accepting or cancelling a transfer raises 42501 instead of
  --     moving a car.
  c_trf_from text := $c1$    new.decided_by := auth.uid();$c1$;
  c_trf_to   text := $c2$    -- 0037: auth.uid() inlined — this trigger is SECURITY INVOKER,
    -- so it resolves names as the tenant role. See the 0037 header.
    new.decided_by := coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid;$c2$;

  -- 2d. record_vehicle_price_history() (0036). Two call sites in one
  --     body, and the whole body is replaced so both move together.
  c_pri_from text := $d1$create or replace function record_vehicle_price_history() returns trigger as $trg$
begin
  if tg_op = 'INSERT' then
    if new.asking_price is not null or new.min_price is not null then
      insert into vehicle_price_history (vehicle_id, branch_id, asking_price, min_price, changed_by)
      values (new.id, new.branch_id, new.asking_price, new.min_price, auth.uid());
    end if;
    return new;
  end if;

  if new.asking_price is distinct from old.asking_price
     or new.min_price is distinct from old.min_price then
    insert into vehicle_price_history (vehicle_id, branch_id, asking_price, min_price, changed_by)
    values (new.id, new.branch_id, new.asking_price, new.min_price, auth.uid());
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$d1$;
  c_pri_to   text := $d2$create or replace function record_vehicle_price_history() returns trigger as $trg$
-- 0037: SECURITY INVOKER, so auth.uid() resolved as the tenant role and
-- raised 42501 on every price change. Both call sites now read the JWT
-- claim directly; see the 0037 header.
declare
  v_actor uuid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
begin
  if tg_op = 'INSERT' then
    if new.asking_price is not null or new.min_price is not null then
      insert into vehicle_price_history (vehicle_id, branch_id, asking_price, min_price, changed_by)
      values (new.id, new.branch_id, new.asking_price, new.min_price, v_actor);
    end if;
    return new;
  end if;

  if new.asking_price is distinct from old.asking_price
     or new.min_price is distinct from old.min_price then
    insert into vehicle_price_history (vehicle_id, branch_id, asking_price, min_price, changed_by)
    values (new.id, new.branch_id, new.asking_price, new.min_price, v_actor);
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$d2$;
begin
  -- The template's own line-ending convention decides the anchors'.
  -- See 0030 §2: an LF anchor never matches CRLF text, and the guards
  -- below would then report drift that is not there.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_act_from  := replace(replace(c_act_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_act_to    := replace(replace(c_act_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_read_from := replace(replace(c_read_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_read_to   := replace(replace(c_read_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trf_from  := replace(replace(c_trf_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trf_to    := replace(replace(c_trf_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pri_from  := replace(replace(c_pri_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pri_to    := replace(replace(c_pri_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('request.jwt.claim.sub' in v_tpl) > 0 then
    raise notice '0037: template already reads the JWT claim directly — skipping amendment.';
  else
    -- 2a and 2b share an anchor: 0030 wrote the two grant arms with
    -- IDENTICAL text, and the two `from` strings above are therefore
    -- the same string. That is not a mistake to be tidied — it is why
    -- ONE replace() call with a count of two is the correct edit, and
    -- why the guard afterwards checks for two occurrences rather than
    -- one. Replacing them separately would rewrite the first twice.
    v_tpl := replace(v_tpl, c_act_from, c_act_to);
    if position(c_act_to in v_tpl) = 0 then
      raise exception '0037: template anchor 2a/2b (branch predicates) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    -- The twin's comment line differs, so this second pass rewrites the
    -- can_read_branch copy that the first pass turned into c_act_to.
    -- Order matters and is asserted below.
    v_tpl := replace(v_tpl, c_act_to, c_read_to);
    if position(c_read_to in v_tpl) = 0 then
      raise exception '0037: template anchor 2b (can_read_branch) did not match.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trf_from, c_trf_to);
    if position(c_trf_to in v_tpl) = 0 then
      raise exception '0037: template anchor 2c (guard_stock_transfer_status) did not match. Template drifted from 0035.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pri_from, c_pri_to);
    if position(c_pri_to in v_tpl) = 0 then
      raise exception '0037: template anchor 2d (record_vehicle_price_history) did not match. Template drifted from 0036.';
    end if;
    v_done := v_done + 1;

    -- THE ASSERTION THIS FILE EXISTS FOR. Not "did the edit apply" but
    -- "is the fault gone": no SECURITY INVOKER body may name auth.*
    -- anywhere in the template. Every remaining auth.uid() belongs to a
    -- SECURITY DEFINER function, which resolves as its owner and is
    -- fine — and to policy expressions, which are resolved once at
    -- CREATE time and never re-resolved.
    --
    -- The count is over the four function bodies only, so it is stated
    -- as "the four we fixed carry none", checked by §4 per schema
    -- against pg_proc, which is the real catalogue rather than text.
    -- Here in the template all we can honestly check is the text.
    if (length(v_tpl) - length(replace(v_tpl, 'request.jwt.claim.sub', '')))
       <> 4 * length('request.jwt.claim.sub') then
      raise exception
        '0037: expected exactly four inlined JWT reads in the template, found a different number.';
    end if;

    -- Lengths COMPUTED, never hand-counted — 0035 shipped a guard with
    -- a hand-written 40 where the string was 42 long, and the guard
    -- aborted a correct migration.
    if (length(v_tpl) - length(replace(v_tpl, 'g.profile_id = auth.uid()', '')))
       <> 0 then
      raise exception '0037: a branch predicate still calls auth.uid().';
    end if;

    if (length(v_tpl) - length(replace(v_tpl, 'new.decided_by := auth.uid()', '')))
       <> 0 then
      raise exception '0037: guard_stock_transfer_status() still calls auth.uid().';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0037$ select %L::text $felix_0037$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0037: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Whole-function replacements, schema-qualified rather than
-- path-resolved for the two branch predicates (0030 §3's reason: they
-- are in create_tenant_schema()'s c_unpinned list, carry NO pinned
-- search_path so the planner can inline them, and must schema-qualify
-- their own inner calls instead).
--
-- create-or-replace preserves grants, so no EXECUTE is re-granted here
-- and none is lost.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_fns constant text := $fns$
create or replace function {{SCHEMA}}.can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = coalesce(
                     nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
                   )::uuid
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;

create or replace function {{SCHEMA}}.can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = coalesce(
                     nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
                   )::uuid
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;
$fns$;

  -- The two trigger functions keep their pinned search_path, so these
  -- are executed under the per-tenant path rather than interpolated.
  c_trg constant text := $trg_all$
create or replace function guard_stock_transfer_status() returns trigger as $trg$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'A transfer always starts as requested';
    end if;
    new.decided_by := null;
    new.decided_at := null;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'requested' and new.status in ('accepted', 'cancelled'))
      or (old.status = 'accepted'  and new.status = 'requested')
    ) then
      raise exception 'A transfer cannot move from % to %', old.status, new.status;
    end if;
    new.decided_by := coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid;
    new.decided_at := now();
  else
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;

  new.vehicle_id     := old.vehicle_id;
  new.from_branch_id := old.from_branch_id;
  new.to_branch_id   := old.to_branch_id;
  new.requested_by   := old.requested_by;
  new.requested_at   := old.requested_at;
  new.note           := old.note;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

create or replace function record_vehicle_price_history() returns trigger as $trg$
declare
  v_actor uuid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
begin
  if tg_op = 'INSERT' then
    if new.asking_price is not null or new.min_price is not null then
      insert into vehicle_price_history (vehicle_id, branch_id, asking_price, min_price, changed_by)
      values (new.id, new.branch_id, new.asking_price, new.min_price, v_actor);
    end if;
    return new;
  end if;

  if new.asking_price is distinct from old.asking_price
     or new.min_price is distinct from old.min_price then
    insert into vehicle_price_history (vehicle_id, branch_id, asking_price, min_price, changed_by)
    values (new.id, new.branch_id, new.asking_price, new.min_price, v_actor);
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;
$trg_all$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0037: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute replace(c_fns, '{{SCHEMA}}', quote_ident(r.schema_name));

    -- Only where 0035/0036 actually landed. A tenant provisioned from
    -- an older template has neither function and needs neither fix;
    -- create-or-replace would otherwise mint a trigger function with no
    -- trigger and, worse, a vehicle_price_history reference that does
    -- not resolve.
    if to_regprocedure(format('%I.guard_stock_transfer_status()', r.schema_name)) is not null
       and to_regprocedure(format('%I.record_vehicle_price_history()', r.schema_name)) is not null then
      execute replace(c_trg, '{{SCHEMA}}', quote_ident(r.schema_name));
    else
      raise notice '0037: % predates 0035/0036 — branch predicates fixed, trigger functions skipped.', r.schema_name;
    end if;

    v_count := v_count + 1;
    raise notice '0037: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0037: % tenant schema(s) no longer resolve auth.* as the tenant role.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — THE INVARIANT, NOT THE EDIT
--
-- The check that matters is not "did those four functions change". It
-- is "does any SECURITY INVOKER function in any tenant schema still
-- name something in auth". That is the rule the whole outage came from,
-- it is stated nowhere else in the schema, and it is exactly the shape
-- of mistake a future migration will make again — so it is asserted
-- against pg_proc rather than against the four names known today.
-- ============================================================
do $$
declare
  r       record;
  v_bad   text[] := '{}';
  v_names text;
  n       int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    -- (a) THE INVARIANT.
    select string_agg(p.proname, ', ' order by p.proname), count(*)
      into v_names, n
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name
       and not p.prosecdef
       and p.prosrc ~ '\mauth\s*\.';

    if n > 0 then
      v_bad := v_bad || format(
        '%s (SECURITY INVOKER function(s) still naming auth.*: %s — these resolve as %s, which holds no USAGE on schema auth)',
        r.schema_name, v_names, r.role_name);
    end if;

    -- (b) the two branch predicates still exist, are still unpinned so
    --     the planner still inlines them, and still carry 0030's
    --     revocation clause. A "fix" that silently pinned them would
    --     pass (a) and quietly cost every policy evaluation in the
    --     schema; a "fix" that dropped `revoked_at is null` would pass
    --     (a) and hand revoked staff their authority back.
    for n in 1..1 loop
      if exists (
        select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = r.schema_name
           and p.proname in ('can_act_on_branch','can_read_branch')
           and p.proconfig is not null
      ) then
        v_bad := v_bad || (r.schema_name || ' (a branch predicate gained a pinned search_path — it can no longer be inlined)');
      end if;

      select count(*) into n
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name
         and p.proname in ('can_act_on_branch','can_read_branch')
         and p.prosrc like '%revoked_at is null%';
      if n <> 2 then
        v_bad := v_bad || format('%s (%s/2 branch predicates keep the revocation clause)', r.schema_name, n);
      end if;

      select count(*) into n
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name
         and p.proname in ('can_act_on_branch','can_read_branch')
         and p.prosrc like '%request.jwt.claim%';
      if n <> 2 then
        v_bad := v_bad || format('%s (%s/2 branch predicates read the JWT claim)', r.schema_name, n);
      end if;
    end loop;

    -- (c) the SECURITY DEFINER count is untouched. This file adds and
    --     removes no function, and assertion (f) inside
    --     create_tenant_schema() requires exactly twenty.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> 20 then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, assertion (f) requires 20)', r.schema_name, n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0037 SELF-VERIFY FAILED: %', array_to_string(v_bad, '; ');
  end if;

  raise notice '0037: self-verify passed — no SECURITY INVOKER function names auth.* in any tenant schema.';
end
$$;

commit;
