-- ============================================================
-- 0045 — "SET PRICES" IS BROKEN IN PRODUCTION: THE auth.uid() TRAP,
--        THIRD OCCURRENCE
--
-- Changing a vehicle's asking or floor price fails for EVERY role,
-- including the CEO, with:
--
--     ERROR: permission denied for schema auth
--
-- Reproduced directly against the live flagship tenant, as the tenant
-- role with a real CEO JWT claim:
--
--     set local role felix_felix;
--     set local request.jwt.claims = '{"sub":"<ceo uuid>", ...}';
--     update vehicles set asking_price = 40000 where id = '<a car>';
--     -- ERROR: permission denied for schema auth
--
-- while an UPDATE that leaves both prices untouched succeeds. That is
-- the tell: the failure is not in vehicles_update at all, it is in the
-- price-history machinery 0036 hangs off the price columns.
--
-- HOW IT ESCAPED NOTICE
-- ---------------------
-- vehicle_price_history is not empty — it holds rows. Every one of them
-- was written by a seed script running as service_role, which bypasses
-- RLS and does hold USAGE on schema auth. No row in it was ever written
-- by a real user pressing "Set prices", because that path has never
-- once worked. An empty table would have been noticed; a table full of
-- plausible seed data was not.
--
-- THE MECHANISM — 0037'S BUG, IN A PLACE 0037 DID NOT LOOK
-- ----------------------------------------------------------
-- 0037's header documents this trap in full: the tenant role
-- felix_<slug> has no USAGE on schema `auth`, so ANY expression
-- evaluated AS that role which names auth.uid() raises 42501. 0037 found
-- it in can_read_branch()/can_act_on_branch() and fixed those by routing
-- the lookup through a SECURITY DEFINER helper. It did not audit the
-- rest of the schema, and 0036 had already planted two more copies:
--
--   1. record_vehicle_price_history() — a PLAIN (SECURITY INVOKER)
--      plpgsql trigger whose INSERT ... values (..., auth.uid()) runs as
--      the calling tenant role.
--   2. vehicle_price_history_insert — a policy whose WITH CHECK is
--      `changed_by = auth.uid() and can_act_on_branch(branch_id)`,
--      likewise evaluated as the tenant role.
--
-- Either alone is fatal to the statement. 0036's header explicitly chose
-- (1) to be plain, reasoning that "a plain trigger fires as the calling
-- session, so auth.uid() is the real actor rather than a definer's
-- identity."
--
-- THAT REASONING IS WRONG, AND THAT IS THE WHOLE FIX
-- ----------------------------------------------------
-- auth.uid() does not read the current ROLE. It reads the request's JWT
-- claims out of a session GUC (`request.jwt.claims`), which SECURITY
-- DEFINER does not touch — DEFINER changes the effective role, not the
-- session's settings. So a SECURITY DEFINER trigger still records the
-- REAL actor in changed_by, exactly as intended, while being permitted
-- to call auth.uid() at all because it runs as the function's owner
-- (the table owner), who does hold USAGE on schema auth.
--
-- Making the trigger DEFINER also resolves (2) for free: a definer
-- function owned by the table owner is not subject to that table's RLS,
-- so vehicle_price_history_insert is no longer evaluated on this path
-- and its auth.uid() never runs. The policy is deliberately LEFT IN
-- PLACE rather than dropped — it is now belt-and-braces that would
-- still refuse a forged changed_by if some future writer reached this
-- table as a non-owner, and 0036's own reasoning for having it stands.
--
-- SECURITY: THE PINNED search_path IS NOT OPTIONAL HERE
-- -------------------------------------------------------
-- 0036 §2 wrote the TEMPLATE copy with `set search_path = {{SCHEMA}},
-- extensions` but 0036 §3 created the LIVE copy with no search_path at
-- all (verified: proconfig is null on t_felix today). That was survivable
-- while the function was SECURITY INVOKER. It is NOT survivable for a
-- DEFINER function: an unpinned definer runs whatever `vehicles` or
-- `vehicle_price_history` the CALLER's search_path resolves to, with the
-- owner's privileges — the textbook search_path-injection shape. §3
-- below therefore recreates the live copy WITH the schema pinned, and §5
-- fails the migration if any tenant ends up with a definer copy that
-- has no proconfig.
--
-- THE SECURITY DEFINER COUNT MOVES 21 -> 22
-- -------------------------------------------
-- Assertion (f) inside platform.create_tenant_schema() pins the number
-- of SECURITY DEFINER functions per tenant schema — 20 at 0009, raised
-- to 21 by 0037. This migration converts an existing function rather
-- than adding one, but the COUNT still moves, so §4 raises it to 22
-- using 0037's exact technique: patch the function's OWN live source,
-- never a hand-retyped copy, so a 250-line function unrelated to this
-- bug cannot silently drift from what is deployed.
--
-- NO OTHER auth.uid() IS TOUCHED. Policies evaluated as the tenant role
-- that name auth.uid() directly are the same latent hazard everywhere
-- they appear, but every other one is on a table whose writes already
-- go through a SECURITY DEFINER RPC (ledger_entries, consignment_payouts)
-- or through service_role (mail inbound), so none of them is reachable
-- as the tenant role today. Fixing a live break is this file's job;
-- auditing the remainder is not, and doing both would make the diff
-- unreviewable.
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
    raise exception
      '0045 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('create or replace function record_vehicle_price_history() returns trigger as $trg$'
              in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0045 PRECONDITION FAILED: the template has no record_vehicle_price_history(). Apply 0036 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- A SPAN replacement (0032/0036's own technique for a function body):
-- head locates the function, tail is the line every plpgsql trigger in
-- the template ends with, so it is only ever searched FORWARD from the
-- head. An anchored replace on the tail alone would hit the first of
-- several identical tails belonging to other trigger functions.
-- ============================================================
do $mig$
declare
  v_tpl text := platform.tenant_ddl_template();
  v_nl  text;
  v_at  int;
  v_len int;
  v_rest text;

  c_head constant text := 'create or replace function record_vehicle_price_history() returns trigger as $trg$';
  c_tail text := '$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;';
  c_new  text := $fn$create or replace function record_vehicle_price_history() returns trigger as $trg$
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
-- 0045: SECURITY DEFINER, not plain. The tenant role has no USAGE on
-- schema auth (0037), so the auth.uid() calls above raise 42501 when
-- this fires as the caller — which broke every price change in the
-- product. DEFINER changes the effective ROLE, not the session GUCs
-- auth.uid() actually reads, so changed_by is still the real actor.
-- The pinned search_path is mandatory for a definer, not decoration.
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$fn$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;
  c_tail := replace(replace(c_tail, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_new  := replace(replace(c_new,  chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('0045: SECURITY DEFINER, not plain' in v_tpl) > 0 then
    raise notice '0045: template already carries the definer price-history trigger — skipping amendment.';
  else
    v_at := position(c_head in v_tpl);
    if v_at = 0 then
      raise exception '0045: record_vehicle_price_history() not found in the template.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, c_head, ''))) <> length(c_head) then
      raise exception '0045: the template does not carry exactly one record_vehicle_price_history().';
    end if;

    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_tail in v_rest);
    if v_len = 0 then
      raise exception '0045: record_vehicle_price_history() has no plpgsql tail. Template drifted from 0036.';
    end if;
    v_len := v_len + length(c_tail) - 1;

    v_tpl := substr(v_tpl, 1, v_at - 1) || c_new || substr(v_tpl, v_at + v_len);

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0045$ select %L::text $felix_0045$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0045: template amended — price-history trigger is now SECURITY DEFINER.';
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- format() with %1$I for the search_path, NOT the template's
-- {{SCHEMA}} placeholder — this is executed directly, not spliced into
-- template text. The body itself carries no %-formatting, so nothing
-- needs re-escaping.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicle_price_history', r.schema_name)) is null then
      raise notice '0045: %.vehicle_price_history missing — skipping (0036 not applied here).', r.schema_name;
      continue;
    end if;

    execute format($ddl$
      create or replace function %1$I.record_vehicle_price_history() returns trigger as $trg$
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
      $trg$ language plpgsql security definer set search_path = %1$I, extensions;
    $ddl$, r.schema_name);

    -- Postgres grants EXECUTE on a (re)created function to PUBLIC by
    -- default. A trigger function needs no EXECUTE grant to fire, and a
    -- SECURITY DEFINER one that anybody may call directly is exactly the
    -- thing not to leave lying around.
    execute format(
      'revoke all on function %I.record_vehicle_price_history() from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0045: % repaired.', r.schema_name;
  end loop;

  raise notice '0045: % tenant schema(s) can record a price change again.', v_count;
end
$mig$;

-- ============================================================
-- 4. RAISE ASSERTION (f) 21 -> 22
--
-- 0037's technique verbatim: patch create_tenant_schema()'s OWN live
-- source rather than a hand-retyped copy.
-- ============================================================
do $mig$
declare
  v_ddl text;
  v_n   int;
begin
  select p.prosrc into v_ddl
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_ddl is null then
    raise exception '0045: platform.create_tenant_schema() not found.';
  end if;

  if position('expected 22 SECURITY DEFINER functions' in v_ddl) > 0 then
    raise notice '0045: create_tenant_schema() already asserts 22 — skipping.';
  else
    v_n := length(v_ddl) - length(replace(v_ddl, 'expected 21 SECURITY DEFINER functions', ''));
    if v_n <> length('expected 21 SECURITY DEFINER functions') then
      raise exception
        '0045: expected exactly one "expected 21 SECURITY DEFINER functions" in create_tenant_schema(). Function drifted from 0037.';
    end if;

    v_ddl := replace(v_ddl, 'expected 21 SECURITY DEFINER functions', 'expected 22 SECURITY DEFINER functions');
    v_ddl := replace(v_ddl, 'if n <> 21 then', 'if n <> 22 then');

    execute format(
      'create or replace function platform.create_tenant_schema(p_slug text) returns text '
      'language plpgsql security definer set search_path = pg_catalog, platform as %L',
      v_ddl
    );
    raise notice '0045: platform.create_tenant_schema() now asserts 22 SECURITY DEFINER functions.';
  end if;
end
$mig$;

-- ============================================================
-- 5. SELF-VERIFY
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_n    int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicle_price_history', r.schema_name)) is null then
      continue;
    end if;

    -- The function is now a definer AND has its search_path pinned.
    -- A definer without proconfig would be a worse bug than the one
    -- being fixed, so this is a hard failure, not a notice.
    if not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'record_vehicle_price_history' and p.prosecdef
    ) then
      v_bad := v_bad || (r.schema_name || ' (price-history trigger is not SECURITY DEFINER)');
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'record_vehicle_price_history'
         and p.proconfig is not null
         and array_to_string(p.proconfig, ',') like '%search_path=%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (definer trigger has NO pinned search_path — injection risk)');
    end if;

    -- PUBLIC must not be able to call a definer directly.
    if has_function_privilege('public', format('%I.record_vehicle_price_history()', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (PUBLIC can execute the definer trigger fn)');
    end if;

    -- The trigger is still attached, or nothing records anything.
    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicles'
         and t.tgname = 'trg_vehicle_price_history' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (trg_vehicle_price_history missing)');
    end if;

    -- Assertion (f)'s new number must match reality in every schema.
    select count(*) into v_n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if v_n <> 22 then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, expected 22)', r.schema_name, v_n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0045 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('expected 22 SECURITY DEFINER functions' in
      (select prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'platform' and p.proname = 'create_tenant_schema')) = 0 then
    raise exception '0045 VERIFY FAILED: create_tenant_schema() does not assert 22.';
  end if;

  if position('0045: SECURITY DEFINER, not plain' in platform.tenant_ddl_template()) = 0 then
    raise exception '0045 VERIFY FAILED: the template does not carry the definer price-history trigger.';
  end if;

  raise notice '0045: verified — a price change records its history as the real actor, and "Set prices" works again.';
end
$$;

notify pgrst, 'reload schema';

commit;
