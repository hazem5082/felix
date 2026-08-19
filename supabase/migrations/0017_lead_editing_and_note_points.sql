-- ============================================================
-- 0017 — EDITING A CLIENT, AND BEING ABLE TO SEE WHO CHANGED WHAT
--
-- Three things the CRM could not do, and they are one change because
-- the third is what makes the first two safe.
--
-- 1. A CLIENT'S DETAILS COULD NEVER BE CORRECTED
-- ----------------------------------------------
-- `leads` has had an UPDATE policy since 0001 and RLS has always
-- permitted the owning salesperson, the branch's manager and the CEO to
-- write to it. Nothing in the application ever issued that update. A
-- phone number typed wrong at the counter, a client who moved house, a
-- job change that moves them into a different finance bracket — all of it
-- was frozen at whatever was typed into the "Add Lead" dialog, and the
-- only way to fix a digit was to raise a second lead for the same
-- person. This migration adds no privilege for that: it is already
-- granted, the app simply never used it. What it adds is the column the
-- new edit form needs, and the visibility that makes editing auditable.
--
-- 2. A CLIENT'S NOTE WAS ONE UNDIFFERENTIATED PARAGRAPH
-- -----------------------------------------------------
-- `client_notes` is a single text blob, and it was being asked to hold
-- two different kinds of fact at once:
--
--   the standing description of who this person is —
--     "married, three kids"
--   and the individual, separately-actionable requirements that a
--   salesperson has to have in front of them on a call —
--     "lives somewhere with bad roads, needs the ride height of an SUV"
--     "wants seven seats"
--     "sport mode, leather, German-built"
--
-- Flattened into one paragraph the second kind is unreadable at a
-- glance and unusable one requirement at a time: a salesperson skimming
-- before dialling loses the seven-seat requirement in the middle of a
-- sentence about the school run. `client_note_points` splits them.
-- `client_notes` keeps its meaning unchanged and becomes the heading;
-- the array holds the bullets beneath it, each one a requirement on its
-- own line.
--
-- WHY AN ARRAY AND NOT A CHILD TABLE. A bullet has no identity of its
-- own: nothing references it, nothing is ordered against it, no other
-- row joins to it, and it is only ever read as part of the lead it
-- belongs to. A child table would buy referential machinery nobody
-- queries and cost a second round trip on the one page that renders it —
-- and, more to the point, would put the bullets OUTSIDE `leads`, whose
-- audit trigger is the entire mechanism behind (3) below. In the array
-- they are audited with the lead, in one before/after pair, for free.
--
-- `not null default '{}'`, never nullable: every read site would
-- otherwise need `coalesce`, and an empty note is an empty array, which
-- is a fact the type can carry. Existing rows take the default.
--
-- 3. THE EDIT HISTORY EXISTED AND NOBODY COULD READ IT
-- ----------------------------------------------------
-- This is the half that is not obvious. 0003 §8 put `record_audit()` on
-- `leads` and 0016 put it on `lead_vehicle_interests`; every update to
-- either has been writing a full before/after pair into `audit_log`
-- since the day it was applied. But `audit_log_select` is
-- `is_ceo() or is_accountant_or_above()` — so a branch manager cannot
-- read the history of their own branch's leads, and the sales exec who
-- owns a lead cannot see that someone changed the phone number on it.
--
-- Opening editing to everyone who can see a lead, while the record of
-- who edited it is visible to two roles out of five, is the wrong trade.
-- The point of showing history on the lead page is that the people doing
-- the editing are the people it keeps honest.
--
-- `audit_log_select_lead_scope` is therefore a SECOND policy, not a
-- widening of the first. Postgres ORs permissive policies together, so
-- the CEO and the accountant keep the unrestricted read they have today
-- and everyone else gains exactly one window: rows whose entity is a
-- lead they can already see, or an interest belonging to one. Nothing
-- about vehicles, ledgers, equity, staff or another branch's pipeline
-- becomes visible — the predicate names the two entity_types and joins
-- to `leads`, so there is no way to reach a third.
--
-- The `before_data`/`after_data` payload it exposes is the lead row
-- itself, which the same caller can already SELECT from `leads`
-- directly. The policy grants a view of history, not of new facts.
--
-- WHY THE JOIN IS SPELLED OUT TWICE. `entity_id` is a bare uuid with no
-- foreign key — audit rows outlive the rows they describe, which is the
-- point of an audit table — so it cannot be resolved generically. Each
-- of the two entity types gets its own EXISTS, and the interest one goes
-- through `lead_vehicle_interests` to reach the lead. An interest that
-- has since been deleted drops out of the history, which is correct
-- here: §6 grants no DELETE to any tenant role, so it can only have gone
-- through the service role, and a repair is not a salesperson's history.
--
-- TWO TARGETS, BOTH REQUIRED — read 0014's header for why. The template
-- for showrooms not yet provisioned, and every live t_<slug> for the
-- ones already trading. Every substitution is verified, because
-- `replace()` on a missing anchor is a silent no-op.
--
-- SEARCH_PATH IN §3 IS LOAD-BEARING, exactly as in 0016. The column is
-- inert either way, but a policy expression is resolved AT CREATE TIME
-- and the OID is stored: creating `audit_log_select_lead_scope` from a
-- session whose path is `public` would bind every showroom's policy to
-- public.is_staff() and public.leads — which 0011 left standing, so it
-- compiles, it runs, and it reads another schema's pipeline forever. §3
-- sets the path per tenant and issues unqualified DDL; §4 re-derives the
-- binding from pg_policy rather than trusting that it worked.
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
      '0017 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0017 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The lead-scoped audit policy names lead_vehicle_interests. Applying
  -- this before 0016 would create a policy referencing a table that does
  -- not exist, which fails at CREATE POLICY rather than at read time —
  -- but it fails per tenant, halfway through §3, so say it up front.
  if position('create table if not exists lead_vehicle_interests' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0017 PRECONDITION FAILED: the template has no lead_vehicle_interests. Apply 0016 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_done int  := 0;

  -- 2a. the column, in the leads DDL, directly beneath the note it
  --     belongs to so the pair reads as one field in the schema.
  c_col_from constant text := $a1$  client_notes              text,
  created_at                timestamptz default now()$a1$;
  c_col_to   constant text := $a2$  client_notes              text,
  -- The heading is client_notes; these are the bullets under it. Each
  -- entry is one separately-actionable requirement a salesperson reads
  -- before dialling — "needs seven seats", "bad roads, wants an SUV" —
  -- which is unreadable and unusable flattened into the paragraph above.
  client_note_points        text[]      not null default '{}',
  created_at                timestamptz default now()$a2$;

  -- 2b. the lead-scoped audit read, after the existing policy rather
  --     than instead of it. Permissive policies OR together: the CEO and
  --     accountant keep the unrestricted read, everyone else gains the
  --     history of the leads they can already see and nothing else.
  c_pol_from constant text := $a3$create policy "audit_log_select" on audit_log for select
  using (is_ceo() or is_accountant_or_above());$a3$;
  c_pol_to   constant text := $a4$create policy "audit_log_select" on audit_log for select
  using (is_ceo() or is_accountant_or_above());

-- ------------------------------------------------------------
-- 5r-bis. LEAD-SCOPED AUDIT READ — 0017
--
-- The CRM shows each client's edit history on their own page, and the
-- people who need it are the people doing the editing: the sales exec
-- who owns the lead and the manager of its branch, neither of whom
-- satisfies the policy above.
--
-- Scoped by joining back to `leads`, so this widens the trail by exactly
-- two entity types and not one row further. entity_id carries no foreign
-- key — audit rows outlive what they describe — so each type is resolved
-- explicitly.
-- ------------------------------------------------------------
drop policy if exists "audit_log_select_lead_scope" on audit_log;
create policy "audit_log_select_lead_scope" on audit_log for select
  using (
    is_staff()
    and (
      (audit_log.entity_type = 'leads' and exists (
        select 1 from leads l
         where l.id = audit_log.entity_id
           and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
                or l.salesperson_id = auth.uid())))
      or
      (audit_log.entity_type = 'lead_vehicle_interests' and exists (
        select 1 from lead_vehicle_interests i
          join leads l on l.id = i.lead_id
         where i.id = audit_log.entity_id
           and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
                or l.salesperson_id = auth.uid())))
    )
  );$a4$;
