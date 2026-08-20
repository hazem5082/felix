-- ============================================================
-- 0024 — ETA E-INVOICE LINKAGE (Egyptian Tax Authority)
--
-- Egypt's e-invoicing platform issues its own identifiers per accepted
-- document — a document UUID and a human-readable "long ID" — and the
-- showroom must keep that linkage per sale. FELIX only carried its
-- internal contracts.serial. This migration adds the RECORDING slots;
-- actual ETA API integration is out of scope (the showroom submits on
-- the ETA portal by hand and transcribes the identifiers here).
--
-- Four columns on `contracts`, all NULLABLE so existing rows and the
-- demo fixtures keep working untouched:
--
--   eta_uuid               the ETA-assigned document UUID.
--                          UNIQUE where not null — the portal issues
--                          one document per invoice, so a duplicate
--                          here is a transcription error.
--   eta_long_id            the ETA long ID printed on the portal's
--                          document view. Free text — the format has
--                          changed across portal versions.
--   eta_submission_status  CHECK: NULL, 'pending', 'submitted',
--                          'accepted' or 'rejected'.
--   eta_submitted_at       when the showroom submitted on the portal.
--
-- WHY `contracts` AND NOT `deal_tickets`: the e-invoice documents the
-- executed sale, and the contract row is the one artifact that exists
-- exactly once per approved deal (deal_ticket_id is UNIQUE). It is also
-- where FELIX's own document identity (serial) already lives, so the
-- internal and external document numbers sit side by side.
--
-- HOW CONTRACTS ROWS ARE MINTED — AND THE ONE NEW WRITE PATH: rows are
-- inserted by the approval trigger handle_deal_ticket_approval() with
-- an explicit column list (deal_ticket_id, serial, unlocked_at). New
-- nullable columns flow through that insert untouched, so NO function
-- body changes and no 0015-style drop/recreate. But until now nothing
-- else ever wrote to contracts — there was deliberately no INSERT,
-- UPDATE or DELETE policy and only a SELECT grant, because the row's
-- mere existence is the vault unlock. Recording the ETA identifiers
-- needs a client write, so this migration opens the NARROWEST possible
-- path: a column-limited `grant update (eta_uuid, eta_long_id,
-- eta_submission_status, eta_submitted_at)` plus an UPDATE policy
-- gated on is_accountant_or_above(). INSERT stays withheld — a
-- salesperson still cannot mint their own unlock — and the vault
-- columns (serial, pdf_url, unlocked_at) stay outside the grant, so
-- the update path cannot forge or relock a contract.
--
-- STRUCTURE MIRRORS 0018–0022 — same two targets (the DDL template for
-- future showrooms, every live t_<slug> for the ones already trading),
-- same anchored-and-verified substitutions on the template, CHECK
-- constraint on existing tenants via drop-then-add so a re-run
-- converges (the conname-guard pitfall 0018 documents). The policy on
-- existing tenants is created with the predicate explicitly
-- schema-qualified, for the reason 0016's header gives at length: a
-- policy expression is resolved and frozen at CREATE time, and an
-- unqualified is_accountant_or_above() from the SQL editor's session
-- path would bind every showroom's policy to the wrong schema.
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
      '0024 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0024 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The anchors below are written against 0009's contracts DDL, policy
  -- and grant text, which no migration since has touched.
  if position('  unlocked_at      timestamptz' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0024 PRECONDITION FAILED: the template has no contracts.unlocked_at. Apply 0009 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — future showrooms
--
-- Three anchored substitutions, each verified (replace() on a missing
-- anchor is a silent no-op). Anchor uniqueness, argued line by line:
--   2a `  unlocked_at      timestamptz` (this exact spacing) appears
--      only in the contracts DDL; the generated_at line pins it.
--   2b `    select 1 from deal_tickets t where t.id = contracts.deal_ticket_id`
--      appears only inside the contracts_select policy.
--   2c `grant select on contracts to {{ROLE}};` appears exactly once —
--      contracts is the only table with a bare-SELECT grant of this
--      shape.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. contracts columns + constraint + partial unique index
  c_col_from constant text := $p1$  generated_at     timestamptz default now(),
  unlocked_at      timestamptz
);$p1$;
  c_col_to   constant text := $p2$  generated_at     timestamptz default now(),
  unlocked_at      timestamptz,
  -- ETA e-invoice linkage (0024). The portal issues a document UUID
  -- and a long ID per accepted invoice; the showroom submits by hand
  -- and records them here. All nullable: contracts predating 0024 and
  -- deals not yet submitted carry nulls.
  eta_uuid              text,
  eta_long_id           text,
  eta_submission_status text,
  eta_submitted_at      timestamptz,
  constraint contracts_eta_submission_status_check check (
    eta_submission_status is null
    or eta_submission_status in ('pending','submitted','accepted','rejected')
  )
);

