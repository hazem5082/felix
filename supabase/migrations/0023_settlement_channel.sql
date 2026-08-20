-- ============================================================
-- 0023 — SETTLEMENT CHANNEL (CBE cashless mandate on car sales)
--
-- Egypt is pushing car sales out of cash: the CBE mandate and the 2025
-- Finance Bill require vehicle sales to settle through bank channels.
-- FELIX's deal_tickets.financing_type only says 'cash'|'installments' —
-- that distinction means PAID IN FULL vs FINANCED and stays untouched —
-- but nothing records the channel the money actually moved through, or
-- the reference an auditor would ask for.
--
-- deal_tickets gains three columns, all NULLABLE so existing tickets
-- and the demo fixtures keep working untouched:
--
--   settlement_method     the channel the sale settled through. CHECK:
--                         NULL or one of 'bank_transfer', 'cheque',
--                         'instapay', 'cash'. 'cash' stays REPRESENTABLE
--                         on purpose — legacy tickets and edge cases
--                         exist, and the compliance posture is the
--                         owner's call; the UI warns, the DB records.
--   settlement_reference  the transfer reference / cheque number the
--                         accountant ties the ticket to a bank statement
--                         line with. Free text, no CHECK — bank
--                         reference formats vary by institution.
--   settlement_bank       the showroom-side receiving bank. Free text
--                         for the same reason.
--
-- WHY NOT A CHECK FORBIDDING 'cash': the mandate governs how showrooms
-- take money, not what the database may remember. Refusing the row
-- would push cash deals off the books entirely — the opposite of an
-- audit trail.
--
-- NO RPC CHANGES: deal_tickets rows are INSERTed directly by the
-- createDealTicket server action (crm/actions.ts) under the table-level
-- `grant select, insert, update on deal_tickets` from 0009 §6d, so new
-- columns flow through automatically — 0022's header establishes this
-- and its report verified the grant. execute_vehicle_sale() reads the
-- ticket as %rowtype and touches only status/executed_at.
--
-- STRUCTURE MIRRORS 0018–0022 — same two targets (the DDL template for
-- future showrooms, every live t_<slug> for the ones already trading),
-- anchored-and-verified substitutions on the template, CHECK constraint
-- on existing tenants via drop-then-add so a re-run converges (and to
-- sidestep the conname-guard pitfall 0018 documents).
--
-- ANCHORS ARE WRITTEN AGAINST THE POST-0022 TEMPLATE: 0022 already
-- inserted vat_rate / vat_amount / price_includes_vat into the
-- deal_tickets DDL and the vat CHECK constraints at its tail, so the
-- column anchor here is 0022's `price_includes_vat` line and the
-- constraint anchor is 0022's deal_tickets_vat_amount_sane tail. The
-- precondition asserts 0022 has been applied (same way 0022 gates on
-- 0019's tax_card_no).
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
      '0023 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0023 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- Both anchors below are written against the POST-0022 template text
  -- (0022 planted the price_includes_vat column line and the
  -- deal_tickets_vat_amount_sane constraint these anchors sit against).
  if position('  price_includes_vat        boolean,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0023 PRECONDITION FAILED: the template has no deal_tickets.price_includes_vat. Apply 0022 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- Two anchored substitutions, each verified (replace() on a missing
-- anchor is a silent no-op). Anchor uniqueness, argued line by line:
--   2a the vat_rate/vat_amount/price_includes_vat + created_at block —
--      `  price_includes_vat        boolean,` appears exactly once in
--      the template (0022 §4 verifies exactly this string), and the
--      deal_tickets `vat_rate ... numeric,` spacing differs from
--      vehicle_expenses' `vat_amount          numeric,` so the whole
--      block matches only inside deal_tickets.
--   2b the deal_tickets_vat_amount_sane constraint tail — the
--      constraint name appears exactly once (vehicle_expenses' twin is
--      named vehicle_expenses_vat_amount_sane), and 0022 left it as the
--      last constraint before the closing `);` of the DDL.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. deal_tickets columns (post-0022 anchor)
  c_dt_col_from constant text := $p1$  vat_rate                  numeric,
  vat_amount                numeric,
  price_includes_vat        boolean,
  created_at                timestamptz default now(),$p1$;
  c_dt_col_to   constant text := $p2$  vat_rate                  numeric,
  vat_amount                numeric,
  price_includes_vat        boolean,
  -- Settlement channel (0023) — Egypt's CBE mandate and the 2025
  -- Finance Bill push car sales through bank channels. Distinct from
  -- financing_type (paid-in-full vs financed): this is the channel the
  -- money moved through, plus the reference and receiving bank the
  -- accountant reconciles against. All nullable — tickets predating
  -- 0023 carry nulls, and a ticket can be raised before settlement.
  settlement_method         text,
  settlement_reference      text,
  settlement_bank           text,
  created_at                timestamptz default now(),$p2$;

  -- 2b. deal_tickets constraints, at the tail of the DDL (post-0022)
  c_dt_chk_from constant text := $p3$  constraint deal_tickets_vat_amount_sane check (
    vat_amount is null or vat_amount >= 0
  )
);$p3$;
  c_dt_chk_to   constant text := $p4$  constraint deal_tickets_vat_amount_sane check (
    vat_amount is null or vat_amount >= 0
  ),
  -- Settlement channel sanity (0023): NULL, or a known channel. 'cash'
  -- is representable on purpose — record it, don't forbid it.
  constraint deal_tickets_settlement_method_check check (
    settlement_method is null
    or settlement_method in ('bank_transfer','cheque','instapay','cash')
  )
);$p4$;
begin
  if position('  settlement_method         text,' in v_tpl) > 0 then
    raise notice '0023: template already carries the settlement fields — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_dt_col_from, c_dt_col_to);
    if position(c_dt_col_to in v_tpl) = 0 then
      raise exception '0023: template anchor 2a (deal_tickets columns) did not match. Template drifted from 0022.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_dt_chk_from, c_dt_chk_to);
    if position(c_dt_chk_to in v_tpl) = 0 then
      raise exception '0023: template anchor 2b (deal_tickets constraints) did not match. Template drifted from 0022.';
    end if;
    v_done := v_done + 1;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0018–0022.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0023$ select %L::text $felix_0023$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0023: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists`; the constraint via
-- drop-then-add so a re-run converges instead of erroring (and to avoid
-- the conname-uniqueness pitfall 0018's header documents). The add is
-- plain (validated), not NOT VALID: the columns are brand new, so every
-- existing row holds NULL and trivially passes. No grants to touch:
-- the deal_tickets grant from 0009 §6 is table-level and covers new
-- columns automatically.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.deal_tickets', r.schema_name)) is null then
      raise notice '0023: %.deal_tickets missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.deal_tickets add column if not exists settlement_method text', r.schema_name);
    execute format('alter table %I.deal_tickets add column if not exists settlement_reference text', r.schema_name);
    execute format('alter table %I.deal_tickets add column if not exists settlement_bank text', r.schema_name);

    execute format(
      'alter table %I.deal_tickets drop constraint if exists deal_tickets_settlement_method_check',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.deal_tickets add constraint deal_tickets_settlement_method_check check (
        settlement_method is null
        or settlement_method in ('bank_transfer','cheque','instapay','cash')
      )
    $ddl$, r.schema_name);

    v_count := v_count + 1;
    raise notice '0023: % amended.', r.schema_name;
  end loop;

  raise notice '0023: % tenant schema(s) carry the settlement fields.', v_count;
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

    foreach col in array array['settlement_method', 'settlement_reference', 'settlement_bank'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'deal_tickets' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (deal_tickets.' || col || ')');
      end if;
    end loop;

    -- Schema-qualified probe on purpose: conname alone is not
    -- database-unique across t_<slug> schemas (0018 §3).
    if not exists (
      select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = r.schema_name and t.relname = 'deal_tickets'
         and c.conname = 'deal_tickets_settlement_method_check'
    ) then
      v_bad := v_bad || (r.schema_name || ' (deal_tickets_settlement_method_check)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0023 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  settlement_method         text,' in platform.tenant_ddl_template()) = 0
     or position('  settlement_reference      text,' in platform.tenant_ddl_template()) = 0
     or position('  settlement_bank           text,' in platform.tenant_ddl_template()) = 0
     or position('deal_tickets_settlement_method_check' in platform.tenant_ddl_template()) = 0 then
    raise exception '0023 VERIFY FAILED: template does not carry the settlement fields.';
  end if;

  raise notice '0023: verified — settlement fields live on every tenant schema and in the template.';
end
$$;

-- PostgREST caches the schema; without this the new columns are
-- invisible to selects until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
