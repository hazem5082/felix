-- ============================================================
-- 0022 — VAT FIELDS (Egyptian VAT Form 10 + e-invoicing)
--
-- FELIX carried no tax fields at all, which blocks both the monthly
-- VAT return (Form 10: output tax on sales, input tax on purchases)
-- and e-invoice issuance (taxable amount, rate and tax total per
-- line). Standard Egyptian VAT is 14%, but vehicles can fall under
-- schedule-tax treatment at other rates, so the rate is STORED PER
-- TRANSACTION rather than hard-coded anywhere.
--
-- Three tables gain columns, all NULLABLE so existing rows and the
-- demo fixtures keep working untouched:
--
--   deal_tickets (output tax — the sale side of Form 10)
--     vat_rate            the percentage applied to THIS deal, e.g. 14.
--                         CHECK: NULL or 0..100.
--     vat_amount          the tax total in EGP for the e-invoice line.
--     price_includes_vat  whether agreed_price is VAT-inclusive (the
--                         normal showroom quote) or VAT is added on top.
--                         Needed to recover the taxable base from the
--                         price actually agreed with the buyer.
--
--   vehicle_expenses (input tax — the purchase side of Form 10)
--     vat_amount           input VAT paid on the expense. CHECK: NULL
--                          or >= 0.
--     supplier_tax_id      the supplier's tax registration number.
--     supplier_invoice_no  the supplier's invoice number. Since July
--                          2023 input-tax deduction requires the
--                          expense to be backed by an e-invoice, and
--                          these two fields are how the accountant
--                          ties the ledger row to that document.
--
--   branches (the seller's identity on every e-invoice)
--     tax_registration_no  the branch's VAT registration number.
--
-- WHY branches AND NOT A TENANT-SETTINGS TABLE: there is no tenant
-- settings/config table anywhere in the schema — 0008 keeps only
-- platform.* control-plane tables, 0009's only config-ish table is
-- overhead_config, which is per-branch. Rather than invent a settings
-- infrastructure for one column, the VAT registration goes on
-- `branches`, next to 0019's tax_card_no / commercial_registration_no —
-- the licensing identity of the same legal premises. (A VAT
-- registration is issued to the taxpayer, but branches of one showroom
-- share it in practice; recording it per branch also survives the case
-- where branches are separately registered.) Distinct from tax_card_no:
-- the tax card is the income-tax identity, the VAT registration is the
-- sales-tax one, and Egyptian paperwork asks for both.
--
-- NO RPC CHANGES: deal_tickets rows are INSERTed directly by the
-- createDealTicket server action (crm/actions.ts) under the table-level
-- `grant select, insert, update on deal_tickets` from 0009 §6d, so new
-- columns flow through automatically. execute_vehicle_sale() reads the
-- ticket as %rowtype and touches only status/executed_at — it neither
-- lists columns nor needs the VAT ones. vehicle_expenses rows are
-- likewise plain INSERTs (inventory/actions.ts) under a table-level
-- grant; compute_sale_waterfall() aggregates sum(amount) only. Nothing
-- writes branches through a function (0019's header establishes this).
--
-- STRUCTURE MIRRORS 0018/0019 — same two targets (the DDL template for
-- future showrooms, every live t_<slug> for the ones already trading),
-- same anchored-and-verified substitutions on the template, CHECK
-- constraints on existing tenants via drop-then-add so a re-run
-- converges (and to sidestep the conname-guard pitfall 0018 documents).
--
-- BRANCHES ANCHOR IS WRITTEN AGAINST THE POST-0019 TEMPLATE: 0019
-- already inserted the licensing columns into the branches DDL, so the
-- anchor here is 0019's `tax_card_no` / `trade_license_no` pair, and
-- the precondition asserts 0019 has been applied.
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
      '0022 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0022 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The branches anchor below is written against the POST-0019 template
  -- text (0019 inserted the licensing columns this anchor sits between).
  if position('  tax_card_no                   text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0022 PRECONDITION FAILED: the template has no branches.tax_card_no. Apply 0019 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- Four anchored substitutions, each verified (replace() on a missing
-- anchor is a silent no-op). Anchor uniqueness, argued line by line:
--   2a `executed_at` + `created_at` pair — `  executed_at
--      timestamptz,` (this exact spacing) appears only in the
--      deal_tickets DDL.
--   2b the deal_tickets_down_payment_sane constraint tail — the
--      constraint name appears exactly once.
--   2c `  is_ceo_override   boolean     not null default false,`
--      appears only in vehicle_expenses. (Its `created_at` line alone
--      would NOT be unique — the pair is the anchor.)
--   2d the tax_card_no/trade_license_no pair 0019 planted — 0019 runs
--      once, so the pair appears once.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. deal_tickets columns
  c_dt_col_from constant text := $p1$  executed_at               timestamptz,
  created_at                timestamptz default now(),$p1$;
  c_dt_col_to   constant text := $p2$  executed_at               timestamptz,
  -- VAT on the sale (0022) — Form 10 output tax and the e-invoice
  -- line. Nullable: tickets predating 0022 carry nulls, and the rate
  -- is per-transaction because schedule-tax vehicles differ from the
  -- 14% standard.
  vat_rate                  numeric,
  vat_amount                numeric,
  price_includes_vat        boolean,
  created_at                timestamptz default now(),$p2$;

  -- 2b. deal_tickets constraints, at the tail of the DDL
  c_dt_chk_from constant text := $p3$  constraint deal_tickets_down_payment_sane check (
    down_payment is null or (down_payment >= 0 and down_payment <= agreed_price)
  )
);$p3$;
  c_dt_chk_to   constant text := $p4$  constraint deal_tickets_down_payment_sane check (
    down_payment is null or (down_payment >= 0 and down_payment <= agreed_price)
  ),
  -- VAT sanity (0022): a rate is a percentage, an amount is money.
  constraint deal_tickets_vat_rate_sane check (
    vat_rate is null or (vat_rate >= 0 and vat_rate <= 100)
  ),
  constraint deal_tickets_vat_amount_sane check (
    vat_amount is null or vat_amount >= 0
  )
);$p4$;

  -- 2c. vehicle_expenses columns + constraint
  c_ve_from constant text := $p5$  is_ceo_override   boolean     not null default false,
  created_at        timestamptz default now()
);$p5$;
  c_ve_to   constant text := $p6$  is_ceo_override   boolean     not null default false,
  -- Input VAT for the Form 10 deduction (0022). Since July 2023 the
  -- deduction requires an e-invoice behind the expense; the supplier's
  -- tax ID and invoice number are how the accountant ties this row to
  -- that document. All nullable — plenty of forecourt expenses carry
  -- no VAT invoice at all.
  vat_amount          numeric,
  supplier_tax_id     text,
  supplier_invoice_no text,
  created_at        timestamptz default now(),
  constraint vehicle_expenses_vat_amount_sane check (
    vat_amount is null or vat_amount >= 0
  )
);$p6$;

  -- 2d. branches: the seller's VAT registration (post-0019 anchor)
  c_br_from constant text := $p7$  tax_card_no                   text,
  trade_license_no              text,$p7$;
  c_br_to   constant text := $p8$  tax_card_no                   text,
  -- The showroom's VAT registration number (0022) — the seller
  -- identity on every e-invoice and the Form 10 return. Distinct from
  -- tax_card_no: the tax card is the income-tax identity, this is the
  -- sales-tax one.
  tax_registration_no           text,
  trade_license_no              text,$p8$;
