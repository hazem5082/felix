-- ============================================================
-- 0036 — INVENTORY INTELLIGENCE: ODOMETER, AGEING AND PRICE HISTORY
--
-- Three gaps a used-car group manages by every day, none of them
-- representable until now.
--
--   ODOMETER      The second question every buyer asks, after "how
--                  much". There is no column for it anywhere.
--   DAYS IN STOCK  Ageing is THE metric a used-car floor manages by —
--                  carry cost (financing, insurance, a parking spot
--                  that could hold something that sells) makes old
--                  stock expensive, and nothing today says how old a
--                  car is beyond eyeballing `created_at`.
--   PRICE HISTORY  A sticker or floor price changes and the old number
--                  is simply gone. Who moved it, when, and from what,
--                  is unanswerable.
--
-- WHAT THIS ADDS
-- --------------
--   vehicles.odometer_km          nullable, updatable, no decrease
--                                 guard — see below.
--   vehicles.acquisition_source   free text: who or where this car came
--                                 from. Nullable; nothing backfills it.
--   vehicle_price_history         one row per price change, written by
--                                 a plain trigger — never by the app.
--   create_vehicle_with_equity_splits()
--                                 widened 23 → 25 arguments so intake
--                                 can record the odometer and the
--                                 source in the same transaction as the
--                                 car itself.
--
-- Days-in-stock and the ageing buckets (fresh/ageing/stale/dead) are
-- DELIBERATELY NOT a column or a function here. They are a pure
-- function of created_at, sold_at and the clock — src/lib/stock-age.ts,
-- under test — and a stored or generated value would either go stale
-- the moment midnight passes or need a job to keep it honest. Nothing
-- in this migration computes them.
--
-- NO DECREASE GUARD ON THE ODOMETER
-- ----------------------------------
-- purchase_price and status both lock once a car sells (0003's
-- guard_vehicle_status()); the odometer does not, and does not gain a
-- monotonic CHECK either. Cars get driven between intake and sale, so
-- the reading legitimately climbs — and a typo entered as 145,000
-- instead of 45,000 is a mistake the next person to look at the car
-- must be able to correct downward, not a rollback attempt to police.
-- The only constraint is the shape: not negative.
--
-- Being updatable needs a write path, so the tenant role gets a
-- column-limited `grant update (odometer_km) on vehicles` — 0028's
-- exact shape for asking_price/min_price, added as its OWN grant
-- statement so 0028's own line survives byte-for-byte for whatever
-- later migration is anchored on it. The vehicles_update policy (CEO,
-- or a manager on their own branch) gates the rows, same as it does for
-- pricing; this migration does not ship a dedicated "edit odometer"
-- dialog — the grant is the DB-level half of "updatable", and a UI for
-- it is left for whenever a screen actually needs one, the same
-- restraint pricing-form.tsx's own header applies elsewhere in this
-- migration's app-surface changes.
--
-- WHY PRICE HISTORY IS A TRIGGER, NOT APP CODE
-- ---------------------------------------------
-- 0028 made asking_price/min_price the ONE direct write the tenant role
-- holds on `vehicles` — a column-limited UPDATE grant, no RPC ceremony.
-- Recording every change through the server action instead of the
-- database would mean trusting every future write path (the pricing
-- form today, a bulk-reprice tool tomorrow, a data-repair UPDATE run by
-- hand) to remember to log it. A trigger on the column cannot be
-- bypassed by forgetting: it is set-based, fires on the UPDATE itself,
-- and is the same reasoning 0033 gives for stamping guard_cheque_status
-- server-side rather than trusting the client's timestamp.
--
-- A trigger also has to be a PLAIN one, not SECURITY DEFINER —
-- assertion (f) inside platform.create_tenant_schema() pins the schema
-- at EXACTLY twenty SECURITY DEFINER functions, and this is a new
-- function. Being plain is also correct on its own merits: the row
-- should say who actually changed the price, and a plain trigger fires
-- as the calling session, so auth.uid() is the real actor rather than a
-- definer's identity.
--
-- TWO TRIGGER MOMENTS, ONE FUNCTION
-- ----------------------------------
--   AFTER UPDATE   fires when asking_price OR min_price IS DISTINCT
--                   FROM the old row — the ordinary case, and the one
--                   the pricing form exercises every time a manager
--                   re-prices a car.
--   AFTER INSERT    fires once, recording the row's BIRTH prices, but
--                   only when either price is already non-null. In
--                   practice this is close to a no-op today: the intake
--                   RPC never sets a price (0028's header explains why
--                   — pricing rides the follow-up UPDATE, not
--                   atomically with the create), so a freshly intaken
--                   car has both prices null and the branch is skipped.
--                   It exists so a future or service-role path that DOES
--                   set a price at INSERT time is covered from day one,
--                   rather than silently missing its first entry.
--
-- WHY AN INSERT POLICY IS NEEDED (0033'S "WHO IS ACTUALLY WRITING"
-- QUESTION, ASKED AGAIN)
-- ------------------------------------------------------------------
-- The trigger is not SECURITY DEFINER, so it runs AS WHOEVER FIRED THE
-- STATEMENT. The intake RPC is SECURITY DEFINER, so the birth-price
-- branch (when it ever fires) runs as the table owner and is not
-- subject to RLS at all. The pricing form's UPDATE is the ordinary
-- tenant role acting under its own session, and RLS is fully in force
-- for it — so the trigger's nested INSERT into vehicle_price_history
-- needs a policy that actually admits it, exactly as 0033's header says
-- for branch_grants.granted_by and installment_plans.created_by:
-- `with check (changed_by = auth.uid() and can_act_on_branch(branch_id))`
-- pins the writer column the same way, so the row can never be entered
-- in somebody else's name or against a branch the caller cannot act on.
--
-- SELECT is `can_read_branch(branch_id)` — the 0033 receivables-book
-- pattern of denormalising branch_id onto the row rather than a
-- per-row subquery into `vehicles` (`can_read_branch((select branch_id
-- from vehicles v where v.id = vehicle_id))`), which would drag
-- vehicles_select — five predicate arms including holds_equity_in_
-- vehicle() — into the plan of every price-history query. A trigger
-- copies branch_id off NEW at write time, so the two can never drift.
--
-- This is a DELIBERATE, slightly narrower audience than vehicles_select
-- (which also admits the marketing role and an investor holding equity
-- in the car). The asking/floor prices this table is a history OF are
-- themselves displayed on the vehicle page to that same
-- can_read_branch() audience — see [vehicleId]/page.tsx, where neither
-- number is gated behind canSeeCost — so the history carries the same
-- audience as the values it records, which is the simplest correct
-- answer rather than a literal mirror of every arm vehicles_select has
-- accumulated for unrelated reasons.
--
-- NO UPDATE, NO DELETE. A price-history row is a fact about a moment;
-- correcting a typo in one is a new row with the right numbers, not a
-- rewrite of history. Matches 0033's ledger-shaped tables exactly, and
-- assertion (j) inside create_tenant_schema() would refuse a DELETE
-- grant to the tenant role regardless.
--
-- NO AUDIT TRIGGER. vehicle_price_history IS an audit log — of prices —
-- and a generic audit trigger over a table that only ever receives
-- INSERTs (no UPDATE/DELETE grant exists to fire the other two arms)
-- would just restate each row's own content back into audit_log. Same
-- reasoning 0033 gives for leaving installment_lines unaudited.
--
-- THE RPC WIDENING: SPAN REPLACEMENT, 0032's SHAPE
-- --------------------------------------------------
-- create_vehicle_with_equity_splits() gains p_odometer_km and
-- p_acquisition_source, appended after p_splits — the last parameter of
-- the 23-argument version 0032 left. The body does not otherwise change
-- (no new validation branches: both fields are optional at every mode),
-- but the signature and the INSERT's column/value lists both move, so
-- an anchored `replace()` on a fragment would have to be written twice
-- and the copies would drift. §0-bis therefore parks the new body once,
-- §2 locates the old function in the template by its opening line and
-- the `$fn$ language plpgsql security definer` tail and replaces the
-- whole span, and §3 installs the identical text into every live
-- schema — exactly 0032's approach for the same function.
--
-- The 23-argument function is DROPPED, not merely replaced: `create or
-- replace` keys on the argument list, and PostgREST refuses to choose
-- between two overloads it can both satisfy (PGRST203 — 0026's header
-- has the full account, 0032 repeated the drop for this same RPC last
-- time it was widened).
--
-- execute_vehicle_sale() is UNTOUCHED. It mints trade-in vehicles with a
-- fixed column list that does not include odometer_km — a trade-in's
-- reading, when the ticket carries one, already folds into that row's
-- `description` (0032's own note on why: an odometer column arrives "in
-- a later migration", which is this one, and widening a mint path that
-- already has a documented, working fallback is not required to ship
-- the column everywhere else).
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * No backfill. 0032's trade-ins, and every row that predates this
--     migration, get odometer_km and acquisition_source as NULL. There
--     is no source of truth to backfill either from — an odometer
--     reading recorded nowhere cannot be recovered, and inventing one
--     would be worse than admitting it is unknown.
--   * vehicle_price_history is NOT added to the c_tables array inside
--     platform.create_tenant_schema(), for the reason 0016, 0030, 0031
--     and 0033 all record: a failed CREATE TABLE aborts the whole
--     template execute, assertion (b) walks pg_class for RLS and guard
--     (5) for the tenant role's SELECT, and §5 below verifies the table
--     across every live schema directly.
--   * No new SECURITY DEFINER function. record_vehicle_price_history()
--     is a plain trigger (see above); assertion (f)'s count of twenty
--     stays exactly twenty. create_vehicle_with_equity_splits() is a
--     REPLACEMENT of an existing definer, not a new one.
--
-- ANCHOR CHOICE. Every substitution below lands on `vehicles` itself —
-- the acquisition-mode block 0032 spliced in, the intake RPC, the
-- guard_vehicle_status()/4.4 EXPENSES seam, the RLS-enable list, the
-- four vehicles_* policies, the trg_audit_vehicles trigger pair, and
-- the pricing grant 0028 added. Nothing here touches `leads` (0016,
-- 0031), `branch_grants` (0030), `customers` (0031) or the receivables
-- book (0033).
--
-- GATE. On 0032 — the last migration to touch `vehicles` or the intake
-- RPC — and NOT on any later-numbered migration. A concurrent stock-
-- transfer feature is being developed against this same `vehicles`
-- table in a separate migration; this file needs nothing from it, so it
-- is not named here, exactly as 0033 gated on 0031 rather than the
-- parallel, unmerged 0032 of its own day.
--
-- LINE ENDINGS. The live platform.tenant_ddl_template() text is CRLF —
-- built from SQL-Editor pastes of CRLF files — while this file is LF.
-- §2 reads the template's own convention and rewrites every anchor and
-- every replacement into it, flattening to LF first so it works whether
-- this file arrives as LF or is converted to CRLF by the operator's
-- applier. Same shape as 0030/0031/0032/0033 §2.
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
      '0036 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0036 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- vehicles.acquisition_type, in 0032's exact spacing — the marker this
  -- migration's own header promises to gate on. Deliberately a
  -- SINGLE-LINE anchor: the CRLF/LF normalisation that makes a
  -- multi-line anchor safe does not run until §2, and a precondition
  -- checked against the template's raw (possibly CRLF) text would fail
  -- against an anchor authored with embedded LF newlines — exactly the
  -- class of bug 0030's header warns about. Single-line anchors have no
  -- embedded newline to disagree about, so this one, and every other
  -- precondition in this file, is written that way on purpose.
  if position('acquisition_type text        not null default ''purchase''' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0036 PRECONDITION FAILED: the template has no vehicles.acquisition_type. Apply 0032 first.';
  end if;

  -- p_consignment_commission_value — the last parameter 0032's own
  -- consignor group added to the intake RPC, confirming that migration
  -- reached the function and not only the table. Whether the RPC is
  -- still at 23 arguments or has already been widened to 25 by an
  -- earlier run of THIS migration is not this check's job — §2 tells
  -- the two apart and skips cleanly on a re-run.
  if position('p_consignment_commission_value numeric,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0036 PRECONDITION FAILED: the template has no 0032-shaped create_vehicle_with_equity_splits(). Apply 0032 first.';
  end if;
end
$$;

-- ============================================================
-- 0-bis. THE REWRITTEN RPC, ONCE
--
-- Parked here so §2 (the template) and §3 (every live schema) install
-- byte-identical text — the same discipline 0032 used for the two
-- functions it rewrote. `on commit drop` takes it away with the
-- transaction.
--
-- {{SCHEMA}} is left as the template's own placeholder: §2 splices this
-- in verbatim, §3 substitutes the tenant's schema name before executing.
-- ============================================================
create temp table felix_0036_fn (name text primary key, body text) on commit drop;

insert into felix_0036_fn (name, body) values (
'create_vehicle_with_equity_splits',
$fnbody$create or replace function create_vehicle_with_equity_splits(
  p_branch_id uuid,
  p_vin text,
  p_year int,
  p_make text,
  p_model text,
  p_trim text,
  p_color text,
  p_description text,
  p_inspection_photos text[],
  p_engine_number text,
  p_plate_number text,
  p_country_of_origin text,
  p_features text[],
  p_item_code text,
  p_acquisition_type text,
  p_consignor_name text,
  p_consignor_phone text,
  p_consignor_national_id text,
  p_consignment_commission_type text,
  p_consignment_commission_value numeric,
  p_purchase_price numeric,
  p_photos text[],
  p_splits jsonb,
  -- 0036. Appended after p_splits — the last parameter of 0032's
  -- 23-argument version. Both optional at every acquisition mode: an
  -- odometer reading and a source note are recorded when known, on a
  -- purchase, a consignment, or (were it ever offered at intake, which
  -- it is not — see 0032) a trade-in alike.
  p_odometer_km numeric,
  p_acquisition_source text
) returns uuid as $fn$
declare
  v_id uuid;
  split jsonb;
  total numeric := 0;
  non_ceo int := 0;
  v_holder uuid;
  -- 0032. An older client that does not send the parameter at all still
  -- means 'purchase' — which is what every row created before this
  -- migration is, so the default and the backfill agree.
  v_mode text := coalesce(nullif(btrim(coalesce(p_acquisition_type, '')), ''), 'purchase');
  v_cost numeric;
begin
  if not exists (select 1 from branches where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;

  -- ROLE + BRANCH check (0001). KEEP VERBATIM. It reads as one block with
  -- the existence check above, which is why the pair has to be separated
  -- deliberately rather than pattern-matched.
  if not (is_ceo() or (is_manager_or_above() and p_branch_id = current_branch_id())) then
    raise exception 'Not authorized to intake a vehicle for this branch';
  end if;

  -- 'trade_in' is deliberately not intakeable (0032). Such a row is born
  -- only inside execute_vehicle_sale(), against a ticket that carries the
  -- allowance it was valued at; one typed in here would be a car with a
  -- cost basis nobody agreed to and no sale behind it.
  if v_mode not in ('purchase', 'consignment') then
    raise exception 'Unknown acquisition type % — expected purchase or consignment', v_mode;
  end if;

  if v_mode = 'consignment' then
    -- The commission terms are the ENTIRE commercial content of a
    -- consignment: without them execute_vehicle_sale() has nothing to pay
    -- the house and nothing to owe the consignor. The table's CHECKs stay
    -- permissive on purpose (see the file header); the requirement lives
    -- here, and in the zod schema, where a human is looking at a form.
    if nullif(btrim(coalesce(p_consignor_name, '')), '') is null then
      raise exception 'A consignment needs the consignor''s name';
    end if;

    if p_consignment_commission_type is null
       or p_consignment_commission_type not in ('fixed', 'percent') then
      raise exception 'A consignment needs a commission type of fixed or percent';
    end if;

    if p_consignment_commission_value is null or p_consignment_commission_value < 0 then
      raise exception 'A consignment needs a commission value of zero or more';
    end if;

    if p_consignment_commission_type = 'percent' and p_consignment_commission_value > 100 then
      raise exception 'A percentage commission cannot exceed 100%%';
    end if;

    -- No capital was deployed, so the cost basis is zero whatever the
    -- caller sent, and there is no cap table to write. Splits are REFUSED
    -- rather than ignored: silently dropping an investor's stake is how
    -- somebody discovers months later that they were never on it.
    if jsonb_array_length(coalesce(p_splits, '[]'::jsonb)) > 0 then
      raise exception 'A consigned vehicle has no equity splits — the showroom does not own it';
    end if;

    v_cost := 0;
  else
    v_cost := p_purchase_price;

    select coalesce(sum((s->>'percentage')::numeric), 0),
           count(*) filter (where s->>'holder_type' <> 'ceo')
      into total, non_ceo
    from jsonb_array_elements(coalesce(p_splits,'[]'::jsonb)) s;

    if abs(total - 100) > 0.01 then
      raise exception 'Equity splits must sum to 100%% (got %)', total;
    end if;

    -- A manager may fund a car entirely from company equity; allocating a
    -- stake to an outside investor is the CEO's decision.
    if non_ceo > 0 and not is_ceo() then
      raise exception 'Only the CEO can allocate investor equity on a vehicle';
    end if;
  end if;

  -- odometer_km and acquisition_source (0036) join the tail of the
  -- column list, right before created_by, on the same reasoning every
  -- other optional intake field here follows: nullif() collapses ''
  -- to NULL, and the odometer's numeric CHECK ( >= 0 ) does the rest —
  -- a negative reading raises straight from the table, same as it would
  -- for any other malformed numeric this RPC passes through.
  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, item_code, acquisition_type, consignor_name, consignor_phone, consignor_national_id, consignment_commission_type, consignment_commission_value, purchase_price, photos, odometer_km, acquisition_source, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''), nullif(p_color,''),
          nullif(p_description,''), coalesce(p_inspection_photos,'{}'),
          nullif(p_engine_number,''), nullif(p_plate_number,''),
          nullif(p_country_of_origin,''), coalesce(p_features,'{}'), nullif(p_item_code,''),
          v_mode,
          -- Consignor fields are written only for a consignment. A
          -- purchase that arrived carrying them — a stale form, a
          -- half-changed client — must not end up naming somebody as the
          -- owner of a car the showroom bought.
          case when v_mode = 'consignment' then nullif(btrim(coalesce(p_consignor_name,'')),'') end,
          case when v_mode = 'consignment' then nullif(btrim(coalesce(p_consignor_phone,'')),'') end,
          case when v_mode = 'consignment' then nullif(btrim(coalesce(p_consignor_national_id,'')),'') end,
          case when v_mode = 'consignment' then p_consignment_commission_type end,
          case when v_mode = 'consignment' then p_consignment_commission_value end,
          v_cost, coalesce(p_photos,'{}'),
          p_odometer_km,
          nullif(btrim(coalesce(p_acquisition_source,'')),''),
          auth.uid())
  returning id into v_id;

  for split in select * from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) loop
    v_holder := nullif(split->>'holder_id','')::uuid;

    if v_holder is not null
       and not exists (select 1 from investors where id = v_holder) then
      raise exception 'Investor not found';
    end if;

    insert into vehicle_equity_splits (vehicle_id, holder_type, holder_id, amount_invested, percentage)
    values (
      v_id,
      split->>'holder_type',
      v_holder,
      (split->>'amount_invested')::numeric,
      (split->>'percentage')::numeric
    );
  end loop;

  return v_id;
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$fnbody$
);

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Eight anchored substitutions plus one function span. None touches a
-- region 0029, 0030, 0031 or 0033 amended — see the header's "anchor
-- choice" note.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;
  v_at   int;
  v_len  int;
  v_rest text;

  c_intake_new text;

  -- None of the strings below is `constant`: every one is rewritten
  -- into the template's own line-ending convention before it is used.
  -- See the header, and the normalisation block near the end of this
  -- body.

  -- 2a. vehicles: odometer_km and acquisition_source, directly under the
  --     consignor block 0032 spliced in — so every intake-time fact
  --     about "what is this car and how did we get it" reads as one
  --     block, ending with the two newest questions.
  c_veh_from text := $a1$  consignment_commission_value numeric,
  -- 0009 wrote `check (purchase_price > 0)` inline here, which auto-named$a1$;
  c_veh_to   text := $a2$  consignment_commission_value numeric,
  -- ODOMETER AND SOURCE (0036) — the second question every buyer asks,
  -- and where the car came from. Both nullable and additive: existing
  -- rows, including 0032's trade-ins, get NULL here and nothing
  -- backfills it this pass. odometer_km is UPDATABLE with no decrease
  -- guard — cars get driven, and a lower reading after a correction is
  -- real, not a rollback to police (see the file header).
  odometer_km          numeric     check (odometer_km >= 0),
  acquisition_source    text,
  -- 0009 wrote `check (purchase_price > 0)` inline here, which auto-named$a2$;

  -- 2b. vehicle_price_history, after vehicles' own free-text search
  --     index — the tail of what 0009 §1 built for this table.
  c_tbl_from text := $b1$create index if not exists idx_vehicles_search on vehicles
  using gin (to_tsvector('simple', coalesce(make,'') || ' ' || coalesce(model,'') || ' ' || coalesce(vin,'')));$b1$;
  c_tbl_to   text := $b2$create index if not exists idx_vehicles_search on vehicles
  using gin (to_tsvector('simple', coalesce(make,'') || ' ' || coalesce(model,'') || ' ' || coalesce(vin,'')));