begin
  if position('client_note_points' in v_tpl) > 0
     and position('audit_log_select_lead_scope' in v_tpl) > 0 then
    raise notice '0017: template already carries both changes — skipping amendment.';
  else
    if position('client_note_points' in v_tpl) = 0 then
      v_tpl := replace(v_tpl, c_col_from, c_col_to);
      if position(c_col_to in v_tpl) = 0 then
        raise exception '0017: template anchor 2a (leads.client_note_points) did not match. Template drifted.';
      end if;
      v_done := v_done + 1;
    end if;

    if position('audit_log_select_lead_scope' in v_tpl) = 0 then
      v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
      if position(c_pol_to in v_tpl) = 0 then
        raise exception '0017: template anchor 2b (audit_log lead scope) did not match. Template drifted.';
      end if;
      v_done := v_done + 1;
    end if;

    -- Both anchors are prefixes of their replacements, so `replace`
    -- would fire twice on a template that somehow carried two copies.
    -- One column, one policy — assert it.
    if (length(v_tpl) - length(replace(v_tpl, 'client_note_points        text[]', ''))) <> 32 then
      raise exception '0017: the template carries more than one client_note_points column.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create policy "audit_log_select_lead_scope"', ''))) <> 43 then
      raise exception '0017: the template carries more than one audit_log_select_lead_scope policy.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0017$ select %L::text $felix_0017$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0017: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, for the reason the
