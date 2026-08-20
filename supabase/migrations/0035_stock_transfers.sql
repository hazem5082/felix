-- ============================================================
-- 0035 — BRANCH-TO-BRANCH STOCK TRANSFERS
--
-- Stock moves between branches constantly — Nasr City sends a car to
-- Sheikh Zayed because that is where its buyer is. Until this file that
-- move was a raw edit to `vehicles.branch_id`, silently rewriting which
-- branch carries the car's overhead, whose manager may approve its
-- sale, and where the sale is counted. Nothing in the app even issued
-- that edit — 0009's `vehicles_update` policy pins branch_id to the
-- actor's own branch in practice, so the column was frozen rather than
-- writable. This migration makes the movement a first-class, audited
-- request instead of an edit nobody could make.
--
-- WHAT THIS ADDS
-- --------------
--   stock_transfers   one row per request. requested -> accepted, or
--                     requested -> cancelled. The row IS the record —
--                     see "no DELETE" below.
--   Two new trigger functions on stock_transfers (eligibility at
--   INSERT, the status/column guard on every write), one new trigger
--   function on VEHICLES (the only place branch_id is allowed to
--   actually move), and a narrow widening of `vehicles_select` and
--   `vehicles_update` to let that one write happen at all.
--
-- WHY THE POLICY WIDENING IS SAFE: THE GRANT, NOT JUST THE POLICY
-- -----------------------------------------------------------------
-- The receiving branch manager is not the branch that owns the vehicle
-- row today, so `vehicles_update`'s existing arm — is_ceo() or
-- (is_manager_or_above() and branch_id = current_branch_id()) — never
-- admits them. The new arm does: an open 'requested' transfer whose
-- to_branch_id they can act on. Read on its own that arm looks
-- dangerous — RLS admits the WHOLE ROW UPDATE, not just one column —
-- and 0009 §6g already anticipated exactly this shape of danger for
-- vehicles generally: "Every write to a vehicle goes through
-- create_vehicle_with_equity_splits() or execute_vehicle_sale() ...
-- A direct UPDATE privilege would let a crafted PATCH set status='sold'
-- with no ledger row behind it," which is why the tenant role's grant
-- on vehicles was SELECT ONLY, full stop, before this file.
--
-- §6g below grants `update (branch_id)` on vehicles — one column, and
-- only that one. This is the SAME idiom 0024 used for the ETA fields on
-- contracts and 0033 used for receipts.reference/note: a policy can
-- admit a whole-row UPDATE statement, but Postgres refuses to touch any
-- column the grant does not name, regardless of what the policy says.
-- So the widened policy's "whole row" reach is theatre — the grant is
-- the real fence, and it was there first. guard_stock_transfer_move()
-- below is a second, independent fence on top of it (comparing every
-- OTHER column between OLD and NEW), which is redundant given the
-- grant and kept anyway: a defence that lives only in a GRANT clause is
-- invisible to a reader of the trigger function, and the guard is what
-- also enforces WHICH branch_id values are legal, which no grant can
-- express.
--
-- THE CALL ORDER: VEHICLE MOVES FIRST, THEN THE TRANSFER IS ACCEPTED
-- --------------------------------------------------------------------
-- The natural-sounding order is "accept the transfer, then move the
-- car" — but the widened policy arm and the vehicles guard both key off
-- `stock_transfers.status = 'requested'`. Flip the transfer to
-- 'accepted' first, in ITS OWN separate call (no cross-call
-- transactions — same reasoning as 0033's repair-not-rollback), and the
-- SECOND call's arm evaluates against an already-'accepted' row and
-- finds nothing: the vehicle write is refused to the very person who
-- just accepted the transfer meant to authorise it.
--
-- So `transfer-actions.ts`'s acceptTransfer() does the reverse: it
-- writes vehicles.branch_id FIRST, while the transfer is still
-- 'requested' and the arm is live, and flips stock_transfers to
-- 'accepted' SECOND. This also makes the repair path exactly as simple
-- as the spec asks for it to be: if the second write (the accept)
-- fails, the transfer was never touched and is already, trivially,
-- still 'requested' — but should the caller need to explicitly UNDO the
-- vehicle move (the branch changed, the accept then failed for an
-- unrelated reason), guard_stock_transfer_status() permits exactly one
-- compensating transition, 'accepted' -> 'requested', and
-- guard_stock_transfer_move() authorises movement in EITHER direction
-- along the SAME open transfer — forward for the initial move, backward
-- for a repair — for as long as that transfer is still 'requested'.
-- Once it is 'accepted' (or 'cancelled'), neither branch_id value is
-- reachable through this mechanism again; by then the vehicle is
-- already sitting in the branch that owns it under the ORDINARY arm,
-- and the extra one is inert.
--
-- WHY vehicles_select IS ALSO WIDENED — NOT ASKED FOR, NEEDED ANYWAY
-- --------------------------------------------------------------------
-- The receiving branch manager has to be able to open
-- inventory/[vehicleId] to see the Accept button at all, and 0009's
-- `vehicles_select` does not admit them until the car is actually
-- theirs (branch_id = current_branch_id()) — a chicken-and-egg the spec
-- for this feature does not mention widening. Without it the page 404s
-- for exactly the one person the feature exists for. The new arm is the
-- read twin of the write one: an open transfer to a branch the caller
-- can READ (can_read_branch(), so the CEO/accountant/an area manager's
-- grant all reach it too) makes the vehicle visible. It cannot leak
-- cost or equity data: vehicle_expenses_select and equity_splits_select
-- gate through vehicle_branch(), a SECURITY DEFINER scalar lookup
-- untouched by this file, not through vehicles_select — so a receiving
-- manager sees the car and nothing about what it cost until it is
-- actually theirs.
--
-- THE GUARD TRIGGER, AND WHY A JSONB DIFF RATHER THAN A COLUMN LIST
-- --------------------------------------------------------------------
-- 0009's guard_vehicle_status() pins three named columns
-- (purchase_price, branch_id, vin) when a vehicle is sold. vehicles has
-- grown a column in nearly every migration since — 0014, 0015, 0021,
-- 0025, 0026, 0028, 0032 — and a hand-maintained "every OTHER column"
-- list here would silently stop being true the next time one of those
-- happens again. `to_jsonb(old) - 'branch_id' IS DISTINCT FROM
-- to_jsonb(new) - 'branch_id'` says the same thing without naming a
-- single one of them, and stays true automatically. This check is
-- belt-and-suspenders on top of §6g's column-limited grant (see above)
-- rather than the only thing standing between a branch move and an
-- open-season UPDATE.
--
-- CEO bypasses both checks in guard_stock_transfer_move() — matching
-- their authority BEFORE this file: is_ceo() already satisfied
-- vehicles_update unconditionally, and this migration does not narrow
-- that to "only via a transfer." What still bounds the CEO is §6g's
-- grant: even the CEO can only move branch_id through this mechanism,
-- one column, same as everyone else.
--
-- ELIGIBILITY, CHECKED ONCE, AT INSERT
-- -------------------------------------
-- A sold vehicle, or one with an active (submitted/approved) deal
-- ticket, cannot be transfer-requested — enforce_transfer_eligible(),
-- NOT SECURITY DEFINER, so the SELECT against vehicles and deal_tickets
-- runs under the requester's own RLS: a session that cannot see either
-- has no business requesting a move for it. Re-checked only at INSERT,
-- on the same reasoning 0033 gives for not re-validating a settled
-- installment plan on every later UPDATE — the moment that matters is
-- the moment the request is raised.
--
-- from_branch_id IS PINNED, NOT TRUSTED, to the vehicle's actual
-- current branch (the same move 0033 makes for
-- installment_plans.branch_id against its ticket), so a request can
-- never claim to originate somewhere the car is not.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * No SECURITY DEFINER function. All three new trigger functions are
--     plain plpgsql, so assertion (f) inside
--     platform.create_tenant_schema() stays at exactly twenty.
--   * No DELETE anywhere for the tenant role — assertion (j) proves a
--     tenant role holding delete on any relation aborts provisioning.
--     A transfer is cancelled by an UPDATE (status='cancelled'), never
--     removed; the row is the record of who asked, who decided, and
--     when, and that must survive the decision.
--   * stock_transfers is not added to the c_tables array inside
--     platform.create_tenant_schema(), for the reason 0016/0030/0033/
--     0034 all give: a failed CREATE TABLE aborts the whole template
--     execute, and §4 below verifies the table across every live schema
--     directly.
--   * No CEO/branch-wide dashboard for transfers. The only surface this
--     pass ships is the vehicle detail page's panel — a concurrent
--     agent is editing the inventory list and vehicle form files, and a
--     second surface is a follow-up, not a collision to invite here.
--
-- ANCHOR CHOICE. Table after 0034's eta_submissions tail (SECTION 1's
-- current end). Functions after 0009's own guard_vehicle_status() —
-- untouched since 0009, and the natural neighbour for a new vehicles
-- guard. Policies: the vehicles_select/insert/update/delete block,
-- unchanged since 0009, is replaced whole; stock_transfers' own three
-- policies are appended after 0034's eta_submissions_update. Triggers
-- after 0009's trg_guard_vehicle_status attachment. Grants: the
-- vehicles column grant after 0009's `grant select on vehicles`;
-- stock_transfers' own grants after 0034's eta_submissions grant tail.
-- Nothing here touches vehicle-form.tsx, inventory-browser.tsx or
-- pricing-form.tsx, and nothing here touches the vehicles/deal_tickets
-- CREATE TABLE bodies a concurrent migration may be working against.
--
-- GATE. Functionally on 0032 (vehicles.acquisition_type, which the
-- transfer panel displays) as instructed — deliberately NOT on 0033 or
-- 0034 as the "migration immediately before" the way 0033/0034 gate on
-- their own predecessors, on the same reasoning 0033's header gives for
-- not gating on the-then-parallel 0032: a database with 0032 applied
-- must be able to apply this file regardless of what else has landed
-- since. The TABLE anchor's own drift-check is a second, independent
-- gate on 0034 specifically, with its own readable message, precisely
-- because that anchor really does require 0034's exact text to match.
--
-- LINE ENDINGS. Anchors authored LF; the stored template's convention
-- is read and matched, exactly as 0030/0031/0033/0034 §2 do.
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
      '0035 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0035 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The two branch predicates every policy below is built out of.
  if position('create or replace function can_read_branch(p_branch_id uuid)' in platform.tenant_ddl_template()) = 0
     or position('create or replace function can_act_on_branch(p_branch_id uuid)' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0035 PRECONDITION FAILED: the template has no can_read_branch/can_act_on_branch. Apply 0009 first.';
  end if;

  -- guard_vehicle_status() is where §2's new functions are anchored.
  if position('create or replace function guard_vehicle_status() returns trigger as $trg$' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0035 PRECONDITION FAILED: the template has no guard_vehicle_status(). Apply 0009 first.';
  end if;

  -- This feature's own functional dependency (the transfer panel reads
  -- acquisition_type for display), and the batch-ordering gate — see
  -- the file header for why it is 0032 and not "the migration
  -- immediately before this one."
  if position('acquisition_type text        not null default ''purchase'',' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0035 PRECONDITION FAILED: the template has no vehicles.acquisition_type. Apply 0032 first.';
  end if;

  -- What §2a's TABLE anchor is spliced onto the tail of. A separate,
  -- readable failure here rather than a generic "anchor did not match"
  -- three lines into §2.
  if position('create unique index if not exists uniq_eta_submission_live' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0035 PRECONDITION FAILED: the template has no eta_submissions. Apply 0034 first.';
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

  -- None of these is `constant`: every one is rewritten into the
  -- template's own line-ending convention before it is used.

  -- 2a. THE TABLE, after 0034's eta_submissions tail.
  c_tbl_from text := $t1$create unique index if not exists uniq_eta_submission_live
  on eta_submissions(contract_id)
  where status in ('queued','submitted','accepted');$t1$;
  c_tbl_to   text := $t2$create unique index if not exists uniq_eta_submission_live
  on eta_submissions(contract_id)
  where status in ('queued','submitted','accepted');

-- ------------------------------------------------------------
-- 13. STOCK TRANSFERS  (0035)
--
-- One row per request to move a car from one branch to another. See the
-- file header for why the move itself rides a narrow, column-limited
-- widening of vehicles_update rather than a SECURITY DEFINER RPC.
--
-- status              'requested' is the only insertable value —
--                     enforced by guard_stock_transfer_status(), not a
--                     CHECK, because the same function also confines
--                     every later transition.
-- requested_by        pinned to auth.uid() by stock_transfers_insert.
-- decided_by/decided_at
--                     stamped by guard_stock_transfer_status() the
--                     moment status leaves 'requested', never trusted
--                     from the client — same idiom as
--                     guard_cheque_status()'s status_changed_at (0033).
-- The CHECK below is the two branches actually differing; the partial
-- unique index is "at most one open request per vehicle", so a second
-- manager cannot request the same car to a different branch while the
-- first request is still live.
-- ------------------------------------------------------------
create table if not exists stock_transfers (
  id             uuid        primary key default gen_random_uuid(),
  vehicle_id     uuid        not null references vehicles(id),
  from_branch_id uuid        not null references branches(id),
  to_branch_id   uuid        not null references branches(id),
  status         text        not null default 'requested'
                             check (status in ('requested','accepted','cancelled')),
  requested_by   uuid        references profiles(id),
  decided_by     uuid        references profiles(id),
  note           text,
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  constraint stock_transfers_branches_differ check (from_branch_id <> to_branch_id)
);

create index if not exists idx_stock_transfers_vehicle    on stock_transfers(vehicle_id);
create index if not exists idx_stock_transfers_to_status  on stock_transfers(to_branch_id, status);

-- One non-cancelled, undecided transfer per vehicle.
create unique index if not exists uniq_stock_transfer_open_per_vehicle
  on stock_transfers(vehicle_id) where status = 'requested';$t2$;

  -- 2b. THE THREE NEW FUNCTIONS, immediately after 0009's own
  --     guard_vehicle_status() — untouched since 0009, and the natural
  --     neighbour for a second vehicles guard. All three are plain
  --     plpgsql (assertion (f) stays at twenty) and pin
  --     search_path = {{SCHEMA}}, extensions (assertion (e)).
  c_fn_from text := $t3$-- ============================================================
-- 4.4 EXPENSES
-- ============================================================$t3$;
  c_fn_to   text := $t4$-- ============================================================
-- 3-bis. STOCK TRANSFERS  (0035)
-- ============================================================

-- WHAT MAY BE TRANSFER-REQUESTED, enforced where it cannot be argued
-- with. NOT SECURITY DEFINER, so both SELECTs below run under the
-- requester's own RLS — the same reasoning 0033's
-- enforce_in_house_installment_plan() gives: a session that cannot see
-- the vehicle, or the deal ticket that would block it, has no standing
-- to request a move for either.
--
-- from_branch_id is pinned to the vehicle's OWN current branch rather
-- than trusted from the client, the same move 0033 makes for
-- installment_plans.branch_id against its ticket.
create or replace function enforce_transfer_eligible() returns trigger as $trg$
declare
  v_branch uuid;
  v_status text;
begin
  select branch_id, status into v_branch, v_status
    from vehicles
   where id = new.vehicle_id;

  if not found then
    raise exception 'That vehicle does not exist, or you cannot see it';
  end if;

  if v_status = 'sold' then
    raise exception 'A sold vehicle cannot be transferred';
  end if;

  if new.from_branch_id is distinct from v_branch then
    raise exception 'A transfer must start from the vehicle''s current branch';
  end if;

  if exists (
    select 1 from deal_tickets dt
     where dt.vehicle_id = new.vehicle_id
       and dt.status in ('submitted','approved')
  ) then
    raise exception 'This vehicle has an active deal ticket and cannot be transferred';
  end if;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- THE TRANSFER'S LIFE, and what it may never do.
--
--   requested -> accepted    the receiving branch takes the car.
--   requested -> cancelled   the sending branch, or the CEO, stands down.
--   accepted  -> requested   COMPENSATING ONLY. transfer-actions.ts
--                            moves the vehicle FIRST, while this row is
--                            still 'requested' (see the file header for
--                            why), and flips it to 'accepted' SECOND.
--                            If that second write fails, the action may
--                            revert the vehicle; this is what keeps this
--                            row's own state reachable for that repair.
--                            No screen ever requeues an accepted
--                            transfer on purpose.
--
-- decided_by/decided_at are stamped here, never trusted from the
-- client — guard_cheque_status()'s status_changed_at is the same idiom.
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
    new.decided_by := auth.uid();
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

-- THE OTHER HALF OF THE MOVE, on VEHICLES rather than stock_transfers.
-- See the file header for the full argument; in short, §6g's
-- column-limited grant is the real fence and this is the second one:
-- a branch move must be the ONLY change in the statement (a jsonb diff
-- rather than a hand-maintained column list, because that list has
-- grown in nearly every migration this table has had), and the
-- destination must match an OPEN transfer between exactly these two
-- branches, in EITHER direction — forward for the move, backward for
-- the one compensating repair guard_stock_transfer_status() allows.
--
-- CEO bypasses both checks, matching the CEO's authority BEFORE this
-- migration: is_ceo() already satisfied vehicles_update unconditionally
-- and this file does not narrow that to "only via a transfer." What
-- still bounds the CEO here is §6g's grant, not this function.
create or replace function guard_stock_transfer_move() returns trigger as $trg$
begin
  if new.branch_id is distinct from old.branch_id and not is_ceo() then
    if (to_jsonb(old) - 'branch_id') is distinct from (to_jsonb(new) - 'branch_id') then
      raise exception 'A branch move cannot be combined with any other change to the vehicle';
    end if;

    if not exists (
      select 1 from stock_transfers st
       where st.vehicle_id = new.id
         and st.status = 'requested'
         and (
              (st.from_branch_id = old.branch_id and st.to_branch_id = new.branch_id)
           or (st.from_branch_id = new.branch_id and st.to_branch_id = old.branch_id)
         )
    ) then
      raise exception 'A vehicle may only move between the two branches of an open transfer request';
    end if;
  end if;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.4 EXPENSES
-- ============================================================$t4$;

  -- 2c. VEHICLES POLICIES — whole-block replacement, in the shape 0030
  --     used for can_act_on_branch/can_read_branch. Unchanged since
  --     0009: vehicles_insert and vehicles_delete are carried through
  --     verbatim; only vehicles_select and vehicles_update gain an arm.
  c_pol_veh_from text := $t5$drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    -- 0029: marketing lists the whole showroom's stock across channels,
    -- so their read is org-wide like the accountant's.
    or current_role_name() = 'marketing'
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
  );

drop policy if exists "vehicles_insert" on vehicles;
create policy "vehicles_insert" on vehicles for insert
  with check (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));

drop policy if exists "vehicles_update" on vehicles;
create policy "vehicles_update" on vehicles for update
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));