-- ------------------------------------------------------------
-- 1-bis. VEHICLE PRICE HISTORY (0036)
--
-- One row per change to asking_price or min_price, written ONLY by the
-- trigger in section 4 below — never by the app. branch_id is
-- denormalised off the vehicle at write time (0033's receivables-book
-- pattern) so the SELECT policy is a scalar can_read_branch(branch_id)
-- rather than a per-row subquery into `vehicles`. See the file header
-- for the full reasoning, including why the audience is deliberately
-- narrower than vehicles_select.
-- ------------------------------------------------------------
create table if not exists vehicle_price_history (
  id           uuid        primary key default gen_random_uuid(),
  vehicle_id   uuid        not null references vehicles(id) on delete cascade,
  branch_id    uuid        not null references branches(id),
  asking_price numeric,
  min_price    numeric,
  changed_by   uuid        references profiles(id),
  changed_at   timestamptz not null default now()
);

-- The vehicle page's own query: this car's history, newest first.
create index if not exists idx_vehicle_price_history_vehicle
  on vehicle_price_history(vehicle_id, changed_at desc);
-- What the SELECT/INSERT policies below evaluate against.
create index if not exists idx_vehicle_price_history_branch
  on vehicle_price_history(branch_id);$b2$;

  -- 2c. the trigger function, between guard_vehicle_status()'s tail and
  --     the "4.4 EXPENSES" section header — beside the other trigger
  --     that fires on `vehicles`, and before the table it inserts into
  --     is out of place: a `language plpgsql` body is not validated at
  --     CREATE time, so the ordering here is for a human reader, not
  --     Postgres.
  c_fn_from text := $c1$  if old.status = 'sold'
     and (new.purchase_price is distinct from old.purchase_price
       or new.branch_id      is distinct from old.branch_id
       or new.vin            is distinct from old.vin) then
    raise exception 'A sold vehicle''s cost basis is locked (SOLD_FINAL)';
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.4 EXPENSES
-- ============================================================$c1$;
  c_fn_to   text := $c2$  if old.status = 'sold'
     and (new.purchase_price is distinct from old.purchase_price
       or new.branch_id      is distinct from old.branch_id
       or new.vin            is distinct from old.vin) then
    raise exception 'A sold vehicle''s cost basis is locked (SOLD_FINAL)';
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.3-bis VEHICLE PRICE HISTORY (0036)
--
-- Two moments, one function — see the file header for why the birth-
-- price branch is close to dead code today and why it is here anyway.
-- NOT SECURITY DEFINER: assertion (f)'s count of twenty SECURITY
-- DEFINER functions per tenant schema is unaffected, and a plain
-- trigger firing as the calling session is what makes auth.uid() the
-- real actor rather than a definer's identity.
-- ------------------------------------------------------------
create or replace function record_vehicle_price_history() returns trigger as $trg$
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
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.4 EXPENSES
-- ============================================================$c2$;

  -- 2d. RLS enablement, beside vehicles' own in the enable-RLS list.
  c_rls_from text := $d1$alter table vehicles               enable row level security;