-- header gives: `create policy` resolves is_staff(), current_branch_id(),
-- `leads` and `lead_vehicle_interests` now and stores the OIDs.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  -- Character-for-character what §2 spliced into the template, so a
  -- showroom licensed next month and one trading since March get the
  -- same policy rather than two that merely resemble each other.
  c_ddl constant text := $ddl$
alter table leads add column if not exists client_note_points text[] not null default '{}';

drop policy if exists "audit_log_select_lead_scope" on audit_log;
create policy "audit_log_select_lead_scope" on audit_log for select
  using (
    is_staff()
    and (
      (audit_log.entity_type = 'leads' and exists (
        select 1 from leads l
         where l.id = audit_log.entity_id
           and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
                or l.salesperson_id = auth.uid())))
      or
      (audit_log.entity_type = 'lead_vehicle_interests' and exists (
        select 1 from lead_vehicle_interests i
          join leads l on l.id = i.lead_id
         where i.id = audit_log.entity_id
           and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
                or l.salesperson_id = auth.uid())))
    )
  );
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- lead_vehicle_interests is named by the policy and leads by both
    -- statements. Checking the later of the two tells a half-provisioned
    -- tenant from a complete one; 0012's runner reaches it later.
    if to_regclass(format('%I.lead_vehicle_interests', r.schema_name)) is null then
      raise notice '0017: %.lead_vehicle_interests missing — skipping (tenant not fully provisioned).',
        r.schema_name;
      continue;
    end if;

    -- Transaction-local, re-set every iteration. `public` is absent on
    -- purpose: with it on the path a name resolved out of order binds to
    -- the flagship's pre-0011 leftovers, silently and permanently.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- No grant. Unlike 0016's new table, both objects here already carry
    -- the privileges they need: 0009 §6d grants `select, insert, update`
    -- on `leads` as a whole (a column added to a table inherits the
    -- table's grants), and `grant select on audit_log to {{ROLE}}` has
    -- been in place since the schema was created. The policy is what was
    -- missing, not the privilege.

    v_count := v_count + 1;
    raise notice '0017: % amended.', r.schema_name;
  end loop;

  -- §4 renders the policy expression with pg_get_expr and reads the
  -- schema qualification it emits. That qualification appears only for
  -- objects NOT on the current path, so leaving the last tenant's path in
  -- place would make its own check pass vacuously.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0017: % tenant schema(s) carry the note points and the lead-scoped audit read.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Provisioning failures here are silent and late — an unreadable history
-- panel looks identical to a lead nobody has edited — so the migration
-- proves its own result rather than trusting §3 reached every schema.
-- ============================================================
do $$
declare
  r     record;
  v_bad text[] := '{}';
  n     int;
  v_def text;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      continue;
    end if;

    -- (a) the column, with the shape the app relies on. A nullable one
    --     would compile and then hand every read site a null array.
    select data_type || ':' || is_nullable || ':' || coalesce(column_default, 'none')
      into v_def
      from information_schema.columns
     where table_schema = r.schema_name
       and table_name = 'leads'
       and column_name = 'client_note_points';

    if v_def is null then
      v_bad := v_bad || (r.schema_name || ' (no client_note_points)');
    elsif v_def not like 'ARRAY:NO:%' then
      v_bad := v_bad || format('%s (client_note_points is %s)', r.schema_name, v_def);
    end if;

    -- (b) the policy landed...
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name
       and c.relname = 'audit_log'
       and p.polname = 'audit_log_select_lead_scope';

    if n <> 1 then
      v_bad := v_bad || format('%s (%s lead-scope policies, expected 1)', r.schema_name, n);
    end if;

    -- (c) ...and the original survived beside it. This one is worth
    --     stating: the whole design rests on the two being OR'd, and a
    --     `drop policy` typo that removed the CEO's unrestricted read
    --     would show up as an empty Audit Trail on the CEO dashboard
    --     long after this file was forgotten.
    if not exists (
      select 1 from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name
         and c.relname = 'audit_log'
         and p.polname = 'audit_log_select'
    ) then
      v_bad := v_bad || (r.schema_name || ' (the original audit_log_select is gone)');
    end if;

    -- (d) THE ONE THAT CATCHES THE SILENT DISASTER — 0016 §4(c)'s check,
    --     for the same reason. pg_get_expr schema-qualifies every name
    --     not on the current search_path, and §3 above left the path at
    --     the last tenant's schema, so a correctly-bound policy prints
    --     't_slug.is_staff(...)' and one bound to the flagship's
    --     leftovers prints 'public.is_staff(...)'. Both compile. One
    --     reads another showroom's pipeline.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name
       and c.relname = 'audit_log'
       and p.polname = 'audit_log_select_lead_scope'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '') !~ ('\m' || r.schema_name || '\M');

    if n > 0 then
      v_bad := v_bad || (r.schema_name || ' (lead-scope policy not bound to this schema)');
    end if;

    -- (e) the showroom can still read the trail at all. The policy is
    --     worthless without the table privilege, and nothing in §3
    --     re-issues it.
    if not has_table_privilege(r.role_name, format('%I.audit_log', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (role cannot select audit_log)');
    end if;

    if not has_table_privilege(r.role_name, format('%I.leads', r.schema_name), 'update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot update leads)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0017 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('client_note_points        text[]      not null default ''{}''' in platform.tenant_ddl_template()) = 0 then
    raise exception '0017 VERIFY FAILED: the template does not carry leads.client_note_points.';
  end if;

  if position('audit_log_select_lead_scope' in platform.tenant_ddl_template()) = 0 then
    raise exception '0017 VERIFY FAILED: the template does not carry the lead-scoped audit read.';
  end if;

  raise notice '0017: verified — clients are editable, their notes have bullets, and the trail is readable.';
end
$$;

-- PostgREST caches the schema; without this the new column is rejected
-- as unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
