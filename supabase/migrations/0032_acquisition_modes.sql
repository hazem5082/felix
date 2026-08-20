-- ============================================================
-- 0032 — ACQUISITION MODES: TRADE-IN AND CONSIGNMENT
--
-- A deal ticket has always been one-directional: one vehicle_id
-- pointing outward, one cap table behind it, one waterfall. The two
-- commonest arrangements on an Egyptian forecourt do not fit that shape
-- at all.
--
--   تبديل   (TRADE-IN)     the buyer's old car is appraised and allowed
--                          against the price. Half the settlement leaves
--                          as cash and the other half arrives as a car —
--                          which must be in stock the moment the sale
--                          executes, or the showroom is holding an asset
--                          its own books deny.
--   بالأمانة (CONSIGNMENT) somebody else's car, sold for a commission.
--                          No capital is deployed, no investor holds a
--                          stake, and the sale creates a DEBT to the
--                          owner rather than a profit to divide.
--
-- Neither was representable. vehicles.purchase_price carried
-- `check (purchase_price > 0)`, so a car that cost nothing could not
-- exist; and the equity model assumes the showroom owns every row in
-- `vehicles`, so compute_sale_waterfall() would happily divide a
-- consignor's money among the house and its investors.
--
-- WHAT THIS ADDS
-- --------------
--   vehicles.acquisition_type   'purchase' (the default, and what every
--                               existing row is), 'trade_in',
--                               'consignment'.
--   vehicles.consignor_*        who still owns the car, and on what
--                               commission terms. All nullable.
--   deal_tickets.trade_in_*     the trade-in leg of a ticket: the car
--                               described, the allowance granted, the
--                               photos. All nullable.
--   consignment_payouts         the debt to the consignor, minted at
--                               execution. Soft state only — marked
--                               paid, never deleted.
--   execute_vehicle_sale()      branches on acquisition_type, and mints
--                               the trade-in vehicle inside the same
--                               transaction as the sale.
--   create_vehicle_with_equity_splits()
--                               widened 17 → 23 arguments so intake can
--                               take a car in on consignment.
--
-- WHY THE PURCHASE-PRICE CHECK IS WIDENED RATHER THAN DROPPED
-- -----------------------------------------------------------
-- `purchase_price > 0` is a real rule for a car the showroom bought: a
-- zero cost basis silently inflates the profit every equity holder is
-- paid. It is meaningless for a consigned car, whose cost basis is zero
-- by definition. The constraint therefore becomes conditional on the
-- mode rather than disappearing:
--
--   (acquisition_type = 'consignment' and purchase_price = 0)
--   or purchase_price > 0
--
-- 0009 wrote the original inline on the column, which auto-named itself
-- `vehicles_purchase_price_check`. §2 rewrites the column line and
-- restates the rule as a NAMED table constraint; §3 drops the old name
-- and adds the same one back. Both targets land on one name, so a later
-- migration has one thing to reason about.
--
-- WHY THE CONSIGNMENT RULES ARE NOT TABLE CHECKS
-- ----------------------------------------------
-- A consignment is commercially empty without a consignor and a
-- commission — execute_vehicle_sale() has nothing to pay the house and
-- nothing to owe the owner. That still is not a CHECK. The judgement
-- 0025 and 0026 recorded applies here too: grey stock exists, rows
-- predating a rule exist, and a NOT NULL on a column the app only just
-- learned to fill turns an ordinary correction into a migration. The
-- requirement is enforced in the two places where a human is present —
-- the intake RPC (which raises a sentence, not a constraint violation)
-- and the zod schema behind the form.
--
-- The CHECKs that ARE here are the shape checks, which cost nothing and
-- catch a typo: the enum of modes, the enum of commission types, a
-- non-negative commission, and the 14-digit national ID 0020 and 0018
-- already use for the same kind of field.
--
-- WHY A CONSIGNED CAR HAS NO CAP TABLE, AND A TRIGGER SAYS SO
-- -----------------------------------------------------------
-- vehicle_equity_splits describes who funded a car. Nobody funded a
-- consigned one. An investor row against it would entitle somebody to a
-- share of a profit that is not the showroom's to divide, and the
-- deferred sum-to-100 trigger would cheerfully accept it. §2 adds
-- prevent_split_on_consignment() as a BEFORE trigger on the splits
-- table, so the rule holds for every write path including direct SQL —
-- the same reasoning 0003 used for prevent_split_edit_after_sale(),
-- which sits beside it and answers a different question.
--
-- It is a NEW function rather than a clause bolted onto that one
-- because the two rules have nothing to do with each other: one is
-- about time (after the sale), one is about ownership (never). A guard
-- whose name stops describing what it does is a guard that gets deleted
-- by someone who read only the name.
--
-- Neither is SECURITY DEFINER, so assertion (f) in
-- platform.create_tenant_schema() — exactly twenty SECURITY DEFINER
-- functions per tenant schema — is untouched. Both RPCs this migration
-- rewrites already existed; replacing a body keeps the count. Assertion
-- (j) is likewise untouched: consignment_payouts is granted SELECT and
-- UPDATE to the tenant role and no DELETE, like every other table.
--
-- WHY THE TRADE-IN DOES NOT CHANGE THE WATERFALL
-- ----------------------------------------------
-- The waterfall stays computed on the full agreed_price. The allowance
-- describes HOW the buyer settled, not what the car sold for: the money
-- leaves as cash-in-kind and returns immediately as the cost basis of a
-- new vehicles row, so the group's position is unchanged and nothing is
-- lost. Netting the allowance out of net_profit would pay every equity
-- holder less for a sale whose price never moved, and would do it
-- differently depending on whether the buyer happened to own a car.
--
-- The trade-in row itself takes a single 100%-CEO split. The allowance
-- was paid out of the sale proceeds — company money — so the company
-- owns it outright. An investor who held a stake in the car that just
-- sold has already been paid their share of that sale; a stake in the
-- car the buyer handed over would pay them twice for one transaction.
--
-- WHY 'trade_in' IS NOT OFFERED AT INTAKE
-- ---------------------------------------
-- create_vehicle_with_equity_splits() accepts 'purchase' and
-- 'consignment' and refuses 'trade_in' outright. A trade-in row is born
-- only inside execute_vehicle_sale(), against a ticket that carries the
-- allowance it was valued at. One typed in by hand would be a car with a
-- cost basis nobody agreed to and no sale behind it.
--
-- THE ODOMETER
-- ------------
-- deal_tickets.trade_in_odometer_km is recorded on the TICKET and is
-- folded into the created vehicle's `description` rather than into a
-- vehicles.odometer_km column. An odometer belongs on every car, not
-- only on the ones that arrived this way, and that column arrives in a
-- later migration. Adding a half-version here would leave two of them.
--
-- TWO TARGETS, BOTH REQUIRED (0026/0028/0031 — read those headers):
--   1. platform.tenant_ddl_template() — showrooms not yet provisioned.
--   2. Every existing t_<slug> schema, from platform.tenants.
--
-- LINE ENDINGS. The live platform.tenant_ddl_template() text is CRLF and
-- this file is LF, so a multi-line anchor matches nothing unless the two
-- agree. §2 reads the template's own convention and rewrites every
-- anchor and every replacement into it, flattening to LF first so it
-- works whether this file arrived as LF or was converted to CRLF by the
-- operator's applier. Same shape as 0030 §2 and 0031 §2.
--
-- SPAN REPLACEMENT FOR THE TWO RPCs. Every other amendment here is an
-- anchored `replace`, as everywhere in this series. The two functions are
-- different: their BODIES change, not just a parameter and an insert
-- list, so an anchored patch would have to be written twice — once as a
-- set of template anchors and once as a §3 constant — and the two copies
-- would drift. §0 therefore parks each new function body in a temp table,
-- §2 locates the old function in the template by its opening line and its
-- `$fn$ language plpgsql security definer` tail and replaces the whole
-- span, and §3 installs the identical text into every live schema. One
-- source of truth per function; §5 proves both targets carry it.
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
      '0032 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0032 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The vehicles anchor quotes the price block exactly as 0028 left it.
  if position('  asking_price    numeric' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0032 PRECONDITION FAILED: the template has no vehicles.asking_price. Apply 0028 first.';
  end if;

  -- The intake RPC span is the 17-argument signature 0026 built.
  if position('p_item_code text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0032 PRECONDITION FAILED: the intake RPC has no p_item_code. Apply 0026 first.';
  end if;

  -- The deal_tickets anchors sit on the settlement block 0023 spliced in,
  -- and consignment_payouts.settlement_method reuses its CHECK values.
  if position('deal_tickets_settlement_method_check' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0032 PRECONDITION FAILED: the template has no settlement fields. Apply 0023 first.';
  end if;

  -- Batch-ordering gate, same reasoning as 0031's: nothing here needs
  -- anything from 0031 — the anchors do not overlap and no policy of
  -- 0031's is touched — but a template amended out of order is a template
  -- nobody can reason about afterwards. A database that skipped it fails
  -- here rather than three anchors deep with a message about drift.
  if position('create table if not exists customers' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0032 PRECONDITION FAILED: the template has no customers table. Apply 0031 first.';
  end if;
end
$$;

-- ============================================================
-- 0-bis. THE TWO REWRITTEN FUNCTIONS, ONCE
--
-- Parked here so §2 (the template) and §3 (every live schema) install
-- byte-identical text. `on commit drop` takes it away with the
-- transaction, so nothing survives the migration.
--
-- {{SCHEMA}} is left as the template's own placeholder: §2 splices these
-- in verbatim, §3 substitutes the tenant's schema name before executing.
-- ============================================================
create temp table felix_0032_fn (name text primary key, body text) on commit drop;

insert into felix_0032_fn (name, body) values (
'execute_vehicle_sale',
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
    w := compute_sale_waterfall(v.id, t.agreed_price, t.discount_amount, v_as_of);
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
  update deal_tickets set status = 'executed', executed_at = v_as_of where id = t.id;

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
), (
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
  p_splits jsonb
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

  insert into vehicles (branch_id, vin, year, make, model, trim, color, description, inspection_photos, engine_number, plate_number, country_of_origin, features, item_code, acquisition_type, consignor_name, consignor_phone, consignor_national_id, consignment_commission_type, consignment_commission_value, purchase_price, photos, created_by)
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
          v_cost, coalesce(p_photos,'{}'), auth.uid())
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
-- Ten anchored substitutions plus two function spans. None of the ten
-- touches a region 0029, 0030 or 0031 amended — those chain off
-- vehicle_listings, the branch predicates and `leads`; these are all on
-- `vehicles`, `deal_tickets`, `ledger_entries` and 0009's own §4/§5/§6.
-- Two migrations amending one anchor point is the failure mode this
-- file, like 0031, was written to avoid.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;
  v_at   int;
  v_len  int;
  v_rest text;
  v_probe text;

  c_exec_new   text;
  c_intake_new text;

  -- Every string below is rewritten into the template's own line-ending
  -- convention before it is used; see the header and the normalisation
  -- block at the top of the body. None is `constant` for that reason.

  -- 2a. vehicles: the acquisition columns, and the purchase-price CHECK
  --     restated by name. The anchor runs from purchase_price through
  --     0028's price-order constraint, which appears exactly once — the
  --     RPC's own column list names purchase_price too, and would match a
  --     shorter anchor.
  c_veh_from text := $a1$  purchase_price  numeric     not null check (purchase_price > 0),
  -- What the shop asks and the least it will take (0028). purchase_price
  -- above is management's confidential cost; these two are the numbers
  -- the sales floor works with. Nullable: priced after intake.
  asking_price    numeric     check (asking_price > 0),
  min_price       numeric     check (min_price > 0),
  constraint chk_vehicle_price_order
    check (asking_price is null or min_price is null or min_price <= asking_price),$a1$;
  c_veh_to   text := $a2$  -- HOW THE SHOWROOM CAME TO HAVE THIS CAR (0032).
  --   purchase     bought outright. The only mode before 0032, still the
  --                default, and what every pre-0032 row is.
  --   trade_in     taken in against a sale (تبديل). Born ONLY inside
  --                execute_vehicle_sale(); never offered at intake.
  --   consignment  somebody else's car, sold for commission (بالأمانة).
  --                No capital deployed, therefore no cap table — see
  --                prevent_split_on_consignment() in §4.3.
  acquisition_type text        not null default 'purchase',
  -- The consignor: the person who still owns the car, and the terms the
  -- house is selling it on. All nullable AT THE TABLE — a purchase has no
  -- consignor, and grey rows predate every rule. The requirement that a
  -- consignment actually names one, with a commission, is enforced in
  -- create_vehicle_with_equity_splits() and in the zod schema, where a
  -- human is looking at a form. Only the SHAPE is checked here.
  consignor_name               text,
  consignor_phone              text,
  consignor_national_id        text,
  consignment_commission_type  text,
  consignment_commission_value numeric,
  -- 0009 wrote `check (purchase_price > 0)` inline here, which auto-named
  -- itself vehicles_purchase_price_check. 0032 restates it by name at the
  -- foot of the table so it can be conditional on the mode: a consigned
  -- car deploys NO capital, so its cost basis is exactly zero.
  purchase_price  numeric     not null,
  -- What the shop asks and the least it will take (0028). purchase_price
  -- above is management's confidential cost; these two are the numbers
  -- the sales floor works with. Nullable: priced after intake.
  asking_price    numeric     check (asking_price > 0),
  min_price       numeric     check (min_price > 0),
  constraint chk_vehicle_price_order
    check (asking_price is null or min_price is null or min_price <= asking_price),
  constraint vehicles_purchase_price_check check (
    (acquisition_type = 'consignment' and purchase_price = 0)
    or purchase_price > 0
  ),
  constraint vehicles_acquisition_type_check check (
    acquisition_type in ('purchase','trade_in','consignment')
  ),
  -- Same 14-digit shape as profiles' (0018), leads' (0020) and
  -- customers' (0031). Nullable: collected when the paperwork is.
  constraint vehicles_consignor_national_id_check check (
    consignor_national_id is null
    or consignor_national_id ~ '^[0-9]{14}$'
  ),
  constraint vehicles_consignment_commission_check check (
    (consignment_commission_type is null
     or consignment_commission_type in ('fixed','percent'))
    and (consignment_commission_value is null
     or consignment_commission_value >= 0)
  ),$a2$;

  -- 2b. deal_tickets: the trade-in leg, before created_at (post-0023).
  c_dt_col_from text := $a3$  settlement_method         text,
  settlement_reference      text,
  settlement_bank           text,
  created_at                timestamptz default now(),$a3$;
  c_dt_col_to   text := $a4$  settlement_method         text,
  settlement_reference      text,
  settlement_bank           text,
  -- THE TRADE-IN LEG (0032) — تبديل. The buyer's old car, described and
  -- appraised on the ticket that sells them the new one. All nullable:
  -- most tickets have no trade-in, and every ticket predating 0032 has
  -- none. execute_vehicle_sale() turns these into a `vehicles` row at the
  -- moment the sale settles, and nothing else reads them.
  --
  -- The odometer lives HERE and not on vehicles: an odometer belongs on
  -- every car, not only on the ones that arrived this way, and that
  -- column arrives in a later migration. Until then it is folded into the
  -- created vehicle's description.
  trade_in_make             text,
  trade_in_model            text,
  trade_in_year             int,
  trade_in_color            text,
  trade_in_vin              text,
  trade_in_odometer_km      numeric,
  trade_in_allowance        numeric,
  trade_in_notes            text,
  trade_in_photos           text[]      not null default '{}',
  created_at                timestamptz default now(),$a4$;

  -- 2c. deal_tickets constraints, at the tail of the DDL (post-0023).
  c_dt_chk_from text := $a5$  constraint deal_tickets_settlement_method_check check (
    settlement_method is null
    or settlement_method in ('bank_transfer','cheque','instapay','cash')
  )
);$a5$;
  c_dt_chk_to   text := $a6$  constraint deal_tickets_settlement_method_check check (
    settlement_method is null
    or settlement_method in ('bank_transfer','cheque','instapay','cash')
  ),
  -- A trade-in allowance of zero is not a trade-in, and a negative one
  -- would add phantom stock at a negative cost basis — the same class of
  -- hole 0009 closed on discount_amount. NULL is the ordinary case.
  -- The requirement that an allowance also DESCRIBES a car lives in the
  -- zod schema: a make and a model are how an appraisal means anything,
  -- and a ticket written before 0032 must not become unsaveable.
  constraint deal_tickets_trade_in_allowance_check check (
    trade_in_allowance is null or trade_in_allowance > 0
  )
);$a6$;

  -- 2d. consignment_payouts, after ledger_entries' indexes in §14 — it is
  --     the same kind of object (money owed, written by the definer) and
  --     reads beside it.
  c_tbl_from text := $a7$create index if not exists idx_ledger_ref_vehicle  on ledger_entries(ref_vehicle_id);$a7$;
  c_tbl_to   text := $a8$create index if not exists idx_ledger_ref_vehicle  on ledger_entries(ref_vehicle_id);

-- ------------------------------------------------------------
-- 14-bis. CONSIGNMENT PAYOUTS (0032)
--
-- What the showroom owes the owner of a consigned car once it has sold
-- it. ledger_entries is the house's OWN wallet — CEO, investors, sales
-- executives — and a consignor is none of those: they are an outside
-- creditor, and putting them in the ledger would make every profit
-- report count somebody else's money as the group's.
--
-- One row per executed consignment sale, written inside
-- execute_vehicle_sale() (SECURITY DEFINER, so no INSERT policy and no
-- INSERT grant are needed — the ledger_entries precedent exactly).
--
-- SOFT STATE ONLY. paid_at, the settlement channel and the reference are
-- filled in when the money actually moves; the row is never deleted,
-- because a debt that was paid is a fact and a debt that was mistakenly
-- raised is corrected by a note, not by erasure.
--
-- settlement_method reuses 0023's four channels verbatim: it is the same
-- question — how did the money move — asked about the other direction.
-- ------------------------------------------------------------
create table if not exists consignment_payouts (
  id                 uuid        primary key default gen_random_uuid(),
  vehicle_id         uuid        not null references vehicles(id),
  deal_ticket_id     uuid        not null references deal_tickets(id),
  -- Copied off the vehicle at execution rather than joined. The name on
  -- the cheque is the name that was agreed on the day, and a later
  -- correction to the vehicle row must not silently restate it.
  consignor_name     text        not null,
  amount_due         numeric     not null check (amount_due >= 0),
  commission_amount  numeric     not null check (commission_amount >= 0),
  paid_at            timestamptz,
  settlement_method  text,
  settlement_reference text,
  note               text,
  created_at         timestamptz default now(),
  constraint consignment_payouts_settlement_method_check check (
    settlement_method is null
    or settlement_method in ('bank_transfer','cheque','instapay','cash')
  )
);

create index if not exists idx_consignment_payouts_vehicle on consignment_payouts(vehicle_id);
create index if not exists idx_consignment_payouts_ticket  on consignment_payouts(deal_ticket_id);
-- The accountant's working query: everything still owed, oldest first.
create index if not exists idx_consignment_payouts_due
  on consignment_payouts(created_at) where paid_at is null;$a8$;

  -- 2e. RLS enablement, beside ledger_entries' in §5a. Assertion (b) of
  --     platform.create_tenant_schema() walks pg_class for a table with
  --     RLS off, so a miss here fails provisioning rather than leaking.
  c_rls_from text := $a9$alter table ledger_entries         enable row level security;$a9$;
  c_rls_to   text := $b1$alter table ledger_entries         enable row level security;
alter table consignment_payouts    enable row level security;$b1$;

  -- 2f. policies, after ledger_entries' two in §5q.
  c_pol_from text := $b2$drop policy if exists "ledger_entries_insert" on ledger_entries;
create policy "ledger_entries_insert" on ledger_entries for insert
  with check (is_accountant_or_above() and type <> 'sale_profit_share');$b2$;
  c_pol_to   text := $b3$drop policy if exists "ledger_entries_insert" on ledger_entries;
create policy "ledger_entries_insert" on ledger_entries for insert
  with check (is_accountant_or_above() and type <> 'sale_profit_share');

-- ------------------------------------------------------------
-- 5q-bis. CONSIGNMENT PAYOUTS — 0032
--
-- Accountant-or-above, org-wide, with no branch predicate: paying the
-- consignors is one desk's job for the whole group, and a payout list
-- that stopped at the branch boundary would be a list nobody could work
-- from. The sales floor is outside it entirely — what the showroom owes
-- an outside creditor is not a salesperson's business, and the ticket
-- they raised already tells them the sale went through.
--
-- UPDATE is the same audience because marking a payout paid IS the only
-- edit: the amounts are set by execute_vehicle_sale() and every one of
-- them is derived from a price the manager already approved.
--
-- NO INSERT POLICY, on purpose and by the ledger_entries precedent: the
-- only writer is execute_vehicle_sale(), which is SECURITY DEFINER and
-- so is not subject to these policies at all. An INSERT policy here
-- would let an accountant invent a debt.
--
-- NO DELETE POLICY, and §6d withholds the grant besides. A paid debt is
-- a fact; a mistaken one is corrected by a note.
-- ------------------------------------------------------------
drop policy if exists "consignment_payouts_select" on consignment_payouts;
create policy "consignment_payouts_select" on consignment_payouts for select
  using (is_accountant_or_above());

drop policy if exists "consignment_payouts_update" on consignment_payouts;
create policy "consignment_payouts_update" on consignment_payouts for update
  using (is_accountant_or_above()) with check (is_accountant_or_above());$b3$;

  -- 2g. the equity guard, beside 0003's in §4.3.
  c_fn_from text := $b4$create or replace function prevent_split_edit_after_sale() returns trigger as $trg$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id) and status = 'sold'
  ) then
    raise exception 'Cannot modify equity splits after the vehicle has been sold';
  end if;
  return coalesce(new, old);
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$b4$;
  c_fn_to   text := $b5$create or replace function prevent_split_edit_after_sale() returns trigger as $trg$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id) and status = 'sold'
  ) then
    raise exception 'Cannot modify equity splits after the vehicle has been sold';
  end if;
  return coalesce(new, old);
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- 0032. A CONSIGNED CAR HAS NO CAP TABLE. vehicle_equity_splits records
-- who FUNDED a car; nobody funded this one. A row here would entitle
-- somebody to a share of money that is not the showroom's to divide, and
-- check_equity_splits_sum() would accept it happily — it only asks
-- whether the percentages reach 100.
--
-- Separate from prevent_split_edit_after_sale() above because the two
-- rules are unrelated: that one is about time (after the sale), this one
-- is about ownership (never). Folding them together would leave a guard
-- whose name no longer says what it does.
--
-- NOT security definer, like every trigger function in this file — the
-- twenty-SECURITY-DEFINER count asserted at provisioning is unchanged.
create or replace function prevent_split_on_consignment() returns trigger as $trg$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id)
      and acquisition_type = 'consignment'
  ) then
    raise exception 'A consigned vehicle has no equity splits — the showroom does not own it';
  end if;
  return coalesce(new, old);
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$b5$;

  -- 2h. the trigger attachment, beside trg_lock_splits in §4.9.
  c_trg_from text := $b6$drop trigger if exists trg_lock_splits on vehicle_equity_splits;
