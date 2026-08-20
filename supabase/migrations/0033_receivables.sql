-- ============================================================
-- 0033 — THE IN-HOUSE RECEIVABLE BOOK
--
-- Big Egyptian showrooms lend their own money. Abaza advertises a 7.5%
-- programme under its own name; the buyer pays a down payment, signs a
-- schedule, hands over a book of post-dated cheques as security, and
-- the showroom keeps the ownership papers until the last instalment
-- clears. تقسيط مباشر — direct instalments. It is the showroom's
-- balance sheet at risk, not a bank's.
--
-- FELIX has never been able to write that down. `deal_tickets.
-- financing_type in ('cash','installments')` reads as a two-way split
-- between paid-in-full and BANK-financed: 0009's
-- enforce_financing_partner_active() refuses an 'installments' ticket
-- that names no financing_partner_id, and financing_requests exists to
-- track a bank's decision. Neither is a loan the showroom owns. There
-- is no schedule, no outstanding balance, no arrears, no cheque
-- register, and — because ledger_entries is written only by
-- execute_vehicle_sale() — no way to take money at the counter at all
-- unless a sale is being executed at the same moment.
--
-- WHAT THIS ADDS
-- --------------
--   installment_plans   one per deal ticket. Principal, FLAT rate,
--                       term, the monthly figure the contract quotes,
--                       and whether ownership is retained until
--                       settlement (نقل الملكية بعد السداد).
--   installment_lines   the schedule itself, one row per instalment,
--                       carrying what is due and what has been paid.
--   cheques             the branch safe. Every post-dated cheque the
--                       showroom is holding, its maturity, and where it
--                       is in its life.
--   receipts            money taken at the counter. Independent of a
--                       sale, which is the point: an instalment payment
--                       is not a sale, and until now the only thing
--                       that could move money was one.
--
-- FLAT RATE, NOT AMORTISED — AND WHY THE MATH IS NOT IN HERE
-- ----------------------------------------------------------
-- An Egyptian showroom quotes a FLAT rate: interest is
-- principal × rate × years, computed once on the whole principal and
-- split evenly. It does not fall as the balance falls. Reading a
-- flat-quoted rate as reducing-balance understates the customer's total
-- by roughly half, on every plan, and every internal number would still
-- agree with every other one.
--
-- The schedule is therefore built in src/lib/receivables.ts, under
-- test, and INSERTED — not computed by a generated column or a
-- function here. Three reasons, in order of weight:
--
--   1. The salesperson must see the schedule BEFORE anyone commits to
--      it. A live preview that called into Postgres for every keystroke
--      is a round trip per digit; one that computed the numbers in the
--      browser and let the database compute them again at insert time
--      is two implementations of the same arithmetic, and the day they
--      disagree the customer has already signed the wrong one.
--   2. A schedule is a CONTRACT. Once signed it must not change because
--      a later migration improved the rounding. Stored rows are the
--      document; a computed column is a re-derivation, and it moves.
--   3. Assertion (f) in platform.create_tenant_schema() pins the schema
--      at EXACTLY twenty SECURITY DEFINER functions, and a plpgsql
--      schedule builder that had to bypass RLS would be a twenty-first.
--      The two functions this file does add are plain trigger guards.
--
-- Postgres still holds the invariants that matter: every line is
-- positive, seq is unique per plan, total_payable >= principal.
--
-- WHY branch_id IS DENORMALISED ONTO PLANS, CHEQUES AND RECEIPTS
-- --------------------------------------------------------------
-- All three could reach a branch through deal_tickets. None of them
-- does. can_read_branch(branch_id) is a scalar call the planner can
-- evaluate against the row it already has; can_read_branch((select
-- branch_id from deal_tickets ...)) drags deal_tickets_select — four
-- predicate calls and a subquery on profiles — into every plan, on a
-- table the accountant's hub reads org-wide. installment_lines pays
-- that cost once (through its plan, which is one indexed lookup) and is
-- the only child table here; everything else is scalar.
--
-- It also makes the cheque register work at all: a cheque may be taken
-- as security for a plan, against a ticket, or from a walk-in with
-- neither, and the branch that is holding the paper is the only thing
-- always true about it. A trigger pins the plan's branch to its
-- ticket's so the two cannot drift.
--
-- OVERDUE IS COMPUTED, NEVER STORED
-- ---------------------------------
-- There is no is_overdue column and no is_overdue index, deliberately.
-- Such a column is correct only until midnight; keeping it true means a
-- nightly job whose failure is invisible — the arrears report simply
-- gets quietly younger. `due_date < current_date and amount_paid <
-- amount_due` is the definition, agingBuckets() in receivables.ts is
-- the app-side twin, and idx_installment_lines_due is what makes it
-- cheap.
--
-- 0009's FINANCING GATE IS WIDENED BY ONE CLAUSE, AND THIS IS THE ONE
-- BEHAVIOUR CHANGE IN THE FILE
-- --------------------------------------------------------------------
-- enforce_financing_partner_active() (0003 §3c, carried into 0009 §4.5)
-- rejects any 'installments' ticket whose financing_partner_id is null.
-- That was right when 'installments' could only mean a bank. It makes
-- an in-house plan UNREACHABLE: the ticket it must hang off cannot be
-- inserted, so §2 replaces the function body with the half that still
-- earns its place — a NAMED partner must be active, uploaded bank
-- contract and all — and drops the half that forbade the null.
--
-- After this migration the ticket's financing columns read:
--     cash                              paid in full
--     installments + partner            the bank's book
--     installments + no partner         the showroom's own book
--
-- and the third is what installment_plans attaches to. The trigger
-- added below refuses a plan on any other shape, so the meaning cannot
-- be borrowed for something else later.
--
-- What is NOT widened: CreateDealTicketSchema in src/lib/validation.ts
-- still refuses an installments ticket with no partner, so the CRM's
-- own intake form cannot yet raise one. That is a deliberate stopping
-- point rather than an oversight — opening the intake form is a change
-- to the deal-ticket write path, which belongs in its own commit next
-- to the form it changes. Until then in-house tickets arrive from the
-- seed script and the service role, and every screen this migration
-- ships works on them.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * No SECURITY DEFINER function, and no change to
--     execute_vehicle_sale() or the waterfall. A receipt against a plan
--     is not a sale: the sale already happened, its profit was already
--     split, and re-entering the waterfall to collect an instalment
--     would pay every equity holder twice.
--   * No ledger_entries rows. A receivable collection posting into the
--     same ledger the profit split lives in needs a chart of accounts
--     and a double-entry model this schema does not have; receipts are
--     the record until it does. Stated so the omission reads as a
--     decision rather than a gap.
--   * No DELETE anywhere for the tenant role. Assertion (j) inside
--     create_tenant_schema() PROVES the tenant role holds delete on
--     nothing, so a delete grant here would break every new showroom's
--     provisioning from a file that never mentions it. It is also right
--     on its own: a receipt is voided by a correcting entry, a bounced
--     cheque is a status, and a plan that should not have existed is
--     'defaulted' with a note. Nothing a showroom session can send
--     removes evidence of money.
--   * No automatic 'defaulted'. Default is a judgement a human makes —
--     the cheques bounced, the phone is off, it is with the lawyer —
--     and no arrears threshold makes it for them. planStatus() in
--     receivables.ts computes 'settled' and nothing else.
--   * installment_lines carries no audit trigger while its three
--     siblings do. Every movement of amount_paid is caused by a
--     receipt, receipts ARE audited, and the receipt names the plan —
--     so the trail exists once, in the place a human would look for it,
--     rather than twice.
--   * None of the four tables is added to the c_tables array inside
--     platform.create_tenant_schema(), for the reason 0016, 0030 and
--     0031 all record: a failed CREATE TABLE aborts the whole template
--     execute, assertion (b) walks pg_class for RLS and guard (5) for
--     the tenant role's SELECT, and §4 below verifies all four across
--     every live schema directly.
--
-- ANCHOR CHOICE. Every substitution below lands on the CALENDAR — the
-- tail of 0009 §8, guard_meeting_invitee_columns(), meeting_invitees'
-- RLS line, its respond policy, its guard trigger, its grant — plus one
-- whole-function replacement of enforce_financing_partner_active().
-- Nothing here touches leads (0016, 0031), vehicle_listings (0029,
-- 0030), or the vehicles / deal_tickets CREATE TABLE bodies, which is
-- where migration 0032 is working concurrently. Two migrations amending
-- one anchor point is the failure mode this convention exists to avoid.
--
-- GATE. On 0031, the migration immediately before this one — NOT on
-- 0032, which is unmerged and parallel. 0033 needs nothing from either.
--
-- LINE ENDINGS. The live platform.tenant_ddl_template() text is CRLF —
-- it was built from SQL-Editor pastes of CRLF files — while a
-- multi-line anchor authored LF matches nothing against it. §2 reads
-- the template's own convention and rewrites the ANCHORS into it,
-- flattening them to LF first so it works whether this file arrived as
-- LF or was converted by the operator's applier. The stored template's
-- endings are left exactly as they were found, so every later migration
-- keeps matching. Same shape as 0030 §2 and 0031 §2.
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
      '0033 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0033 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The two branch predicates every policy below is built out of, in
  -- the form 0030 left them. Checked by name only; §2's anchors do not
  -- touch their bodies.
  if position('create or replace function can_read_branch(p_branch_id uuid)' in platform.tenant_ddl_template()) = 0
     or position('create or replace function can_act_on_branch(p_branch_id uuid)' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0033 PRECONDITION FAILED: the template has no can_read_branch/can_act_on_branch. Apply 0009 first.';
  end if;

  -- The function §2c replaces. If it is not there in 0009's exact
  -- shape, the widening will not take and in-house tickets stay
  -- impossible — better to say so here than three anchors deep.
  if position('create or replace function enforce_financing_partner_active()' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0033 PRECONDITION FAILED: the template has no enforce_financing_partner_active(). Apply 0009 first.';
  end if;

  -- Batch-ordering gate. 0033 needs nothing from 0031 — the anchors do
  -- not overlap and no policy here names customers — but a template
  -- amended out of order is a template nobody can reason about
  -- afterwards, so the gate is on the migration immediately before this
  -- one. Deliberately NOT gated on 0032: that file is parallel and
  -- unmerged, and this one must apply with or without it.
  if position('create table if not exists customers' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0033 PRECONDITION FAILED: the template has no customers table. Apply 0031 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Seven anchors. Order inside the template is load-bearing (0009's own
-- header says why): the four tables go into SECTION 1, the two new
-- trigger functions into SECTION 4 where every table they read already
-- exists, and the RLS / policies / triggers / grants into their own
-- sections. A `language plpgsql` body is not validated at CREATE time,
-- so the functions could sit anywhere after their tables — they are put
-- beside the calendar guards they were anchored on so the template
-- still reads in one order.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  -- None of the strings below is `constant`: every one is rewritten
  -- into the template's own line-ending convention before it is used.
  -- See the header, and the normalisation block at the top of the body.

  -- 2a. THE FOUR TABLES, at the very end of §8 — after the calendar's
  --     indexes, which are the last statements in SECTION 1. Every FK
  --     target (deal_tickets, branches, profiles) is created well above
  --     this point, and Postgres resolves an FK target at CREATE time.
  c_tbl_from text := $r1$create index if not exists idx_meeting_invitees_profile on meeting_invitees(profile_id);$r1$;
  c_tbl_to   text := $r2$create index if not exists idx_meeting_invitees_profile on meeting_invitees(profile_id);

-- ------------------------------------------------------------
-- 8f. THE IN-HOUSE RECEIVABLE BOOK  (0033)
--
-- What the showroom is owed by its own customers, as opposed to what a
-- bank is owed. See the file header of 0033 for why this is not the
-- same thing as financing_requests.
-- ------------------------------------------------------------

-- One plan per deal ticket — UNIQUE on deal_ticket_id, because two
-- schedules against one car is not a feature, it is two answers to
-- "what does he still owe" that will disagree.
--
-- principal          the financed amount, i.e. AFTER the down payment.
--                    deal_tickets.down_payment stays where it is; this
--                    is deliberately not derived from it, because a
--                    plan is frequently written on a figure that
--                    already nets off a trade-in or a discount the
--                    ticket records separately.
-- annual_flat_rate   FLAT, not reducing-balance. Nullable: an
--                    interest-free plan over six months is common and
--                    a stored 0 would be indistinguishable from "not
--                    decided yet".
-- monthly_amount     what the contract quotes. Stored rather than
--                    derived — see the header. The last line of the
--                    schedule absorbs the rounding remainder, so this
--                    is what every line but that one carries.
-- total_payable      principal + flat interest. CHECKed at or above
--                    principal so a plan can never be written that
--                    collects less than it lent.
-- ownership_retained نقل الملكية بعد السداد — the papers stay with the
--                    showroom until the last instalment clears. True by
--                    default because that is the whole security model
--                    of in-house lending, and a plan written without it
--                    is an unsecured personal loan the owner should
--                    have to say out loud.
-- status             'defaulted' is a HUMAN's judgement and nothing
--                    computes it. 'settled' is set by the payment
--                    action when the last line closes.
create table if not exists installment_plans (
  id                 uuid        primary key default gen_random_uuid(),
  deal_ticket_id     uuid        not null unique references deal_tickets(id),
  -- Denormalised from the ticket so every policy on this table is a
  -- scalar predicate. enforce_in_house_installment_plan() pins it to
  -- the ticket's own branch, so the copy cannot drift from the source.
  branch_id          uuid        not null references branches(id),
  principal          numeric     not null check (principal > 0),
  annual_flat_rate   numeric     check (annual_flat_rate is null
                                        or (annual_flat_rate >= 0 and annual_flat_rate <= 100)),
  months             int         not null check (months > 0 and months <= 120),
  start_date         date        not null,
  monthly_amount     numeric     not null check (monthly_amount > 0),
  total_payable      numeric     not null check (total_payable >= principal),
  ownership_retained boolean     not null default true,
  status             text        not null default 'active'
                                 check (status in ('active','settled','defaulted')),
  notes              text,
  created_by         uuid        references profiles(id),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create index if not exists idx_installment_plans_branch on installment_plans(branch_id);
create index if not exists idx_installment_plans_status on installment_plans(status);

-- The schedule. Written once at plan creation and thereafter only
-- amount_paid / paid_at move.
--
-- OVERDUE IS NOT A COLUMN HERE. It is `due_date < current_date and
-- amount_paid < amount_due`, evaluated at read time; see the header.
--
-- CASCADE from the plan is the one delete in this design, and it is
-- reachable only through the service role (§6f grants the tenant role
-- no DELETE on anything). A plan removed by an operator repair must not
-- leave 60 orphan instalments behind.
create table if not exists installment_lines (
  id          uuid        primary key default gen_random_uuid(),
  plan_id     uuid        not null references installment_plans(id) on delete cascade,
  seq         int         not null,
  due_date    date        not null,
  amount_due  numeric     not null check (amount_due > 0),
  amount_paid numeric     not null default 0 check (amount_paid >= 0),
  paid_at     timestamptz,
  -- One row per instalment number, which is what makes oldest-first
  -- allocation deterministic: allocatePayment() orders by seq, not by
  -- due_date, and two lines sharing a seq would make the order the
  -- planner's choice.
  constraint installment_lines_plan_seq_unique unique (plan_id, seq)
);

create index if not exists idx_installment_lines_plan on installment_lines(plan_id);
-- The arrears query, org-wide, is a range scan on this.
create index if not exists idx_installment_lines_due  on installment_lines(due_date);

-- THE BRANCH SAFE. Every post-dated cheque the showroom is physically
-- holding, whether it secures a plan, a single ticket, or neither.
--
-- deal_ticket_id and plan_id are both nullable and neither is required:
-- a customer hands over a book of cheques at signing (plan), a single
-- cheque for a cash deal's balance (ticket), or a deposit cheque to
-- hold a car before any paperwork exists (neither). branch_id is the
-- only thing always true — somebody in a particular showroom has the
-- paper in a particular drawer.
--
-- drawer_name is not redundant with the buyer's name. Egyptian
-- practice is routinely for a relative's or a company's cheque book to
-- be used, and the drawer is who the bank will pursue.
--
-- status_changed_at is stamped by guard_cheque_status(), never by the
-- client: "when did this bounce" is the question the whole register
-- exists to answer and it must not be answerable with a typed date.
create table if not exists cheques (
  id                uuid        primary key default gen_random_uuid(),
  branch_id         uuid        not null references branches(id),
  deal_ticket_id    uuid        references deal_tickets(id),
  plan_id           uuid        references installment_plans(id),
  cheque_number     text        not null,
  bank_name         text        not null,
  drawer_name       text        not null,
  amount            numeric     not null check (amount > 0),
  due_date          date        not null,
  status            text        not null default 'in_safe'
                                check (status in ('in_safe','deposited','cleared','bounced','returned_to_customer')),
  status_changed_at timestamptz,
  note              text,
  created_by        uuid        references profiles(id),
  created_at        timestamptz default now()
);

-- The maturity calendar: "what falls due in this branch over the next
-- 30 days", which is the query the accountant's hub is built around.
create index if not exists idx_cheques_branch_due on cheques(branch_id, due_date);
create index if not exists idx_cheques_plan       on cheques(plan_id);

-- MONEY TAKEN AT THE COUNTER, and the first thing in this schema that
-- can record a payment without a sale being executed at the same
-- moment. An instalment collection, a deposit on a car, a balance
-- settled after delivery — none of those is a sale, and until now
-- ledger_entries (written only by execute_vehicle_sale) was the only
-- place money existed.
--
-- method reuses 0023's settlement channel values verbatim, so the
-- counter and the deal ticket describe a bank transfer with the same
-- word.
--
-- received_by is pinned to auth.uid() by the INSERT policy: a receipt
-- names the person who took the money, and that is not a field anybody
-- fills in.
create table if not exists receipts (
  id             uuid        primary key default gen_random_uuid(),
  branch_id      uuid        not null references branches(id),
  deal_ticket_id uuid        references deal_tickets(id),
  plan_id        uuid        references installment_plans(id),
  amount         numeric     not null check (amount > 0),
  method         text        not null check (method in ('cash','bank_transfer','cheque','instapay')),
  reference      text,
  payer_name     text,
  note           text,
  received_by    uuid        not null references profiles(id),
  received_at    timestamptz not null default now()
);

create index if not exists idx_receipts_branch on receipts(branch_id, received_at desc);
create index if not exists idx_receipts_plan   on receipts(plan_id);$r2$;

  -- 2b. THE TWO TRIGGER FUNCTIONS, immediately above the calendar's
  --     column guard in §4.8. Both are plain plpgsql — NOT SECURITY
  --     DEFINER — so assertion (f)'s count of twenty stays exactly
  --     twenty. Both pin a search_path, which assertion (e) requires of
  --     every function outside the seven inlinable predicates.
  c_fn_from text := $r3$create or replace function guard_meeting_invitee_columns() returns trigger as $trg$$r3$;
  c_fn_to   text := $r4$-- ============================================================
-- 4.8-bis THE IN-HOUSE RECEIVABLE BOOK  (0033)
-- ============================================================

-- WHAT AN IN-HOUSE PLAN IS ALLOWED TO HANG OFF, enforced where it
-- cannot be argued with.
--
-- After 0033 widened enforce_financing_partner_active() the ticket's
-- financing columns carry three meanings, and only the third is this
-- table's business:
--
--     cash                        paid in full
--     installments + a partner    the bank's book (financing_requests)
--     installments + no partner   the showroom's own book  <- here
--
-- Without this trigger the third meaning is a convention, and a
-- convention is what the fourth developer breaks. The zod schema and
-- the server action check the same three things; this is the one that
-- is still true when somebody POSTs the action by hand.
--
-- It also pins branch_id to the ticket's own. The column is
-- denormalised for the sake of scalar RLS predicates (see the header),
-- and a denormalised copy that anyone may set is a second, WRONG answer
-- to "whose row is this?" — which is precisely the question every
-- policy on this table asks.
--
-- NOT SECURITY DEFINER, so the SELECT below runs under the caller's own
-- RLS. That is correct rather than merely acceptable: a session that
-- cannot see the ticket has no business writing a plan against it, and
-- the "does not exist, or you cannot see it" wording is deliberate —
-- distinguishing the two would confirm the existence of a ticket in a
-- branch the caller has no standing in.
create or replace function enforce_in_house_installment_plan() returns trigger as $trg$
declare
  v_branch  uuid;
  v_type    text;
  v_partner uuid;
begin
  select branch_id, financing_type, financing_partner_id
    into v_branch, v_type, v_partner
    from deal_tickets
   where id = new.deal_ticket_id;

  if not found then
    raise exception 'That deal ticket does not exist, or you cannot see it';
  end if;

  if v_type <> 'installments' then
    raise exception 'An in-house payment plan belongs to an instalments deal, not a cash one';
  end if;

  if v_partner is not null then
    raise exception 'This deal is financed by a bank. An in-house payment plan is only for deals the showroom finances itself';
  end if;

  if new.branch_id is distinct from v_branch then
    raise exception 'A payment plan must carry the branch of its own deal ticket';
  end if;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- THE CHEQUE'S LIFE, and what it may never do.
--
--   in_safe  -> deposited | returned_to_customer
--   deposited-> cleared | bounced
--   bounced  -> deposited        (re-presentation, which is real:
--                                 the drawer funds the account and the
--                                 showroom banks it again)
--   cleared  -> nothing          (money has moved; there is no undo)
--   returned_to_customer -> nothing
--
-- INSERT is restricted to 'in_safe' or 'deposited'. Allowing any value
-- would make the whole transition table optional — a row inserted
-- straight as 'cleared' reaches the terminal state without ever having
-- been in the safe, which is exactly the move the register exists to
-- make impossible. 'deposited' is admitted because a cheque handed
-- directly to the bank and recorded afterwards is ordinary.
--
-- Everything identifying the instrument is pinned on UPDATE. The
-- register is a control document: the amount and number of a cheque
-- already in the safe are facts about a piece of paper, and the only
-- fields the app ever means to change are status and note.
create or replace function guard_cheque_status() returns trigger as $trg$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('in_safe', 'deposited') then
      raise exception 'A cheque is recorded in the safe, or as deposited. Move it from there';
    end if;
    new.status_changed_at := now();
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'in_safe'   and new.status in ('deposited', 'returned_to_customer'))
      or (old.status = 'deposited' and new.status in ('cleared', 'bounced'))
      or (old.status = 'bounced'   and new.status = 'deposited')
    ) then
      raise exception 'A cheque cannot move from % to %', old.status, new.status;
    end if;
    -- Stamped here rather than trusted from the client, for the reason
    -- guard_meeting_invitee_columns() stamps responded_at: "when did
    -- this bounce" is the question the register answers.
    new.status_changed_at := now();
  else
    new.status_changed_at := old.status_changed_at;
  end if;

  new.branch_id      := old.branch_id;
  new.deal_ticket_id := old.deal_ticket_id;
  new.plan_id        := old.plan_id;
  new.cheque_number  := old.cheque_number;
  new.bank_name      := old.bank_name;
  new.drawer_name    := old.drawer_name;
  new.amount         := old.amount;
  new.due_date       := old.due_date;
  new.created_by     := old.created_by;
  new.created_at     := old.created_at;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

create or replace function guard_meeting_invitee_columns() returns trigger as $trg$$r4$;

  -- 2c. WIDEN 0009's FINANCING GATE — a whole-function replacement, in
  --     the shape 0030 used for can_act_on_branch/can_read_branch.
  --
  --     This is the only pre-existing behaviour this file changes, and
  --     the header explains it at length. In short: the rejected state
  --     (installments, no partner) is what an in-house plan hangs off,
  --     so leaving the rule in place would make the rest of this
  --     migration unreachable. The half that mattered stays.
  c_fin_from text := $r5$create or replace function enforce_financing_partner_active() returns trigger as $trg$
begin
  if new.financing_type = 'installments' then
    if new.financing_partner_id is null then
      raise exception 'An installments deal requires a financing partner';
    end if;
    if not exists (
      select 1 from financing_partners
      where id = new.financing_partner_id and status = 'active'
    ) then
      raise exception 'Selected financing partner is not active yet (bank contract not uploaded)';
    end if;
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$r5$;
  c_fin_to   text := $r6$create or replace function enforce_financing_partner_active() returns trigger as $trg$
begin
  -- 0033 widened this. 0003 §3c required a partner on every
  -- 'installments' ticket, because at the time 'installments' could
  -- only mean a bank. It now also means the showroom's own book — a
  -- plan in installment_plans, secured by cheques, with no bank
  -- anywhere — and that ticket carries no partner by definition.
  --
  -- The half that still earns its place is untouched: a ticket that
  -- NAMES a partner must name one that is active, which is what makes
  -- the uploaded-bank-contract gate on financing_partners mean
  -- anything. What was dropped is the requirement that a partner be
  -- named at all.
  --
  -- The null is not unguarded: enforce_in_house_installment_plan()
  -- refuses a plan on any ticket that is not exactly this shape, so
  -- "installments, no partner" cannot quietly come to mean something
  -- else.
  if new.financing_type = 'installments' and new.financing_partner_id is not null then
    if not exists (
      select 1 from financing_partners
      where id = new.financing_partner_id and status = 'active'
    ) then
      raise exception 'Selected financing partner is not active yet (bank contract not uploaded)';
    end if;
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$r6$;

  -- 2d. RLS, after the last of 0009's own enables.
  c_rls_from text := $r7$alter table meeting_invitees       enable row level security;$r7$;
  c_rls_to   text := $r8$alter table meeting_invitees       enable row level security;
alter table installment_plans      enable row level security;
alter table installment_lines      enable row level security;
alter table cheques                enable row level security;
alter table receipts               enable row level security;$r8$;

  -- 2e. the policies, after the calendar's four.
  c_pol_from text := $r9$drop policy if exists "meeting_invitees_respond" on meeting_invitees;
create policy "meeting_invitees_respond" on meeting_invitees for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());$r9$;
  c_pol_to   text := $s1$drop policy if exists "meeting_invitees_respond" on meeting_invitees;
create policy "meeting_invitees_respond" on meeting_invitees for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ------------------------------------------------------------
-- 5t. THE IN-HOUSE RECEIVABLE BOOK — 0033
--
-- BRANCH-SCOPED THROUGHOUT, through the two predicates 0030 left, which
-- already carry the CEO, the accountant and branch grants. There is no
-- salesperson arm anywhere in this section, and that is deliberate: the
-- deal-ticket policies admit `salesperson_id = auth.uid()` so a sales
-- exec can follow their own deal after transferring branch, but a
-- receivable is the BRANCH's asset and its arrears are the branch
-- manager's problem. A salesperson sees their branch's book because
-- they are in that branch, not because they sold the car.
--
-- The lines inherit through their plan — 0016's child-table shape,
-- restated. USING **and** WITH CHECK on the update for the reason 0016
-- gives: a policy with USING alone would let a visible line be
-- re-pointed at a plan in a branch the caller cannot read, which is the
-- harder half of a leak to notice.
--
-- NO DELETE POLICY ON ANY OF THE FOUR, and §6d withholds the grant
-- besides. See the file header.
-- ------------------------------------------------------------
drop policy if exists "installment_plans_select" on installment_plans;
create policy "installment_plans_select" on installment_plans for select
  using (can_read_branch(branch_id));

-- created_by = auth.uid() in WITH CHECK, as branch_grants.granted_by
-- and vehicle_listings.posted_by are: the row names whoever wrote the
-- schedule, and audit_log holds the pair.
drop policy if exists "installment_plans_insert" on installment_plans;
create policy "installment_plans_insert" on installment_plans for insert
  with check (can_act_on_branch(branch_id) and created_by = auth.uid());

-- UPDATE is how a plan reaches 'settled' (the payment action) and
-- 'defaulted' (a human deciding). enforce_in_house_installment_plan()
-- fires on update too, so branch_id and deal_ticket_id cannot be
-- repointed at a bank-financed ticket after the fact.
drop policy if exists "installment_plans_update" on installment_plans;
create policy "installment_plans_update" on installment_plans for update
  using (can_act_on_branch(branch_id))
  with check (can_act_on_branch(branch_id));

drop policy if exists "installment_lines_select" on installment_lines;
create policy "installment_lines_select" on installment_lines for select
  using (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_read_branch(p.branch_id)));