drop policy if exists "vehicles_delete" on vehicles;
create policy "vehicles_delete" on vehicles for delete using (is_ceo());$t5$;
  c_pol_veh_to   text := $t6$drop policy if exists "vehicles_select" on vehicles;
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
  );

drop policy if exists "vehicles_insert" on vehicles;
create policy "vehicles_insert" on vehicles for insert
  with check (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));

drop policy if exists "vehicles_update" on vehicles;
create policy "vehicles_update" on vehicles for update
  using (
    is_ceo()
    or (is_manager_or_above() and branch_id = current_branch_id())
    -- 0035: the receiving branch may write the vehicle while an open
    -- transfer to their branch exists. §6g's grant is column-limited to
    -- branch_id alone and guard_stock_transfer_move() pins every other
    -- column and the destination — this arm's "whole row" reach on its
    -- own is not the real fence; see the file header.
    or exists (
      select 1 from stock_transfers st
       where st.vehicle_id = vehicles.id
         and st.status = 'requested'
         and can_act_on_branch(st.to_branch_id)
    )
  );

drop policy if exists "vehicles_delete" on vehicles;
create policy "vehicles_delete" on vehicles for delete using (is_ceo());$t6$;

  -- 2d. RLS ENABLE, after 0034's eta_submissions.
  c_rls_from text := $t7$alter table eta_submissions        enable row level security;$t7$;
  c_rls_to   text := $t8$alter table eta_submissions        enable row level security;