-- One ETA document per contract (0024). Partial so the many
-- never-submitted rows do not participate.
create unique index if not exists uniq_contracts_eta_uuid
  on contracts(eta_uuid) where eta_uuid is not null;$p2$;

  -- 2b. the UPDATE policy, after contracts_select
  c_pol_from constant text := $p3$drop policy if exists "contracts_select" on contracts;
create policy "contracts_select" on contracts for select
  using (exists (
    select 1 from deal_tickets t where t.id = contracts.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));$p3$;
  c_pol_to   constant text := $p4$drop policy if exists "contracts_select" on contracts;
create policy "contracts_select" on contracts for select
  using (exists (
    select 1 from deal_tickets t where t.id = contracts.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

-- ETA recording (0024): the accountant (or CEO) transcribes the
-- portal's identifiers after manual submission. UPDATE only — rows are
-- still minted exclusively by handle_deal_ticket_approval(), and the
-- grant in §6d is column-limited so this path cannot touch serial,
-- pdf_url or unlocked_at.
drop policy if exists "contracts_eta_update" on contracts;
create policy "contracts_eta_update" on contracts for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());$p4$;

  -- 2c. the column-limited grant, after the SELECT grant
  c_gnt_from constant text := $p5$grant select on contracts to {{ROLE}};$p5$;
  c_gnt_to   constant text := $p6$grant select on contracts to {{ROLE}};

-- ETA linkage (0024): a column-limited UPDATE so the accountant can
-- record the portal's identifiers without gaining a write on the vault
-- columns. INSERT stays withheld — see the note above.
grant update (eta_uuid, eta_long_id, eta_submission_status, eta_submitted_at)
  on contracts to {{ROLE}};$p6$;
begin
  if position('  eta_uuid              text,' in v_tpl) > 0 then
    raise notice '0024: template already carries the ETA fields — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0024: template anchor 2a (contracts columns) did not match. Template drifted.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0024: template anchor 2b (contracts_select policy) did not match. Template drifted.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0024: template anchor 2c (contracts grant) did not match. Template drifted.';
    end if;
    v_done := v_done + 1;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0018–0022.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0024$ select %L::text $felix_0024$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0024: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Columns via `add column if not exists`; the constraint via
-- drop-then-add so a re-run converges. The index and the grant are
-- idempotent by their own syntax. The policy predicate is explicitly
-- schema-qualified so each showroom's policy binds to ITS OWN
-- is_accountant_or_above() regardless of this session's search_path
-- (0016's header explains why the unqualified spelling is a trap here).
-- ============================================================
do $mig$
declare
  r record;
  v_count int := 0;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.contracts', r.schema_name)) is null then
      raise notice '0024: %.contracts missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Columns
    execute format('alter table %I.contracts add column if not exists eta_uuid text', r.schema_name);
    execute format('alter table %I.contracts add column if not exists eta_long_id text', r.schema_name);
    execute format('alter table %I.contracts add column if not exists eta_submission_status text', r.schema_name);
    execute format('alter table %I.contracts add column if not exists eta_submitted_at timestamptz', r.schema_name);

    -- Status CHECK
    execute format(
      'alter table %I.contracts drop constraint if exists contracts_eta_submission_status_check',
      r.schema_name
    );
    execute format($ddl$
      alter table %I.contracts add constraint contracts_eta_submission_status_check check (
        eta_submission_status is null
        or eta_submission_status in ('pending','submitted','accepted','rejected')
      )
    $ddl$, r.schema_name);

    -- One ETA document per contract
    execute format(
      'create unique index if not exists uniq_contracts_eta_uuid on %I.contracts(eta_uuid) where eta_uuid is not null',
      r.schema_name
    );

    -- Column-limited UPDATE grant. 0009 §6d granted contracts SELECT
    -- only; a grant issued when the schema was created cannot reach a
    -- privilege added afterwards, so this is what makes the recording
    -- path exist for live showrooms at all.
    execute format(
      'grant update (eta_uuid, eta_long_id, eta_submission_status, eta_submitted_at) on %I.contracts to %I',
      r.schema_name, r.role_name
    );

    -- UPDATE policy, predicate pinned to this tenant's own function.
    execute format(
      'drop policy if exists "contracts_eta_update" on %I.contracts',
      r.schema_name
    );
    execute format(
      'create policy "contracts_eta_update" on %I.contracts for update '
      'using (%I.is_accountant_or_above()) with check (%I.is_accountant_or_above())',
      r.schema_name, r.schema_name, r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0024: % amended.', r.schema_name;
  end loop;

  raise notice '0024: % tenant schema(s) carry the ETA linkage.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Provisioning failures in this architecture are silent and late, so
-- the migration proves its own result rather than trusting section 3.
-- The policy check also asserts the BINDING, not just the existence:
-- with the search_path reset to pg_catalog, pg_policies renders every
-- function schema-qualified, so a policy bound to the wrong schema's
-- predicate is caught here rather than discovered as a cross-tenant
-- read months later.
-- ============================================================
do $$
declare
  r record;
  col text;
  v_qual text;
  v_bad text[] := '{}';
begin
  perform set_config('search_path', 'pg_catalog', true);

  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.contracts', r.schema_name)) is null then
      continue;
    end if;

    foreach col in array array['eta_uuid', 'eta_long_id', 'eta_submission_status', 'eta_submitted_at'] loop
      if not exists (
        select 1 from information_schema.columns
         where table_schema = r.schema_name and table_name = 'contracts' and column_name = col
      ) then
        v_bad := v_bad || (r.schema_name || ' (contracts.' || col || ')');
      end if;
    end loop;

    if not exists (
      select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = r.schema_name and t.relname = 'contracts'
         and c.conname = 'contracts_eta_submission_status_check'
    ) then
      v_bad := v_bad || (r.schema_name || ' (contracts_eta_submission_status_check)');
    end if;

    if not exists (
      select 1 from pg_indexes
       where schemaname = r.schema_name and tablename = 'contracts'
         and indexname = 'uniq_contracts_eta_uuid'
    ) then
      v_bad := v_bad || (r.schema_name || ' (uniq_contracts_eta_uuid)');
    end if;

    -- The policy exists AND is bound to this tenant's own predicate.
    select qual into v_qual
      from pg_policies
     where schemaname = r.schema_name and tablename = 'contracts'
       and policyname = 'contracts_eta_update';
    if v_qual is null then
      v_bad := v_bad || (r.schema_name || ' (contracts_eta_update missing)');
    elsif position(r.schema_name || '.is_accountant_or_above' in v_qual) = 0 then
      v_bad := v_bad || (r.schema_name || ' (contracts_eta_update mis-bound: ' || v_qual || ')');
    end if;

    -- The column-limited UPDATE grant reached the tenant role.
    if not exists (
      select 1 from information_schema.column_privileges
       where table_schema = r.schema_name and table_name = 'contracts'
         and column_name = 'eta_uuid' and grantee = r.role_name
         and privilege_type = 'UPDATE'
    ) then
      v_bad := v_bad || (r.schema_name || ' (role has no update on eta_uuid)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0024 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('  eta_uuid              text,' in platform.tenant_ddl_template()) = 0
     or position('uniq_contracts_eta_uuid' in platform.tenant_ddl_template()) = 0
     or position('contracts_eta_update' in platform.tenant_ddl_template()) = 0
     or position('grant update (eta_uuid, eta_long_id, eta_submission_status, eta_submitted_at)' in platform.tenant_ddl_template()) = 0 then
    raise exception '0024 VERIFY FAILED: template does not carry the ETA linkage.';
  end if;

  raise notice '0024: verified — ETA linkage live on every tenant schema and in the template.';
end
$$;

-- PostgREST caches the schema; without this the new columns are
-- invisible to selects until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
