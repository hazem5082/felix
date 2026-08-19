-- ============================================================
-- 0016 — LEAD ↔ VEHICLE INTEREST
--
-- One table, joining a buyer to a car and carrying the number that
-- decides everything: what they are willing to pay for it.
--
-- WHAT WAS THERE BEFORE, AND WHY IT WAS NOT ENOUGH
-- ------------------------------------------------
-- Two columns already touched this ground and neither could answer the
-- question:
--
--   leads.car_interest   free text, one per lead. "Looking for a sedan".
--                        Not joinable to a vehicle, so a car on the floor
--                        could not know who wanted it; single-valued, so a
--                        buyer weighing three cars overwrote themselves;
--                        and it carries no price at all.
--   deal_tickets         joins a lead to a vehicle WITH a price — but a
--                        ticket is a commitment. It is raised at the end
--                        of the conversation, it locks the car
--                        (uniq_active_ticket_per_vehicle), it opens a
--                        financing request, and it flips the lead to
--                        'ticket_created'. None of that may happen when a
--                        buyer says "I like that Civic, I have 21,000".
--
-- The gap between those two is the entire sales pipeline, and it was
-- being kept in salespeople's heads. This table is that gap: cheap to
-- write, reversible, many per lead, and priced.
--
-- ORIGIN: WHO PUT THE TWO TOGETHER
-- --------------------------------
-- The brief has two halves and they are not the same fact:
--
--   'requested'  the buyer asked for this car.
--   'suggested'  a salesperson matched the buyer to something on the
--                floor that they had not asked for.
--
-- Collapsing them would ruin the CEO's list. Demand means what buyers
-- walked in wanting; five 'suggested' rows against one slow-moving car
-- is a salesperson working a listing, and reading that as five people
-- wanting it is how a showroom buys a second one it cannot sell.
--
-- VEHICLE_ID IS NULLABLE, AND THAT IS THE POINT
-- ---------------------------------------------
-- The most valuable row in this table is the one with no vehicle_id:
-- somebody wanted a car the showroom does not have, and said what they
-- would pay for it. That is the only record of a sale that was lost for
-- want of stock, and nothing in the schema could hold it before. So
-- wanted_make / wanted_model / wanted_year sit alongside vehicle_id, and
-- the row must carry one or the other — lead_vehicle_interests_names_a_car
-- rejects a row that names no car at all, which would be pure noise in
-- the one report this table exists to feed.
--
-- WHY IT IS AUDITED WHEN lead_comments IS NOT
-- -------------------------------------------
-- §4.10 omits lead_comments from the audit triggers because it is
-- already an append-only record of something that happened. This table
-- is neither: budget_amount and status are meant to be revised as the
-- conversation moves, and budget_amount is a number the CEO makes
-- purchasing decisions against. It follows `leads`, which is audited,
-- not lead_comments.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
-- It does not add 'lead_vehicle_interests' to the c_tables array inside
-- platform.create_tenant_schema(). That array drives assertion (a) —
-- "every table is present" — and reaching it would mean rewriting a
-- 300-line function to change one string literal, in a file whose other
-- three sections are surgical. The property is not lost: a CREATE TABLE
-- that fails aborts the whole template execute, assertion (b) walks
-- pg_class and would catch the table arriving without RLS, and guard
-- (5) walks it again and would catch it arriving without the tenant
-- role's SELECT. Assertion (a) is the belt to those two braces. §4 below
-- verifies the table across every live schema directly.
--
-- STRUCTURE MIRRORS 0014/0015 — read 0014's header first. Same two
-- targets (the DDL template for showrooms not yet provisioned, every
-- live t_<slug> for the ones already trading) and the same
-- anchored-and-verified substitutions.
--
-- SEARCH_PATH IN §3 IS LOAD-BEARING, unlike in 0015. That file created
-- only functions, whose bodies are resolved on first execution against
-- the caller's path. This one creates a table with three foreign keys, a
-- trigger, and four policies — and Postgres resolves a policy expression,
-- an FK target and a trigger's function AT CREATE TIME, storing the OID.
-- Running `create policy ... using (is_ceo())` from a session whose path
-- is `public` binds every showroom's policy to public.is_ceo(), which
-- 0011 left in place: it compiles, it runs, and it reads another schema's
-- profiles table forever. §3 therefore sets the path per tenant and
-- issues unqualified DDL, exactly as create_tenant_schema() does, and §4
-- re-derives the binding from pg_policy rather than trusting it.
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
      '0016 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('  description     text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0016 PRECONDITION FAILED: the template has no vehicles.description. Apply 0015 first.';
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

  -- 2a. the table, immediately after lead_comments' index so it lands in
  --     §8 (LEADS / CRM) beside the rows it belongs to.
  c_tbl_from constant text := $a1$create index if not exists idx_lead_comments_lead on lead_comments(lead_id);$a1$;
  c_tbl_to   constant text := $a2$create index if not exists idx_lead_comments_lead on lead_comments(lead_id);