alter table stock_transfers        enable row level security;$t8$;

  -- 2e. STOCK TRANSFERS' OWN POLICIES, after 0034's eta_submissions_update.
  c_pol_st_from text := $t9$-- USING **and** WITH CHECK: the service walks one row through its
-- statuses, and without the WITH CHECK a visible row could be re-pointed
-- at a contract the caller was never able to insert against.
drop policy if exists "eta_submissions_update" on eta_submissions;
create policy "eta_submissions_update" on eta_submissions for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());$t9$;
  c_pol_st_to   text := $u1$-- USING **and** WITH CHECK: the service walks one row through its
-- statuses, and without the WITH CHECK a visible row could be re-pointed
-- at a contract the caller was never able to insert against.
drop policy if exists "eta_submissions_update" on eta_submissions;
create policy "eta_submissions_update" on eta_submissions for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());

-- ------------------------------------------------------------
-- 5u. STOCK TRANSFERS — 0035
--
-- SELECT admits either end — can_read_branch(from_branch_id) or
-- can_read_branch(to_branch_id)) — the same shape installment_plans and
-- every other branch-scoped child table use; the CEO and accountant
-- read everything through those two calls, and 0030's grants reach
-- both sides for an area manager. Neither arm names any table besides
-- branch_grants (through can_read_branch itself), so there is no
-- recursion back into vehicles — stock_transfers' own policies never
-- mention it.
--
-- INSERT is the sending branch's decision alone, with requested_by
-- pinned to auth.uid() — the same pin installment_plans.created_by and
-- receipts.received_by carry.
--
-- UPDATE admits either end's actor at the RLS layer, because both the
-- accept (receiving branch) and the cancel (sending branch, or the
-- CEO) are legitimate decisions that flip this row. Which actor may
-- reach which transition in practice is guard_stock_transfer_status()'s
-- job at the database layer and assertBranch()'s at the app layer — the
-- same split every other action in this codebase draws between "who
-- may write the row" (RLS) and "what the write may say" (a trigger, or
-- the action's own checks).
--
-- NO DELETE — see the file header.
-- ------------------------------------------------------------
drop policy if exists "stock_transfers_select" on stock_transfers;
create policy "stock_transfers_select" on stock_transfers for select
  using (can_read_branch(from_branch_id) or can_read_branch(to_branch_id));