create trigger trg_lock_splits
  before insert or update or delete on vehicle_equity_splits
  for each row execute function prevent_split_edit_after_sale();$b6$;
  c_trg_to   text := $b7$drop trigger if exists trg_lock_splits on vehicle_equity_splits;
create trigger trg_lock_splits
  before insert or update or delete on vehicle_equity_splits
  for each row execute function prevent_split_edit_after_sale();

drop trigger if exists trg_no_splits_on_consignment on vehicle_equity_splits;
create trigger trg_no_splits_on_consignment
  before insert or update or delete on vehicle_equity_splits
  for each row execute function prevent_split_on_consignment();$b7$;

  -- 2i. the audit trigger, beside ledger_entries' in §4.10.
  c_aud_from text := $b8$drop trigger if exists trg_audit_ledger_entries on ledger_entries;
create trigger trg_audit_ledger_entries
  after insert or update or delete on ledger_entries
  for each row execute function record_audit();$b8$;
  c_aud_to   text := $b9$drop trigger if exists trg_audit_ledger_entries on ledger_entries;
create trigger trg_audit_ledger_entries
  after insert or update or delete on ledger_entries
  for each row execute function record_audit();

-- consignment_payouts (0032). The single most damaging edit this table
-- allows is a payout quietly marked paid that never was, so every write
-- leaves a before/after pair, exactly as ledger_entries does.
drop trigger if exists trg_audit_consignment_payouts on consignment_payouts;
create trigger trg_audit_consignment_payouts
  after insert or update or delete on consignment_payouts
  for each row execute function record_audit();$b9$;

  -- 2j. the grant, beside ledger_entries' in §6d.
  c_gnt_from text := $c1$grant select on ledger_entries to {{ROLE}};$c1$;
  c_gnt_to   text := $c2$grant select on ledger_entries to {{ROLE}};

