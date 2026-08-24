-- ============================================================
-- 0054 — THE FELIX NETWORK
--
-- A showroom that does not have the car in front of it loses the sale.
-- Somewhere else on this deployment another licensed showroom has that
-- car sitting on its floor, and neither of them can see the other. This
-- migration is the one bit of state that has to exist in the database
-- for them to: WHETHER A SHOWROOM PUBLISHES ITS STOCK TO THE NETWORK.
--
-- WHY THIS IS THE ONLY SCHEMA CHANGE
-- ----------------------------------
-- The search itself needs no new table, view or function. Since 0008
-- every showroom's stock is already a `vehicles` table in its own
-- t_<slug> schema, and the app's service-role client can read any of
-- them by name (the same mechanism the inbound-mail route uses to
-- deliver into a tenant). What did not exist was CONSENT — a place for
-- a showroom to say "yes, my in-stock cars may be seen by the other
-- showrooms on this deployment". That is a per-licence fact, so it
-- belongs on the licence row, which is this one column.
--
-- WHY IT LIVES IN `platform` AND NOT IN THE TENANT TEMPLATE
-- --------------------------------------------------------
-- Two reasons, and the second is the one that matters:
--
--   1. It is control-plane data about a showroom rather than data
--      belonging to one — the same category as `status` and
--      `licensed_via` directly above it.
--   2. A tenant-schema column would be readable and writable by that
--      tenant's own role, which sounds right and is not: the network
--      is a property of the DEPLOYMENT, and one showroom flipping its
--      own bit changes what OTHER showrooms may read. Keeping it here
--      means the only thing that can write it is service_role, driven
--      by an action that has already checked the caller is that
--      showroom's CEO — and no tenant role can even see the column,
--      let alone set it for somebody else.
--
-- WHY THE DEFAULT IS TRUE
-- -----------------------
-- The network is worth nothing to the first showroom that joins it and
-- everything to the tenth, so a default of false produces an empty
-- screen for every showroom until every showroom has independently
-- opted in — the coordination problem that kills the feature. The
-- exposure a `true` default creates is deliberately narrow, and is
-- enforced in the app's query rather than here (see
-- app/[locale]/(app)/network/actions.ts):
--
--   * only vehicles whose status is 'in_stock' — never sold or
--     reserved stock, and never a car's history;
--   * only what a windscreen already says — year, make, model, trim,
--     colour, odometer, asking price;
--   * NEVER purchase_price or min_price. What a car cost the showroom
--     and the floor it will drop to are confidential inside a showroom
--     (canSeeCost in lib/auth.ts) and would be commercially disastrous
--     outside one;
--   * never a VIN, plate or engine number, and never a customer.
--
-- And any CEO can leave with one switch, which the page carries.
--
-- Idempotent, additive, and reversible with a single DROP COLUMN. No
-- tenant schema is touched, so nothing here interacts with the
-- SECURITY DEFINER accounting in platform.create_tenant_schema().
-- ============================================================

begin;

set local search_path = pg_catalog;

-- ============================================================
-- 1. THE CONSENT COLUMN
-- ============================================================

alter table platform.tenants
  add column if not exists network_opt_in boolean not null default true;

comment on column platform.tenants.network_opt_in is
  'Whether this showroom''s IN-STOCK cars are searchable by other licensed showrooms on the FELIX Network. Set by the showroom''s own CEO through the /network page; never by another tenant. Cost, floor price, VIN, plate and customers are never published regardless of this flag.';

-- No index. platform.tenants is one row per licensed showroom — tens,
-- not thousands — and the network query reads the whole registry once
-- per search. An index here would be ceremony.

-- ============================================================
-- 2. VERIFY
--
-- Same shape as every other migration in this tree: the file asserts
-- its own outcome rather than trusting that the statements above did
-- what they say, so a partial apply fails the transaction instead of
-- leaving a half-built feature behind.
-- ============================================================
do $$
declare
  v_default text;
  v_notnull boolean;
begin
  select column_default, (is_nullable = 'NO')
    into v_default, v_notnull
    from information_schema.columns
   where table_schema = 'platform'
     and table_name   = 'tenants'
     and column_name  = 'network_opt_in';

  if v_default is null then
    raise exception '0054: platform.tenants.network_opt_in was not created';
  end if;

  if not v_notnull then
    raise exception '0054: network_opt_in must be NOT NULL — the app reads it as a boolean, not a tri-state';
  end if;

  if v_default !~* 'true' then
    raise exception '0054: network_opt_in default is %, expected true — see the header', v_default;
  end if;

  -- Deliberately NOT asserting that every row reads true. On the first
  -- apply they all do, by the default; on a re-run some CEO may have
  -- since left the network, and a re-run that fails because the feature
  -- is being used as designed is a worse migration than no check.
  raise notice '0054: FELIX Network consent column in place (% of % showrooms participating)',
    (select count(*) from platform.tenants where network_opt_in),
    (select count(*) from platform.tenants);
end $$;

commit;

