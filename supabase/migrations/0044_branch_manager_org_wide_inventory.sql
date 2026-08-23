-- ============================================================
-- 0044 — BRANCH MANAGERS SEE THE WHOLE GROUP'S FLOOR
--
-- 0029 gave marketing an org-wide vehicles_select arm. 0043 gave
-- sales_exec the same. 0003/0009 had already given the CEO and the
-- accountant theirs. That left the BRANCH MANAGER as the only staff
-- role in the whole ladder still pinned to a single arm —
-- `branch_id = current_branch_id()` — which is exactly backwards: a
-- manager is the person who decides whether to request a car from a
-- sibling branch, and 0035 built the stock-transfer machinery for them
-- to do it with. They could not see the car they were meant to request.
--
-- Observed, not theorised: on the flagship tenant the Airport Road
-- manager's Inventory page showed 2 vehicles (their own branch's single
-- sold car, plus one Downtown car visible only through 0035's
-- open-transfer arm) while Downtown held 8 more in stock that they had
-- no way to see or search.
--
-- WHAT THIS CHANGES
-- -----------------
--   vehicles_select                one added arm:
--                                  current_role_name() = 'branch_manager'
--   vehicle_price_history_select   widened to the same audience, so a
--                                  manager opening a sibling branch's
--                                  car does not read "No price changes
--                                  recorded yet" about a car that has
--                                  had several. See below.
--
-- READ ONLY. NOTHING HERE TOUCHES A WRITE PATH.
-- ----------------------------------------------
-- vehicles_insert, vehicles_update and vehicles_delete are separate
-- policies and are NOT in this file. A manager still intakes, re-prices,
-- transfers and sells only at their own branch (plus any branch_grants
-- the CEO has issued them — 0030/0037). The branch boundary that stops
-- one manager settling another branch's deal is untouched; this
-- migration only lets them LOOK. Moving a car between branches remains
-- the 0035 transfer request, which is the auditable path that exists
-- precisely so this does not become an edit.
--
-- WHY THIS IS SAFE — COST STILL NEVER LEAVES THE APP
-- ---------------------------------------------------
-- 0043's header argues this in full and every word of it applies here.
-- In short: RLS is ROW-level and cannot hide a column, so the fence
-- around purchase_price / expenses / equity is canSeeCost() in
-- src/lib/auth.ts, whose COST_ROLES is (ceo, accountant, investor) —
-- branch_manager is NOT in it and is not being added. A branch manager
-- cannot see the cost of a car in their OWN branch today and will not be
-- able to on a sibling branch's car after this. inventory/page.tsx does
-- not merely hide purchase_price for such a viewer, it overwrites it
-- with 0 before the row is serialised to the browser.
--
-- Same reasoning covers the detail page: vehicle_expenses_select still
-- uses can_read_branch(), so a manager reads no expense rows for a
-- sibling branch's car — and would render none anyway, because the
-- whole expenses panel is behind the same canSeeCost() gate.
--
-- WHY PRICE HISTORY MOVES WITH IT
-- --------------------------------
-- vehicle_price_history holds asking_price and min_price only — the
-- sales-floor numbers, NOT cost. 0036's own header is explicit that
-- neither is gated behind canSeeCost, because the vehicle page already
-- shows both to exactly this audience. Left un-widened, the card on a
-- sibling branch's car would state "No price changes recorded yet" —
-- not an empty read but a FALSE one, which is worse than the gap it
-- would be papering over. Widened to `is_staff() or marketing`, the
-- audience for a car's price history becomes the audience for the car.
-- can_read_branch(branch_id) is kept as the leading arm so branch grants
-- keep working unchanged for the roles that rely on them.
--
-- WHAT IS DELIBERATELY NOT WIDENED
-- ---------------------------------
--   * can_read_branch() ITSELF. 0009:905-909 records the original intent
--     that a read widening "e.g. letting managers see sibling branches'
--     stock" should be one change to that function. That advice is now
--     stale and following it would be a mistake: since it was written,
--     0033 hung the entire receivables book (installment_plans,
--     installment_lines, cheques, receipts) off can_read_branch(), plus
--     0034's eta_submissions and 0038's attendance_events. Widening the
--     function would hand every branch manager every other branch's
--     cheques, instalments and staff attendance punches — none of which
--     was asked for. Worse, it would NOT even fix the reported problem,
--     because vehicles_select's branch arm is a bare
--     `branch_id = current_branch_id()` and never called the function at
--     all. Two named policies is the honest change; 0029 and 0043 both
--     set that precedent for this exact table.
--   * leads, deal_tickets, contracts, financing_requests. A manager is
--     still branch-scoped on all of these. Customer and pipeline data is
--     a different privacy question from "what stock does the group
--     hold", and merging the two into one migration would smuggle the
--     larger decision in behind the smaller one.
--
-- WHY NO TENANT CAN SEE ANOTHER TENANT'S CARS
-- ----------------------------------------------
-- Unchanged and unchangeable by this file: per-tenant schemas
-- (0008/0011). A policy defined in t_acme.vehicles is only ever
-- evaluated against t_acme rows; there is no cross-schema path a USING
-- clause could open. §3 applies the change independently inside each
-- schema and §4 re-verifies every expression stayed bound to its own,
-- exactly as 0035 §4 and 0043 §4 do.
--
-- STRUCTURE mirrors 0043: template + live-schema loop, anchored and
-- verified. Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0044 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  -- 0043's arm is this file's anchor, and confirms the template's
  -- vehicles_select is the shape §2 expects.
  if position('or current_role_name() = ''sales_exec''' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0044 PRECONDITION FAILED: the template has no sales_exec arm. Apply 0043 first.';
  end if;

  if position('create policy "vehicle_price_history_select" on vehicle_price_history for select' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0044 PRECONDITION FAILED: the template has no vehicle_price_history_select. Apply 0036 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- 2a is a SINGLE-LINE anchor on purpose. 0043 used a twenty-line span
-- covering the whole policy; that works exactly once and then any later
-- migration has to reproduce the previous one's comment block byte for
-- byte to match. Anchoring on the one line that is unique in the whole
-- template (verified: exactly one occurrence) and appending after it is
-- the same result with nothing to drift.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  c_sel_from text := $a1$    or current_role_name() = 'sales_exec'$a1$;
  c_sel_to   text := $a2$    or current_role_name() = 'sales_exec'
    -- 0044: and the branch manager, the last staff role that could not
    -- see a sibling branch's stock — and the one who decides whether to
    -- request it (0035). Read only: vehicles_insert/update/delete are
    -- untouched and still pin them to their own branch.
    or current_role_name() = 'branch_manager'$a2$;

  c_vph_from text := $b1$create policy "vehicle_price_history_select" on vehicle_price_history for select
  using (can_read_branch(branch_id));$b1$;
  c_vph_to   text := $b2$create policy "vehicle_price_history_select" on vehicle_price_history for select
  -- 0044: the audience for a car's price history is the audience for the
  -- car. asking_price/min_price are the sales-floor numbers, never cost
  -- (0036's header says so), and an un-widened policy would tell a
  -- manager "no price changes recorded" about a sibling branch's car
  -- that has had several — a false read, not an absent one.
  -- can_read_branch() stays the leading arm so branch grants still work.
  using (
    can_read_branch(branch_id)
    or is_staff()
    or current_role_name() = 'marketing'
  );$b2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;
  c_sel_from := replace(replace(c_sel_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_sel_to   := replace(replace(c_sel_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_vph_from := replace(replace(c_vph_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_vph_to   := replace(replace(c_vph_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('or current_role_name() = ''branch_manager''' in v_tpl) > 0 then
    raise notice '0044: template already carries the branch_manager arm — skipping amendment.';
  else
    -- The anchor must be unique, or `replace` would fire on a second
    -- copy nobody knew about and duplicate the arm.
    if (length(v_tpl) - length(replace(v_tpl, c_sel_from, ''))) <> length(c_sel_from) then
      raise exception '0044: the template does not carry exactly one sales_exec arm.';
    end if;

    v_tpl := replace(v_tpl, c_sel_from, c_sel_to);
    if position(c_sel_to in v_tpl) = 0 then
      raise exception '0044: template anchor 2a (vehicles_select) did not match. Template drifted from 0043.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_vph_from, c_vph_to);
    if position(c_vph_to in v_tpl) = 0 then
      raise exception '0044: template anchor 2b (vehicle_price_history_select) did not match. Template drifted from 0036.';
    end if;
    v_done := v_done + 1;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0044$ select %L::text $felix_0044$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0044: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path (0043 §3's shape):
-- is_ceo(), current_role_name(), can_read_branch() and the rest resolve
-- and bind to each showroom's own copy. Drop-and-recreate rather than a
-- text-anchored replace — there is no stored text to anchor against
-- inside a live schema, and recreating a policy is safe to repeat.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0044: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
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
        or current_role_name() = 'branch_manager'
        or branch_id = current_branch_id()
        or holds_equity_in_vehicle(vehicles.id)
        or exists (
          select 1 from stock_transfers st
           where st.vehicle_id = vehicles.id
             and st.status = 'requested'
             and can_read_branch(st.to_branch_id)
        )
      );

    -- 0036 shipped this table; a tenant provisioned before it, or one
    -- that skipped the migration, simply has nothing to widen here.
    if to_regclass(format('%I.vehicle_price_history', r.schema_name)) is not null then
      drop policy if exists "vehicle_price_history_select" on vehicle_price_history;
      create policy "vehicle_price_history_select" on vehicle_price_history for select
        using (
          can_read_branch(branch_id)
          or is_staff()
          or current_role_name() = 'marketing'
        );
    end if;

    v_count := v_count + 1;
    raise notice '0044: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0044: % tenant schema(s) widened for branch managers.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- The arms landed, stayed bound to their own schema, and NO privilege
-- moved: this migration adds no grant, only rows the existing SELECT
-- privilege now applies to. The negative assertions matter as much as
-- the positive ones — §4 fails if a write policy was widened by
-- accident.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_qual text;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    -- ── vehicles_select gained the arm ──────────────────────
    select coalesce(pg_get_expr(p.polqual, p.polrelid), '') into v_qual
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicles' and p.polname = 'vehicles_select';

    if v_qual = '' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select missing)');
      continue;
    end if;
    if v_qual !~ 'branch_manager' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select not widened for branch_manager)');
    end if;
    -- 0043's arm must have survived this file's replacement of the whole
    -- policy — dropping it would silently re-break sales.
    if v_qual !~ 'sales_exec' then
      v_bad := v_bad || (r.schema_name || ' (0043 sales_exec arm lost!)');
    end if;
    if v_qual ~ ('\mt_' || '[a-z0-9_]+\.') and v_qual !~ ('\m' || r.schema_name || '\M') then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select bound to another schema)');
    end if;

    -- ── THE WRITE PATHS MUST NOT HAVE MOVED ─────────────────
    -- This migration is read-only by intent. If a manager can now UPDATE
    -- or INSERT a vehicle outside their branch, something widened that
    -- should not have, and that is a far worse outcome than the problem
    -- being fixed. Assert the branch pin is still literally there.
    select coalesce(pg_get_expr(p.polqual, p.polrelid), '') into v_qual
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicles' and p.polname = 'vehicles_update';
    if v_qual !~ 'current_branch_id' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_update lost its branch pin!)');
    end if;
    if v_qual ~ 'branch_manager' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_update was widened by role name!)');
    end if;

    select coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') into v_qual
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicles' and p.polname = 'vehicles_insert';
    if v_qual !~ 'current_branch_id' then
      v_bad := v_bad || (r.schema_name || ' (vehicles_insert lost its branch pin!)');
    end if;

    -- ── price history widened, where the table exists ───────
    if to_regclass(format('%I.vehicle_price_history', r.schema_name)) is not null then
      select coalesce(pg_get_expr(p.polqual, p.polrelid), '') into v_qual
        from pg_policy p
        join pg_class c      on c.oid = p.polrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicle_price_history'
         and p.polname = 'vehicle_price_history_select';
      if v_qual !~ 'is_staff' then
        v_bad := v_bad || (r.schema_name || ' (price history not widened)');
      end if;
      if v_qual ~ ('\mt_' || '[a-z0-9_]+\.') and v_qual !~ ('\m' || r.schema_name || '\M') then
        v_bad := v_bad || (r.schema_name || ' (price history bound to another schema)');
      end if;
    end if;

    -- ── no privilege moved ──────────────────────────────────
    if not has_table_privilege(r.role_name, format('%I.vehicles', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (role lost select on vehicles)');
    end if;
    if has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'purchase_price', 'update')
       or has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'status', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can update guarded vehicles columns!)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0044 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('or current_role_name() = ''branch_manager''' in platform.tenant_ddl_template()) = 0
     or position('or is_staff()' in platform.tenant_ddl_template()) = 0 then
    raise exception '0044 VERIFY FAILED: the template does not carry the branch_manager widening.';
  end if;

  raise notice '0044: verified — branch managers read every branch''s vehicles and price history within their own showroom only; every write path still pinned to their own branch.';
end
$$;

notify pgrst, 'reload schema';

commit;