-- What the showroom owes the owners of consigned stock (0032). SELECT and
-- UPDATE only: the rows are minted by execute_vehicle_sale() as the
-- definer, so no INSERT is needed, and marking one paid is the single
-- edit the accountant hub makes. No DELETE, like every other table in 6d
-- — see the policy note in §5q-bis.
grant select, update on consignment_payouts to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on consignment_payouts to service_role;$c2$;

  -- 2k. the intake RPC's grant — 17 arguments become 23. The old grant
  --     must be GONE, not merely joined: a leftover would grant on a
  --     function the new template never creates, and provisioning would
  --     abort (0026's lesson, and PGRST203 is the other half of it).
  c_rpc_gnt_from text := $c3$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, numeric, text[], jsonb) to {{ROLE}};$c3$;
  c_rpc_gnt_to   text := $c4$grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb) to {{ROLE}};$c4$;

  -- The two function spans. Head locates the function; tail is the line
  -- every SECURITY DEFINER plpgsql function in the template ends with, so
  -- it is only ever searched FORWARD from a head.
  c_exec_head   text := $c5$create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)$c5$;
  c_intake_head text := $c6$create or replace function create_vehicle_with_equity_splits($c6$;
  c_fn_tail     text := $c7$$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$c7$;
begin
  select body into c_exec_new   from felix_0032_fn where name = 'execute_vehicle_sale';
  select body into c_intake_new from felix_0032_fn where name = 'create_vehicle_with_equity_splits';

  -- The template's own line-ending convention decides every string's.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next. Each string is flattened to LF
  -- first — the operator's runbook converts this whole FILE to CRLF
  -- before applying it, so they can arrive either way — and then
  -- rewritten in the template's convention. Same shape as 0030/0031 §2.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_veh_from      := replace(replace(c_veh_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_veh_to        := replace(replace(c_veh_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_dt_col_from   := replace(replace(c_dt_col_from,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_dt_col_to     := replace(replace(c_dt_col_to,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_dt_chk_from   := replace(replace(c_dt_chk_from,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_dt_chk_to     := replace(replace(c_dt_chk_to,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_from      := replace(replace(c_tbl_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to        := replace(replace(c_tbl_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from      := replace(replace(c_rls_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to        := replace(replace(c_rls_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from      := replace(replace(c_pol_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to        := replace(replace(c_pol_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_from       := replace(replace(c_fn_from,       chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_to         := replace(replace(c_fn_to,         chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_from      := replace(replace(c_trg_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_to        := replace(replace(c_trg_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_aud_from      := replace(replace(c_aud_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_aud_to        := replace(replace(c_aud_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from      := replace(replace(c_gnt_from,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to        := replace(replace(c_gnt_to,        chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rpc_gnt_from  := replace(replace(c_rpc_gnt_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rpc_gnt_to    := replace(replace(c_rpc_gnt_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_exec_new      := replace(replace(c_exec_new,      chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_intake_new    := replace(replace(c_intake_new,    chr(13)||chr(10), chr(10)), chr(10), v_nl);

  -- Two probes, one per half of the migration, because the amendment is
  -- not atomic in the way a single-column one is: a template carrying the
  -- vehicles column but not the payouts table is a template somebody
  -- edited by hand, and it must not be quietly skipped.
  if position('acquisition_type text        not null' in v_tpl) > 0
     or position('create table if not exists consignment_payouts' in v_tpl) > 0 then
    raise notice '0032: template already carries the acquisition modes — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_veh_from, c_veh_to);
    if position(c_veh_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2a (vehicles columns) did not match. Template drifted from 0028.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_dt_col_from, c_dt_col_to);
    if position(c_dt_col_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2b (deal_tickets columns) did not match. Template drifted from 0023.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_dt_chk_from, c_dt_chk_to);
    if position(c_dt_chk_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2c (deal_tickets constraints) did not match. Template drifted from 0023.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2d (consignment_payouts) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2e (rls) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2f (policies) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2g (split guard) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2h (split trigger) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_aud_from, c_aud_to);
    if position(c_aud_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2i (audit trigger) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2j (grants) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rpc_gnt_from, c_rpc_gnt_to);
    if position(c_rpc_gnt_to in v_tpl) = 0 then
      raise exception '0032: template anchor 2k (intake grant) did not match. Template drifted from 0026.';
    end if;
    if position(c_rpc_gnt_from in v_tpl) > 0 then
      raise exception '0032: the 17-argument intake grant survived the amendment.';
    end if;
    v_done := v_done + 1;

    -- ── the two function spans ──────────────────────────────
    -- position() has no FROM-offset in Postgres, so the tail is located
    -- inside the substring that starts at the head. That is what makes a
    -- tail shared by six functions safe to use here.
    v_at := position(c_exec_head in v_tpl);
    if v_at = 0 then
      raise exception '0032: execute_vehicle_sale() not found in the template. Template drifted from 0009.';
    end if;
    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_fn_tail in v_rest);
    if v_len = 0 then
      raise exception '0032: execute_vehicle_sale() has no SECURITY DEFINER tail. Template drifted from 0009.';
    end if;
    v_len  := v_len + length(c_fn_tail) - 1;
    v_tpl  := substr(v_tpl, 1, v_at - 1) || c_exec_new || substr(v_tpl, v_at + v_len);
    v_done := v_done + 1;

    v_at := position(c_intake_head in v_tpl);
    if v_at = 0 then
      raise exception '0032: create_vehicle_with_equity_splits() not found in the template. Template drifted from 0026.';
    end if;
    v_rest := substr(v_tpl, v_at);
    v_len  := position(c_fn_tail in v_rest);
    if v_len = 0 then
      raise exception '0032: create_vehicle_with_equity_splits() has no SECURITY DEFINER tail. Template drifted from 0026.';
    end if;
    v_len  := v_len + length(c_fn_tail) - 1;
    v_tpl  := substr(v_tpl, 1, v_at - 1) || c_intake_new || substr(v_tpl, v_at + v_len);
    v_done := v_done + 1;

    -- The 17-argument body must be gone with its grant, or PostgREST
    -- would face two overloads at every intake (PGRST203).
    if position('p_features text[],' || v_nl || '  p_purchase_price numeric,' in v_tpl) > 0 then
      raise exception '0032: a pre-0026 intake signature survived the span replacement.';
    end if;
    if position('  p_item_code text,' || v_nl || '  p_purchase_price numeric,' in v_tpl) > 0 then
      raise exception '0032: the 17-argument intake signature survived the span replacement.';
    end if;

    -- Every plain anchor above is a prefix or a suffix of its replacement,
    -- so `replace` would fire twice if the template ever carried two copies
    -- of one. Counted by comparing the bytes `replace` removed against the
    -- probe's OWN length rather than against a hand-counted constant, as
    -- 0026/0028/0031 did — a number written out by hand is a number that
    -- can be wrong, and this one is only ever read when it fires. A probe
    -- whose spacing has drifted removes nothing and fails here too, which
    -- is the same answer for a different reason and equally worth having.
    foreach v_probe in array array[
      'create table if not exists consignment_payouts',
      'acquisition_type text        not null',
      'trade_in_allowance        numeric'
    ] loop
      if (length(v_tpl) - length(replace(v_tpl, v_probe, ''))) <> length(v_probe) then
        raise exception '0032: the template does not carry exactly one "%".', v_probe;
      end if;
    end loop;

    -- `set search_path = pg_catalog` carried over verbatim from 0009; the
    -- PUBLIC revoke is re-issued rather than assumed, as in 0026/0031.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0032$ select %L::text $felix_0032$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0032: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0016 §3,