-- ------------------------------------------------------------
-- 8b. LEAD <-> VEHICLE INTEREST  (0016)
--
-- Who wants which car, and what they will pay for it. Many per lead,
-- because a buyer weighing three cars is the normal case and
-- leads.car_interest could only hold one of them.
--
-- vehicle_id null  = they want something not on the floor; wanted_* says
--                    what. This is the row that records a sale lost for
--                    want of stock.
-- origin           = who put the pair together. 'requested' is demand,
--                    'suggested' is a salesperson working a listing, and
--                    the CEO's report must not add them up.
-- budget_amount    = what the buyer says they will pay. Nullable: a lead
--                    who will not name a number is still worth recording,
--                    and a fabricated zero would poison every average.
-- ------------------------------------------------------------
create table if not exists lead_vehicle_interests (
  id              uuid        primary key default gen_random_uuid(),
  lead_id         uuid        not null references leads(id) on delete cascade,
  -- CASCADE, not SET NULL: nulling this column on a row that names no
  -- wanted_make would violate the names_a_car CHECK, turning a vehicle
  -- deletion into an error nobody could act on.
  vehicle_id      uuid        references vehicles(id) on delete cascade,
  wanted_make     text,
  wanted_model    text,
  wanted_year     int         check (wanted_year is null or wanted_year between 1950 and 2100),
  budget_amount   numeric     check (budget_amount is null or budget_amount > 0),
  origin          text        not null default 'requested' check (origin in ('requested','suggested')),
  status          text        not null default 'open' check (status in ('open','shown','declined')),
  note            text,
  created_by      uuid        references profiles(id),
  created_at      timestamptz default now(),
  constraint lead_vehicle_interests_names_a_car check (
    vehicle_id is not null or nullif(btrim(coalesce(wanted_make, '')), '') is not null
  )
);

create index if not exists idx_lead_interests_lead    on lead_vehicle_interests(lead_id);
create index if not exists idx_lead_interests_vehicle on lead_vehicle_interests(vehicle_id);
create index if not exists idx_lead_interests_created on lead_vehicle_interests(created_at desc);

-- One row per lead per car. Without this, re-opening the dialog on a
-- vehicle already linked silently doubles that car's demand count.
create unique index if not exists uniq_lead_interest_vehicle
  on lead_vehicle_interests(lead_id, vehicle_id) where vehicle_id is not null;$a2$;

  -- 2b. RLS
  c_rls_from constant text := $a3$alter table lead_comments          enable row level security;$a3$;
  c_rls_to   constant text := $a4$alter table lead_comments          enable row level security;
alter table lead_vehicle_interests enable row level security;$a4$;

  -- 2c. the policies, after lead_comments' pair
  c_pol_from constant text := $a5$      select 1 from leads l where l.id = lead_id
      and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
           or l.salesperson_id = auth.uid())));$a5$;
  c_pol_to   constant text := $a6$      select 1 from leads l where l.id = lead_id
      and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
           or l.salesperson_id = auth.uid())));

