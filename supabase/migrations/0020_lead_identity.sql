-- ============================================================
-- 0020 — LEAD IDENTITY DOCUMENTS (buyer national ID & nationality)
--
-- The `leads` row is the customer record, and it carried no identity
-- document at all. In Egypt that blocks three things every car sale
-- runs into:
--
--   * the ETA e-invoice: a buyer's national ID is mandatory on any
--     invoice of EGP 25,000 or more — which is every car;
--   * the traffic-authority ownership-transfer contract, which names
--     both parties by national ID;
--   * AML customer due diligence, which requires identifying the
--     customer before the money moves.
--
-- Two columns on `leads`, both NULLABLE so existing rows, the demo
-- fixtures and the public referral flow keep working untouched:
--
--   national_id   Egyptian national ID. CHECK: NULL or exactly
--                 14 digits (same shape as 0018's
--                 profiles_national_id_check).
--   nationality   free text. Conceptually defaults to Egyptian, but
--                 the column stays NULL until a member of staff
--                 actually records it — a default would fabricate a
--                 compliance fact nobody attested to.
--
-- NO RPC CHANGES, AND THAT IS DELIBERATE. Leads are minted two ways:
--
--   1. Staff, via the CRM's "Add Lead" dialog — a plain RLS-scoped
--      INSERT under `leads_insert` and the table-level
--      `grant select, insert, update on leads` from 0009 §6d. Both are
--      table-level, so the new columns are covered automatically.
--   2. The public referral link (src/app/[locale]/refer/…/actions.ts) —
--      a direct service-role INSERT of the PublicLeadSchema fields.
--      There is no lead-minting function in the database at all, so
--      there is nothing to widen. The public form must NOT collect a
--      national ID — an unauthenticated page asking strangers for
--      their government ID is a phishing template, not due diligence —
--      so the submission simply leaves the new columns NULL and staff
--      record the ID later, when the person is actually buying.
--
-- STRUCTURE MIRRORS 0018/0019 — same two targets (the DDL template for
-- future showrooms, every live t_<slug> for the ones already trading),
-- anchored-and-verified substitution on the template, and drop-then-add
-- for the CHECK on existing tenants (see 0018 §3 for why: conname is
-- not database-unique, and drop-then-add converges on re-run).
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
      '0020 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0020 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The anchor below sits on 0017's client_note_points line; applying
  -- 0020 before 0017 would fail the substitution check anyway, but say
  -- it up front with the right instruction.
  if position('client_note_points' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0020 PRECONDITION FAILED: the template has no leads.client_note_points. Apply 0017 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- One anchor: the tail of the leads CREATE TABLE as 0017 left it.
-- `client_note_points` appears exactly once in the template (0017
-- asserts as much), so the anchor cannot double-fire. The replacement
-- adds the two columns and turns the DDL tail into a constraint tail,
-- which is why the anchor must include the closing `);`.
-- ============================================================
do $mig$
declare
  v_tpl text := platform.tenant_ddl_template();

  c_col_from constant text := $a1$  client_note_points        text[]      not null default '{}',
  created_at                timestamptz default now()
);$a1$;
  c_col_to   constant text := $a2$  client_note_points        text[]      not null default '{}',
  -- Buyer identity for the sale paperwork (0020): the e-invoice at or
  -- above EGP 25,000, the traffic-authority ownership transfer, and AML
  -- due diligence. Nullable on purpose — link-sourced leads arrive
  -- without it and staff record it when the person is actually buying.
  -- nationality stays NULL until entered; no fabricated default.
  national_id               text,
  nationality               text,
  created_at                timestamptz default now(),
  constraint leads_national_id_check check (
    national_id is null
    or national_id ~ '^[0-9]{14}$'
  )
);$a2$;
begin
  if position('leads_national_id_check' in v_tpl) > 0 then
    raise notice '0020: template already carries the lead identity columns — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0020: template anchor (leads DDL tail) did not match. Template drifted from 0017.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0018/0019.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0020$ select %L::text $felix_0020$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0020: template amended.';
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists`; the constraint via
-- drop-then-add so a re-run converges instead of erroring (0018's
-- rationale — an EXISTS probe on conname without a schema qualifier
-- silently skips every tenant after the first). No grants to touch:
-- `grant select, insert, update on leads` (0009 §6d) is table-level
-- and covers new columns automatically, which is also what keeps the
-- service-role public-link insert working unchanged.
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      raise notice '0020: %.leads missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.leads add column if not exists national_id text', r.schema_name);
    execute format('alter table %I.leads add column if not exists nationality text', r.schema_name);

    execute format(
      'alter table %I.leads drop constraint if exists leads_national_id_check',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.leads add constraint leads_national_id_check check (
        national_id is null
        or national_id ~ '^[0-9]{14}$'
      )
    $ddl$, r.schema_name);

    v_count := v_count + 1;
    raise notice '0020: % amended.', r.schema_name;
  end loop;

  raise notice '0020: % tenant schema(s) carry the lead identity columns.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
-- ============================================================
do $$
declare
  r record;
  col text;
  v_bad text[] := '{}';
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array['national_id', 'nationality'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'leads' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (' || col || ')');
      end if;
    end loop;

    if not exists (
      select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = r.schema_name and t.relname = 'leads'
         and c.conname = 'leads_national_id_check'
    ) then
      v_bad := v_bad || (r.schema_name || ' (leads_national_id_check)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0020 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  national_id               text,' in platform.tenant_ddl_template()) = 0
     or position('leads_national_id_check' in platform.tenant_ddl_template()) = 0 then
    raise exception '0020 VERIFY FAILED: template does not carry the lead identity columns.';
  end if;

  raise notice '0020: verified — lead identity columns live everywhere.';
end
$$;

-- PostgREST caches the schema; without this the new columns are rejected
-- as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