drop policy if exists "installment_lines_insert" on installment_lines;
create policy "installment_lines_insert" on installment_lines for insert
  with check (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_act_on_branch(p.branch_id)));

drop policy if exists "installment_lines_update" on installment_lines;
create policy "installment_lines_update" on installment_lines for update
  using (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_act_on_branch(p.branch_id)))
  with check (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_act_on_branch(p.branch_id)));

drop policy if exists "cheques_select" on cheques;
create policy "cheques_select" on cheques for select
  using (can_read_branch(branch_id));

drop policy if exists "cheques_insert" on cheques;
create policy "cheques_insert" on cheques for insert
  with check (can_act_on_branch(branch_id) and created_by = auth.uid());

-- Broad on purpose, and narrowed by guard_cheque_status() instead: the
-- policy says who may touch the row, the trigger says which columns may
-- move and in what order. Expressing "only status and note" as a policy
-- is not possible; expressing it as a trigger is four lines.
drop policy if exists "cheques_update" on cheques;
create policy "cheques_update" on cheques for update
  using (can_act_on_branch(branch_id))
  with check (can_act_on_branch(branch_id));

drop policy if exists "receipts_select" on receipts;
create policy "receipts_select" on receipts for select
  using (can_read_branch(branch_id));

drop policy if exists "receipts_insert" on receipts;
create policy "receipts_insert" on receipts for insert
  with check (can_act_on_branch(branch_id) and received_by = auth.uid());