-- ------------------------------------------------------------
-- 5j-bis. LEAD <-> VEHICLE INTEREST — 0016
--
-- Visibility is the parent lead's, exactly as lead_comments' is: a sales
-- exec sees the interests of their own pipeline, a manager their
-- branch's, the CEO everything. The table holds a phone number's worth
-- of commercial intent — what a named buyer will pay — and must not be
-- readable one branch over.
-- ------------------------------------------------------------
drop policy if exists "lead_vehicle_interests_select" on lead_vehicle_interests;
create policy "lead_vehicle_interests_select" on lead_vehicle_interests for select
  using (exists (
    select 1 from leads l where l.id = lead_vehicle_interests.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
         or l.salesperson_id = auth.uid())));

drop policy if exists "lead_vehicle_interests_insert" on lead_vehicle_interests;
create policy "lead_vehicle_interests_insert" on lead_vehicle_interests for insert
  with check (
    is_staff()
    and created_by = auth.uid()
    and exists (
      select 1 from leads l where l.id = lead_vehicle_interests.lead_id
      and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
           or l.salesperson_id = auth.uid())));

-- USING **and** WITH CHECK, unlike leads_update. leads has no parent, so
-- its USING clause alone is a complete answer. This row's visibility is
-- derived from lead_id, so a USING-only policy would let a visible row be
-- re-pointed at somebody else's lead — writing into a pipeline the caller
-- cannot read, which is the harder half of a leak to notice.
drop policy if exists "lead_vehicle_interests_update" on lead_vehicle_interests;
create policy "lead_vehicle_interests_update" on lead_vehicle_interests for update
  using (exists (
    select 1 from leads l where l.id = lead_vehicle_interests.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
         or l.salesperson_id = auth.uid())))
  with check (exists (
    select 1 from leads l where l.id = lead_vehicle_interests.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
         or l.salesperson_id = auth.uid())));

-- Manager+, mirroring leads_delete and for the same reason: a row
-- deleted by its author is the easy way to make a lost sale disappear
-- from the CEO's report. §6 withholds the DELETE grant regardless, so
-- this policy is reachable only through the service role today.
drop policy if exists "lead_vehicle_interests_delete" on lead_vehicle_interests;
create policy "lead_vehicle_interests_delete" on lead_vehicle_interests for delete
  using (is_manager_or_above());$a6$;

  -- 2d. the audit trigger, after leads'
  c_trg_from constant text := $a7$drop trigger if exists trg_audit_leads on leads;
create trigger trg_audit_leads
  after insert or update or delete on leads
  for each row execute function record_audit();$a7$;
  c_trg_to   constant text := $a8$drop trigger if exists trg_audit_leads on leads;
create trigger trg_audit_leads
  after insert or update or delete on leads
  for each row execute function record_audit();

-- Audited where lead_comments is not: a comment is an append-only record
-- of a call that already happened, whereas budget_amount and status here
-- are revised as the conversation moves, and budget_amount is a number
-- the CEO buys stock against.
drop trigger if exists trg_audit_lead_vehicle_interests on lead_vehicle_interests;
create trigger trg_audit_lead_vehicle_interests
  after insert or update or delete on lead_vehicle_interests
  for each row execute function record_audit();$a8$;

  -- 2e. the grant
  c_gnt_from constant text := $a9$grant select, insert, update on leads to {{ROLE}};$a9$;
  c_gnt_to   constant text := $b1$grant select, insert, update on leads to {{ROLE}};