-- 0027 §3 and 0031 §3: the FK targets, the policy expressions and the
-- triggers' functions are resolved and FROZEN HERE, and each showroom's
-- must bind to its own is_accountant_or_above(), its own record_audit(),
-- its own vehicles.
--
-- The two SECURITY DEFINER functions are the same text §2 spliced into
-- the template, with {{SCHEMA}} substituted — one source of truth, §0-bis.
--
-- ORDER MATTERS. The columns land before the constraint that references
-- them, and before the function bodies that insert into them.
-- ============================================================
do $mig$
declare
  r            record;
  v_count      int := 0;
  c_exec_new   text;
  c_intake_new text;

  c_ddl constant text := $ddl$
-- ── vehicles: the acquisition mode and the consignor ─────────
alter table vehicles add column if not exists acquisition_type text not null default 'purchase';
alter table vehicles add column if not exists consignor_name text;
alter table vehicles add column if not exists consignor_phone text;
alter table vehicles add column if not exists consignor_national_id text;
alter table vehicles add column if not exists consignment_commission_type text;
alter table vehicles add column if not exists consignment_commission_value numeric;

-- No `add constraint if not exists` in Postgres, and conname is not
-- database-unique, so an EXISTS probe without a schema qualifier would
-- silently skip every tenant after the first (0018's lesson). Drop and
-- add converges on a re-run instead.
--
-- vehicles_purchase_price_check is 0009's INLINE check, auto-named by
-- Postgres. Dropping it by that name and adding the widened rule under
-- the same name is what makes the live schemas and the template agree.
alter table vehicles drop constraint if exists vehicles_purchase_price_check;
alter table vehicles add constraint vehicles_purchase_price_check check (
  (acquisition_type = 'consignment' and purchase_price = 0)
  or purchase_price > 0
);

alter table vehicles drop constraint if exists vehicles_acquisition_type_check;
alter table vehicles add constraint vehicles_acquisition_type_check check (
  acquisition_type in ('purchase','trade_in','consignment')
);

alter table vehicles drop constraint if exists vehicles_consignor_national_id_check;
alter table vehicles add constraint vehicles_consignor_national_id_check check (
  consignor_national_id is null
  or consignor_national_id ~ '^[0-9]{14}$'
);

alter table vehicles drop constraint if exists vehicles_consignment_commission_check;
alter table vehicles add constraint vehicles_consignment_commission_check check (
  (consignment_commission_type is null
   or consignment_commission_type in ('fixed','percent'))
  and (consignment_commission_value is null
   or consignment_commission_value >= 0)
);

-- ── deal_tickets: the trade-in leg ───────────────────────────
alter table deal_tickets add column if not exists trade_in_make text;
alter table deal_tickets add column if not exists trade_in_model text;
alter table deal_tickets add column if not exists trade_in_year int;
alter table deal_tickets add column if not exists trade_in_color text;
alter table deal_tickets add column if not exists trade_in_vin text;
alter table deal_tickets add column if not exists trade_in_odometer_km numeric;
alter table deal_tickets add column if not exists trade_in_allowance numeric;
alter table deal_tickets add column if not exists trade_in_notes text;
alter table deal_tickets add column if not exists trade_in_photos text[] not null default '{}';

alter table deal_tickets drop constraint if exists deal_tickets_trade_in_allowance_check;
alter table deal_tickets add constraint deal_tickets_trade_in_allowance_check check (
  trade_in_allowance is null or trade_in_allowance > 0
);

-- ── consignment_payouts ──────────────────────────────────────
create table if not exists consignment_payouts (
  id                 uuid        primary key default gen_random_uuid(),
  vehicle_id         uuid        not null references vehicles(id),
  deal_ticket_id     uuid        not null references deal_tickets(id),
  consignor_name     text        not null,
  amount_due         numeric     not null check (amount_due >= 0),
  commission_amount  numeric     not null check (commission_amount >= 0),
  paid_at            timestamptz,
  settlement_method  text,
  settlement_reference text,
  note               text,
  created_at         timestamptz default now(),
  constraint consignment_payouts_settlement_method_check check (
    settlement_method is null
    or settlement_method in ('bank_transfer','cheque','instapay','cash')
  )
);

create index if not exists idx_consignment_payouts_vehicle on consignment_payouts(vehicle_id);
create index if not exists idx_consignment_payouts_ticket  on consignment_payouts(deal_ticket_id);
create index if not exists idx_consignment_payouts_due
  on consignment_payouts(created_at) where paid_at is null;

alter table consignment_payouts enable row level security;

drop policy if exists "consignment_payouts_select" on consignment_payouts;
create policy "consignment_payouts_select" on consignment_payouts for select
  using (is_accountant_or_above());

drop policy if exists "consignment_payouts_update" on consignment_payouts;
create policy "consignment_payouts_update" on consignment_payouts for update
  using (is_accountant_or_above()) with check (is_accountant_or_above());

drop trigger if exists trg_audit_consignment_payouts on consignment_payouts;
create trigger trg_audit_consignment_payouts
  after insert or update or delete on consignment_payouts
  for each row execute function record_audit();

-- ── the cap-table guard ──────────────────────────────────────
create or replace function prevent_split_on_consignment() returns trigger as $trg$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id)
      and acquisition_type = 'consignment'
  ) then
    raise exception 'A consigned vehicle has no equity splits — the showroom does not own it';
  end if;
  return coalesce(new, old);
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