alter table vehicle_equity_splits  enable row level security;$d1$;
  c_rls_to   text := $d2$alter table vehicles               enable row level security;
alter table vehicle_price_history  enable row level security;
alter table vehicle_equity_splits  enable row level security;$d2$;

  -- 2e. the policies, right after vehicles' own four.
  c_pol_from text := $e1$drop policy if exists "vehicles_delete" on vehicles;
create policy "vehicles_delete" on vehicles for delete using (is_ceo());$e1$;
  c_pol_to   text := $e2$drop policy if exists "vehicles_delete" on vehicles;
create policy "vehicles_delete" on vehicles for delete using (is_ceo());

-- ------------------------------------------------------------
-- 5e-bis. VEHICLE PRICE HISTORY — 0036
--
-- can_read_branch(branch_id) — the SAME audience the vehicle page
-- already shows asking_price/min_price to (neither is gated behind
-- canSeeCost there), not a literal mirror of vehicles_select's five
-- arms. See the file header for why that is the simplest correct
-- answer rather than an oversight.
-- ------------------------------------------------------------
drop policy if exists "vehicle_price_history_select" on vehicle_price_history;
create policy "vehicle_price_history_select" on vehicle_price_history for select
  using (can_read_branch(branch_id));

-- INSERT comes only from record_vehicle_price_history(), which is NOT
-- security definer and so runs under RLS when it is the pricing form's
-- plain UPDATE that fired it (see the file header for the full
-- reasoning). changed_by = auth.uid() pins the writer column, the same
-- shape 0033 used for installment_plans.created_by and
-- branch_grants.granted_by.
drop policy if exists "vehicle_price_history_insert" on vehicle_price_history;
create policy "vehicle_price_history_insert" on vehicle_price_history for insert
  with check (changed_by = auth.uid() and can_act_on_branch(branch_id));