begin
  if position('  price_includes_vat        boolean,' in v_tpl) > 0 then
    raise notice '0022: template already carries the VAT fields — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_dt_col_from, c_dt_col_to);
    if position(c_dt_col_to in v_tpl) = 0 then
      raise exception '0022: template anchor 2a (deal_tickets columns) did not match. Template drifted.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_dt_chk_from, c_dt_chk_to);
    if position(c_dt_chk_to in v_tpl) = 0 then
      raise exception '0022: template anchor 2b (deal_tickets constraints) did not match. Template drifted.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ve_from, c_ve_to);
    if position(c_ve_to in v_tpl) = 0 then
      raise exception '0022: template anchor 2c (vehicle_expenses tail) did not match. Template drifted.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_br_from, c_br_to);
    if position(c_br_to in v_tpl) = 0 then
      raise exception '0022: template anchor 2d (branches licensing block) did not match. Template drifted from 0019.';
    end if;
    v_done := v_done + 1;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0018/0019.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0022$ select %L::text $felix_0022$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0022: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists`; constraints via drop-then-add
-- so a re-run converges instead of erroring (and to avoid the
-- conname-uniqueness pitfall 0018's header documents). No grants to
-- touch: the deal_tickets, vehicle_expenses and branches grants from
-- 0009 §6 are table-level and cover new columns automatically.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      raise notice '0022: %.deal_tickets missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- deal_tickets: output tax
    execute format('alter table %I.deal_tickets add column if not exists vat_rate numeric', r.schema_name);
    execute format('alter table %I.deal_tickets add column if not exists vat_amount numeric', r.schema_name);
    execute format('alter table %I.deal_tickets add column if not exists price_includes_vat boolean', r.schema_name);

    execute format(
      'alter table %I.deal_tickets drop constraint if exists deal_tickets_vat_rate_sane',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.deal_tickets add constraint deal_tickets_vat_rate_sane check (
        vat_rate is null or (vat_rate >= 0 and vat_rate <= 100)
      )
    $ddl$, r.schema_name);

    execute format(
      'alter table %I.deal_tickets drop constraint if exists deal_tickets_vat_amount_sane',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.deal_tickets add constraint deal_tickets_vat_amount_sane check (
        vat_amount is null or vat_amount >= 0
      )
    $ddl$, r.schema_name);

    -- vehicle_expenses: input tax
    execute format('alter table %I.vehicle_expenses add column if not exists vat_amount numeric', r.schema_name);
    execute format('alter table %I.vehicle_expenses add column if not exists supplier_tax_id text', r.schema_name);
    execute format('alter table %I.vehicle_expenses add column if not exists supplier_invoice_no text', r.schema_name);

    execute format(
      'alter table %I.vehicle_expenses drop constraint if exists vehicle_expenses_vat_amount_sane',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.vehicle_expenses add constraint vehicle_expenses_vat_amount_sane check (
        vat_amount is null or vat_amount >= 0
      )
    $ddl$, r.schema_name);

    -- branches: seller identity
    execute format('alter table %I.branches add column if not exists tax_registration_no text', r.schema_name);

    v_count := v_count + 1;
    raise notice '0022: % amended.', r.schema_name;
  end loop;

  raise notice '0022: % tenant schema(s) carry the VAT fields.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Provisioning failures in this architecture are silent and late, so
-- the migration proves its own result rather than trusting section 3.
-- ============================================================
do $$
declare
  r record;
  col text;
  v_bad text[] := '{}';
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array['vat_rate', 'vat_amount', 'price_includes_vat'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'deal_tickets' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (deal_tickets.' || col || ')');
      end if;
    end loop;

    foreach col in array array['vat_amount', 'supplier_tax_id', 'supplier_invoice_no'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'vehicle_expenses' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (vehicle_expenses.' || col || ')');
      end if;
    end loop;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'branches' and column_name = 'tax_registration_no'
    ) then
      v_bad := v_bad || (r.schema_name || ' (branches.tax_registration_no)');
    end if;

    foreach col in array array[
      'deal_tickets_vat_rate_sane', 'deal_tickets_vat_amount_sane'
    ] loop
      if not exists (
        select 1
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = r.schema_name and t.relname = 'deal_tickets' and c.conname = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;

    if not exists (
      select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = r.schema_name and t.relname = 'vehicle_expenses'
         and c.conname = 'vehicle_expenses_vat_amount_sane'
    ) then
      v_bad := v_bad || (r.schema_name || ' (vehicle_expenses_vat_amount_sane)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0022 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  price_includes_vat        boolean,' in platform.tenant_ddl_template()) = 0
     or position('  supplier_invoice_no text,' in platform.tenant_ddl_template()) = 0
     or position('  tax_registration_no           text,' in platform.tenant_ddl_template()) = 0
     or position('deal_tickets_vat_rate_sane' in platform.tenant_ddl_template()) = 0 then
    raise exception '0022 VERIFY FAILED: template does not carry the VAT fields.';
  end if;

  raise notice '0022: verified — VAT fields live on every tenant schema and in the template.';
end
$$;

-- PostgREST caches the schema; without this the new columns are
-- invisible to selects until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