drop policy if exists "stock_transfers_insert" on stock_transfers;
create policy "stock_transfers_insert" on stock_transfers for insert
  with check (can_act_on_branch(from_branch_id) and requested_by = auth.uid());

drop policy if exists "stock_transfers_update" on stock_transfers;
create policy "stock_transfers_update" on stock_transfers for update
  using (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id))
  with check (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id));$u1$;

  -- 2f. TRIGGER ATTACHMENTS, after 0009's own trg_guard_vehicle_status.
  c_trg_from text := $u2$drop trigger if exists trg_guard_vehicle_status on vehicles;
create trigger trg_guard_vehicle_status
  before update on vehicles
  for each row execute function guard_vehicle_status();$u2$;
  c_trg_to   text := $u3$drop trigger if exists trg_guard_vehicle_status on vehicles;
create trigger trg_guard_vehicle_status
  before update on vehicles
  for each row execute function guard_vehicle_status();

drop trigger if exists trg_guard_stock_transfer_move on vehicles;
create trigger trg_guard_stock_transfer_move
  before update on vehicles
  for each row execute function guard_stock_transfer_move();

-- ── stock_transfers ─────────────────────────────────────────
drop trigger if exists trg_transfer_eligible on stock_transfers;
create trigger trg_transfer_eligible
  before insert on stock_transfers
  for each row execute function enforce_transfer_eligible();