-- NO UPDATE, NO DELETE. A price-history row is a fact about a moment —
-- see the file header.$e2$;

  -- 2f. the trigger attachment, right after trg_audit_vehicles.
  c_trg_from text := $f1$drop trigger if exists trg_audit_vehicles on vehicles;
create trigger trg_audit_vehicles
  after insert or update or delete on vehicles
  for each row execute function record_audit();$f1$;
  c_trg_to   text := $f2$drop trigger if exists trg_audit_vehicles on vehicles;
create trigger trg_audit_vehicles
  after insert or update or delete on vehicles
  for each row execute function record_audit();

-- vehicle_price_history (0036). AFTER INSERT OR UPDATE so one function
-- and one trigger cover both moments described in the file header.
drop trigger if exists trg_vehicle_price_history on vehicles;
create trigger trg_vehicle_price_history
  after insert or update on vehicles
  for each row execute function record_vehicle_price_history();$f2$;

  -- 2g. the grants, right after 0028's column-limited pricing UPDATE.
  c_gnt_from text := $g1$grant update (asking_price, min_price) on vehicles to {{ROLE}};$g1$;
  c_gnt_to   text := $g2$grant update (asking_price, min_price) on vehicles to {{ROLE}};
-- A car gets driven between intake and sale, so the odometer stays
-- writable after intake — a SEPARATE statement rather than folding into
-- 0028's line above, which stays byte-for-byte what it was so any later
-- migration anchored on it still matches. Same column-limited shape:
-- the vehicles_update policy (CEO, or a manager on their own branch)
-- gates the rows, this grant gates the column.
grant update (odometer_km) on vehicles to {{ROLE}};

