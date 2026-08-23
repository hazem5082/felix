-- ============================================================
-- 0046 — THE COMPANY'S OWN IDENTITY: NAME, LOGO, TAX NUMBERS
--
-- Every printed FELIX document — the sale contract, the whole report
-- suite, the CPA windshield sticker — goes out under a letterhead that
-- says "FELIX" and "508.world" and then, as the only customer-specific
-- line, platform.tenants.name. That name is the LICENCE label chosen by
-- 508.world when the showroom was provisioned, not the legal entity the
-- customer actually trades as, and there is nowhere in the product for a
-- CEO to put their own company name, their logo, or the tax numbers an
-- Egyptian invoice or contract is expected to carry.
--
-- WHAT THIS ADDS — one singleton table per tenant schema:
--
--   company_settings
--     legal_name               the entity that signs the contract.
--     trade_name               the brand over the door, when it differs.
--     logo_url                 R2 public URL, uploaded through the new
--                              CEO-only `branding` folder (lib/r2.ts).
--     tax_id                   the company-level tax registration. See
--                              below on why this is NOT the same as
--                              branches.tax_registration_no.
--     commercial_registration  the commercial-register number.
--     address / phone / email  the contact block under the letterhead.
--
-- WHY NOT platform.tenants
-- ------------------------
-- That table is the CONTROL PLANE: the licence registry 508.world owns,
-- holding status and licensed_via. A CEO editing their own logo must
-- never acquire write access to the row that says whether their licence
-- is active — and giving the tenant role any write path into `platform`
-- would put a cross-tenant table one policy mistake away from every
-- showroom. Per-tenant data belongs in the per-tenant schema, where
-- 0008/0011's isolation already does the work for free.
--
-- WHY NOT branches
-- ----------------
-- branches already carries tax_card_no (0019), trade_license_no (0019)
-- and tax_registration_no (0022), and 0022's header reasoned explicitly
-- that the e-invoice seller identity is per-BRANCH. That is still right
-- and none of it is moved or duplicated: ETA files per branch and
-- eta/service.ts keeps reading the branch. What was missing is the level
-- ABOVE the branch — the legal entity all the branches belong to, which
-- is what a contract names and a letterhead prints. A group with three
-- showrooms has three branch registrations and ONE company.
--
-- A SINGLETON, ENFORCED BY THE DATABASE
-- --------------------------------------
-- `singleton boolean not null default true`, a UNIQUE on it, and a CHECK
-- that it is true. Two rows are then impossible, which matters because
-- every read site does .maybeSingle() and a second row would make the
-- letterhead nondeterministic. The template CANNOT seed the row — it is
-- pure DDL executed by create_tenant_schema() and contains no INSERT
-- anywhere — so the row is created on first save (upsert on the
-- singleton constraint) and every reader tolerates its absence by
-- falling back to platform.tenants.name, exactly as today.
--
-- NO auth.uid() IN ANY POLICY HERE — DELIBERATE
-- -----------------------------------------------
-- 0033's pattern for a writer column is `with check (updated_by =
-- auth.uid() and ...)`. That pattern is BANNED on this table, and this
-- is the reason: a policy is evaluated AS THE TENANT ROLE, which has no
-- USAGE on schema auth, so naming auth.uid() there raises 42501 and
-- breaks the write outright. Not hypothetical — it is exactly what 0045
-- had to repair in the price-history path, where it had silently broken
-- "Set prices" for every user since 0036. The policies below are
-- is_ceo() and nothing else; updated_by is set by the server action from
-- the already-authenticated session. The most that buys an attacker is a
-- CEO mis-attributing an edit to another CEO, which is not a boundary
-- worth risking a 42501 for. §5 asserts the ban held.
--
-- WHO READS IT
-- ------------
-- Everyone holding a profile in the schema — `current_role_name() is not
-- null`. The letterhead prints on the investor statement as much as on
-- the sale contract, so gating this behind is_staff() would blank the
-- header on exactly the document an outside investor receives. Nothing
-- here is confidential: it is what the company prints on its own paper.
--
-- WHO WRITES IT: is_ceo(), nothing weaker. A branch manager changing the
-- group's legal name or tax number on every contract it issues is not a
-- branch-level decision.
--
-- NO DELETE anywhere. Assertion (j) inside create_tenant_schema() refuses
-- a DELETE grant to the tenant role regardless; clearing a field is an
-- UPDATE to NULL.
--
-- NOT ADDED TO c_tables. Same reasoning 0016, 0030, 0031, 0033 and 0036
-- all record: a failed CREATE TABLE aborts the whole template execute,
-- assertion (b) walks pg_class for RLS and (j) for the grant ceiling, and
-- §5 verifies the table across every live schema directly.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor and replacement into the template's own
-- convention first (0036's header explains why).
--
-- GATE. On 0039 — the anchors are the mail block's, the newest stable
-- landmarks in the template.
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
    raise exception '0046 PRECONDITION FAILED: platform.tenant_ddl_template() missing. Apply 0009 first.';
  end if;
  if position('create index if not exists idx_mail_attachments_message on mail_attachments(message_id);'
              in platform.tenant_ddl_template()) = 0 then
    raise exception '0046 PRECONDITION FAILED: the template has no mail block. Apply 0039 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Four single-line anchors (append, append, prepend, append).
-- Single-line on purpose: 0044's header explains why a multi-line span
-- anchor only ever works once.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int := 0;

  c_tbl_from text := $a1$create index if not exists idx_mail_attachments_message on mail_attachments(message_id);$a1$;
  c_tbl_to   text := $a2$create index if not exists idx_mail_attachments_message on mail_attachments(message_id);

-- ------------------------------------------------------------
-- 1-ter. COMPANY PROFILE (0046)
--
-- The legal entity every branch in this schema belongs to: the name that
-- signs a contract, the logo on the letterhead, the tax numbers an
-- Egyptian document carries. Exactly one row, enforced by the unique
-- singleton column — see the file header for why the template cannot
-- seed it and every reader tolerates its absence.
--
-- Distinct from branches.tax_registration_no (0022), which is the
-- per-branch e-invoice seller identity and stays exactly where it is.
-- ------------------------------------------------------------
create table if not exists company_settings (
  id                      uuid        primary key default gen_random_uuid(),
  singleton               boolean     not null default true,
  legal_name              text,
  trade_name              text,
  logo_url                text,
  tax_id                  text,
  commercial_registration text,
  address                 text,
  phone                   text,
  email                   text,
  updated_at              timestamptz not null default now(),
  updated_by              uuid        references profiles(id),
  constraint company_settings_is_singleton check (singleton),
  constraint uniq_company_settings unique (singleton)
);$a2$;

  c_rls_from text := $b1$alter table mail_attachments       enable row level security;$b1$;
  c_rls_to   text := $b2$alter table mail_attachments       enable row level security;
alter table company_settings       enable row level security;$b2$;

  c_pol_from text := $c1$drop policy if exists "mail_attachments_select" on mail_attachments;$c1$;
  c_pol_to   text := $c2$-- ------------------------------------------------------------
-- 5t. COMPANY PROFILE — 0046
--
-- READ: anyone holding a profile in this schema. The letterhead prints
-- on the investor statement as well as the sale contract, so is_staff()
-- would blank the header on the one document an outside investor gets.
--
-- WRITE: is_ceo() and nothing weaker.
--
-- NO auth.uid() ANYWHERE IN THESE POLICIES. 0033's `updated_by =
-- auth.uid()` writer-pinning pattern is deliberately NOT used: a policy
-- runs as the tenant role, which has no USAGE on schema auth, so that
-- clause raises 42501 and breaks the write. 0045 had to repair exactly
-- that mistake in the price-history path. updated_by is set by the
-- server action instead.
-- ------------------------------------------------------------
drop policy if exists "company_settings_select" on company_settings;
create policy "company_settings_select" on company_settings for select
  using (current_role_name() is not null);

drop policy if exists "company_settings_insert" on company_settings;
create policy "company_settings_insert" on company_settings for insert
  with check (is_ceo());

drop policy if exists "company_settings_update" on company_settings;
create policy "company_settings_update" on company_settings for update
  using (is_ceo()) with check (is_ceo());

-- NO DELETE POLICY, and §6 grants none. Clearing a field is an UPDATE to
-- NULL; assertion (j) would refuse the grant regardless.

drop policy if exists "mail_attachments_select" on mail_attachments;$c2$;

  c_gnt_from text := $d1$grant select, insert on mail_recipients to {{ROLE}};$d1$;
  c_gnt_to   text := $d2$grant select, insert on mail_recipients to {{ROLE}};

-- The company's own letterhead (0046). SELECT for everyone with a
-- profile, INSERT/UPDATE gated to the CEO by policy — no DELETE, ever.
grant select, insert, update on company_settings to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on company_settings to service_role;$d2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_tbl_from := replace(replace(c_tbl_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists company_settings' in v_tpl) > 0 then
    raise notice '0046: template already carries company_settings — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0046: template anchor 2a (table) did not match. Template drifted from 0039.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0046: template anchor 2b (rls) did not match. Template drifted from 0039.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0046: template anchor 2c (policies) did not match. Template drifted from 0039.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0046: template anchor 2d (grants) did not match. Template drifted from 0039.';
    end if;
    v_done := v_done + 1;

    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists company_settings', ''))) <>
       length('create table if not exists company_settings') then
      raise exception '0046: the template does not carry exactly one company_settings table.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0046$ select %L::text $felix_0046$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0046: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
  c_ddl constant text := $ddl$
create table if not exists company_settings (
  id                      uuid        primary key default gen_random_uuid(),
  singleton               boolean     not null default true,
  legal_name              text,
  trade_name              text,
  logo_url                text,
  tax_id                  text,
  commercial_registration text,
  address                 text,
  phone                   text,
  email                   text,
  updated_at              timestamptz not null default now(),
  updated_by              uuid        references profiles(id)
);

-- No `add constraint if not exists` in Postgres and conname is not
-- database-unique, so drop-then-add converges on a re-run (0018's lesson).
alter table company_settings drop constraint if exists company_settings_is_singleton;
alter table company_settings add constraint company_settings_is_singleton check (singleton);
drop index if exists uniq_company_settings;
create unique index uniq_company_settings on company_settings(singleton);

alter table company_settings enable row level security;

drop policy if exists "company_settings_select" on company_settings;
create policy "company_settings_select" on company_settings for select
  using (current_role_name() is not null);

drop policy if exists "company_settings_insert" on company_settings;
create policy "company_settings_insert" on company_settings for insert
  with check (is_ceo());

drop policy if exists "company_settings_update" on company_settings;
create policy "company_settings_update" on company_settings for update
  using (is_ceo()) with check (is_ceo());
$ddl$;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0046: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    execute format('grant select, insert, update on %I.company_settings to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update, delete on %I.company_settings to service_role', r.schema_name);
    execute format('revoke all on table %I.company_settings from public, anon, authenticated', r.schema_name);

    v_count := v_count + 1;
    raise notice '0046: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0046: % tenant schema(s) can carry a company profile.', v_count;
end
$mig$;

-- ============================================================
-- 4. BACKFILL
--
-- None, deliberately. The row is created on first save. Inventing a
-- legal_name from platform.tenants.name would stamp a 508.world licence
-- label onto a customer's contracts as if they had chosen it, which is
-- precisely the confusion this table exists to end. Every reader falls
-- back to the tenant name until a CEO fills the form in.
-- ============================================================

-- ============================================================
-- 5. SELF-VERIFY
-- ============================================================
do $$
declare
  r     record;
  v_bad text[] := '{}';
  n     int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.company_settings', r.schema_name)) is null then
      if to_regclass(format('%I.profiles', r.schema_name)) is not null then
        v_bad := v_bad || (r.schema_name || ' (table missing)');
      end if;
      continue;
    end if;

    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = r.schema_name and c.relname = 'company_settings' and c.relrowsecurity) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'company_settings';
    if n <> 3 then
      v_bad := v_bad || format('%s (%s policies, expected 3)', r.schema_name, n);
    end if;

    -- THE 0045 LESSON, ASSERTED: no policy on this table may name
    -- auth.uid(), or every CEO write raises 42501 the moment it ships.
    select count(*) into n from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'company_settings'
       and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ 'auth\.uid';
    if n > 0 then
      v_bad := v_bad || format('%s (%s company_settings policy/policies name auth.uid() — will 42501)', r.schema_name, n);
    end if;

    if not exists (select 1 from pg_indexes where schemaname = r.schema_name and indexname = 'uniq_company_settings') then
      v_bad := v_bad || (r.schema_name || ' (singleton unique index missing)');
    end if;

    if not has_table_privilege(r.role_name, format('%I.company_settings', r.schema_name), 'select')
       or not has_table_privilege(r.role_name, format('%I.company_settings', r.schema_name), 'insert')
       or not has_table_privilege(r.role_name, format('%I.company_settings', r.schema_name), 'update') then
      v_bad := v_bad || (r.schema_name || ' (role missing select/insert/update)');
    end if;
    if has_table_privilege(r.role_name, format('%I.company_settings', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (role holds DELETE — assertion (j) would fail provisioning)');
    end if;

    if has_table_privilege('anon', format('%I.company_settings', r.schema_name), 'select')
       or has_table_privilege('authenticated', format('%I.company_settings', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated can read company_settings)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0046 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists company_settings' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert, update on company_settings' in platform.tenant_ddl_template()) = 0
     or position('"company_settings_update" on company_settings' in platform.tenant_ddl_template()) = 0 then
    raise exception '0046 VERIFY FAILED: the template does not carry the company profile.';
  end if;

  raise notice '0046: verified — every showroom can carry its own legal name, logo and tax numbers.';
end
$$;

notify pgrst, 'reload schema';

commit;