-- THE NARROWEST UPDATE IN THE SCHEMA, and it is meant to be. A receipt
-- is a record that money changed hands: the amount, the method, the
-- payer and the taker are what a customer's copy says, and none of them
-- is editable by anybody. What the accountant may fix is a mistyped
-- transfer reference or a note — and §6d's grant is column-limited to
-- exactly those two, in the shape 0024 used for the ETA fields, so even
-- this policy cannot reach the amount. A receipt entered wrongly is
-- corrected by a second receipt, not by rewriting the first.
drop policy if exists "receipts_update" on receipts;
create policy "receipts_update" on receipts for update
  using (is_accountant_or_above() and can_act_on_branch(branch_id))
  with check (is_accountant_or_above() and can_act_on_branch(branch_id));$s1$;

  -- 2f. the triggers, after the calendar's guard pair in §4.9.
  c_trg_from text := $s2$drop trigger if exists trg_guard_meeting_invitee_columns on meeting_invitees;
create trigger trg_guard_meeting_invitee_columns
  before update on meeting_invitees
  for each row execute function guard_meeting_invitee_columns();$s2$;
  c_trg_to   text := $s3$drop trigger if exists trg_guard_meeting_invitee_columns on meeting_invitees;
create trigger trg_guard_meeting_invitee_columns
  before update on meeting_invitees
  for each row execute function guard_meeting_invitee_columns();