-- vehicle_price_history (0036). SELECT and INSERT only — the trigger is
-- the only writer, INSERT is what lets it write under RLS when it is
-- the tenant role's own session that fired the UPDATE (see the file
-- header). No UPDATE, no DELETE: a history row is never revised.
grant select, insert on vehicle_price_history to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on vehicle_price_history to service_role;$g2$;

  -- 2h. the intake RPC's grant — 23 arguments become 25. The old grant
  --     must be GONE, not merely joined: a leftover would grant on a
  --     function the new template never creates, and provisioning would
  --     abort (0026's/0032's PGRST203 lesson).
  c_rpc_gnt_from text := $h1$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb) to {{ROLE}};$h1$;
  c_rpc_gnt_to   text := $h2$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text) to {{ROLE}};$h2$;

  -- The function span. Head locates the function; tail is the line
  -- every SECURITY DEFINER plpgsql function in the template ends with,
  -- so it is only ever searched FORWARD from a head — 0032's approach
  -- for this same function, restated.
  c_intake_head constant text := $h3$create or replace function create_vehicle_with_equity_splits($h3$;
  c_fn_tail     constant text := $h4$$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$h4$;
begin
  select body into c_intake_new from felix_0036_fn where name = 'create_vehicle_with_equity_splits';

  -- The template's own line-ending convention decides every string's.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next. Each string is flattened to
  -- LF first — the operator's runbook converts this whole FILE to CRLF
  -- before applying it, so the anchors can arrive either way — and then
  -- rewritten in the template's convention. Same shape as 0030–0033 §2.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_veh_from     := replace(replace(c_veh_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_veh_to       := replace(replace(c_veh_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_from     := replace(replace(c_tbl_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to       := replace(replace(c_tbl_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_from      := replace(replace(c_fn_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_to        := replace(replace(c_fn_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from     := replace(replace(c_rls_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to       := replace(replace(c_rls_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from     := replace(replace(c_pol_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to       := replace(replace(c_pol_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_from     := replace(replace(c_trg_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_to       := replace(replace(c_trg_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from     := replace(replace(c_gnt_from,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to       := replace(replace(c_gnt_to,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rpc_gnt_from := replace(replace(c_rpc_gnt_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rpc_gnt_to   := replace(replace(c_rpc_gnt_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_intake_new   := replace(replace(c_intake_new,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('odometer_km          numeric' in v_tpl) > 0
     or position('create table if not exists vehicle_price_history' in v_tpl) > 0 then
    raise notice '0036: template already carries inventory intelligence — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_veh_from, c_veh_to);
    if position(c_veh_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2a (vehicles columns) did not match. Template drifted from 0032.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2b (vehicle_price_history) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2c (trigger function) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2d (rls) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2e (policies) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2f (trigger attachment) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2g (grants) did not match. Template drifted from 0028.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rpc_gnt_from, c_rpc_gnt_to);
    if position(c_rpc_gnt_to in v_tpl) = 0 then
      raise exception '0036: template anchor 2h (intake grant) did not match. Template drifted from 0032.';
    end if;
    if position(c_rpc_gnt_from in v_tpl) > 0 then
      raise exception '0036: the 23-argument intake grant survived the amendment.';
    end if;
    v_done := v_done + 1;

    -- ── the function span ───────────────────────────────────
    v_at := position(c_intake_head in v_tpl);
    if v_at = 0 then
      raise exception '0036: create_vehicle_with_equity_splits() not found in the template. Template drifted from 0026.';
    end if;
    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_fn_tail in v_rest);
    if v_len = 0 then
      raise exception '0036: create_vehicle_with_equity_splits() has no SECURITY DEFINER tail. Template drifted from 0026.';
    end if;
    v_len  := v_len + length(c_fn_tail) - 1;
    v_tpl  := substr(v_tpl, 1, v_at - 1) || c_intake_new || substr(v_tpl, v_at + v_len);
    v_done := v_done + 1;

    -- The 23-argument body must be gone with its grant, or PostgREST
    -- would face two overloads at every intake (PGRST203).
    if position('p_photos text[],' || v_nl || '  p_splits jsonb' || v_nl || ') returns uuid' in v_tpl) > 0 then
      raise exception '0036: the 23-argument intake signature survived the span replacement.';
    end if;

    -- Every plain anchor above is a prefix or a suffix of its
    -- replacement, so `replace` would fire twice if the template ever
    -- carried two copies of one. Counted against the probe's OWN
    -- length rather than a hand-counted constant — 0032's convention —
    -- so a probe whose spacing has drifted removes nothing and fails
    -- here too, which is the same answer for a different reason and
    -- equally worth having.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists vehicle_price_history', ''))) <>
       length('create table if not exists vehicle_price_history') then
      raise exception '0036: the template does not carry exactly one vehicle_price_history table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'odometer_km          numeric', ''))) <>
       length('odometer_km          numeric') then
      raise exception '0036: the template does not carry exactly one vehicles.odometer_km.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in
    -- 0026/0031/0032.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0036$ select %L::text $felix_0036$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0036: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0016 §3,