drop trigger if exists trg_guard_stock_transfer_status on stock_transfers;
create trigger trg_guard_stock_transfer_status
  before insert or update on stock_transfers
  for each row execute function guard_stock_transfer_status();

drop trigger if exists trg_audit_stock_transfers on stock_transfers;
create trigger trg_audit_stock_transfers
  after insert or update or delete on stock_transfers
  for each row execute function record_audit();$u3$;

  -- 2g. THE VEHICLES GRANT, after 0009's `grant select on vehicles`.
  --     See the file header for why this is one column and not the
  --     whole table.
  c_gnt_veh_from text := $u4$grant select on vehicles to {{ROLE}};$u4$;
  c_gnt_veh_to   text := $u5$grant select on vehicles to {{ROLE}};
-- 0035: the one column a branch move touches. See the file header —
-- this, not the widened policy, is the real fence around
-- guard_stock_transfer_move().
grant update (branch_id) on vehicles to {{ROLE}};$u5$;

  -- 2h. STOCK TRANSFERS' OWN GRANTS, after 0034's eta_submissions tail.
  c_gnt_st_from text := $u6$grant select, insert, update on eta_submissions to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on eta_submissions to service_role;$u6$;
  c_gnt_st_to   text := $u7$grant select, insert, update on eta_submissions to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on eta_submissions to service_role;