-- crm/actions.ts inserts an interest and updates its status/budget;
-- crm/[leadId]/page.tsx, inventory/[vehicleId]/page.tsx and ceo/page.tsx
-- read. No DELETE, matching every other table in 6d — an interest that
-- was a mistake is set to 'declined', not erased, because the CEO's
-- demand report is the reason the row exists.
grant select, insert, update on lead_vehicle_interests to {{ROLE}};$b1$;
begin
  if position('create table if not exists lead_vehicle_interests' in v_tpl) > 0 then
    raise notice '0016: template already carries lead_vehicle_interests — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0016: template anchor 2a (table) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0016: template anchor 2b (rls) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0016: template anchor 2c (policies) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0016: template anchor 2d (audit trigger) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0016: template anchor 2e (grant) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    -- Every anchor above is a prefix of its replacement, so `replace`
    -- would happily fire twice if the template ever carried two copies.
    -- One table, one grant, one trigger — assert it.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists lead_vehicle_interests', ''))) <> 49 then
      raise exception '0016: the template carries more than one lead_vehicle_interests table.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0016$ select %L::text $felix_0016$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0016: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path — the same mechanism
-- create_tenant_schema() uses, for the reason the header gives at
-- length: foreign keys, policy expressions and a trigger's function are
-- resolved and frozen HERE, not on first use.
--
-- Issued through EXECUTE rather than written as static statements in
-- this block. plpgsql compiles and caches a plan for every statement it
-- contains, and these run once per tenant under a DIFFERENT search_path
-- each time. The plan cache does track the path and would re-analyse —
-- but "each showroom's policies bound to its own predicates" is the one
-- property this whole file rests on, and it is worth stating outright
-- rather than inferring from plancache.c's invalidation rules.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  -- The same statements §2 spliced into the template, so a showroom
  -- provisioned next month and one trading since March get the same
  -- table rather than two that merely resemble each other.
  c_ddl constant text := $ddl$
create table if not exists lead_vehicle_interests (
  id              uuid        primary key default gen_random_uuid(),
  lead_id         uuid        not null references leads(id) on delete cascade,
  vehicle_id      uuid        references vehicles(id) on delete cascade,
  wanted_make     text,
  wanted_model    text,
  wanted_year     int         check (wanted_year is null or wanted_year between 1950 and 2100),
  budget_amount   numeric     check (budget_amount is null or budget_amount > 0),
  origin          text        not null default 'requested' check (origin in ('requested','suggested')),
  status          text        not null default 'open' check (status in ('open','shown','declined')),
  note            text,
  created_by      uuid        references profiles(id),
  created_at      timestamptz default now(),
  constraint lead_vehicle_interests_names_a_car check (
    vehicle_id is not null or nullif(btrim(coalesce(wanted_make, '')), '') is not null
  )
);

create index if not exists idx_lead_interests_lead    on lead_vehicle_interests(lead_id);
create index if not exists idx_lead_interests_vehicle on lead_vehicle_interests(vehicle_id);
create index if not exists idx_lead_interests_created on lead_vehicle_interests(created_at desc);

create unique index if not exists uniq_lead_interest_vehicle
  on lead_vehicle_interests(lead_id, vehicle_id) where vehicle_id is not null;

alter table lead_vehicle_interests enable row level security;

drop policy if exists "lead_vehicle_interests_select" on lead_vehicle_interests;
create policy "lead_vehicle_interests_select" on lead_vehicle_interests for select
  using (exists (
    select 1 from leads l where l.id = lead_vehicle_interests.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
         or l.salesperson_id = auth.uid())));

drop policy if exists "lead_vehicle_interests_insert" on lead_vehicle_interests;
create policy "lead_vehicle_interests_insert" on lead_vehicle_interests for insert
  with check (
    is_staff()
    and created_by = auth.uid()
    and exists (
      select 1 from leads l where l.id = lead_vehicle_interests.lead_id
      and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
           or l.salesperson_id = auth.uid())));

drop policy if exists "lead_vehicle_interests_update" on lead_vehicle_interests;
create policy "lead_vehicle_interests_update" on lead_vehicle_interests for update
  using (exists (
    select 1 from leads l where l.id = lead_vehicle_interests.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
         or l.salesperson_id = auth.uid())))
  with check (exists (
    select 1 from leads l where l.id = lead_vehicle_interests.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
         or l.salesperson_id = auth.uid())));