drop trigger if exists trg_no_splits_on_consignment on vehicle_equity_splits;
create trigger trg_no_splits_on_consignment
  before insert or update or delete on vehicle_equity_splits
  for each row execute function prevent_split_on_consignment();
$ddl$;
begin
  select body into c_exec_new   from felix_0032_fn where name = 'execute_vehicle_sale';
  select body into c_intake_new from felix_0032_fn where name = 'create_vehicle_with_equity_splits';

  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- vehicles is both the table this migration exists to widen and the
    -- FK target of the new one; its absence tells a half-provisioned
    -- tenant from a complete one.
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      raise notice '0032: %.vehicles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    -- pg_temp is searched implicitly, so felix_0032_fn stays reachable —
    -- though both bodies were read into locals above regardless.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute replace(c_ddl, '{{SCHEMA}}', quote_ident(r.schema_name));

    -- The 17-argument intake must be DROPPED before the 23-argument one
    -- is created: `create or replace` keys on the argument list, and
    -- PostgREST refuses to choose between two overloads it can both
    -- satisfy (PGRST203). 0026's header has the full account.
    execute format(
      'drop function if exists %I.create_vehicle_with_equity_splits('
      'uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, numeric, text[], jsonb)',
      r.schema_name
    );

    -- format() is avoided for the two bodies: they are full of `%s` and
    -- `%%` that would have to be re-escaped, and a mis-escaped RAISE is a
    -- bug nobody sees until the day it fires. The template's own
    -- placeholder does the job instead.
    execute replace(c_intake_new, '{{SCHEMA}}', quote_ident(r.schema_name));
    execute replace(c_exec_new,   '{{SCHEMA}}', quote_ident(r.schema_name));

    -- §6b's blanket revoke and §6d/§6h's grants ran at provisioning and
    -- cannot reach objects added afterwards. These are what make the new
    -- table and the new signature reachable, and by exactly whom. No
    -- DELETE for the tenant role — assertion (j) forbids it besides.
    execute format(
      'grant select, update on %I.consignment_payouts to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.consignment_payouts to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.consignment_payouts from public, anon, authenticated',
      r.schema_name
    );

    execute format(
      'grant execute on function %I.create_vehicle_with_equity_splits('
      'uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb) to %I',
      r.schema_name, r.role_name
    );

    -- Postgres grants EXECUTE on a NEW function to PUBLIC by default, and
    -- prevent_split_on_consignment() is the first function any migration
    -- after 0009 has added to a tenant schema. §6a's blanket revoke ran
    -- long ago, so this is the matching one. A trigger function needs no
    -- EXECUTE grant to fire (§4.11).
    execute format(
      'revoke all on function %I.prevent_split_on_consignment() from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0032: % amended.', r.schema_name;
  end loop;

  -- §5 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0032: % tenant schema(s) carry the acquisition modes.', v_count;
end
$mig$;

-- ============================================================
-- 4. BACKFILL
--
-- There is none, and that is worth stating rather than leaving as an
-- absence. `acquisition_type` was added `not null default 'purchase'`,
-- so every row that already existed is already correct: a showroom that
-- has been trading for two years bought every car it holds, because
-- until this migration there was no other way to hold one. The
-- consignor columns are NULL for the same reason.
--
-- The one thing worth asserting is that nothing slipped through the
-- widened CHECK — §5 does it.
-- ============================================================

-- ============================================================
-- 5. SELF-VERIFY — structure, lockdown, the two rewritten functions,
-- and that every policy bound to THIS schema's predicates.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_col  text;
  v_priv text;
  n      int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.vehicles', r.schema_name)) is null then
      continue;
    end if;

    foreach v_col in array array[
      'acquisition_type', 'consignor_name', 'consignor_phone',
      'consignor_national_id', 'consignment_commission_type',
      'consignment_commission_value'
    ] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'vehicles'
           and column_name = v_col
      ) then
        v_bad := v_bad || format('%s (vehicles.%s)', r.schema_name, v_col);
      end if;
    end loop;

    foreach v_col in array array[
      'trade_in_make', 'trade_in_model', 'trade_in_year', 'trade_in_color',
      'trade_in_vin', 'trade_in_odometer_km', 'trade_in_allowance',
      'trade_in_notes', 'trade_in_photos'
    ] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'deal_tickets'
           and column_name = v_col
      ) then
        v_bad := v_bad || format('%s (deal_tickets.%s)', r.schema_name, v_col);
      end if;
    end loop;

    -- The widened rule, by name. A schema that lost the constraint
    -- entirely would accept a zero cost basis on a PURCHASE, which is the
    -- hole 0009 wrote it to close.
    if not exists (
      select 1 from pg_constraint c
        join pg_class t      on t.oid = c.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = r.schema_name and t.relname = 'vehicles'
         and c.conname = 'vehicles_purchase_price_check'
         and pg_get_constraintdef(c.oid) like '%consignment%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (vehicles_purchase_price_check not widened)');
    end if;

    if to_regclass(format('%I.consignment_payouts', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (consignment_payouts)');
      continue;
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'consignment_payouts'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    -- Two, not three: no INSERT policy, deliberately. An extra one here
    -- would mean somebody can invent a debt.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'consignment_payouts';
    if n <> 2 then
      v_bad := v_bad || format('%s (%s payout policies, expected 2)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's
    -- is_accountant_or_above().
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'consignment_payouts'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s payout policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    -- One privilege per call, deliberately: has_table_privilege() with a
    -- comma-separated list returns true if ANY of them is held.
    foreach v_priv in array array['select', 'update'] loop
      if not has_table_privilege(
           r.role_name, format('%I.consignment_payouts', r.schema_name), v_priv) then
        v_bad := v_bad || format('%s (role has no %s on payouts)', r.schema_name, v_priv);
      end if;
    end loop;

    -- INSERT and DELETE are both withheld on purpose — the definer writes
    -- the rows and nothing removes them. Assert both, or a later blanket
    -- grant hands them over without anyone deciding so. DELETE would also
    -- break assertion (j) at the next provisioning.
    foreach v_priv in array array['insert', 'delete'] loop
      if has_table_privilege(
           r.role_name, format('%I.consignment_payouts', r.schema_name), v_priv) then
        v_bad := v_bad || format('%s (role holds %s on payouts)', r.schema_name, v_priv);
      end if;
    end loop;

    if not has_table_privilege(
         'service_role', format('%I.consignment_payouts', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write payouts)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.consignment_payouts', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.consignment_payouts', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege on payouts)');
    end if;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'consignment_payouts'
         and t.tgname = 'trg_audit_consignment_payouts' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (missing trg_audit_consignment_payouts)');
    end if;

    -- The cap-table guard. It fails OPEN — without it an investor row
    -- against a consigned car is simply accepted, with no error at
    -- runtime — which is exactly why assertion (i) in
    -- create_tenant_schema() asserts guards by name.
    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicle_equity_splits'
         and t.tgname = 'trg_no_splits_on_consignment' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (missing trg_no_splits_on_consignment)');
    end if;

    -- The RPC, at the new arity and NOT at the old one.
    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, text, text, text, text, text, numeric, numeric, text[], jsonb)',
      r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (23-arg intake rpc)');
    end if;

    if to_regprocedure(format(
      '%I.create_vehicle_with_equity_splits(uuid, text, int, text, text, text, text, text, text[], text, text, text, text[], text, numeric, text[], jsonb)',
      r.schema_name)) is not null then
      v_bad := v_bad || (r.schema_name || ' (0026 intake rpc survived — PGRST203)');
    end if;

    -- Both bodies actually landed, rather than merely compiling. The
    -- probe is a string nothing else in either function contains.
    if (select prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = r.schema_name and p.proname = 'execute_vehicle_sale')
       not like '%consignment_payouts%' then
      v_bad := v_bad || (r.schema_name || ' (execute_vehicle_sale not rewritten)');
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'prevent_split_on_consignment'
         and not p.prosecdef
    ) then
      v_bad := v_bad || (r.schema_name || ' (prevent_split_on_consignment missing or security definer)');
    end if;

    -- The backfill's postcondition, such as it is: nothing may have been
    -- left in a state the widened CHECK would refuse.
    execute format(
      'select count(*) from %I.vehicles where acquisition_type is null'
      ' or acquisition_type not in (''purchase'',''trade_in'',''consignment'')',
      r.schema_name
    ) into n;
    if n > 0 then
      v_bad := v_bad || format('%s (%s vehicle(s) with an unknown acquisition type)', r.schema_name, n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0032 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('acquisition_type text        not null default ''purchase''' in platform.tenant_ddl_template()) = 0
     or position('create table if not exists consignment_payouts' in platform.tenant_ddl_template()) = 0
     or position('"consignment_payouts_select" on consignment_payouts' in platform.tenant_ddl_template()) = 0
     or position('grant select, update on consignment_payouts' in platform.tenant_ddl_template()) = 0
     or position('trade_in_allowance        numeric' in platform.tenant_ddl_template()) = 0
     or position('prevent_split_on_consignment' in platform.tenant_ddl_template()) = 0
     or position('p_consignment_commission_value numeric,' in platform.tenant_ddl_template()) = 0
     or position('v.acquisition_type = ''consignment''' in platform.tenant_ddl_template()) = 0 then
    raise exception '0032 VERIFY FAILED: the template does not carry the acquisition modes.';
  end if;

  raise notice '0032: verified — trade-ins enter stock and consignors get paid, everywhere.';
end
$$;

-- PostgREST caches the schema; without this the new table, the new
-- columns and the widened RPC signature are all rejected as unknown
-- until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