-- ── stock transfers (0035) ──────────────────────────────────
-- No DELETE — assertion (j) forbids it, and a transfer is cancelled by
-- an UPDATE (status='cancelled'), never removed; see the file header.
grant select, insert, update on stock_transfers to {{ROLE}};
grant select, insert, update, delete on stock_transfers to service_role;$u7$;
begin
  -- The template's own line-ending convention decides the anchors',
  -- exactly as 0030/0031/0033/0034 §2 do.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_tbl_from     := replace(replace(c_tbl_from,     chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to       := replace(replace(c_tbl_to,       chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fn_from      := replace(replace(c_fn_from,      chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fn_to        := replace(replace(c_fn_to,        chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_veh_from := replace(replace(c_pol_veh_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_veh_to   := replace(replace(c_pol_veh_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from     := replace(replace(c_rls_from,     chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to       := replace(replace(c_rls_to,       chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_st_from  := replace(replace(c_pol_st_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_st_to    := replace(replace(c_pol_st_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_from     := replace(replace(c_trg_from,     chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_to       := replace(replace(c_trg_to,       chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_veh_from := replace(replace(c_gnt_veh_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_veh_to   := replace(replace(c_gnt_veh_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_st_from  := replace(replace(c_gnt_st_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_st_to    := replace(replace(c_gnt_st_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists stock_transfers' in v_tpl) > 0 then
    raise notice '0035: template already carries stock_transfers — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2a (table) did not match. Template drifted from 0034.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2b (functions) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_veh_from, c_pol_veh_to);
    if position(c_pol_veh_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2c (vehicles policies) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2d (rls) did not match. Template drifted from 0034.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_st_from, c_pol_st_to);
    if position(c_pol_st_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2e (stock_transfers policies) did not match. Template drifted from 0034.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2f (triggers) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_veh_from, c_gnt_veh_to);
    if position(c_gnt_veh_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2g (vehicles grant) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_st_from, c_gnt_st_to);
    if position(c_gnt_st_to in v_tpl) = 0 then
      raise exception '0035: template anchor 2h (stock_transfers grants) did not match. Template drifted from 0034.';
    end if;
    v_done := v_done + 1;

    -- 0027's prefix-of-replacement safety, restated — but the expected
    -- delta is COMPUTED, not hand-counted: the original draft wrote 40
    -- where the probe string is 42 characters long, and the guard then
    -- refused a perfectly correct single insertion (0032 took the same
    -- lesson: "duplicate-count probes compare against the probe's own
    -- length()").
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists stock_transfers', '')))
       <> length('create table if not exists stock_transfers') then
      raise exception '0035: the template carries more than one stock_transfers table.';
    end if;

    -- 2b and 2c are whole-block REPLACEMENTS, so the count above says
    -- nothing about them. `st.status = 'requested'` must appear exactly
    -- three times — once inside guard_stock_transfer_move() and once in
    -- each of the two widened vehicles policies — 69 = 3 x
    -- length('st.status = ''requested'''). Fewer would mean an arm
    -- silently failed to land; more would mean an anchor matched
    -- somewhere unintended.
    if (length(v_tpl) - length(replace(v_tpl, 'st.status = ''requested''', ''))) <> 69 then
      raise exception '0035: the widened vehicles policies and the vehicles guard did not land exactly three times between them.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0035$ select %L::text $felix_0035$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0035: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0033 §3:
-- FK targets, policy expressions and trigger functions are resolved and
-- FROZEN here, and each showroom's must bind to its own can_read_branch(),
-- can_act_on_branch(), is_ceo(), record_audit().
--
-- The three new functions are created WITHOUT a SET clause inside
-- c_ddl (a `set search_path = t_<slug>` would have to be interpolated
-- per tenant, and c_ddl is a constant) and pinned immediately after via
-- ALTER FUNCTION — the exact shape 0033 §3 uses for its own three.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_ddl constant text := $ddl$
create table if not exists stock_transfers (
  id             uuid        primary key default gen_random_uuid(),
  vehicle_id     uuid        not null references vehicles(id),
  from_branch_id uuid        not null references branches(id),
  to_branch_id   uuid        not null references branches(id),
  status         text        not null default 'requested'
                             check (status in ('requested','accepted','cancelled')),
  requested_by   uuid        references profiles(id),
  decided_by     uuid        references profiles(id),
  note           text,
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  constraint stock_transfers_branches_differ check (from_branch_id <> to_branch_id)
);

create index if not exists idx_stock_transfers_vehicle    on stock_transfers(vehicle_id);
create index if not exists idx_stock_transfers_to_status  on stock_transfers(to_branch_id, status);

create unique index if not exists uniq_stock_transfer_open_per_vehicle
  on stock_transfers(vehicle_id) where status = 'requested';

create or replace function enforce_transfer_eligible() returns trigger as $trg$
declare
  v_branch uuid;
  v_status text;
begin
  select branch_id, status into v_branch, v_status
    from vehicles
   where id = new.vehicle_id;

  if not found then
    raise exception 'That vehicle does not exist, or you cannot see it';
  end if;

  if v_status = 'sold' then
    raise exception 'A sold vehicle cannot be transferred';
  end if;

  if new.from_branch_id is distinct from v_branch then
    raise exception 'A transfer must start from the vehicle''s current branch';
  end if;

  if exists (
    select 1 from deal_tickets dt
     where dt.vehicle_id = new.vehicle_id
       and dt.status in ('submitted','approved')
  ) then
    raise exception 'This vehicle has an active deal ticket and cannot be transferred';
  end if;

  return new;
end;
$trg$ language plpgsql;

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
    new.decided_by := auth.uid();
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
$trg$ language plpgsql;

create or replace function guard_stock_transfer_move() returns trigger as $trg$
begin
  if new.branch_id is distinct from old.branch_id and not is_ceo() then
    if (to_jsonb(old) - 'branch_id') is distinct from (to_jsonb(new) - 'branch_id') then
      raise exception 'A branch move cannot be combined with any other change to the vehicle';
    end if;

    if not exists (
      select 1 from stock_transfers st
       where st.vehicle_id = new.id
         and st.status = 'requested'
         and (
              (st.from_branch_id = old.branch_id and st.to_branch_id = new.branch_id)
           or (st.from_branch_id = new.branch_id and st.to_branch_id = old.branch_id)
         )
    ) then
      raise exception 'A vehicle may only move between the two branches of an open transfer request';
    end if;
  end if;

  return new;
end;
$trg$ language plpgsql;

alter table stock_transfers enable row level security;

drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    -- 0029: marketing lists the whole showroom's stock across channels,
    -- so their read is org-wide like the accountant's.
    or current_role_name() = 'marketing'
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
    or exists (
      select 1 from stock_transfers st
       where st.vehicle_id = vehicles.id
         and st.status = 'requested'
         and can_read_branch(st.to_branch_id)
    )
  );

drop policy if exists "vehicles_update" on vehicles;
create policy "vehicles_update" on vehicles for update
  using (
    is_ceo()
    or (is_manager_or_above() and branch_id = current_branch_id())
    or exists (
      select 1 from stock_transfers st
       where st.vehicle_id = vehicles.id
         and st.status = 'requested'
         and can_act_on_branch(st.to_branch_id)
    )
  );

drop policy if exists "stock_transfers_select" on stock_transfers;
create policy "stock_transfers_select" on stock_transfers for select
  using (can_read_branch(from_branch_id) or can_read_branch(to_branch_id));

drop policy if exists "stock_transfers_insert" on stock_transfers;
create policy "stock_transfers_insert" on stock_transfers for insert
  with check (can_act_on_branch(from_branch_id) and requested_by = auth.uid());

drop policy if exists "stock_transfers_update" on stock_transfers;
create policy "stock_transfers_update" on stock_transfers for update
  using (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id))
  with check (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id));

drop trigger if exists trg_guard_stock_transfer_move on vehicles;
create trigger trg_guard_stock_transfer_move
  before update on vehicles
  for each row execute function guard_stock_transfer_move();

drop trigger if exists trg_transfer_eligible on stock_transfers;
create trigger trg_transfer_eligible
  before insert on stock_transfers
  for each row execute function enforce_transfer_eligible();

drop trigger if exists trg_guard_stock_transfer_status on stock_transfers;
create trigger trg_guard_stock_transfer_status
  before insert or update on stock_transfers
  for each row execute function guard_stock_transfer_status();

drop trigger if exists trg_audit_stock_transfers on stock_transfers;
create trigger trg_audit_stock_transfers
  after insert or update or delete on stock_transfers
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- vehicles is both the FK target of stock_transfers and the table
    -- the widened policies belong to; its absence tells a
    -- half-provisioned tenant from a complete one, as 0030/0033 §3 do.
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0035: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- The three functions above were created WITHOUT a SET clause —
    -- see the section header. Pin them here instead: assertion (e)
    -- inside create_tenant_schema() requires every function outside the
    -- seven inlinable predicates to carry one, and an unpinned trigger
    -- function resolves against whatever path the CALLER had, which for
    -- a PostgREST session is not this schema.
    execute format(
      'alter function %I.enforce_transfer_eligible() set search_path = %I, extensions',
      r.schema_name, r.schema_name
    );
    execute format(
      'alter function %I.guard_stock_transfer_status() set search_path = %I, extensions',
      r.schema_name, r.schema_name
    );
    execute format(
      'alter function %I.guard_stock_transfer_move() set search_path = %I, extensions',
      r.schema_name, r.schema_name
    );

    -- §6b's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards, or a column grant added to
    -- an existing table afterwards.
    execute format('grant update (branch_id) on %I.vehicles to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update on %I.stock_transfers to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update, delete on %I.stock_transfers to service_role', r.schema_name);
    execute format('revoke all on table %I.stock_transfers from public, anon, authenticated', r.schema_name);

    -- Postgres grants EXECUTE on a new function to PUBLIC by default,
    -- and 0009 §6h's blanket revoke ran at provisioning, before these
    -- three existed.
    execute format(
      'revoke all on function %I.enforce_transfer_eligible(), %I.guard_stock_transfer_status(), '
      '%I.guard_stock_transfer_move() from public, anon, authenticated',
      r.schema_name, r.schema_name, r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0035: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0035: % tenant schema(s) carry stock_transfers.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — structure, isolation, lockdown, that the vehicles
-- grant is column-limited to branch_id and nothing else, that the two
-- widened vehicles policies actually name stock_transfers, and that
-- assertion (f)'s count of twenty SECURITY DEFINER functions holds.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_fn   text;
  v_col  text;
  n      int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.stock_transfers', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (stock_transfers missing)');
      continue;
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'stock_transfers' and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (stock_transfers rls off)');
    end if;

    -- Three policies, and no fourth: a DELETE policy here would be
    -- somebody deciding a transfer request can be erased.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'stock_transfers';
    if n <> 3 then
      v_bad := v_bad || format('%s (stock_transfers has %s policies, expected 3)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's
    -- can_read_branch()/can_act_on_branch(). pg_get_expr
    -- schema-qualifies only what is NOT on the current search_path,
    -- which §3 cleared.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname in ('stock_transfers', 'vehicles')
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    if not has_table_privilege(r.role_name, format('%I.stock_transfers', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (role cannot read stock_transfers)');
    end if;
    if not has_table_privilege(r.role_name, format('%I.stock_transfers', r.schema_name), 'insert') then
      v_bad := v_bad || (r.schema_name || ' (role cannot insert stock_transfers)');
    end if;
    if not has_table_privilege(r.role_name, format('%I.stock_transfers', r.schema_name), 'update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot update stock_transfers)');
    end if;
    -- assertion (j) parity: a DELETE grant here would make the NEXT
    -- showroom's provisioning fail, long after this migration ran and
    -- nowhere near it.
    if has_table_privilege(
         r.role_name, format('%I.stock_transfers', r.schema_name),
         'delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (role holds delete/truncate/references/trigger on stock_transfers)');
    end if;
    if not has_table_privilege(
         'service_role', format('%I.stock_transfers', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write stock_transfers)');
    end if;
    if has_table_privilege('authenticated', format('%I.stock_transfers', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege('anon', format('%I.stock_transfers', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege on stock_transfers)');
    end if;

    -- THE POINT OF §6g. The tenant role must hold NO table-wide UPDATE
    -- on vehicles (has_table_privilege reports false for a
    -- column-limited grant), must hold column UPDATE on branch_id, and
    -- must hold it on NOTHING else — a later blanket
    -- `grant update on vehicles` would otherwise be invisible here.
    if has_table_privilege(r.role_name, format('%I.vehicles', r.schema_name), 'update') then
      v_bad := v_bad || (r.schema_name || ' (role holds a table-wide update on vehicles)');
    end if;
    if not has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name), 'branch_id', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot update vehicles.branch_id)');
    end if;
    -- asking_price is NOT in this list: 0028 grants the role a
    -- column-limited UPDATE on asking_price/min_price on purpose (the
    -- pricing form writes them directly), and this verify runs against
    -- real tenants that carry that grant. Assert only the columns 0035
    -- itself is responsible for keeping closed.
    foreach v_col in array array['status', 'purchase_price', 'vin', 'sold_at'] loop
      if has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name), v_col, 'update') then
        v_bad := v_bad || format('%s (role can rewrite vehicles.%s)', r.schema_name, v_col);
      end if;
    end loop;

    foreach v_fn in array array['trg_transfer_eligible', 'trg_guard_stock_transfer_status', 'trg_audit_stock_transfers'] loop
      if not exists (
        select 1 from pg_trigger t
        join pg_class c      on c.oid = t.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = r.schema_name and c.relname = 'stock_transfers'
           and t.tgname = v_fn and not t.tgisinternal
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_fn);
      end if;
    end loop;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicles'
         and t.tgname = 'trg_guard_stock_transfer_move' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (missing trg_guard_stock_transfer_move)');
    end if;

    -- Assertion (e)'s rule, applied to the three functions this file
    -- adds: pinned, and pinned to THIS schema.
    foreach v_fn in array array[
      'enforce_transfer_eligible', 'guard_stock_transfer_status', 'guard_stock_transfer_move'
    ] loop
      if not exists (
        select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = r.schema_name and p.proname = v_fn
           and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                        where cfg like 'search_path=%' and cfg ~ ('\m' || r.schema_name || '\M'))
      ) then
        v_bad := v_bad || format('%s (%s is not pinned to this schema)', r.schema_name, v_fn);
      end if;

      -- None of the three may be SECURITY DEFINER: assertion (f) pins
      -- the schema at exactly twenty, and this file adds none.
      if exists (
        select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = r.schema_name and p.proname = v_fn and p.prosecdef
      ) then
        v_bad := v_bad || format('%s (%s became SECURITY DEFINER)', r.schema_name, v_fn);
      end if;
    end loop;

    -- Assertion (f) itself, re-run against the live schema.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> 20 then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, expected 20)', r.schema_name, n);
    end if;

    -- The widening actually took, on the LIVE function definitions —
    -- prosrc is what Postgres will run, not what §3 sent.
    if not exists (
      select 1 from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicles' and p.polname = 'vehicles_select'
         and pg_get_expr(p.polqual, p.polrelid) like '%stock_transfers%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select was not widened)');
    end if;
    if not exists (
      select 1 from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicles' and p.polname = 'vehicles_update'
         and pg_get_expr(p.polqual, p.polrelid) like '%stock_transfers%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (vehicles_update was not widened)');
    end if;

    -- The partial unique index behind one-open-transfer-per-vehicle.
    if not exists (
      select 1 from pg_class i
      join pg_index ix     on ix.indexrelid = i.oid
      join pg_class t      on t.oid = ix.indrelid
      join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = r.schema_name and t.relname = 'stock_transfers'
         and i.relname = 'uniq_stock_transfer_open_per_vehicle' and ix.indisunique
    ) then
      v_bad := v_bad || (r.schema_name || ' (stock_transfers has no uniq_stock_transfer_open_per_vehicle)');
    end if;

    -- from <> to, structurally.
    if not exists (
      select 1 from pg_constraint c
      join pg_class t      on t.oid = c.conrelid
      join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = r.schema_name and t.relname = 'stock_transfers'
         and c.conname = 'stock_transfers_branches_differ'
    ) then
      v_bad := v_bad || (r.schema_name || ' (stock_transfers has no from<>to constraint)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0035 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  -- The template, for showrooms not yet provisioned.
  if position('create table if not exists stock_transfers' in platform.tenant_ddl_template()) = 0
     or position('"stock_transfers_select" on stock_transfers' in platform.tenant_ddl_template()) = 0
     or position('create or replace function guard_stock_transfer_move()' in platform.tenant_ddl_template()) = 0
     or position('create or replace function enforce_transfer_eligible()' in platform.tenant_ddl_template()) = 0
     or position('create or replace function guard_stock_transfer_status()' in platform.tenant_ddl_template()) = 0
     or position('grant update (branch_id) on vehicles' in platform.tenant_ddl_template()) = 0 then
    raise exception '0035 VERIFY FAILED: the template does not carry stock_transfers.';
  end if;

  if position('delete on stock_transfers to {{ROLE}}' in platform.tenant_ddl_template()) > 0 then
    raise exception
      '0035 VERIFY FAILED: the template grants the tenant role DELETE on stock_transfers; assertion (j) would refuse to provision.';
  end if;

  raise notice '0035: verified — a car moves branches only through an open, audited request.';
end
$$;

notify pgrst, 'reload schema';

commit;