-- ── the in-house receivable book (0033) ─────────────────────
drop trigger if exists trg_in_house_plan_gate on installment_plans;
create trigger trg_in_house_plan_gate
  before insert or update on installment_plans
  for each row execute function enforce_in_house_installment_plan();

drop trigger if exists trg_installment_plans_updated_at on installment_plans;
create trigger trg_installment_plans_updated_at
  before update on installment_plans
  for each row execute function set_updated_at();

drop trigger if exists trg_guard_cheque_status on cheques;
create trigger trg_guard_cheque_status
  before insert or update on cheques
  for each row execute function guard_cheque_status();

-- Audited: a plan is a credit agreement, a cheque is a control
-- document, and a receipt is money. All three are revised in place
-- (status moves, a note is corrected), so the trail has to survive the
-- revision. installment_lines is deliberately NOT audited — every
-- movement of amount_paid is caused by a receipt, and the receipt names
-- the plan; see the file header.
drop trigger if exists trg_audit_installment_plans on installment_plans;
create trigger trg_audit_installment_plans
  after insert or update or delete on installment_plans
  for each row execute function record_audit();

drop trigger if exists trg_audit_cheques on cheques;
create trigger trg_audit_cheques
  after insert or update or delete on cheques
  for each row execute function record_audit();

drop trigger if exists trg_audit_receipts on receipts;
create trigger trg_audit_receipts
  after insert or update or delete on receipts
  for each row execute function record_audit();$s3$;

  -- 2g. the grants, after the calendar's in §6e.
  c_gnt_from text := $s4$grant select, update on meeting_invitees to {{ROLE}};$s4$;
  c_gnt_to   text := $s5$grant select, update on meeting_invitees to {{ROLE}};

