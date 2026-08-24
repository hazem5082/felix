-- ============================================================
-- 0050 — SHOWROOM FEES: A REAL RUNNING COST, AND A CEO WHO CAN STEER IT
--
-- Since 0001 the waterfall has subtracted an "overhead" from a sale
-- before the cap table divides what is left:
--
--     overhead_total := monthly_opex_amount * months_in_inventory
--
-- That is one hand-typed number per branch, multiplied by a 30-day
-- month count. Three things were wrong with it, and this migration fixes
-- all three.
--
-- (1) NOBODY COULD SAY WHERE THE NUMBER CAME FROM. A showroom's running
--     cost is the electricity, the water, the cleaner, the rent and the
--     security — a stack of bills. There was no place to record a single
--     one of them, so `monthly_opex_amount` was a guess a CEO retyped
--     whenever it felt stale, and an investor being charged for it had
--     nothing to read. `showroom_expenses` is that book, and
--     overhead_config.basis = 'average' derives the monthly rate from it.
--
-- (2) THERE WAS NO SWITCH AND NO CALENDAR. A CEO who wanted to stop
--     charging fees for a slow month, or to charge a different figure
--     for THIS month, had exactly one lever: overwrite the branch's only
--     number — which silently re-priced every month the car had already
--     been in stock, backwards, for every unsold car in the branch.
--     `overhead_config.fees_enabled` is the switch. `overhead_months` is
--     the calendar: one row per branch per month, and the fee a car
--     accrues is now integrated month by month over the months it was
--     actually held, each month at its own rate. Editing August changes
--     August. July keeps the rate July was charged at.
--
-- (3) A SOLD CAR'S FEE KEPT MOVING. This is the serious one. The ledger
--     rows execute_vehicle_sale() writes are the money, and they were
--     always fixed at settlement — but compute_sale_waterfall() recomputed
--     the fee LIVE, from today's config, every time anyone opened the
--     ticket. Raise the branch's opex from 200 to 600 and last quarter's
--     executed sale would redraw itself with a 600 fee and a smaller
--     profit than the ledger had actually paid out, with no indication
--     which of the two numbers was real. deal_tickets.overhead_snapshot
--     ends that: execute_vehicle_sale() records the fee it charged, and
--     an executed ticket is priced from the snapshot forever after.
--
-- AND THE ONE DELIBERATE EXCEPTION: THE CEO CAN STILL EDIT ONE SALE
-- -----------------------------------------------------------------
-- Freezing the fee must not mean nobody can ever correct it. A fee
-- charged against the wrong month, a bill that arrived late, a car that
-- sat on the forecourt for a reason that was not the investor's fault —
-- these are real, and the answer is a deliberate, attributed, audited
-- edit on THAT ticket, not a config change that quietly rewrites a
-- hundred others.
--
--     set_ticket_overhead(ticket, fee, reason)
--
-- is that edit. CEO only. It stores deal_tickets.overhead_override with
-- who set it, when, and why — and if the sale has already settled it
-- moves the money to match, by posting ADJUSTMENT ROWS to the ledger.
--
-- WHY ADJUSTMENT ROWS AND NOT AN UPDATE
-- --------------------------------------
-- ledger_entries is written by SECURITY DEFINER functions and by nothing
-- else; it has no UPDATE policy and the tenant role holds no DELETE.
-- That is the property that makes it worth trusting, and this migration
-- does not spend it. A fee moved from 200 to 600 posts, per equity
-- holder, a row for their share of the -400 difference — the original
-- rows stay exactly as settled, and the ledger reads as what it is: a
-- sale, then a correction to it, both attributable.
--
-- It is also why the adjustment rows carry type 'sale_profit_share'
-- rather than a new type. Every consumer of this table — the CEO
-- dashboard's MTD profit, the investor's wallet balance, the operating
-- report's "profit distributed", the ledger CSV — SUMS amounts by type
-- and holder. None of them counts rows: units sold comes from
-- deal_tickets. So a delta row makes every one of those figures correct
-- with no code change anywhere, which a new type would not have done —
-- it would have made all four silently wrong until each was found and
-- updated.
--
-- THE DELTA IS THE FEE DELTA, AND NOTHING ELSE
-- ---------------------------------------------
-- The adjustment is `old_fee - new_fee` divided by the cap table, NOT a
-- re-run of the whole waterfall against today's figures. A vehicle
-- expense recorded after settlement, a purchase price corrected, a
-- discount edited — none of those are what the CEO asked to change, and
-- folding them in silently would turn "fix the fee" into "re-settle the
-- sale". The cap table itself cannot have moved: trg_lock_splits has
-- refused edits to a sold car's splits since 0001.
--
-- WHAT A CONSIGNED CAR GETS: NOTHING. Same reasoning as 0032. There is
-- no cap table on a car the showroom does not own, the house earns a
-- commission rather than a profit share, and execute_vehicle_sale()
-- skips the waterfall for it entirely. set_ticket_overhead() refuses.
--
-- ROUNDING. split_amount() is extracted from the body
-- compute_sale_waterfall() has carried since 0009 — per-holder round()
-- then push the residual cent onto the CEO line — and is now the single
-- implementation used by both the waterfall and the adjustment. That is
-- what guarantees an adjustment sums to exactly the fee delta, the same
-- way a sale sums to exactly the net profit.
--
-- SEVEN NEW SECURITY DEFINER FUNCTIONS, so assertion (f) rises by seven.
-- §5 patches create_tenant_schema()'s own live source, 0037's technique
-- as 0045 used it — but READS the old number instead of hard-coding it,
-- and then checks the new one against what §3 actually built. 0037 and
-- 0045 each wrote their expected figure in by hand and this database has
-- since moved past what the migration history reads as; a constant here
-- would abort a correct migration over a number that is not this file's
-- business. §5's header has the full reasoning.
--
-- WHAT IS *NOT* CHANGED, ON PURPOSE
-- ----------------------------------
--   * overhead_config.basis defaults to 'manual'. A showroom that
--     records no bills is charged exactly what it is charged today. The
--     average is opt-in, per branch, and even then falls back to the
--     manual figure for any month with nothing recorded — switching the
--     basis over must never silently stop billing.
--   * compute_sale_waterfall() and preview_vehicle_sale_waterfall() keep
--     their signatures. Adding a parameter with a DEFAULT would have
--     created an OVERLOAD, not a replacement, and PostgREST would have
--     met two candidates at every call (PGRST203, 0026's lesson). The
--     new fee argument lives on waterfall_with_overhead() instead, and
--     compute_sale_waterfall() becomes a thin wrapper over it.
--   * months_in_inventory keeps its 30-day definition. It is a display
--     figure and four screens read it; the FEE no longer uses it.
--
-- NO auth.uid() IN ANY POLICY HERE. 0045's 42501 lesson, restated by
-- 0046: a policy is evaluated as the tenant role, which has no USAGE on
-- schema auth. Every policy below is is_ceo() / is_accountant_or_above()
-- and nothing else; created_by and updated_by are set by the server
-- action, and inside set_ticket_overhead() — a SECURITY DEFINER function,
-- where auth.uid() is perfectly legal. §6 asserts the ban held.
--
-- NO DELETE, ANYWHERE. Assertion (j) refuses a DELETE grant to the
-- tenant role regardless, so a mis-keyed bill is VOIDED
-- (showroom_expenses.voided_at) rather than erased, and a voided row is
-- excluded from every average. Same shape as consignment_payouts having
-- no unpay.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor and replacement into the template's own
-- convention first (0036's header explains why).
--
-- GATE. On 0046 — the anchors are the company-profile block's, the
-- newest stable landmarks in the template.
--
-- Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $mig$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception '0050 PRECONDITION FAILED: platform.tenant_ddl_template() missing. Apply 0009 first.';
  end if;
  if position('create table if not exists company_settings' in platform.tenant_ddl_template()) = 0 then
    raise exception '0050 PRECONDITION FAILED: the template has no company profile. Apply 0046 first.';
  end if;
  if position('create or replace function compute_sale_waterfall(' in platform.tenant_ddl_template()) = 0 then
    raise exception '0050 PRECONDITION FAILED: compute_sale_waterfall() is not in the template. Template drifted from 0009.';
  end if;
  if position('create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)' in platform.tenant_ddl_template()) = 0 then
    raise exception '0050 PRECONDITION FAILED: execute_vehicle_sale() is not in the template. Template drifted from 0032.';
  end if;
end
$mig$;

-- ============================================================
-- 1-bis. THE FUNCTION BODIES, ONCE
--
-- Written with {{SCHEMA}} still unsubstituted, because both consumers
-- need them: §2 splices this text into the template verbatim, and §3
-- executes it into each live schema with {{SCHEMA}} replaced by that
-- schema's own quoted name. Holding one copy is the only way the two
-- can be guaranteed to agree — 0032's felix_0032_fn pattern.
-- ============================================================
create temp table felix_0050_fn (name text primary key, ord int, body text) on commit drop;

-- ── (1) split_amount ────────────────────────────────────────
insert into felix_0050_fn values ('split_amount', 1,
$fnbody$-- Divide an amount across a vehicle's cap table, exactly.
--
-- Extracted verbatim from the body compute_sale_waterfall() has carried
-- since 0009: round each holder's share to the cent, then push whatever
-- the rounding failed to allocate onto the CEO's line, so the shares sum
-- to the amount and not to a cent either side of it.
--
-- It lives on its own now because 0050 added a SECOND caller — the fee
-- adjustment in set_ticket_overhead() — and two hand-copied
-- implementations of a rounding rule is how a ledger stops balancing.
--
-- If the cap table has no CEO line the residual is DROPPED rather than
-- forced onto an investor. That is the pre-existing behaviour and it is
-- deliberate: an investor's share is a contractual percentage and must
-- not silently acquire somebody else's rounding error.
create or replace function split_amount(p_vehicle_id uuid, p_amount numeric)
returns jsonb as $fn$
declare
  shares    jsonb;
  allocated numeric;
  remainder numeric;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'holder_type', s.holder_type,
    'holder_id',   s.holder_id,
    'percentage',  s.percentage,
    'share',       round(p_amount * s.percentage / 100, 2)
  ) order by s.holder_type, s.holder_id), '[]'::jsonb) into shares
  from vehicle_equity_splits s where s.vehicle_id = p_vehicle_id;

  select coalesce(sum((e->>'share')::numeric), 0) into allocated
    from jsonb_array_elements(shares) e;
  remainder := round(p_amount - allocated, 2);

  if remainder <> 0 and jsonb_array_length(shares) > 0 then
    select jsonb_agg(
      case when (e->>'holder_type') = 'ceo'
        then jsonb_set(e, '{share}', to_jsonb(round((e->>'share')::numeric + remainder, 2)))
        else e end
    ) into shares
    from jsonb_array_elements(shares) e;
  end if;

  return shares;
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (2) effective_overhead_rate ─────────────────────────────
insert into felix_0050_fn values ('effective_overhead_rate', 2,
$fnbody$-- What one month of showroom fee costs, for one branch, in one month.
--
-- THE RESOLUTION ORDER, most specific first:
--
--   1. overhead_months  — the CEO said what THIS month costs. Carries its
--      own enabled flag, so a single month can be switched off without
--      switching the branch off.
--   2. overhead_config.fees_enabled = false — the branch charges nothing.
--   3. basis = 'average' — the mean of the months that actually have
--      bills recorded, within the trailing window ending at this month.
--      Divided by the number of months WITH data, not by the window
--      width: a showroom two months into keeping records would otherwise
--      have its true cost quartered by four empty months.
--   4. basis = 'manual', or 'average' with nothing recorded in the
--      window — monthly_opex_amount, which is what every showroom is
--      charged today and therefore the only safe floor. An 'average'
--      basis that fell through to ZERO would silently stop billing the
--      instant a CEO switched the toggle, which is the opposite of what
--      switching to a measured figure is meant to mean.
--   5. No overhead_config row at all — zero. Same as today: the pre-0050
--      waterfall coalesced a missing row to zero too.
--
-- Voided bills are excluded from the average at every step (there is no
-- DELETE on this table, by design — see the file header).
--
-- Returns jsonb rather than numeric because the CEO's control page has
-- to show WHERE each month's figure came from. A rate with no
-- provenance is the thing this migration exists to stop shipping.
create or replace function effective_overhead_rate(p_branch_id uuid, p_month date)
returns jsonb as $fn$
declare
  v_month  date := date_trunc('month', p_month::timestamp)::date;
  m        overhead_months%rowtype;
  c        overhead_config%rowtype;
  v_sum    numeric;
  v_months int;
begin
  select * into m from overhead_months
   where branch_id = p_branch_id and period_month = v_month;
  if found then
    return jsonb_build_object(
      'rate',    case when m.enabled then round(m.rate_amount, 2) else 0 end,
      'enabled', m.enabled,
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
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (3) overhead_between ────────────────────────────────────
insert into felix_0050_fn values ('overhead_between', 3,
$fnbody$-- The fee a car accrues between two instants, month by month.
--
-- REPLACES `monthly_opex_amount * months_in_inventory`, and the
-- difference is the whole point of 0050: that expression priced every
-- month a car had ever been in stock at TODAY's rate, so editing the
-- rate rewrote history. This walks the calendar months the car was
-- actually held, prices each at ITS OWN rate, and prorates the first and
-- last by the fraction of the month covered. Editing August changes what
-- August costs and nothing else.
--
-- UTC, explicitly. date_trunc('month', timestamptz) resolves against the
-- SESSION's TimeZone, so the same car could accrue a different fee
-- depending on who was looking. Both bounds are converted to plain
-- `timestamp` at UTC on the way in and every arithmetic below is
-- timezone-free.
--
-- Prorating is by elapsed time over the length of THAT month, so a
-- February day is worth more than a July day — which is right: the rent
-- is monthly, not daily.
--
-- THE 20-YEAR CLAMP is a guard, not a policy. created_at is
-- `default now()` and cannot legitimately predate the showroom, but a
-- bad backfill or an imported legacy row with a 1970 date would
-- otherwise make this loop a million iterations inside a waterfall the
-- UI blocks on.
create or replace function overhead_between(p_branch_id uuid, p_from timestamptz, p_to timestamptz)
returns numeric as $fn$
declare
  v_from  timestamp := p_from at time zone 'UTC';
  v_to    timestamp := p_to   at time zone 'UTC';
  v_total numeric   := 0;
  v_start timestamp;
  v_end   timestamp;
  r       record;
begin
  if p_branch_id is null or v_from is null or v_to is null then
    return 0;
  end if;
  if v_to <= v_from then
    return 0;
  end if;
  if v_from < v_to - interval '20 years' then
    v_from := v_to - interval '20 years';
  end if;

  for r in
    select g as month_start
      from generate_series(date_trunc('month', v_from), date_trunc('month', v_to), interval '1 month') g
  loop
    v_start := greatest(v_from, r.month_start);
    v_end   := least(v_to, r.month_start + interval '1 month');
    if v_end > v_start then
      v_total := v_total
        + (effective_overhead_rate(p_branch_id, r.month_start::date)->>'rate')::numeric
          * (extract(epoch from (v_end - v_start))
             / extract(epoch from ((r.month_start + interval '1 month') - r.month_start)));
    end if;
  end loop;

  return round(v_total, 2);
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (4) waterfall_with_overhead ─────────────────────────────
insert into felix_0050_fn values ('waterfall_with_overhead', 4,
$fnbody$-- The waterfall proper, with the fee handed to it rather than computed.
--
-- This is compute_sale_waterfall()'s body from 0009 with exactly one
-- change: overhead_total is a parameter. Everything else — the four-way
-- authorization check, months_in_inventory, the expense sum, the
-- rounding residual, the returned key set — is carried over unchanged,
-- because four screens and two reports read that shape.
--
-- Splitting it out is what lets a fee come from three different places
-- without three copies of the arithmetic:
--   compute_sale_waterfall()  — live, from the calendar (unsold cars).
--   ticket_waterfall()        — the snapshot, or the CEO's override.
--   execute_vehicle_sale()    — the figure it is about to freeze.
--
-- A NEGATIVE FEE IS CLAMPED TO ZERO rather than rejected. The callers
-- all check their own inputs; this is the last line, and a fee that
-- ADDED profit would be indistinguishable from a legitimate one in every
-- report downstream.
create or replace function waterfall_with_overhead(
  p_vehicle_id   uuid,
  p_agreed_price numeric,
  p_discount     numeric,
  p_overhead     numeric,
  p_as_of        timestamptz
) returns jsonb as $fn$
declare
  v vehicles%rowtype;
  months_in_inventory numeric;
  overhead_total      numeric;
  total_expenses      numeric;
  net_profit          numeric;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  -- ROLE + BRANCH + equity-holder check (0003 §7). KEEP VERBATIM. This is
  -- the whole of the authorisation: SECURITY DEFINER means vehicles_select
  -- never runs. An accountant sees every branch; everyone else sees their
  -- own branch's cars, or a car they personally hold equity in.
  if not (is_ceo() or is_accountant_or_above()
          or v.branch_id = current_branch_id()
          or exists (select 1 from vehicle_equity_splits s
                      where s.vehicle_id = v.id and s.holder_id = auth.uid())) then
    raise exception 'Not authorized to view this vehicle''s waterfall';
  end if;

  months_in_inventory := greatest(extract(epoch from (p_as_of - v.created_at)) / (30*86400), 0);

  select coalesce(sum(amount),0) into total_expenses
    from vehicle_expenses where vehicle_id = v.id;

  overhead_total := round(greatest(coalesce(p_overhead, 0), 0), 2);

  net_profit := round(
    p_agreed_price - v.purchase_price - total_expenses - overhead_total - coalesce(p_discount,0), 2);

  return jsonb_build_object(
    'sale_price',          p_agreed_price,
    'purchase_price',      v.purchase_price,
    'total_expenses',      total_expenses,
    'months_in_inventory', round(months_in_inventory, 2),
    'overhead_total',      overhead_total,
    'discount',            coalesce(p_discount, 0),
    'net_profit',          net_profit,
    'shares',              split_amount(v.id, net_profit)
  );
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (5) compute_sale_waterfall (REPLACED) ───────────────────
insert into felix_0050_fn values ('compute_sale_waterfall', 5,
$fnbody$-- ── The waterfall ───────────────────────────────────────────
-- Both the preview and the commit need identical inputs, or a manager
-- approves one number and books another. This single source of truth is
-- SECURITY DEFINER so every role — including a sales_exec, who cannot read
-- vehicle_expenses or overhead_config — sees the true figures instead of
-- silently getting zeros. It takes an explicit as-of timestamp so the
-- preview and the execution agree on months_in_inventory.
--
-- 0050: the arithmetic moved to waterfall_with_overhead() and the fee
-- to overhead_between(). This function is now the LIVE view — what the
-- car has accrued up to p_as_of, at each month's own rate — which is the
-- right answer for a car still in stock and the WRONG one for a car
-- already sold. Sold cars go through ticket_waterfall(), which reads the
-- snapshot execute_vehicle_sale() froze. See the file header.
--
-- The signature is deliberately unchanged. A fifth parameter with a
-- DEFAULT would have created an overload rather than a replacement, and
-- PostgREST would then have met two candidates at every call (PGRST203).
create or replace function compute_sale_waterfall(
  p_vehicle_id uuid,
  p_agreed_price numeric,
  p_discount numeric default 0,
  p_as_of timestamptz default now()
) returns jsonb as $fn$
declare
  v_branch  uuid;
  v_created timestamptz;
begin
  select branch_id, created_at into v_branch, v_created
    from vehicles where id = p_vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  return waterfall_with_overhead(
    p_vehicle_id,
    p_agreed_price,
    p_discount,
    overhead_between(v_branch, v_created, p_as_of),
    p_as_of);
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (6) ticket_waterfall ────────────────────────────────────
insert into felix_0050_fn values ('ticket_waterfall', 6,
$fnbody$-- The waterfall AS THIS TICKET IS PRICED — which is not the same
-- question as "what would this car's waterfall be today".
--
-- Three fee sources, most specific first:
--   override — the CEO edited this sale deliberately (set_ticket_overhead).
--   snapshot — the sale has settled; this is the fee it actually paid.
--   auto     — still open, so the live accrual applies and will keep
--              moving until it settles.
--
-- `overhead_auto` rides along in every case so the UI can show the CEO
-- what the calendar WOULD charge next to what this ticket IS charged.
-- On a settled sale that gap is the whole story: it is how you see that
-- the branch's rate has moved since, without the sale moving with it.
--
-- as-of is executed_at for a settled sale, so months_in_inventory and
-- the expense total are also read as-of settlement rather than drifting
-- forward every time somebody opens the page.
--
-- Authorization is waterfall_with_overhead()'s four-way check, unchanged
-- and not duplicated here.
create or replace function ticket_waterfall(p_deal_ticket_id uuid)
returns jsonb as $fn$
declare
  t      deal_tickets%rowtype;
  v      vehicles%rowtype;
  v_auto numeric;
  v_used numeric;
  v_src  text;
  v_asof timestamptz;
begin
  select * into t from deal_tickets where id = p_deal_ticket_id;
  if not found then
    raise exception 'Deal ticket not found';
  end if;

  select * into v from vehicles where id = t.vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  v_asof := coalesce(t.executed_at, now());
  v_auto := overhead_between(v.branch_id, v.created_at, v_asof);

  if t.overhead_override is not null then
    v_used := t.overhead_override;
    v_src  := 'override';
  elsif t.status = 'executed' and t.overhead_snapshot is not null then
    v_used := t.overhead_snapshot;
    v_src  := 'snapshot';
  else
    v_used := v_auto;
    v_src  := 'auto';
  end if;

  return waterfall_with_overhead(v.id, t.agreed_price, t.discount_amount, v_used, v_asof)
      || jsonb_build_object(
           'overhead_source',          v_src,
           'overhead_auto',            v_auto,
           'overhead_locked',          (t.status = 'executed'),
           'overhead_override_reason', t.overhead_override_reason,
           'overhead_override_at',     t.overhead_override_at);
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (7) set_ticket_overhead ─────────────────────────────────
insert into felix_0050_fn values ('set_ticket_overhead', 7,
$fnbody$-- The CEO's per-sale fee edit — the one crack in the freeze, and the
-- reason the freeze is safe to have.
--
-- p_overhead null CLEARS the override: an open ticket falls back to the
-- live accrual, a settled one back to the fee it actually settled at.
-- Clearing moves money too, and by the same mechanism.
--
-- ON A SETTLED SALE this posts ADJUSTMENT ROWS rather than touching the
-- rows already written. See the file header for why the ledger is worth
-- more append-only than editable, and why the adjustment carries type
-- 'sale_profit_share' rather than a type of its own.
--
-- THE DELTA IS `old_fee - new_fee`: a fee going DOWN leaves more profit,
-- so the adjustment is positive. It is divided by split_amount() — the
-- same rounding rule the original sale used — so the adjustment sums to
-- exactly the delta and the holder totals stay exact to the cent.
--
-- IT IS THE FEE DELTA AND NOTHING ELSE. Not a re-run of the waterfall:
-- an expense recorded after settlement, or a corrected purchase price,
-- would otherwise be swept into an edit the CEO did not ask for. The cap
-- table cannot have moved — trg_lock_splits has refused edits to a sold
-- car's splits since 0001.
--
-- A CONSIGNED CAR IS REFUSED (0032): no cap table, no profit share,
-- nothing for a fee to reduce. The house's commission is a term of the
-- consignment agreement, not a showroom overhead.
--
-- SALESPERSON COMMISSION IS NOT REVISITED. It was earned on a sale that
-- was profitable at settlement and it is not clawed back because a fee
-- was corrected upward months later. Adjusting somebody's pay is a
-- payroll decision with its own screen, not a side effect of this one.
create or replace function set_ticket_overhead(
  p_deal_ticket_id uuid,
  p_overhead       numeric,
  p_reason         text default null
) returns jsonb as $fn$
declare
  t         deal_tickets%rowtype;
  v         vehicles%rowtype;
  v_old     numeric;
  v_new     numeric;
  v_delta   numeric;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  adj       jsonb;
  e         jsonb;
  v_rows    int := 0;
begin
  if not is_ceo() then
    raise exception 'Only the CEO can change the showroom fee on a sale';
  end if;

  if p_overhead is not null and p_overhead < 0 then
    raise exception 'A showroom fee cannot be negative';
  end if;

  select * into t from deal_tickets where id = p_deal_ticket_id for update;
  if not found then
    raise exception 'Deal ticket not found';
  end if;

  select * into v from vehicles where id = t.vehicle_id for update;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  if v.acquisition_type = 'consignment' then
    raise exception 'A consigned car carries no showroom fee — the house earns a commission, not a profit share';
  end if;

  -- What this ticket is charged BEFORE the edit.
  if t.overhead_override is not null then
    v_old := t.overhead_override;
  elsif t.status = 'executed' and t.overhead_snapshot is not null then
    v_old := t.overhead_snapshot;
  else
    v_old := overhead_between(v.branch_id, v.created_at, coalesce(t.executed_at, now()));
  end if;
  v_old := round(coalesce(v_old, 0), 2);

  -- And AFTER. Clearing falls back to the snapshot on a settled sale and
  -- to the live accrual on an open one.
  if p_overhead is not null then
    v_new := round(p_overhead, 2);
  elsif t.status = 'executed' then
    v_new := round(coalesce(t.overhead_snapshot, v_old), 2);
  else
    v_new := overhead_between(v.branch_id, v.created_at, now());
  end if;

  update deal_tickets set
    overhead_override        = case when p_overhead is null then null else v_new end,
    overhead_override_reason = case when p_overhead is null then null else v_reason end,
    overhead_override_by     = case when p_overhead is null then null else auth.uid() end,
    overhead_override_at     = case when p_overhead is null then null else now() end
  where id = t.id;

  v_delta := round(v_old - v_new, 2);

  if t.status = 'executed' and v_delta <> 0 then
    adj := split_amount(v.id, v_delta);

    for e in select * from jsonb_array_elements(adj) loop
      if round((e->>'share')::numeric, 2) <> 0 then
        insert into ledger_entries (
          holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
        values (
          e->>'holder_type',
          case when e->>'holder_type' = 'ceo' then null
               else (e->>'holder_id')::uuid end,
          'sale_profit_share',
          (e->>'share')::numeric,
          t.id, v.id,
          format('Showroom fee adjustment on %s %s %s (VIN %s): fee %s -> %s%s',
                 v.year, v.make, v.model, coalesce(v.vin, '—'), v_old, v_new,
                 case when v_reason is null then '' else ' — ' || v_reason end));
        v_rows := v_rows + 1;
      end if;
    end loop;
  end if;

  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
  values (auth.uid(), 'set_ticket_overhead', 'deal_ticket', t.id,
          jsonb_build_object(
            'old_overhead',      v_old,
            'new_overhead',      v_new,
            'delta',             v_delta,
            'ticket_status',     t.status,
            'cleared',           (p_overhead is null),
            'reason',            v_reason,
            'adjustment_rows',   v_rows));

  return jsonb_build_object(
    'old_overhead',    v_old,
    'new_overhead',    v_new,
    'delta',           v_delta,
    'adjusted',        (v_rows > 0),
    'adjustment_rows', v_rows,
    'cleared',         (p_overhead is null));
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (8) overhead_overview ───────────────────────────────────
insert into felix_0050_fn values ('overhead_overview', 8,
$fnbody$-- Everything the CEO's fee page needs, in one round trip.
--
-- An RPC rather than four PostgREST reads and a TypeScript reimplementation
-- of effective_overhead_rate(): the resolution order in that function is
-- the product rule, and a second copy of it in the browser is a second
-- copy that will disagree with the money.
--
-- Branch scoping mirrors the tables' own policies — CEO and accountant
-- see the group, everyone else sees the branches can_read_branch() allows.
-- Read-only and manager-or-accountant, deliberately wider than the WRITE
-- side: a branch manager whose stock is being charged a fee should be
-- able to see what the fee is and where it came from, without being able
-- to change it.
--
-- accrued_unsold is what the branch's CURRENT stock has run up so far —
-- money that will come off a profit share the day each car sells. It is
-- the number that makes the page worth opening, and it is deliberately
-- computed live rather than cached: it moves every day by construction.
create or replace function overhead_overview(p_months int default 12)
returns jsonb as $fn$
declare
  v_months   int  := least(greatest(coalesce(p_months, 12), 1), 36);
  v_this     date := date_trunc('month', (now() at time zone 'UTC'))::date;
  b          record;
  c          overhead_config%rowtype;
  m          date;
  r          jsonb;
  months_out jsonb;
  out_rows   jsonb := '[]'::jsonb;
  v_accrued  numeric;
  v_stock    int;
  v_hi       int;
begin
  v_hi := v_months - 1;
  if not (is_manager_or_above() or is_accountant_or_above()) then
    raise exception 'Not authorized to view the showroom fee configuration';
  end if;

  for b in
    select id, name from branches
     where is_ceo() or is_accountant_or_above() or can_read_branch(id)
     order by name
  loop
    select * into c from overhead_config where branch_id = b.id;

    months_out := '[]'::jsonb;
    for i in reverse v_hi .. 0 loop
      m := (v_this - make_interval(months => i))::date;
      r := effective_overhead_rate(b.id, m);
      months_out := months_out || jsonb_build_array(jsonb_build_object(
        'month',    m,
        'rate',     (r->>'rate')::numeric,
        'enabled',  (r->>'enabled')::boolean,
        'source',   r->>'source',
        'recorded', (select coalesce(sum(amount), 0) from showroom_expenses
                      where branch_id = b.id and period_month = m and voided_at is null),
        'bills',    (select count(*) from showroom_expenses
                      where branch_id = b.id and period_month = m and voided_at is null)
      ));
    end loop;

    select count(*), coalesce(sum(overhead_between(b.id, x.created_at, now())), 0)
      into v_stock, v_accrued
      from vehicles x
     where x.branch_id = b.id and x.status <> 'sold';

    r := effective_overhead_rate(b.id, v_this);

    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'branch_id',             b.id,
      'branch_name',           b.name,
      'fees_enabled',          coalesce(c.fees_enabled, false),
      'basis',                 coalesce(c.basis, 'manual'),
      'monthly_opex_amount',   round(coalesce(c.monthly_opex_amount, 0), 2),
      'average_window_months', coalesce(c.average_window_months, 6),
      'current_rate',          (r->>'rate')::numeric,
      'current_source',        r->>'source',
      'current_enabled',       (r->>'enabled')::boolean,
      'in_stock_count',        coalesce(v_stock, 0),
      'accrued_unsold',        round(coalesce(v_accrued, 0), 2),
      'months',                months_out
    ));
  end loop;

  return jsonb_build_object('this_month', v_this, 'branches', out_rows);
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ── (9) execute_vehicle_sale (REPLACED) ─────────────────────
--
-- 0032's body, with three changes and nothing else:
--   * the non-consignment leg resolves the fee itself — the CEO's
--     pre-set override if there is one, else the live accrual — and
--     calls waterfall_with_overhead() instead of compute_sale_waterfall();
--   * v_overhead is FROZEN onto the ticket in the same UPDATE that flips
--     it to 'executed', inside the same transaction as the ledger rows,
--     so the snapshot and the money can never disagree;
--   * the consignment leg sets v_overhead := 0 explicitly, because a
--     consigned car has no cap table and no fee (0032), and a NULL
--     snapshot would later read as "pre-0050, recompute me".
insert into felix_0050_fn values ('execute_vehicle_sale', 9,
$fnbody$create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)
returns jsonb as $fn$
declare
  t deal_tickets%rowtype;
  v vehicles%rowtype;
  w jsonb;
  net_profit numeric;
  share_row jsonb;
  commission numeric;
  -- One timestamp shared by the waterfall, both updates and the ledger, so
  -- preview and execution agree on months_in_inventory.
  v_as_of timestamptz := now();
  -- The showroom fee this sale is charged, frozen onto the ticket below
  -- (0050). Resolved once, used for the split AND for the snapshot, so
  -- the two cannot drift apart.
  v_overhead numeric;
  -- The consignment leg (0032): the price actually settled, what the
  -- house keeps of it, and what is left owing to the owner of the car.
  v_final      numeric;
  v_house_fee  numeric;
  v_owed       numeric;
  -- The trade-in leg (0032).
  v_trade_id   uuid;
  v_trade_vin  text;
  v_ticket_vin text;
  v_trade_desc text;
begin
  -- ROLE check (0001). KEEP VERBATIM.
  if not is_manager_or_above() then
    raise exception 'Only a branch manager or CEO can execute a sale';
  end if;

  select * into t from deal_tickets where id = p_deal_ticket_id for update;
  if not found then
    raise exception 'Deal ticket not found';
  end if;

  -- BRANCH check (0003). KEEP VERBATIM. SECURITY DEFINER bypasses the
  -- branch filter in RLS, so without this a manager could settle any
  -- branch's ticket. Separating showrooms does nothing about branches
  -- WITHIN a showroom — this is still the only thing stopping the
  -- Alexandria manager from settling Cairo's sale.
  if not can_act_on_branch(t.branch_id) then
    raise exception 'Not authorized to execute a sale for this branch';
  end if;

  if t.status <> 'approved' then
    raise exception 'Deal ticket must be approved before it can be executed (current status: %)', t.status;
  end if;

  select * into v from vehicles where id = t.vehicle_id for update;
  if v.status = 'sold' then
    raise exception 'Vehicle already sold';
  end if;

  -- Belt and braces against a double-post if two managers race.
  if exists (select 1 from ledger_entries
             where ref_deal_ticket_id = t.id and type = 'sale_profit_share') then
    raise exception 'This sale has already been posted to the ledger';
  end if;

  if v.acquisition_type = 'consignment' then
    -- ── CONSIGNMENT (بالأمانة) — 0032 ──────────────────────────
    -- compute_sale_waterfall() is skipped ENTIRELY, and not merely fed
    -- a zero cost: it divides a net profit among a cap table, and there
    -- is no cap table on a car the showroom does not own. What the house
    -- earns here is a COMMISSION; what is left is a debt to the owner.
    v_final := t.agreed_price - coalesce(t.discount_amount, 0);

    v_house_fee := case
      when v.consignment_commission_type = 'fixed'
        then coalesce(v.consignment_commission_value, 0)
      when v.consignment_commission_type = 'percent'
        then round(v_final * coalesce(v.consignment_commission_value, 0) / 100, 2)
      -- A car taken in before 0032's intake rule existed carries no
      -- commission terms at all. Zero is the only honest answer: the
      -- alternative is inventing a fee the consignor never agreed to.
      else 0
    end;

    -- consignment_payouts.amount_due is CHECKed >= 0, and a fixed fee
    -- typed larger than the car eventually sold for is a data-entry
    -- error, not a reason to refuse an otherwise valid sale. Clamp and
    -- record: the accountant sees a zero payout and asks.
    v_house_fee := greatest(least(v_house_fee, v_final), 0);
    v_owed      := round(v_final - v_house_fee, 2);

    -- 0050: no showroom fee on somebody else's car, and the snapshot is
    -- an explicit zero rather than NULL — NULL means "settled before
    -- 0050, recompute me", which is exactly the wrong answer here.
    v_overhead := 0;

    insert into consignment_payouts (
      vehicle_id, deal_ticket_id, consignor_name, amount_due, commission_amount, note)
    values (
      v.id, t.id,
      coalesce(nullif(btrim(coalesce(v.consignor_name, '')), ''), 'Consignor'),
      v_owed, v_house_fee,
      format('Consignment sale of %s %s %s (VIN %s) settled at %s',
             v.year, v.make, v.model, coalesce(v.vin, '—'), v_final));

    -- The commission is house income and nothing else: no investor holds
    -- a stake in a car the showroom never bought, so the ledger takes ONE
    -- CEO line rather than a split per holder. Reconditioning spent on a
    -- consigned car still lands in vehicle_expenses and still reduces
    -- what the house actually kept — it is netted in reporting, not here,
    -- because this row records the commission that was agreed.
    insert into ledger_entries (holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
    values ('ceo', null, 'sale_profit_share', v_house_fee, t.id, v.id,
            format('Consignment commission on %s %s %s — %s owed to %s',
                   v.year, v.make, v.model, v_owed,
                   coalesce(nullif(btrim(coalesce(v.consignor_name, '')), ''), 'the consignor')));

    -- Same shape as the waterfall's return, so every caller — the server
    -- action, the audit row, the UI — keeps working without a special
    -- case. purchase_price is 0 by construction and there is no cap
    -- table, hence the empty shares; the three extra keys are what the
    -- consignment view of the ticket reads.
    w := jsonb_build_object(
      'sale_price',          t.agreed_price,
      'purchase_price',      0,
      'total_expenses',      (select coalesce(sum(amount), 0)
                                from vehicle_expenses where vehicle_id = v.id),
      'months_in_inventory', round(greatest(
                               extract(epoch from (v_as_of - v.created_at)) / (30*86400), 0), 2),
      'overhead_total',      0,
      'discount',            coalesce(t.discount_amount, 0),
      'net_profit',          v_house_fee,
      'shares',              '[]'::jsonb,
      'acquisition_type',       'consignment',
      'consignment_commission', v_house_fee,
      'consignment_amount_due', v_owed
    );

    -- Drives the salesperson-commission gate below unchanged: they earn
    -- on a consignment exactly when the house did.
    net_profit := v_house_fee;
  else
    -- 0050: the showroom fee, resolved ONCE. A CEO who set an override on
    -- the ticket before approving it settles at that figure; everyone
    -- else settles at what the calendar says the car accrued, month by
    -- month, at each month's own rate.
    v_overhead := coalesce(t.overhead_override,
                           overhead_between(v.branch_id, v.created_at, v_as_of));

    w := waterfall_with_overhead(v.id, t.agreed_price, t.discount_amount, v_overhead, v_as_of);
    net_profit := (w->>'net_profit')::numeric;

    for share_row in select * from jsonb_array_elements(w->'shares') loop
      insert into ledger_entries (holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
      values (
        share_row->>'holder_type',
        case when share_row->>'holder_type' = 'ceo' then null
             else (share_row->>'holder_id')::uuid end,
        'sale_profit_share',
        (share_row->>'share')::numeric,
        t.id, v.id,
        format('Profit share from sale of %s %s %s (VIN %s)', v.year, v.make, v.model, coalesce(v.vin,'—'))
      );
    end loop;
  end if;

  update vehicles     set status = 'sold',     sold_at = v_as_of where id = v.id;
  -- 0050: the fee is frozen HERE, in the same statement that closes the
  -- ticket and the same transaction as the ledger rows above. From this
  -- point the sale is priced from the snapshot and a later config change
  -- cannot move it — only set_ticket_overhead() can, deliberately and
  -- with an audit row.
  update deal_tickets set status = 'executed', executed_at = v_as_of,
                          overhead_snapshot = round(coalesce(v_overhead, 0), 2)
   where id = t.id;

  -- Commission is only earned on a profitable sale, and is booked after
  -- the ticket flips to 'executed' so this unit counts toward the tier.
  if net_profit > 0 then
    commission := commission_for_sale(t.salesperson_id, v_as_of);
    if commission > 0 then
      insert into ledger_entries (holder_type, holder_id, type, amount, ref_deal_ticket_id, ref_vehicle_id, note)
      values ('sales_exec', t.salesperson_id, 'commission', commission, t.id, v.id,
              format('Commission for %s %s %s', v.year, v.make, v.model));
    end if;
  end if;

  -- ── TRADE-IN (تبديل) — 0032 ────────────────────────────────
  -- The buyer's old car enters stock inside THIS transaction, so a
  -- settled deal can never leave the trade-in unrecorded. The waterfall
  -- above was deliberately not adjusted for the allowance — see the file
  -- header: the allowance changes how the buyer settled, not what the
  -- car sold for, and it comes straight back as this row's cost basis.
  if t.trade_in_allowance is not null and t.trade_in_allowance > 0 then
    v_ticket_vin := nullif(btrim(coalesce(t.trade_in_vin, '')), '');
    v_trade_vin  := v_ticket_vin;

    -- vehicles.vin is UNIQUE per showroom, and a trade-in whose VIN was
    -- already typed onto some other row would abort a sale that is
    -- otherwise perfectly valid. The identifier is worth less than the
    -- settlement, so it is dropped into the description instead and the
    -- clerk reconciles it afterwards.
    if v_trade_vin is not null
       and exists (select 1 from vehicles x where x.vin = v_trade_vin) then
      v_trade_vin := null;
    end if;

    -- Odometer and notes fold into description: an odometer column
    -- belongs on every car and arrives in a later migration, so inventing
    -- one here would leave two of them.
    v_trade_desc := nullif(btrim(concat_ws(chr(10),
      nullif(btrim(coalesce(t.trade_in_notes, '')), ''),
      case when t.trade_in_odometer_km is not null
           then 'Odometer at trade-in: ' || t.trade_in_odometer_km || ' km' end,
      case when v_trade_vin is null and v_ticket_vin is not null
           then 'VIN on the ticket: ' || v_ticket_vin
                || ' (not stored on this row — another vehicle already holds it)' end,
      'Taken in as a trade-in against deal ticket ' || t.id || '.'
    )), '');

    insert into vehicles (
      branch_id, vin, year, make, model, color, description,
      acquisition_type, purchase_price, status, photos, created_by)
    values (
      t.branch_id,
      v_trade_vin,
      -- year is NOT NULL. Every ticket written through the app carries
      -- one; this coalesce is for rows that predate the form.
      coalesce(t.trade_in_year, extract(year from v_as_of)::int),
      coalesce(nullif(btrim(coalesce(t.trade_in_make, '')), ''), '—'),
      coalesce(nullif(btrim(coalesce(t.trade_in_model, '')), ''), '—'),
      nullif(btrim(coalesce(t.trade_in_color, '')), ''),
      v_trade_desc,
      'trade_in',
      t.trade_in_allowance,
      'in_stock',
      coalesce(t.trade_in_photos, '{}'),
      auth.uid())
    returning id into v_trade_id;

    -- ONE 100-PERCENT CEO LINE, and no investor anywhere on it. The allowance
    -- was paid out of the sale proceeds — company money — so the company
    -- owns this car outright. See the file header.
    insert into vehicle_equity_splits (vehicle_id, holder_type, holder_id, amount_invested, percentage)
    values (v_trade_id, 'ceo', null, t.trade_in_allowance, 100);
  end if;

  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
  values (auth.uid(), 'execute_vehicle_sale', 'deal_ticket', t.id,
          w || jsonb_build_object('commission', coalesce(commission, 0),
                                  'trade_in_vehicle_id', v_trade_id));

  return w || jsonb_build_object('commission', coalesce(commission, 0),
                                 'trade_in_vehicle_id', v_trade_id);
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ============================================================
-- 1-ter. THE TABLE DDL, ONCE
--
-- Same reasoning as 1-bis: §2 splices it into the template and §3
-- executes it into every live schema, so it is written down once.
-- `add column if not exists` and drop-then-add on the constraints make
-- it safe both as first-time provisioning DDL and as a re-run.
-- ============================================================
create temp table felix_0050_ddl (name text primary key, body text) on commit drop;

insert into felix_0050_ddl values ('tables',
$ddl$-- ------------------------------------------------------------
-- 7-bis. SHOWROOM FEES (0050)
--
-- showroom_expenses — the bills. What it actually costs to keep the
-- lights on, the floor clean and the doors open, one row per bill per
-- month per branch. overhead_config.basis = 'average' turns this book
-- into the monthly rate; on 'manual' it is recorded for the record and
-- charged nothing. Either way it is the first place in FELIX where the
-- fee an investor is charged has a paper trail behind it.
--
-- NO DELETE. Assertion (j) refuses the grant regardless, and a bill
-- keyed against the wrong month is VOIDED — voided_at set, excluded from
-- every average, still visible in the book. Same shape as
-- consignment_payouts having no unpay.
--
-- overhead_months — the CEO's calendar. One row per branch per month
-- overrides whatever the config would otherwise resolve to, including
-- switching a single month off without switching the branch off. Absent
-- rows are the normal case: this table holds the exceptions.
--
-- period_month is always the first of the month, enforced. A CHECK on
-- extract(day) rather than on date_trunc so it is unambiguously
-- IMMUTABLE and can live in a constraint at all.
-- ------------------------------------------------------------
create table if not exists showroom_expenses (
  id           uuid        primary key default gen_random_uuid(),
  branch_id    uuid        not null references branches(id),
  period_month date        not null,
  category     text        not null,
  amount       numeric     not null,
  note         text,
  voided_at    timestamptz,
  voided_by    uuid        references profiles(id),
  created_by   uuid        references profiles(id),
  created_at   timestamptz not null default now()
);

alter table showroom_expenses drop constraint if exists showroom_expenses_amount_positive;
alter table showroom_expenses add  constraint showroom_expenses_amount_positive check (amount > 0);
alter table showroom_expenses drop constraint if exists showroom_expenses_month_first;
alter table showroom_expenses add  constraint showroom_expenses_month_first check (extract(day from period_month) = 1);
alter table showroom_expenses drop constraint if exists showroom_expenses_category_known;
alter table showroom_expenses add  constraint showroom_expenses_category_known check (category in (
  'rent','electricity','water','gas','internet','phone','cleaning','maintenance',
  'security','salaries','transport','marketing','licenses','insurance','bank_fees','other'));

create index if not exists idx_showroom_expenses_branch_month on showroom_expenses(branch_id, period_month);
create index if not exists idx_showroom_expenses_live on showroom_expenses(branch_id, period_month) where voided_at is null;

create table if not exists overhead_months (
  branch_id    uuid        not null references branches(id),
  period_month date        not null,
  rate_amount  numeric     not null default 0,
  enabled      boolean     not null default true,
  note         text,
  updated_by   uuid        references profiles(id),
  updated_at   timestamptz not null default now(),
  primary key (branch_id, period_month)
);

alter table overhead_months drop constraint if exists overhead_months_rate_non_negative;
alter table overhead_months add  constraint overhead_months_rate_non_negative check (rate_amount >= 0);
alter table overhead_months drop constraint if exists overhead_months_month_first;
alter table overhead_months add  constraint overhead_months_month_first check (extract(day from period_month) = 1);

-- overhead_config gains the branch-level policy the per-month rows
-- override: the kill switch, where the rate comes from, and how far back
-- the average looks. basis defaults to 'manual' so no showroom's numbers
-- move on the day this migration lands.
alter table overhead_config add column if not exists fees_enabled          boolean not null default true;
alter table overhead_config add column if not exists basis                 text    not null default 'manual';
alter table overhead_config add column if not exists average_window_months int     not null default 6;
alter table overhead_config add column if not exists updated_by            uuid    references profiles(id);

alter table overhead_config drop constraint if exists overhead_config_basis_known;
alter table overhead_config add  constraint overhead_config_basis_known check (basis in ('manual','average'));
alter table overhead_config drop constraint if exists overhead_config_window_sane;
alter table overhead_config add  constraint overhead_config_window_sane check (average_window_months between 1 and 36);

-- deal_tickets carries the FROZEN fee and the CEO's deliberate exception
-- to it. overhead_snapshot NULL on an executed ticket means "settled
-- before 0050" and ticket_waterfall() falls back to recomputing, which
-- is the pre-0050 behaviour and the only honest answer for a sale whose
-- fee was never recorded. §4 backfills what it can.
alter table deal_tickets add column if not exists overhead_snapshot        numeric;
alter table deal_tickets add column if not exists overhead_override        numeric;
alter table deal_tickets add column if not exists overhead_override_reason text;
alter table deal_tickets add column if not exists overhead_override_by     uuid references profiles(id);
alter table deal_tickets add column if not exists overhead_override_at     timestamptz;

alter table deal_tickets drop constraint if exists deal_tickets_overhead_sane;
alter table deal_tickets add  constraint deal_tickets_overhead_sane check (
  (overhead_snapshot is null or overhead_snapshot >= 0)
  and (overhead_override is null or overhead_override >= 0));$ddl$
);

insert into felix_0050_ddl values ('rls',
$ddl$alter table showroom_expenses      enable row level security;
alter table overhead_months        enable row level security;$ddl$
);

insert into felix_0050_ddl values ('policies',
$ddl$-- ------------------------------------------------------------
-- 5u. SHOWROOM FEES — 0050
--
-- READ mirrors overhead_config_select exactly: manager-or-above or
-- accountant-or-above. A branch manager whose stock is being charged a
-- fee can see what it is; the sales floor cannot, for the same reason it
-- cannot see a purchase price (0028).
--
-- WRITE on the bills is is_accountant_or_above() — recording the
-- electricity bill is the accountant's job, not a board decision.
-- WRITE on the calendar is is_ceo() and nothing weaker: those rows change
-- what every equity holder in the branch is paid.
--
-- NO DELETE POLICY on either, and §6 grants none. A mis-keyed bill is
-- voided; a month override is disabled or set back to the branch figure.
--
-- NO auth.uid() ANYWHERE. A policy runs as the tenant role, which has no
-- USAGE on schema auth, so naming it raises 42501 and breaks the write
-- outright — 0045 had to repair exactly that in the price-history path.
-- created_by / updated_by are set by the server action.
-- ------------------------------------------------------------
drop policy if exists "showroom_expenses_select" on showroom_expenses;
create policy "showroom_expenses_select" on showroom_expenses for select
  using (is_manager_or_above() or is_accountant_or_above());

drop policy if exists "showroom_expenses_insert" on showroom_expenses;
create policy "showroom_expenses_insert" on showroom_expenses for insert
  with check (is_accountant_or_above());

drop policy if exists "showroom_expenses_update" on showroom_expenses;
create policy "showroom_expenses_update" on showroom_expenses for update
  using (is_accountant_or_above()) with check (is_accountant_or_above());

drop policy if exists "overhead_months_select" on overhead_months;
create policy "overhead_months_select" on overhead_months for select
  using (is_manager_or_above() or is_accountant_or_above());

drop policy if exists "overhead_months_insert" on overhead_months;
create policy "overhead_months_insert" on overhead_months for insert
  with check (is_ceo());

drop policy if exists "overhead_months_update" on overhead_months;
create policy "overhead_months_update" on overhead_months for update
  using (is_ceo()) with check (is_ceo());$ddl$
);

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Four single-line anchors (prepend, append, prepend, append) plus one
-- more for the RPC grants, and two function-span replacements.
-- Single-line on purpose: 0044's header explains why a multi-line span
-- anchor only ever works once.
-- ============================================================
do $mig$
declare
  v_tpl   text := platform.tenant_ddl_template();
  v_nl    text;
  v_done  int  := 0;
  v_at    int;
  v_len   int;
  v_rest  text;
  v_probe text;

  c_tbl_from text := $a1$create table if not exists company_settings ($a1$;
  c_tbl_to   text;

  c_rls_from text := $b1$alter table company_settings       enable row level security;$b1$;
  c_rls_to   text;

  c_pol_from text := $c1$drop policy if exists "company_settings_select" on company_settings;$c1$;
  c_pol_to   text;

  c_gnt_from text := $d1$grant select, insert, update, delete on company_settings to service_role;$d1$;
  c_gnt_to   text := $d2$grant select, insert, update, delete on company_settings to service_role;

-- The showroom fee book and calendar (0050). SELECT for manager+ /
-- accountant+ by policy, INSERT/UPDATE gated there too — no DELETE,
-- ever: a bill is voided, not erased.
grant select, insert, update on showroom_expenses to {{ROLE}};
grant select, insert, update on overhead_months   to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on showroom_expenses to service_role;
grant select, insert, update, delete on overhead_months   to service_role;$d2$;

  c_rpc_from text := $e1$grant execute on function calendar_invitable_people()             to {{ROLE}};$e1$;
  c_rpc_to   text := $e2$grant execute on function calendar_invitable_people()             to {{ROLE}};
-- The showroom fee RPCs (0050). Three, and only three:
--   ticket_waterfall()     — how THIS sale is priced, snapshot and all.
--   set_ticket_overhead()  — the CEO's per-sale edit; is_ceo() inside.
--   overhead_overview()    — the fee control page's single read.
-- The four helpers below them (split_amount, effective_overhead_rate,
-- overhead_between, waterfall_with_overhead) are deliberately NOT
-- granted: they carry no authorization check of their own beyond
-- waterfall_with_overhead's, exactly like commission_for_sale(), and
-- their only callers are the three above and execute_vehicle_sale().
grant execute on function ticket_waterfall(uuid)                  to {{ROLE}};
grant execute on function set_ticket_overhead(uuid, numeric, text) to {{ROLE}};
grant execute on function overhead_overview(int)                  to {{ROLE}};$e2$;

  -- The two function spans. Head locates the function; tail is the line
  -- every plpgsql function in the template ends with, so it is only ever
  -- searched FORWARD from a head.
  c_cw_head   text := $f1$create or replace function compute_sale_waterfall($f1$;
  c_cw_tail   text := $f2$$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;$f2$;
  c_exec_head text := $g1$create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)$g1$;
  c_exec_tail text := $g2$$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$g2$;

  c_cw_new    text;
  c_exec_new  text;
begin
  -- The waterfall span is replaced by SEVEN functions: the four helpers,
  -- the rewritten compute_sale_waterfall, and the two new RPCs. They all
  -- land where the waterfall already lived, which keeps
  -- preview_vehicle_sale_waterfall() — `language sql`, and therefore
  -- name-resolved AT CREATE TIME — still sitting immediately after a
  -- compute_sale_waterfall that exists.
  select string_agg(body, E'\n\n' order by ord) into c_cw_new
    from felix_0050_fn where ord between 1 and 8;
  select body into c_exec_new from felix_0050_fn where name = 'execute_vehicle_sale';

  select body into c_tbl_to from felix_0050_ddl where name = 'tables';
  c_tbl_to := c_tbl_to || E'\n\n' || c_tbl_from;

  select body into v_probe from felix_0050_ddl where name = 'rls';
  c_rls_to := c_rls_from || E'\n' || v_probe;

  select body into c_pol_to from felix_0050_ddl where name = 'policies';
  c_pol_to := c_pol_to || E'\n\n' || c_pol_from;

  -- The template's own line-ending convention decides every string's.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;

  c_tbl_from  := replace(replace(c_tbl_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to    := replace(replace(c_tbl_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from  := replace(replace(c_rls_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to    := replace(replace(c_rls_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from  := replace(replace(c_pol_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to    := replace(replace(c_pol_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from  := replace(replace(c_gnt_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to    := replace(replace(c_gnt_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rpc_from  := replace(replace(c_rpc_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rpc_to    := replace(replace(c_rpc_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_cw_head   := replace(replace(c_cw_head,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_cw_tail   := replace(replace(c_cw_tail,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_exec_head := replace(replace(c_exec_head, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_exec_tail := replace(replace(c_exec_tail, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_cw_new    := replace(replace(c_cw_new,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_exec_new  := replace(replace(c_exec_new,  chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists showroom_expenses' in v_tpl) > 0 then
    raise notice '0050: template already carries the showroom fee tables — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0050: template anchor 2a (tables) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0050: template anchor 2b (rls) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0050: template anchor 2c (policies) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0050: template anchor 2d (table grants) did not match. Template drifted from 0046.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rpc_from, c_rpc_to);
    if position(c_rpc_to in v_tpl) = 0 then
      raise exception '0050: template anchor 2e (rpc grants) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    -- ── the two function spans ──────────────────────────────
    -- position() has no FROM-offset in Postgres, so the tail is located
    -- inside the substring that starts at the head. That is what makes a
    -- tail shared by many functions safe to use here.
    v_at := position(c_cw_head in v_tpl);
    if v_at = 0 then
      raise exception '0050: compute_sale_waterfall() not found in the template. Template drifted from 0009.';
    end if;
    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_cw_tail in v_rest);
    if v_len = 0 then
      raise exception '0050: compute_sale_waterfall() has no stable SECURITY DEFINER tail. Template drifted from 0009.';
    end if;
    v_len := v_len + length(c_cw_tail) - 1;
    v_tpl := substr(v_tpl, 1, v_at - 1) || c_cw_new || substr(v_tpl, v_at + v_len);
    v_done := v_done + 1;

    v_at := position(c_exec_head in v_tpl);
    if v_at = 0 then
      raise exception '0050: execute_vehicle_sale() not found in the template. Template drifted from 0032.';
    end if;
    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_exec_tail in v_rest);
    if v_len = 0 then
      raise exception '0050: execute_vehicle_sale() has no SECURITY DEFINER tail. Template drifted from 0032.';
    end if;
    v_len := v_len + length(c_exec_tail) - 1;
    v_tpl := substr(v_tpl, 1, v_at - 1) || c_exec_new || substr(v_tpl, v_at + v_len);
    v_done := v_done + 1;

    -- ── ORDERING, ASSERTED ──────────────────────────────────
    -- The template is executed top to bottom with search_path set, so a
    -- CREATE that names a table defined below it aborts the whole
    -- provisioning. The new tables land at the company_settings anchor,
    -- which every previous migration has appended to — but "the anchor is
    -- late in the file" is an assumption, and an assumption about
    -- ordering is exactly the kind that fails silently three migrations
    -- later. Checked, not assumed.
    if position('create table if not exists branches' in v_tpl) = 0
       or position('create table if not exists branches' in v_tpl)
          > position('create table if not exists showroom_expenses' in v_tpl) then
      raise exception '0050: showroom_expenses is created before branches — the FK would abort provisioning.';
    end if;
    if position('create table if not exists profiles' in v_tpl) = 0
       or position('create table if not exists profiles' in v_tpl)
          > position('create table if not exists showroom_expenses' in v_tpl) then
      raise exception '0050: showroom_expenses is created before profiles — the FK would abort provisioning.';
    end if;
    if position('create table if not exists deal_tickets' in v_tpl) = 0
       or position('create table if not exists deal_tickets' in v_tpl)
          > position('alter table deal_tickets add column if not exists overhead_snapshot' in v_tpl) then
      raise exception '0050: the deal_tickets fee columns are added before the table exists.';
    end if;
    -- CREATE TABLE, then ALTER ... ENABLE ROW LEVEL SECURITY, then the
    -- policies — three separate anchors in three separate regions of the
    -- template, and nothing but 0046's own layout guarantees they stay in
    -- that order. `alter table ... enable row level security` on a table
    -- that does not exist yet aborts provisioning outright.
    if position('create table if not exists showroom_expenses' in v_tpl)
       > position('alter table showroom_expenses      enable row level security;' in v_tpl)
       or position('alter table showroom_expenses      enable row level security;' in v_tpl)
          > position('create policy "showroom_expenses_select" on showroom_expenses' in v_tpl) then
      raise exception '0050: showroom_expenses table / rls / policy are out of order in the template.';
    end if;
    if position('create table if not exists overhead_months' in v_tpl)
       > position('alter table overhead_months        enable row level security;' in v_tpl)
       or position('alter table overhead_months        enable row level security;' in v_tpl)
          > position('create policy "overhead_months_select" on overhead_months' in v_tpl) then
      raise exception '0050: overhead_months table / rls / policy are out of order in the template.';
    end if;
    -- preview_vehicle_sale_waterfall() is `language sql`, so its body is
    -- name-resolved at CREATE time and compute_sale_waterfall must exist
    -- by then. The span replacement preserves that; this proves it did.
    if position('create or replace function compute_sale_waterfall(' in v_tpl)
       > position('create or replace function preview_vehicle_sale_waterfall(' in v_tpl) then
      raise exception '0050: compute_sale_waterfall() now lands AFTER its language-sql wrapper — provisioning would abort.';
    end if;

    -- Every plain anchor above is a prefix or a suffix of its
    -- replacement, so `replace` would fire twice if the template ever
    -- carried two copies of one. Counted by comparing the bytes `replace`
    -- removed against the probe's OWN length, as 0032 did.
    foreach v_probe in array array[
      'create table if not exists showroom_expenses',
      'create table if not exists overhead_months',
      'create or replace function set_ticket_overhead(',
      'create or replace function ticket_waterfall(',
      'create or replace function overhead_overview(',
      'create or replace function compute_sale_waterfall(',
      'create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)',
      'grant execute on function ticket_waterfall(uuid)'
    ] loop
      if (length(v_tpl) - length(replace(v_tpl, v_probe, ''))) <> length(v_probe) then
        raise exception '0050: the template does not carry exactly one "%".', v_probe;
      end if;
    end loop;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0050$ select %L::text $felix_0050$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0050: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Tables, then RLS, then policies, then the functions — in that order,
-- because the functions read the tables the moment anything calls them.
-- {{SCHEMA}} is substituted per schema so every function body keeps its
-- own pinned search_path, which assertion (e) requires and which is the
-- only thing binding a tenant's copy to its own tables.
-- ============================================================
do $mig$
declare
  r        record;
  v_count  int := 0;
  v_tables text;
  v_rls    text;
  v_pol    text;
  v_fns    text;
begin
  select body into v_tables from felix_0050_ddl where name = 'tables';
  select body into v_rls    from felix_0050_ddl where name = 'rls';
  select body into v_pol    from felix_0050_ddl where name = 'policies';
  select string_agg(body, E'\n\n' order by ord) into v_fns from felix_0050_fn;

  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      raise notice '0050: %.deal_tickets missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute v_tables;
    execute v_rls;
    execute v_pol;
    execute replace(v_fns, '{{SCHEMA}}', quote_ident(r.schema_name));

    execute format('grant select, insert, update on %I.showroom_expenses to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update on %I.overhead_months   to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update, delete on %I.showroom_expenses to service_role', r.schema_name);
    execute format('grant select, insert, update, delete on %I.overhead_months   to service_role', r.schema_name);
    execute format('revoke all on table %I.showroom_expenses from public, anon, authenticated', r.schema_name);
    execute format('revoke all on table %I.overhead_months   from public, anon, authenticated', r.schema_name);

    -- The three RPCs, and only the three. The four helpers stay
    -- ungranted — see the template's grant comment for why.
    execute format('revoke all on function %I.split_amount(uuid, numeric) from public', r.schema_name);
    execute format('revoke all on function %I.effective_overhead_rate(uuid, date) from public', r.schema_name);
    execute format('revoke all on function %I.overhead_between(uuid, timestamptz, timestamptz) from public', r.schema_name);
    execute format('revoke all on function %I.waterfall_with_overhead(uuid, numeric, numeric, numeric, timestamptz) from public', r.schema_name);
    execute format('revoke all on function %I.ticket_waterfall(uuid) from public', r.schema_name);
    execute format('revoke all on function %I.set_ticket_overhead(uuid, numeric, text) from public', r.schema_name);
    execute format('revoke all on function %I.overhead_overview(int) from public', r.schema_name);

    execute format('grant execute on function %I.ticket_waterfall(uuid) to %I', r.schema_name, r.role_name);
    execute format('grant execute on function %I.set_ticket_overhead(uuid, numeric, text) to %I', r.schema_name, r.role_name);
    execute format('grant execute on function %I.overhead_overview(int) to %I', r.schema_name, r.role_name);

    v_count := v_count + 1;
    raise notice '0050: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0050: % tenant schema(s) carry showroom fees.', v_count;
end
$mig$;

-- ============================================================
-- 4. BACKFILL — the fee every ALREADY-SETTLED sale actually paid
--
-- Without this, every executed ticket in every live showroom has a NULL
-- snapshot, ticket_waterfall() falls back to recomputing it live, and
-- the exact drift 0050 exists to stop would go on happening for every
-- sale made before today.
--
-- TWO SOURCES, best first:
--
--   (a) audit_log. execute_vehicle_sale() has written its whole waterfall
--       into the audit row since 0003, `overhead_total` included. That IS
--       the number the ledger was built from — not a reconstruction of
--       it — so where the row exists the backfill is exact.
--
--   (b) the pre-0050 formula, for tickets with no audit row: the branch's
--       CURRENT monthly_opex_amount times the 30-day month count at
--       settlement. That reproduces what execute_vehicle_sale() computed
--       IF the branch's rate has not been edited since, and approximates
--       it otherwise. It is written anyway, because a stale snapshot the
--       CEO can see and correct on the ticket beats a NULL that silently
--       re-prices the sale every time the page is opened — which is the
--       status quo this migration is replacing.
--
-- Consignment sales get an explicit 0: they never carried a fee (0032).
--
-- The count of each is raised as a notice, so an operator can see how
-- much of their history is exact and how much is reconstructed.
-- ============================================================
do $mig$
declare
  r       record;
  v_exact int;
  v_recon int;
  v_cons  int;
  v_e     int := 0;
  v_r     int := 0;
  v_c     int := 0;
begin
  for r in select schema_name from platform.tenants order by slug loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute $bk$
      update deal_tickets t
         set overhead_snapshot = 0
        from vehicles v
       where v.id = t.vehicle_id
         and t.status = 'executed'
         and t.overhead_snapshot is null
         and v.acquisition_type = 'consignment'
    $bk$;
    get diagnostics v_cons = row_count;

    execute $bk$
      update deal_tickets t
         set overhead_snapshot = round((a.detail->>'overhead_total')::numeric, 2)
        from audit_log a
       where a.entity_type = 'deal_ticket'
         and a.entity_id   = t.id
         and a.action      = 'execute_vehicle_sale'
         and a.detail ? 'overhead_total'
         and t.status = 'executed'
         and t.overhead_snapshot is null
    $bk$;
    get diagnostics v_exact = row_count;

    execute $bk$
      update deal_tickets t
         set overhead_snapshot = round(greatest(coalesce(o.monthly_opex_amount, 0), 0)
               * greatest(extract(epoch from (coalesce(t.executed_at, v.sold_at, now()) - v.created_at))
                          / (30*86400), 0), 2)
        from vehicles v
        left join overhead_config o on o.branch_id = v.branch_id
       where v.id = t.vehicle_id
         and t.status = 'executed'
         and t.overhead_snapshot is null
    $bk$;
    get diagnostics v_recon = row_count;

    v_c := v_c + v_cons;
    v_e := v_e + v_exact;
    v_r := v_r + v_recon;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0050 backfill: % exact (from audit_log), % reconstructed, % consignment zeros.', v_e, v_r, v_c;
end
$mig$;

-- ============================================================
-- 5. RAISE ASSERTION (f) BY SEVEN
--
-- 0037's technique as 0045 used it: patch create_tenant_schema()'s OWN
-- live source rather than a hand-retyped copy. Seven new SECURITY
-- DEFINER functions — split_amount, effective_overhead_rate,
-- overhead_between, waterfall_with_overhead, ticket_waterfall,
-- set_ticket_overhead, overhead_overview.
--
-- THE OLD NUMBER IS READ, NOT ASSUMED. 0037 and 0045 each hard-coded the
-- figure they expected to find (20 and 21), and 0045's header says a
-- migration that changes the count "should change this line in the same
-- commit" — but that only holds while every migration remembers to. This
-- database is already at 23 rather than the 22 the migration history
-- reads as, so a hard-coded 22 here would abort a migration that is
-- otherwise perfectly correct, for a number that is not this file's
-- business.
--
-- What IS asserted, and much harder: that the new figure matches what
-- §3 ACTUALLY built. Every amended schema is counted, they must all
-- agree, and the count must be exactly seven more than the assertion was
-- claiming. So the number is derived from reality and then checked
-- against the arithmetic — either half failing means something other
-- than this migration changed the shape of a tenant schema.
-- ============================================================
do $mig$
declare
  v_ddl   text;
  v_found text;
  v_old   int;
  v_new   int;
  v_n     int;
  r       record;
  v_seen  int := -1;
begin
  select p.prosrc into v_ddl
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_ddl is null then
    raise exception '0050: platform.create_tenant_schema() not found.';
  end if;

  v_found := substring(v_ddl from 'expected [0-9]+ SECURITY DEFINER functions');
  if v_found is null then
    raise exception '0050: create_tenant_schema() carries no "expected N SECURITY DEFINER functions" assertion. Function drifted from 0009.';
  end if;
  v_n := length(v_ddl) - length(replace(v_ddl, v_found, ''));
  if v_n <> length(v_found) then
    raise exception '0050: "%" appears more than once in create_tenant_schema().', v_found;
  end if;
  v_old := substring(v_found from '[0-9]+')::int;

  -- What §3 actually produced, across every schema it touched.
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      continue;
    end if;
    select count(*) into v_n from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if v_seen < 0 then
      v_seen := v_n;
    elsif v_seen <> v_n then
      raise exception '0050: tenant schemas disagree on their SECURITY DEFINER count (% vs %) — one of them has drifted.', v_seen, v_n;
    end if;
  end loop;

  if v_seen < 0 then
    -- No provisioned schema to measure against. Trust the arithmetic;
    -- the template amendment in §2 is what the next provisioning runs.
    v_new := v_old + 7;
    raise notice '0050: no provisioned tenant to measure — raising assertion (f) % -> % from the function count alone.', v_old, v_new;
  elsif v_seen = v_old then
    raise notice '0050: create_tenant_schema() already asserts % and every schema carries % — skipping.', v_old, v_seen;
    return;
  elsif v_seen <> v_old + 7 then
    raise exception
      '0050: assertion (f) says % and the amended schemas carry % — expected exactly seven more. Something other than 0050 changed the SECURITY DEFINER set.',
      v_old, v_seen;
  else
    v_new := v_seen;
  end if;

  v_ddl := replace(v_ddl, v_found, format('expected %s SECURITY DEFINER functions', v_new));
  v_ddl := replace(v_ddl, format('if n <> %s then', v_old), format('if n <> %s then', v_new));

  if position(format('if n <> %s then', v_new) in v_ddl) = 0 then
    raise exception '0050: the "if n <> %" comparison was not found next to assertion (f). Function drifted from 0009.', v_old;
  end if;

  execute format(
    'create or replace function platform.create_tenant_schema(p_slug text) returns text '
    'language plpgsql security definer set search_path = pg_catalog, platform as %L',
    v_ddl
  );
  raise notice '0050: platform.create_tenant_schema() now asserts % SECURITY DEFINER functions.', v_new;
end
$mig$;

-- ============================================================
-- 6. SELF-VERIFY
-- ============================================================
do $mig$
declare
  r        record;
  v_bad    text[] := '{}';
  n        int;
  fn       text;
  v_expect int;
begin
  select substring(p.prosrc from 'expected ([0-9]+) SECURITY DEFINER functions')::int
    into v_expect
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';
  if v_expect is null then
    raise exception '0050 VERIFY FAILED: create_tenant_schema() carries no SECURITY DEFINER count assertion.';
  end if;

  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      continue;
    end if;

    -- (1) both tables exist, with RLS on.
    foreach fn in array array['showroom_expenses', 'overhead_months'] loop
      if to_regclass(format('%I.%I', r.schema_name, fn)) is null then
        v_bad := v_bad || format('%s (%s missing)', r.schema_name, fn);
        continue;
      end if;
      if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                      where ns.nspname = r.schema_name and c.relname = fn and c.relrowsecurity) then
        v_bad := v_bad || format('%s (%s rls off)', r.schema_name, fn);
      end if;

      select count(*) into n from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = fn;
      if n <> 3 then
        v_bad := v_bad || format('%s (%s has %s policies, expected 3)', r.schema_name, fn, n);
      end if;

      -- THE 0045 LESSON, ASSERTED: no policy on these tables may name
      -- auth.uid(), or every write raises 42501 the moment it ships.
      select count(*) into n from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = fn
         and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ 'auth\.uid';
      if n > 0 then
        v_bad := v_bad || format('%s (%s policy names auth.uid() — will 42501)', r.schema_name, fn);
      end if;

      if not has_table_privilege(r.role_name, format('%I.%I', r.schema_name, fn), 'select')
         or not has_table_privilege(r.role_name, format('%I.%I', r.schema_name, fn), 'insert')
         or not has_table_privilege(r.role_name, format('%I.%I', r.schema_name, fn), 'update') then
        v_bad := v_bad || format('%s (%s: role missing select/insert/update)', r.schema_name, fn);
      end if;
      if has_table_privilege(r.role_name, format('%I.%I', r.schema_name, fn), 'delete') then
        v_bad := v_bad || format('%s (%s: role holds DELETE — assertion (j) would fail provisioning)', r.schema_name, fn);
      end if;
      if has_table_privilege('anon', format('%I.%I', r.schema_name, fn), 'select')
         or has_table_privilege('authenticated', format('%I.%I', r.schema_name, fn), 'select') then
        v_bad := v_bad || format('%s (%s readable by anon/authenticated)', r.schema_name, fn);
      end if;
    end loop;

    -- (2) the five new columns on deal_tickets and the four on
    --     overhead_config.
    foreach fn in array array['overhead_snapshot','overhead_override','overhead_override_reason',
                              'overhead_override_by','overhead_override_at'] loop
      if not exists (select 1 from information_schema.columns
                      where table_schema = r.schema_name and table_name = 'deal_tickets'
                        and column_name = fn) then
        v_bad := v_bad || format('%s (deal_tickets.%s missing)', r.schema_name, fn);
      end if;
    end loop;
    foreach fn in array array['fees_enabled','basis','average_window_months','updated_by'] loop
      if not exists (select 1 from information_schema.columns
                      where table_schema = r.schema_name and table_name = 'overhead_config'
                        and column_name = fn) then
        v_bad := v_bad || format('%s (overhead_config.%s missing)', r.schema_name, fn);
      end if;
    end loop;

    -- (3) all seven functions exist, are SECURITY DEFINER, and carry a
    --     pinned search_path. A definer without proconfig is a worse bug
    --     than anything this migration fixes.
    foreach fn in array array['split_amount','effective_overhead_rate','overhead_between',
                              'waterfall_with_overhead','ticket_waterfall',
                              'set_ticket_overhead','overhead_overview'] loop
      if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                      where ns.nspname = r.schema_name and p.proname = fn and p.prosecdef) then
        v_bad := v_bad || format('%s (%s() missing or not SECURITY DEFINER)', r.schema_name, fn);
      end if;
      if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                      where ns.nspname = r.schema_name and p.proname = fn
                        and p.proconfig is not null
                        and array_to_string(p.proconfig, ',') like '%search_path=%') then
        v_bad := v_bad || format('%s (%s() has NO pinned search_path — injection risk)', r.schema_name, fn);
      end if;
    end loop;

    -- (4) the four helpers are NOT reachable by the tenant role, and the
    --     three RPCs are. A helper that leaked EXECUTE would hand a
    --     sales_exec waterfall_with_overhead() — which bypasses RLS by
    --     design and takes the fee as a caller-supplied argument.
    foreach fn in array array['split_amount(uuid, numeric)',
                              'effective_overhead_rate(uuid, date)',
                              'overhead_between(uuid, timestamptz, timestamptz)',
                              'waterfall_with_overhead(uuid, numeric, numeric, numeric, timestamptz)'] loop
      if has_function_privilege(r.role_name, format('%I.%s', r.schema_name, fn), 'execute')
         or has_function_privilege('public', format('%I.%s', r.schema_name, fn), 'execute') then
        v_bad := v_bad || format('%s (%s is EXECUTE-able — it carries no role check of its own)', r.schema_name, fn);
      end if;
    end loop;
    foreach fn in array array['ticket_waterfall(uuid)',
                              'set_ticket_overhead(uuid, numeric, text)',
                              'overhead_overview(int)'] loop
      if not has_function_privilege(r.role_name, format('%I.%s', r.schema_name, fn), 'execute') then
        v_bad := v_bad || format('%s (%s not granted to the tenant role)', r.schema_name, fn);
      end if;
      if has_function_privilege('public', format('%I.%s', r.schema_name, fn), 'execute') then
        v_bad := v_bad || format('%s (%s EXECUTE-able by PUBLIC)', r.schema_name, fn);
      end if;
    end loop;

    -- (5) the count assertion (f) will make at the NEXT provisioning,
    --     checked here instead — against the number §5 just wrote into
    --     create_tenant_schema(), not against a constant in this file.
    --     A mismatch means a schema amended today would fail to
    --     re-provision tomorrow, which is a failure nobody would see for
    --     weeks.
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> v_expect then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, assertion (f) expects %s)', r.schema_name, n, v_expect);
    end if;

    -- (6) no executed, non-consignment ticket left without a snapshot.
    execute format(
      'select count(*) from %I.deal_tickets where status = ''executed'' and overhead_snapshot is null',
      r.schema_name) into n;
    if n > 0 then
      v_bad := v_bad || format('%s (%s executed ticket(s) still have no fee snapshot)', r.schema_name, n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0050 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists showroom_expenses' in platform.tenant_ddl_template()) = 0
     or position('create table if not exists overhead_months' in platform.tenant_ddl_template()) = 0
     or position('grant execute on function set_ticket_overhead(uuid, numeric, text)' in platform.tenant_ddl_template()) = 0
     or position('"showroom_expenses_select" on showroom_expenses' in platform.tenant_ddl_template()) = 0
     or position('overhead_between(v.branch_id, v.created_at, v_as_of)' in platform.tenant_ddl_template()) = 0 then
    raise exception '0050 VERIFY FAILED: the template does not carry the showroom fee build.';
  end if;

  raise notice '0050: verified — a showroom fee has a paper trail, a switch, a calendar, and a freeze the CEO can break on purpose.';
end
$mig$;

notify pgrst, 'reload schema';

commit;