-- 0031 §3, 0032 §3 and 0033 §3: the FK targets, the policy expressions
-- and the trigger's function are resolved and FROZEN here, and each
-- showroom's must bind to its own can_read_branch(), can_act_on_branch()
-- and record_audit() (unused here, but vehicles' own audit trigger
-- still needs its own copy — untouched by this migration).
--
-- ORDER MATTERS: the table lands before the trigger function that
-- inserts into it, and the trigger function lands before the trigger
-- that attaches it — a `language plpgsql` body is not validated at
-- CREATE time, but `create trigger ... execute function X()` IS
-- resolved immediately and fails if X does not exist yet.
-- ============================================================
do $mig$
declare
  r            record;
  v_count      int := 0;
  c_intake_new text;

  c_ddl constant text := $ddl$
-- ── vehicles: odometer and source ────────────────────────────
alter table vehicles add column if not exists odometer_km numeric;
alter table vehicles add column if not exists acquisition_source text;

-- No `add constraint if not exists` in Postgres, and conname is not
-- database-unique, so an EXISTS probe without a schema qualifier would
-- silently skip every tenant after the first (0018's lesson). Drop and
-- add converges on a re-run instead.
alter table vehicles drop constraint if exists vehicles_odometer_km_check;
alter table vehicles add constraint vehicles_odometer_km_check check (odometer_km >= 0);

-- ── vehicle_price_history ────────────────────────────────────
create table if not exists vehicle_price_history (
  id           uuid        primary key default gen_random_uuid(),
  vehicle_id   uuid        not null references vehicles(id) on delete cascade,
  branch_id    uuid        not null references branches(id),
  asking_price numeric,
  min_price    numeric,
  changed_by   uuid        references profiles(id),
  changed_at   timestamptz not null default now()
);

create index if not exists idx_vehicle_price_history_vehicle
  on vehicle_price_history(vehicle_id, changed_at desc);
create index if not exists idx_vehicle_price_history_branch
  on vehicle_price_history(branch_id);

alter table vehicle_price_history enable row level security;

drop policy if exists "vehicle_price_history_select" on vehicle_price_history;
create policy "vehicle_price_history_select" on vehicle_price_history for select
  using (can_read_branch(branch_id));

drop policy if exists "vehicle_price_history_insert" on vehicle_price_history;
create policy "vehicle_price_history_insert" on vehicle_price_history for insert
  with check (changed_by = auth.uid() and can_act_on_branch(branch_id));

-- ── the trigger function and its attachment ──────────────────
create or replace function record_vehicle_price_history() returns trigger as $trg$
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
$trg$ language plpgsql;

drop trigger if exists trg_vehicle_price_history on vehicles;
create trigger trg_vehicle_price_history
  after insert or update on vehicles
  for each row execute function record_vehicle_price_history();
$ddl$;
begin
  select body into c_intake_new from felix_0036_fn where name = 'create_vehicle_with_equity_splits';

  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- vehicles is both the table this migration exists to widen and the
    -- FK target of the new one; its absence tells a half-provisioned
    -- tenant from a complete one.
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0036: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    -- pg_temp is searched implicitly, so felix_0036_fn stays reachable —
    -- though the body was already read into a local above regardless.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute c_ddl;

    -- The 23-argument intake must be DROPPED before the 25-argument one
    -- is created: `create or replace` keys on the argument list, and
    -- PostgREST refuses to choose between two overloads it can both
    -- satisfy (PGRST203). 0026's and 0032's headers have the full
    -- account.
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits('
      'uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb)',
      r.schema_name
    );

    -- format() is avoided for the function body: it is full of `%s` and
    -- `%%` that would have to be re-escaped, and a mis-escaped RAISE is
    -- a bug nobody sees until the day it fires. The template's own
    -- placeholder does the job instead.
    execute replace(c_intake_new, '{{SCHEMA}}', quote_ident(r.schema_name));

    -- §6b's blanket revoke and §6d/§6h's grants ran at provisioning and
    -- cannot reach objects added afterwards. These are what make the new
    -- column, the new table and the new RPC signature reachable, and by
    -- exactly whom. No DELETE/UPDATE for the tenant role on
    -- vehicle_price_history — assertion (j) forbids DELETE outright, and
    -- a history row is never revised (see the file header).
    execute format(
      'grant update (odometer_km) on %I.vehicles to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert on %I.vehicle_price_history to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.vehicle_price_history to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.vehicle_price_history from public, anon, authenticated',
      r.schema_name
    );

    execute format(
      'grant execute on function %I.create_vehicle_with_equity_splits('
      'uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text) to %I',
      r.schema_name, r.role_name
    );

    -- Postgres grants EXECUTE on a NEW function to PUBLIC by default —
    -- 0032's note on prevent_split_on_consignment() applies identically
    -- here. §6a's blanket revoke ran long ago at provisioning, so this
    -- is the matching one for a function added afterwards. A trigger
    -- function needs no EXECUTE grant to fire (§4.11).
    execute format(
      'revoke all on function %I.record_vehicle_price_history() from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0036: % amended.', r.schema_name;
  end loop;

  -- §5 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0036: % tenant schema(s) carry inventory intelligence.', v_count;
end
$mig$;

-- ============================================================
-- 4. BACKFILL
--
-- There is none, and that is worth stating rather than leaving as an
-- absence. odometer_km and acquisition_source are both NULLABLE with no
-- default, so every row that already existed simply carries NULL —
-- including 0032's trade-ins, which the file header calls out by name.
-- There is no source of truth to backfill either column from: an
-- odometer reading recorded nowhere cannot be recovered, and inventing
-- one would be worse than admitting it is unknown. §5 asserts nothing
-- was silently coerced into failing the new CHECK instead.
-- ============================================================

-- ============================================================
-- 5. SELF-VERIFY — structure, lockdown, the rewritten RPC, and that
-- every policy is bound to THIS schema's predicates.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_priv text;
  n      int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'vehicles'
         and column_name in ('odometer_km', 'acquisition_source')
       having count(*) = 2
    ) then
      v_bad := v_bad || (r.schema_name || ' (vehicles columns)');
    end if;

    if not exists (
      select 1 from pg_constraint c
       join pg_class t      on t.oid = c.conrelid
       join pg_namespace ns on ns.oid = t.relnamespace
      where ns.nspname = r.schema_name and t.relname = 'vehicles'
        and c.conname = 'vehicles_odometer_km_check'
    ) then
      v_bad := v_bad || (r.schema_name || ' (odometer check)');
    end if;

    -- The odometer is UPDATABLE — cars get driven — the same
    -- column-limited shape 0028 used for asking_price/min_price. And
    -- still not the columns the RPC ceremony exists to protect.
    if not has_column_privilege(
         r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'odometer_km', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot update odometer_km)');
    end if;
    if has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'status', 'update')
       or has_column_privilege(r.role_name, format('%I.vehicles', r.schema_name)::regclass, 'purchase_price', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can update guarded vehicles columns!)');
    end if;

    if to_regclass(format('%I.vehicle_price_history', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicle_price_history'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicle_price_history';
    if n <> 2 then
      v_bad := v_bad || format('%s (%s price-history policies, expected 2)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's
    -- can_read_branch()/can_act_on_branch()/auth.uid().
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicle_price_history'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M|auth\.uid');
    if n > 0 then
      v_bad := v_bad || format('%s (%s price-history policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    foreach v_priv in array array['select', 'insert'] loop
      if not has_table_privilege(
           r.role_name, format('%I.vehicle_price_history', r.schema_name), v_priv) then
        v_bad := v_bad || format('%s (role has no %s on price history)', r.schema_name, v_priv);
      end if;
    end loop;

    -- UPDATE and DELETE are both withheld on purpose — a history row is
    -- never revised. Assert both, or a later blanket grant hands them
    -- over without anyone deciding so. DELETE would also break
    -- assertion (j) at the next provisioning.
    foreach v_priv in array array['update', 'delete'] loop
      if has_table_privilege(
           r.role_name, format('%I.vehicle_price_history', r.schema_name), v_priv) then
        v_bad := v_bad || format('%s (role holds %s on price history)', r.schema_name, v_priv);
      end if;
    end loop;

    if not has_table_privilege(
         'service_role', format('%I.vehicle_price_history', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write price history)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.vehicle_price_history', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.vehicle_price_history', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege on price history)');
    end if;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicles'
         and t.tgname = 'trg_vehicle_price_history' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (missing trg_vehicle_price_history)');
    end if;

    -- The trigger function must exist and must NOT be security definer
    -- — assertion (f)'s count of twenty would otherwise silently drift,
    -- and auth.uid() inside it would stop meaning "the real caller".
    if not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'record_vehicle_price_history'
         and not p.prosecdef
    ) then
      v_bad := v_bad || (r.schema_name || ' (record_vehicle_price_history missing or security definer)');
    end if;

    -- The RPC, at the new arity and NOT at the old one (PGRST203).
    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb, numeric, text)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (25-arg intake rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (23-arg intake rpc survived — PGRST203)');
    end if;

    -- The rewritten body actually landed, rather than merely compiling.
    if (select prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = r.schema_name and p.proname = 'create_vehicle_with_equity_splits')
       not like '%p_acquisition_source%' then
      v_bad := v_bad || (r.schema_name || ' (create_vehicle_with_equity_splits not rewritten)');
    end if;

    -- The backfill's postcondition, such as it is: nothing may have
    -- been left in a state the new CHECK would refuse.
    execute format(
      'select count(*) from %I.vehicles where odometer_km is not null and odometer_km < 0',
      r.schema_name
    ) into n;
    if n > 0 then
      v_bad := v_bad || format('%s (%s vehicle(s) with a negative odometer reading)', r.schema_name, n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0036 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('odometer_km          numeric' in platform.tenant_ddl_template()) = 0
     or position('acquisition_source    text' in platform.tenant_ddl_template()) = 0
     or position('create table if not exists vehicle_price_history' in platform.tenant_ddl_template()) = 0
     or position('"vehicle_price_history_select" on vehicle_price_history' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert on vehicle_price_history' in platform.tenant_ddl_template()) = 0
     or position('grant update (odometer_km) on vehicles' in platform.tenant_ddl_template()) = 0
     or position('p_odometer_km numeric,' in platform.tenant_ddl_template()) = 0
     or position('p_acquisition_source text' in platform.tenant_ddl_template()) = 0 then
    raise exception '0036 VERIFY FAILED: the template does not carry inventory intelligence.';
  end if;

  raise notice '0036: verified — every car has an odometer field, an ageing clock and a price history, everywhere.';
end
$$;

-- PostgREST caches the schema; without this the new table, the new
-- columns and the widened RPC signature are all rejected as unknown
-- until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