-- ── the in-house receivable book (0033) ─────────────────────
--
-- deals/[ticketId]/installment-actions.ts writes all four; the ticket
-- panel and the accountant's hub read them.
--
-- No DELETE on any of them, matching every other table in 6d and
-- required by assertion (j) besides: a tenant role holding delete on
-- any relation aborts provisioning.

-- The schedule is written once and then flips to 'settled'.
grant select, insert, update on installment_plans to {{ROLE}};
-- amount_paid / paid_at move as payments land.
grant select, insert, update on installment_lines to {{ROLE}};
-- Status moves through guard_cheque_status(); nothing else may move.
grant select, insert, update on cheques to {{ROLE}};

-- A receipt is a record of money changing hands, so the write is
-- INSERT and the UPDATE is column-limited to the two fields that can
-- be mistyped without changing what happened — the same shape 0024
-- used to open the ETA fields on contracts without opening the vault
-- columns. The amount, the method, the payer and received_by are
-- outside the grant and therefore unreachable, whatever any policy
-- says.
grant select, insert on receipts to {{ROLE}};
grant update (reference, note) on receipts to {{ROLE}};

-- seed/demo scripts and the operator's data-repair path. §6g already
-- grants service_role DML on ALL tables in the schema, so this is a
-- restatement rather than a widening — written out because a reader
-- checking who can remove a receipt should find the answer beside the
-- grant that withholds it from everyone else.
grant select, insert, update, delete
  on installment_plans, installment_lines, cheques, receipts to service_role;$s5$;