drop policy if exists "lead_vehicle_interests_delete" on lead_vehicle_interests;
create policy "lead_vehicle_interests_delete" on lead_vehicle_interests for delete
  using (is_manager_or_above());

drop trigger if exists trg_audit_lead_vehicle_interests on lead_vehicle_interests;
create trigger trg_audit_lead_vehicle_interests
  after insert or update or delete on lead_vehicle_interests
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- leads, vehicles and profiles are all FK targets below and
    -- record_audit() has to exist for the trigger. Checking one of them
    -- is enough to tell a half-provisioned tenant from a complete one,
    -- and skipping is right: 0012's runner reaches it later.
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      raise notice '0016: %.leads missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set on every iteration. `public` is absent
    -- on purpose: with it on the path, an object that resolved out of
    -- order would bind to the flagship's pre-0011 leftovers — silently,
    -- permanently, and with nothing anywhere reporting a problem.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- The table was born reachable by nobody but its owner: §6b's blanket
    -- revoke and §6d's grants ran when the schema was created and cannot
    -- reach an object added afterwards. This grant is the only thing that
    -- makes the table visible to the showroom.
    execute format(
      'grant select, insert, update on %I.lead_vehicle_interests to %I',
      r.schema_name, r.role_name
    );

    -- 0009 §6i left ALTER DEFAULT PRIVILEGES entries that already strip
    -- anon/authenticated from anything created later — but they are keyed
    -- to the role that owns create_tenant_schema(), and §6i's own comment
    -- flags that as an assumption which silently stops holding if a
    -- migration is applied as somebody else. Restated rather than relied
    -- upon; §4 then asserts the result instead of trusting either.
    execute format(
      'revoke all on table %I.lead_vehicle_interests from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0016: % amended.', r.schema_name;
  end loop;

  -- §4 renders policy expressions with pg_get_expr and reads the schema
  -- qualification it emits. That qualification appears only for objects
  -- NOT on the current path, so leaving the last tenant's path in place
  -- would make its own check pass vacuously.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0016: % tenant schema(s) carry lead_vehicle_interests.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Structure, isolation, lockdown and — the one that matters most —
-- that every policy bound to THIS schema's predicates rather than to
-- some other schema's copy of them.
-- ============================================================
do $$
declare
  r       record;
  v_bad   text[] := '{}';
  n       int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.lead_vehicle_interests', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    -- (a) RLS on. Without it every employee of the showroom reads every
    --     buyer's budget, which is the whole reason the table is scoped
    --     to the parent lead.
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'lead_vehicle_interests'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    -- (b) All four policies landed.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'lead_vehicle_interests';

    if n <> 4 then
      v_bad := v_bad || format('%s (%s policies, expected 4)', r.schema_name, n);
    end if;

    -- (c) THE ONE THAT CATCHES THE SILENT DISASTER. pg_get_expr renders a
    --     stored policy expression with every function schema-qualified
    --     unless it is on the current search_path — which §3 has just
    --     reset to pg_catalog, so a correctly-bound policy prints
    --     't_slug.is_ceo(...)' and one bound to the flagship's leftovers
    --     prints 'public.is_ceo(...)'. Both compile. Only one is right.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'lead_vehicle_interests'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');

    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    -- (d) The showroom can reach it, and nobody outside can.
    if not has_table_privilege(
         r.role_name, format('%I.lead_vehicle_interests', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (role has no select)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.lead_vehicle_interests', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.lead_vehicle_interests', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege)');
    end if;

    -- (e) The audit trigger fires.
    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'lead_vehicle_interests'
         and t.tgname = 'trg_audit_lead_vehicle_interests' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (no audit trigger)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0016 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists lead_vehicle_interests' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert, update on lead_vehicle_interests' in platform.tenant_ddl_template()) = 0 then
    raise exception '0016 VERIFY FAILED: the template does not carry the new table.';
  end if;

  raise notice '0016: verified — buyers can be linked to cars everywhere.';
end
$$;

notify pgrst, 'reload schema';

commit;
