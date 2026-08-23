-- ============================================================
-- 0043 — SALES SEES THE WHOLE FLOOR, NOT JUST THEIR OWN BRANCH
--
-- Until now vehicles_select gave a sales_exec exactly one arm:
-- `branch_id = current_branch_id()`. A salesperson could not see a car
-- sitting at another branch at all — not even the sticker price — which
-- meant they could not tell a buyer "we don't have that trim here, but
-- Airport Road does." This migration adds a sales_exec arm alongside
-- marketing's (0029) and the accountant's: org-wide SELECT.
--
-- WHY THIS IS SAFE — COST STILL NEVER LEAVES THE APP
-- ---------------------------------------------------
-- RLS is ROW-level. It answers "may this session see this vehicles row
-- at all", never "which columns of it". purchase_price has been
-- readable-by-grant to every tenant role since 0009 (`grant select on
-- vehicles to {{role}}`, whole table, no column list) for every role
-- that already has ANY vehicles_select arm — marketing has held this
-- exact shape since 0029 and nothing has ever leaked through it. The
-- fence around purchase_price/expenses/equity is canSeeCost() in
-- src/lib/auth.ts (COST_ROLES = ceo, accountant, investor — see that
-- file's own migration-0028 history), enforced entirely in the Next.js
-- server components that read these rows and decide what to render or
-- redact before anything reaches a browser. Widening the ROW predicate
-- here changes nothing about that fence; a sales_exec still cannot see
-- purchase_price on a car in THEIR OWN branch today, and will not be
-- able to on any other branch's car after this migration either.
--
-- WHY THIS IS SAFE — NO TENANT CAN SEE ANOTHER TENANT'S CARS
-- -------------------------------------------------------------
-- This is a per-tenant-schema install (0008/0011): every showroom's
-- `vehicles` table lives in its own t_<slug> schema, and a policy
-- defined inside t_acme.vehicles can only ever be evaluated against
-- t_acme's own rows — there is no cross-schema query path a widened
-- USING clause could open. §3 below applies the SAME change
-- independently inside every existing tenant schema (never a shared
-- table), and §4 re-checks that every policy expression stays bound to
-- its own schema, exactly as 0035 §4 already does for this same table.
-- Widening "which branches can a sales_exec read WITHIN their own
-- showroom" cannot, by construction, touch a different showroom's data.
--
-- STRUCTURE mirrors 0029/0035: template + live-schema loop, anchored
-- and verified substitutions. Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0043 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('select 1 from stock_transfers st' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0043 PRECONDITION FAILED: the template''s vehicles_select has no stock_transfers arm. Apply 0035 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  c_sel_from text := $a1$drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    -- 0029: marketing lists the whole showroom's stock across channels,
    -- so their read is org-wide like the accountant's.
    or current_role_name() = 'marketing'
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
    -- 0035: the receiving branch may see a car mid-transfer, before it
    -- physically arrives — otherwise the Accept button has no page to
    -- live on. can_read_branch() rather than a bare comparison so an
    -- accountant, the CEO and an area manager's grant all reach it the
    -- same way they reach everything else. Cannot leak cost or equity:
    -- those gate through vehicle_branch(), untouched by this file, not
    -- through this policy.
    or exists (
      select 1 from stock_transfers st
       where st.vehicle_id = vehicles.id
         and st.status = 'requested'
         and can_read_branch(st.to_branch_id)
    )
  );$a1$;
  c_sel_to   text := $a2$drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    -- 0029: marketing lists the whole showroom's stock across channels,
    -- so their read is org-wide like the accountant's.
    or current_role_name() = 'marketing'
    -- 0043: sales sees every branch's floor, not just their own — cost
    -- stays hidden regardless; see the file header. Row-level only.
    or current_role_name() = 'sales_exec'
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
    or exists (
      select 1 from stock_transfers st
       where st.vehicle_id = vehicles.id
         and st.status = 'requested'
         and can_read_branch(st.to_branch_id)
    )
  );$a2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;
  c_sel_from := replace(replace(c_sel_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_sel_to   := replace(replace(c_sel_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('or current_role_name() = ''sales_exec''' in v_tpl) > 0 then
    raise notice '0043: template already carries the sales_exec arm — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_sel_from, c_sel_to);
    if position(c_sel_to in v_tpl) = 0 then
      raise exception '0043: template anchor 2a (vehicles_select) did not match. Template drifted from 0035.';
    end if;
    v_done := v_done + 1;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0043$ select %L::text $felix_0043$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0043: template amended (% substitution).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path (0030/0033/0035-style):
-- can_read_branch(), is_ceo(), current_role_name() and the rest resolve
-- and bind to each showroom's own copy. A plain re-create, not a
-- text-anchored replace, because there is nothing stored to anchor
-- against inside a live schema — the policy is simply dropped and
-- recreated with the one added arm, which is safe to repeat.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0043: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    drop policy if exists "vehicles_select" on vehicles;
    create policy "vehicles_select" on vehicles for select
      using (
        is_ceo()
        or is_accountant_or_above()
        or current_role_name() = 'marketing'
        or current_role_name() = 'sales_exec'
        or branch_id = current_branch_id()
        or holds_equity_in_vehicle(vehicles.id)
        or exists (
          select 1 from stock_transfers st
           where st.vehicle_id = vehicles.id
             and st.status = 'requested'
             and can_read_branch(st.to_branch_id)
        )
      );

    v_count := v_count + 1;
    raise notice '0043: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0043: % tenant schema(s) widened.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — the arm landed, stayed bound to its own schema, and
-- nothing about the grant (still whole-row SELECT, unchanged since
-- 0009) moved. This migration adds no new privilege, only a new row
-- the existing SELECT privilege now applies to.
-- ============================================================
do $$
declare
  r     record;
  v_bad text[] := '{}';
  v_qual text;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    select coalesce(pg_get_expr(p.polqual, p.polrelid), '') into v_qual
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicles' and p.polname = 'vehicles_select';

    if v_qual = '' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select missing)');
      continue;
    end if;

    if v_qual !~ 'sales_exec' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select was not widened for sales_exec)');
    end if;

    -- The silent-disaster check 0035 §4 already runs for this table: a
    -- policy expression referencing an UNQUALIFIED helper is fine only
    -- because it resolves via search_path at evaluation time, but a
    -- policy that ended up schema-QUALIFIED to a DIFFERENT tenant's
    -- schema would mean this loop's set_config leaked across
    -- iterations. It has not: pg_get_expr only qualifies names not on
    -- the CURRENT session's search_path, which §3 cleared before this
    -- block ran.
    if v_qual ~ ('\mt_' || '[a-z0-9_]+\.') and v_qual !~ ('\m' || r.schema_name || '\M') then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select bound to another schema)');
    end if;

    if not has_table_privilege(r.role_name, format('%I.vehicles', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (role lost select on vehicles)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0043 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('or current_role_name() = ''sales_exec''' in platform.tenant_ddl_template()) = 0 then
    raise exception '0043 VERIFY FAILED: the template does not carry the sales_exec arm.';
  end if;

  raise notice '0043: verified — sales_exec reads every branch''s vehicles row, in its own tenant schema only; no grant changed.';
end
$$;

notify pgrst, 'reload schema';

commit;