begin
  -- The template's own line-ending convention decides the anchors'.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next. Each string is flattened to
  -- LF first — the operator's runbook converts this whole FILE to CRLF
  -- before applying it, so the anchors can arrive either way — and then
  -- rewritten in the template's convention. Same shape as 0030 §2 and
  -- 0031 §2.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_tbl_from := replace(replace(c_tbl_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fn_from  := replace(replace(c_fn_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fn_to    := replace(replace(c_fn_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fin_from := replace(replace(c_fin_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fin_to   := replace(replace(c_fin_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_from := replace(replace(c_trg_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_to   := replace(replace(c_trg_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists installment_plans' in v_tpl) > 0 then
    raise notice '0033: template already carries the receivable book — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2a (tables) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2b (trigger functions) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fin_from, c_fin_to);
    if position(c_fin_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2c (financing gate) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2d (rls) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2e (policies) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2f (triggers) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0033: template anchor 2g (grants) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    -- 0027's prefix-of-replacement safety, restated. Six of the seven
    -- anchors above are a prefix or a suffix of their replacement, so
    -- `replace` would fire twice if the template ever carried two
    -- copies of one of them. One count per table; the lengths are the
    -- literals' own.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists installment_plans', ''))) <> 44
       or (length(v_tpl) - length(replace(v_tpl, 'create table if not exists installment_lines', ''))) <> 44
       or (length(v_tpl) - length(replace(v_tpl, 'create table if not exists cheques', ''))) <> 34
       or (length(v_tpl) - length(replace(v_tpl, 'create table if not exists receipts', ''))) <> 35 then
      raise exception '0033: the template carries a duplicated receivable-book table.';
    end if;

    -- 2c is a whole-function REPLACEMENT rather than a splice, so the
    -- counts above say nothing about it. These two do. The old
    -- requirement must be GONE (it is the thing this file exists to
    -- lift), and the widened condition must appear exactly once —
    -- 54 = length('installments'' and new.financing_partner_id is not null').
    if position('An installments deal requires a financing partner' in v_tpl) > 0 then
      raise exception '0033: the template still refuses a partnerless installments ticket.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'installments'' and new.financing_partner_id is not null', ''))) <> 54 then
      raise exception '0033: the widened financing gate did not land exactly once.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0027.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0033$ select %L::text $felix_0033$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0033: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0016 §3,
-- 0030 §3 and 0031 §3: the FK targets, the policy expressions and the
-- triggers' functions are resolved and FROZEN here, and each showroom's
-- must bind to its own can_read_branch(), its own set_updated_at(), its
-- own record_audit().
--
-- enforce_financing_partner_active() is replaced in the same pass.
-- CREATE OR REPLACE keeps the function's OID, so the trigger that
-- already points at it (trg_deal_ticket_financing_gate) picks up the
-- new body without being touched.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_ddl constant text := $ddl$
create table if not exists installment_plans (
  id                 uuid        primary key default gen_random_uuid(),
  deal_ticket_id     uuid        not null unique references deal_tickets(id),
  branch_id          uuid        not null references branches(id),
  principal          numeric     not null check (principal > 0),
  annual_flat_rate   numeric     check (annual_flat_rate is null
                                        or (annual_flat_rate >= 0 and annual_flat_rate <= 100)),
  months             int         not null check (months > 0 and months <= 120),
  start_date         date        not null,
  monthly_amount     numeric     not null check (monthly_amount > 0),
  total_payable      numeric     not null check (total_payable >= principal),
  ownership_retained boolean     not null default true,
  status             text        not null default 'active'
                                 check (status in ('active','settled','defaulted')),
  notes              text,
  created_by         uuid        references profiles(id),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create index if not exists idx_installment_plans_branch on installment_plans(branch_id);
create index if not exists idx_installment_plans_status on installment_plans(status);

create table if not exists installment_lines (
  id          uuid        primary key default gen_random_uuid(),
  plan_id     uuid        not null references installment_plans(id) on delete cascade,
  seq         int         not null,
  due_date    date        not null,
  amount_due  numeric     not null check (amount_due > 0),
  amount_paid numeric     not null default 0 check (amount_paid >= 0),
  paid_at     timestamptz,
  constraint installment_lines_plan_seq_unique unique (plan_id, seq)
);

create index if not exists idx_installment_lines_plan on installment_lines(plan_id);
create index if not exists idx_installment_lines_due  on installment_lines(due_date);

create table if not exists cheques (
  id                uuid        primary key default gen_random_uuid(),
  branch_id         uuid        not null references branches(id),
  deal_ticket_id    uuid        references deal_tickets(id),
  plan_id           uuid        references installment_plans(id),
  cheque_number     text        not null,
  bank_name         text        not null,
  drawer_name       text        not null,
  amount            numeric     not null check (amount > 0),
  due_date          date        not null,
  status            text        not null default 'in_safe'
                                check (status in ('in_safe','deposited','cleared','bounced','returned_to_customer')),
  status_changed_at timestamptz,
  note              text,
  created_by        uuid        references profiles(id),
  created_at        timestamptz default now()
);

create index if not exists idx_cheques_branch_due on cheques(branch_id, due_date);
create index if not exists idx_cheques_plan       on cheques(plan_id);

create table if not exists receipts (
  id             uuid        primary key default gen_random_uuid(),
  branch_id      uuid        not null references branches(id),
  deal_ticket_id uuid        references deal_tickets(id),
  plan_id        uuid        references installment_plans(id),
  amount         numeric     not null check (amount > 0),
  method         text        not null check (method in ('cash','bank_transfer','cheque','instapay')),
  reference      text,
  payer_name     text,
  note           text,
  received_by    uuid        not null references profiles(id),
  received_at    timestamptz not null default now()
);

create index if not exists idx_receipts_branch on receipts(branch_id, received_at desc);
create index if not exists idx_receipts_plan   on receipts(plan_id);

create or replace function enforce_in_house_installment_plan() returns trigger as $trg$
declare
  v_branch  uuid;
  v_type    text;
  v_partner uuid;
begin
  select branch_id, financing_type, financing_partner_id
    into v_branch, v_type, v_partner
    from deal_tickets
   where id = new.deal_ticket_id;

  if not found then
    raise exception 'That deal ticket does not exist, or you cannot see it';
  end if;

  if v_type <> 'installments' then
    raise exception 'An in-house payment plan belongs to an instalments deal, not a cash one';
  end if;

  if v_partner is not null then
    raise exception 'This deal is financed by a bank. An in-house payment plan is only for deals the showroom finances itself';
  end if;

  if new.branch_id is distinct from v_branch then
    raise exception 'A payment plan must carry the branch of its own deal ticket';
  end if;

  return new;
end;
$trg$ language plpgsql;

create or replace function guard_cheque_status() returns trigger as $trg$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('in_safe', 'deposited') then
      raise exception 'A cheque is recorded in the safe, or as deposited. Move it from there';
    end if;
    new.status_changed_at := now();
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'in_safe'   and new.status in ('deposited', 'returned_to_customer'))
      or (old.status = 'deposited' and new.status in ('cleared', 'bounced'))
      or (old.status = 'bounced'   and new.status = 'deposited')
    ) then
      raise exception 'A cheque cannot move from % to %', old.status, new.status;
    end if;
    new.status_changed_at := now();
  else
    new.status_changed_at := old.status_changed_at;
  end if;

  new.branch_id      := old.branch_id;
  new.deal_ticket_id := old.deal_ticket_id;
  new.plan_id        := old.plan_id;
  new.cheque_number  := old.cheque_number;
  new.bank_name      := old.bank_name;
  new.drawer_name    := old.drawer_name;
  new.amount         := old.amount;
  new.due_date       := old.due_date;
  new.created_by     := old.created_by;
  new.created_at     := old.created_at;

  return new;
end;
$trg$ language plpgsql;

create or replace function enforce_financing_partner_active() returns trigger as $trg$
begin
  -- 0033: see the file header. A NAMED partner must still be active;
  -- a ticket that names none is the showroom's own book.
  if new.financing_type = 'installments' and new.financing_partner_id is not null then
    if not exists (
      select 1 from financing_partners
      where id = new.financing_partner_id and status = 'active'
    ) then
      raise exception 'Selected financing partner is not active yet (bank contract not uploaded)';
    end if;
  end if;
  return new;
end;
$trg$ language plpgsql;

alter table installment_plans enable row level security;
alter table installment_lines enable row level security;
alter table cheques           enable row level security;
alter table receipts          enable row level security;

drop policy if exists "installment_plans_select" on installment_plans;
create policy "installment_plans_select" on installment_plans for select
  using (can_read_branch(branch_id));

drop policy if exists "installment_plans_insert" on installment_plans;
create policy "installment_plans_insert" on installment_plans for insert
  with check (can_act_on_branch(branch_id) and created_by = auth.uid());

drop policy if exists "installment_plans_update" on installment_plans;
create policy "installment_plans_update" on installment_plans for update
  using (can_act_on_branch(branch_id))
  with check (can_act_on_branch(branch_id));

drop policy if exists "installment_lines_select" on installment_lines;
create policy "installment_lines_select" on installment_lines for select
  using (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_read_branch(p.branch_id)));

drop policy if exists "installment_lines_insert" on installment_lines;
create policy "installment_lines_insert" on installment_lines for insert
  with check (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_act_on_branch(p.branch_id)));

drop policy if exists "installment_lines_update" on installment_lines;
create policy "installment_lines_update" on installment_lines for update
  using (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_act_on_branch(p.branch_id)))
  with check (exists (
    select 1 from installment_plans p
     where p.id = installment_lines.plan_id and can_act_on_branch(p.branch_id)));

drop policy if exists "cheques_select" on cheques;
create policy "cheques_select" on cheques for select
  using (can_read_branch(branch_id));

drop policy if exists "cheques_insert" on cheques;
create policy "cheques_insert" on cheques for insert
  with check (can_act_on_branch(branch_id) and created_by = auth.uid());

drop policy if exists "cheques_update" on cheques;
create policy "cheques_update" on cheques for update
  using (can_act_on_branch(branch_id))
  with check (can_act_on_branch(branch_id));

drop policy if exists "receipts_select" on receipts;
create policy "receipts_select" on receipts for select
  using (can_read_branch(branch_id));

drop policy if exists "receipts_insert" on receipts;
create policy "receipts_insert" on receipts for insert
  with check (can_act_on_branch(branch_id) and received_by = auth.uid());

drop policy if exists "receipts_update" on receipts;
create policy "receipts_update" on receipts for update
  using (is_accountant_or_above() and can_act_on_branch(branch_id))
  with check (is_accountant_or_above() and can_act_on_branch(branch_id));

drop trigger if exists trg_in_house_plan_gate on installment_plans;
create trigger trg_in_house_plan_gate
  before insert or update on installment_plans
  for each row execute function enforce_in_house_installment_plan();

drop trigger if exists trg_installment_plans_updated_at on installment_plans;
create trigger trg_installment_plans_updated_at
  before update on installment_plans
  for each row execute function set_updated_at();

drop trigger if exists trg_guard_cheque_status on cheques;
create trigger trg_guard_cheque_status
  before insert or update on cheques
  for each row execute function guard_cheque_status();

drop trigger if exists trg_audit_installment_plans on installment_plans;
create trigger trg_audit_installment_plans
  after insert or update or delete on installment_plans
  for each row execute function record_audit();

drop trigger if exists trg_audit_cheques on cheques;
create trigger trg_audit_cheques
  after insert or update or delete on cheques
  for each row execute function record_audit();

drop trigger if exists trg_audit_receipts on receipts;
create trigger trg_audit_receipts
  after insert or update or delete on receipts
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- deal_tickets is both the anchor of every plan and the table the
    -- widened financing gate lives on; its absence tells a
    -- half-provisioned tenant from a complete one.
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      raise notice '0033: %.deal_tickets missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- The three functions above were created WITHOUT a SET clause,
    -- because a `set search_path = t_<slug>` written into c_ddl would
    -- have to be interpolated per tenant and c_ddl is a constant. Pin
    -- them here instead: assertion (e) inside create_tenant_schema()
    -- requires every function outside the seven inlinable predicates to
    -- carry one, and an unpinned trigger function is the exact hazard
    -- 0009 §4's header describes — it resolves against whatever path
    -- the CALLER had, which for a PostgREST session is not this schema.
    execute format(
      'alter function %I.enforce_in_house_installment_plan() set search_path = %I, extensions',
      r.schema_name, r.schema_name
    );
    execute format(
      'alter function %I.guard_cheque_status() set search_path = %I, extensions',
      r.schema_name, r.schema_name
    );
    execute format(
      'alter function %I.enforce_financing_partner_active() set search_path = %I, extensions',
      r.schema_name, r.schema_name
    );

    -- §6a's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards — these are what make the
    -- four tables reachable, and by exactly whom. No DELETE for the
    -- tenant role; see the policy note in §2.
    execute format(
      'grant select, insert, update on %I.installment_plans, %I.installment_lines, %I.cheques to %I',
      r.schema_name, r.schema_name, r.schema_name, r.role_name
    );
    execute format('grant select, insert on %I.receipts to %I', r.schema_name, r.role_name);
    execute format(
      'grant update (reference, note) on %I.receipts to %I', r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.installment_plans, %I.installment_lines, '
      '%I.cheques, %I.receipts to service_role',
      r.schema_name, r.schema_name, r.schema_name, r.schema_name
    );
    execute format(
      'revoke all on table %I.installment_plans, %I.installment_lines, %I.cheques, %I.receipts '
      'from public, anon, authenticated',
      r.schema_name, r.schema_name, r.schema_name, r.schema_name
    );
    -- Postgres grants EXECUTE on a new function to PUBLIC by default,
    -- and 0009 §6h's blanket revoke ran at provisioning. Two of these
    -- three are new here.
    execute format(
      'revoke all on function %I.enforce_in_house_installment_plan(), %I.guard_cheque_status() '
      'from public, anon, authenticated',
      r.schema_name, r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0033: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0033: % tenant schema(s) carry the receivable book.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — structure, isolation, lockdown, that every policy
-- bound to THIS schema's predicates, and that the financing gate was
-- actually widened rather than merely recompiled.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_tbl  text;
  v_priv text;
  v_trg  text;
  v_fn   text;
  n      int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      continue;
    end if;

    foreach v_tbl in array array['installment_plans', 'installment_lines', 'cheques', 'receipts'] loop
      if to_regclass(format('%I.%I', r.schema_name, v_tbl)) is null then
        v_bad := v_bad || format('%s (%s missing)', r.schema_name, v_tbl);
        continue;
      end if;

      if not exists (
        select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = r.schema_name and c.relname = v_tbl and c.relrowsecurity
      ) then
        v_bad := v_bad || format('%s (%s rls off)', r.schema_name, v_tbl);
      end if;

      -- Three policies each, and no fourth: a DELETE policy appearing
      -- here would be somebody deciding money can be erased.
      select count(*) into n
        from pg_policy p
        join pg_class c      on c.oid = p.polrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = v_tbl;
      if n <> 3 then
        v_bad := v_bad || format('%s (%s has %s policies, expected 3)', r.schema_name, v_tbl, n);
      end if;

      -- The silent disaster: a policy bound to another schema's
      -- can_read_branch(). pg_get_expr schema-qualifies only what is
      -- NOT on the current search_path, which §3 cleared.
      select count(*) into n
        from pg_policy p
        join pg_class c      on c.oid = p.polrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = v_tbl
         and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
             || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
             !~ ('\m' || r.schema_name || '\M');
      if n > 0 then
        v_bad := v_bad || format('%s (%s: %s policy expr(s) not bound to this schema)',
                                 r.schema_name, v_tbl, n);
      end if;

      -- One privilege per call, deliberately: has_table_privilege()
      -- with a comma-separated list returns true if ANY of them is
      -- held, so a combined call would pass on SELECT alone.
      if not has_table_privilege(r.role_name, format('%I.%I', r.schema_name, v_tbl), 'select') then
        v_bad := v_bad || format('%s (role cannot read %s)', r.schema_name, v_tbl);
      end if;
      if not has_table_privilege(r.role_name, format('%I.%I', r.schema_name, v_tbl), 'insert') then
        v_bad := v_bad || format('%s (role cannot insert %s)', r.schema_name, v_tbl);
      end if;

      -- DELETE is withheld deliberately and assertion (j) depends on
      -- it; assert here too, or a later blanket grant hands it over
      -- with nobody deciding so.
      if has_table_privilege(r.role_name, format('%I.%I', r.schema_name, v_tbl), 'delete') then
        v_bad := v_bad || format('%s (role holds delete on %s)', r.schema_name, v_tbl);
      end if;

      if has_table_privilege('authenticated', format('%I.%I', r.schema_name, v_tbl),
           'select, insert, update, delete, truncate, references, trigger')
         or has_table_privilege('anon', format('%I.%I', r.schema_name, v_tbl),
           'select, insert, update, delete, truncate, references, trigger') then
        v_bad := v_bad || format('%s (%s: anon/authenticated hold a privilege)', r.schema_name, v_tbl);
      end if;
    end loop;

    -- The three writable tables carry a table-level UPDATE; receipts
    -- deliberately does NOT — its update is column-limited to
    -- reference and note, which has_table_privilege() reports as false
    -- and has_column_privilege() as true. Both directions are asserted,
    -- because a later blanket `grant update on receipts` would be
    -- invisible otherwise.
    foreach v_tbl in array array['installment_plans', 'installment_lines', 'cheques'] loop
      if not has_table_privilege(r.role_name, format('%I.%I', r.schema_name, v_tbl), 'update') then
        v_bad := v_bad || format('%s (role cannot update %s)', r.schema_name, v_tbl);
      end if;
    end loop;

    if has_table_privilege(r.role_name, format('%I.receipts', r.schema_name), 'update') then
      v_bad := v_bad || format('%s (role holds a table-wide update on receipts)', r.schema_name);
    end if;
    foreach v_priv in array array['reference', 'note'] loop
      if not has_column_privilege(
           r.role_name, format('%I.receipts', r.schema_name), v_priv, 'update') then
        v_bad := v_bad || format('%s (role cannot correct receipts.%s)', r.schema_name, v_priv);
      end if;
    end loop;
    foreach v_priv in array array['amount', 'method', 'received_by'] loop
      if has_column_privilege(
           r.role_name, format('%I.receipts', r.schema_name), v_priv, 'update') then
        v_bad := v_bad || format('%s (role can rewrite receipts.%s)', r.schema_name, v_priv);
      end if;
    end loop;

    foreach v_trg in array array[
      'trg_in_house_plan_gate', 'trg_installment_plans_updated_at',
      'trg_audit_installment_plans'
    ] loop
      if not exists (
        select 1 from pg_trigger t
        join pg_class c      on c.oid = t.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = r.schema_name and c.relname = 'installment_plans'
           and t.tgname = v_trg and not t.tgisinternal
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_trg);
      end if;
    end loop;

    foreach v_trg in array array['trg_guard_cheque_status', 'trg_audit_cheques'] loop
      if not exists (
        select 1 from pg_trigger t
        join pg_class c      on c.oid = t.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = r.schema_name and c.relname = 'cheques'
           and t.tgname = v_trg and not t.tgisinternal
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_trg);
      end if;
    end loop;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'receipts'
         and t.tgname = 'trg_audit_receipts' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (missing trg_audit_receipts)');
    end if;

    -- Assertion (e)'s rule, applied to the three functions this file
    -- touched: pinned, and pinned to THIS schema. An unpinned trigger
    -- function resolves against the caller's path.
    foreach v_fn in array array[
      'enforce_in_house_installment_plan', 'guard_cheque_status',
      'enforce_financing_partner_active'
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

    -- Assertion (f) itself, re-run against the live schema. A count
    -- other than twenty here means something else drifted, and this
    -- file would be blamed for it at the next provisioning.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> 20 then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, expected 20)', r.schema_name, n);
    end if;

    -- The widening actually took. prosrc is the function's own text, so
    -- this reads what Postgres will run rather than what §3 sent.
    if exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name
         and p.proname = 'enforce_financing_partner_active'
         and p.prosrc like '%requires a financing partner%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (financing gate still refuses an in-house ticket)');
    end if;

    -- The unique index behind one-plan-per-ticket. Without it two
    -- schedules can be written against one car and every outstanding
    -- figure in the group doubles for that deal.
    if not exists (
      select 1 from pg_constraint c
      join pg_class t      on t.oid = c.conrelid
      join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = r.schema_name and t.relname = 'installment_plans'
         and c.contype = 'u'
    ) then
      v_bad := v_bad || (r.schema_name || ' (installment_plans has no unique deal_ticket_id)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0033 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists installment_plans' in platform.tenant_ddl_template()) = 0
     or position('create table if not exists installment_lines' in platform.tenant_ddl_template()) = 0
     or position('create table if not exists cheques' in platform.tenant_ddl_template()) = 0
     or position('create table if not exists receipts' in platform.tenant_ddl_template()) = 0
     or position('"installment_plans_select" on installment_plans' in platform.tenant_ddl_template()) = 0
     or position('grant update (reference, note) on receipts' in platform.tenant_ddl_template()) = 0
     or position('create or replace function guard_cheque_status()' in platform.tenant_ddl_template()) = 0
     or position('create or replace function enforce_in_house_installment_plan()' in platform.tenant_ddl_template()) = 0 then
    raise exception '0033 VERIFY FAILED: the template does not carry the receivable book.';
  end if;

  if position('An installments deal requires a financing partner' in platform.tenant_ddl_template()) > 0 then
    raise exception '0033 VERIFY FAILED: the template still refuses a partnerless installments ticket.';
  end if;

  raise notice '0033: verified — the showroom can lend its own money, everywhere.';
end
$$;

-- PostgREST caches the schema; without this all four tables are
-- rejected as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
