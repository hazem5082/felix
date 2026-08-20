-- ============================================================
-- 0031 — THE CUSTOMER ENTITY
--
-- 0020's header says it plainly: "the `leads` row is the customer
-- record". That is true, and it is the problem. A lead is a pipeline
-- object — it belongs to one salesperson, at one branch, and it ends
-- (ticket_created, closed). A person does not. At group scale the same
-- man walks into Maadi in March and into Sheikh Zayed in October and
-- becomes two unrelated rows, worked by two people who cannot see each
-- other's, neither of whom can answer the only question that matters at
-- the counter: what has this person bought from us before?
--
-- leads.national_id (0020) has been sitting there since the compliance
-- batch as the natural key for exactly this, unused for it.
--
-- WHAT THIS ADDS
-- --------------
--   customers            one row per person. Name, the national ID that
--                        identifies them, every phone number they have
--                        ever been reached on, and the free-text scraps
--                        (address, nationality, notes) that used to be
--                        retyped into every new lead.
--   leads.customer_id    nullable FK. The lead REMAINS the working
--                        pipeline object; the customer is the durable
--                        identity behind it. Nothing about how a lead is
--                        worked changes.
--
-- WHY THE LINK IS MADE IN THE SERVER ACTION AND NOT IN A TRIGGER
-- --------------------------------------------------------------
-- A BEFORE INSERT trigger on leads that invented a customer whenever it
-- saw a new phone number would be shorter than the TypeScript that
-- replaces it, and it would be wrong. The public referral flow
-- (src/app/[locale]/refer/[salespersonId]/actions.ts) inserts leads
-- through the service role from an unauthenticated page: a stranger
-- typing a number into a web form would silently mint a permanent
-- customer identity, visible org-wide, with no member of staff having
-- decided that this is a person the showroom knows. Worse, a mistyped
-- digit would attach that submission to somebody else's identity.
--
-- Linking is therefore an explicit act of the CRM's own write paths
-- (createLead / updateLead), where a human typed the fields and an
-- authenticated session is accountable for them. The referral flow is
-- left exactly as it was — a link-sourced lead carries customer_id NULL
-- until staff open it and save it, which is the same moment they record
-- the national ID.
--
-- WHY STAFF READ EVERY CUSTOMER, ORG-WIDE
-- ---------------------------------------
-- customers_select is `is_staff()` with no branch predicate, and that is
-- the whole point of the table: dedupe that stops at the branch boundary
-- does not dedupe. Three things make it safe.
--
--   1. The sensitive objects keep their branch-scoped RLS untouched.
--      leads_select, deal_tickets_select, contracts, ledger_entries —
--      none of them are widened here. A salesperson in Maadi can see
--      that Sheikh Zayed knows this man; they cannot see what he paid,
--      who sold it to him, or what the showroom made on it.
--   2. The customer row is the phone-book entry, not the file. Name,
--      phone, address, nationality — every one of those fields is
--      already typed in by a salesperson at the counter, into a lead
--      that colleague could already have created themselves.
--   3. The alternative leaks worse. Without a shared customer row the
--      only way to answer "have we dealt with him?" is to phone around
--      the branches, which discloses the same facts with no record that
--      it happened. Here it is one SELECT, and the audit trigger on
--      customers records every edit.
--
-- Investors see nothing: is_staff() has never included them, and there
-- is no investor arm on any of the three policies. 'marketing' (0029) is
-- likewise outside is_staff() and stays outside — the marketing desk
-- advertises stock, it does not hold the customer book.
--
-- THE BACKFILL, AND HOW IT DEDUPES
-- --------------------------------
-- §4 turns the leads that already exist into customers, in two passes,
-- per tenant schema:
--
--   pass 1  leads carrying a national_id. One customer per DISTINCT
--           national_id (the oldest lead names them), every such lead
--           linked to it, and every phone number those leads carry
--           merged into the customer's array. This is the pass that
--           actually collapses branches: two leads, two branches, one
--           14-digit number, one customer.
--   pass 2  everything left. Link to an existing customer when the
--           lead's phone_number is already in somebody's array — which
--           is how a lead with no ID joins the identity pass 1 built —
--           then one customer per remaining DISTINCT phone_number, then
--           link again.
--
-- Exact string match on the phone, deliberately: normalising +20 / 0020
-- / 010… in SQL means guessing at data this migration cannot inspect,
-- and a wrong guess MERGES TWO PEOPLE, which is the one error in this
-- design that cannot be undone from the UI. The app-side matcher
-- (src/lib/customer-match.ts) does normalise, because there a human is
-- looking at the result before it is saved. The backfill is
-- conservative and leaves the rest to be merged by hand later.
--
-- Idempotent by construction: every statement is guarded on
-- `customer_id is null` or on the customer not already existing, so a
-- second run is a no-op rather than a second set of duplicates.
--
-- The backfill's UPDATE on leads fires trg_audit_leads like any other
-- write, and that is left alone rather than suppressed: the rows really
-- did change. It does not pollute the lead page's History panel because
-- customer_id is deliberately absent from lead-history.ts's field
-- allowlist — a uuid is not a sentence, and an update that moves nothing
-- on the allowlist is dropped.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * No merge UI, and no DELETE policy. Two customer rows that turn out
--     to be one person stay two rows until somebody builds the screen
--     that merges them, with the audit trail that a merge deserves.
--     Shipping a delete first would mean the first correction anyone
--     made was destructive.
--   * No household or company modelling. A man buying in his wife's name
--     and a fleet buying six vans are real, they are different problems,
--     and both want relationships between customers rather than more
--     columns on one. company_name stays on the lead where 0001 put it.
--   * No cross-TENANT dedupe. Schema-per-tenant means a customer belongs
--     to one showroom group, full stop. Two groups sharing a customer
--     book is not a feature, it is a data-protection incident.
--   * No FK from deal_tickets to customers. A ticket names a lead, the
--     lead names the customer; adding a second path to the same fact is
--     how the two get to disagree.
--   * customers is NOT added to the c_tables array inside
--     platform.create_tenant_schema(). Same reasoning 0016 recorded: the
--     property is not lost — a failed CREATE TABLE aborts the whole
--     template execute, assertion (b) walks pg_class for RLS and guard
--     (5) for the tenant role's SELECT — and §5 below verifies the table
--     across every live schema directly.
--
-- STRUCTURE MIRRORS 0027/0029 — same two targets (the DDL template for
-- showrooms not yet provisioned, every live t_<slug> for the ones
-- already trading), same anchored-and-verified substitutions, same
-- per-tenant search_path in §3 because FK targets, policy expressions
-- and trigger functions are resolved and FROZEN at CREATE time.
--
-- LINE ENDINGS. The live platform.tenant_ddl_template() text is CRLF —
-- it was built from SQL-Editor pastes of CRLF files — while this file is
-- LF, so a multi-line anchor matches nothing unless the two agree. §2
-- reads the template's own convention and rewrites the ANCHORS into it,
-- flattening them to LF first so it works whether this file arrived as
-- LF or was converted to CRLF by the operator's applier. The stored
-- template's endings are left exactly as they were found, so every later
-- migration keeps matching. Same shape as 0030 §2; the anchor guards
-- remain, and they are what caught this class of failure in the first
-- place.
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
      '0031 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0031 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- The customer_id anchor sits on the leads column 0020 spliced in, and
  -- national_id is the dedupe key this whole migration is built around.
  if position('leads_national_id_check' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0031 PRECONDITION FAILED: the template has no leads.national_id. Apply 0020 first.';
  end if;

  -- Batch-ordering gate. 0031 needs nothing from 0030 — the anchors do
  -- not overlap at a single point, and customers_select uses is_staff()
  -- rather than either of the branch predicates 0030 widens — but a
  -- template amended out of order is a template nobody can reason about
  -- afterwards, so the gate is on the migration immediately before this
  -- one and a database that skipped it fails here rather than three
  -- anchors deep with a message about drift.
  if position('create table if not exists branch_grants' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0031 PRECONDITION FAILED: the template has no branch_grants. Apply 0030 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Seven anchors. The table itself goes in FIRST, immediately above
-- `leads`, because leads.customer_id references it and Postgres resolves
-- an FK target at CREATE time: a customers table spliced in after leads
-- would compile into a template that cannot provision a showroom.
--
-- None of the seven touches a region 0029 or 0030 amended — those chain
-- off vehicle_listings and the branch predicates; these are all on
-- `leads` and 0009's own §8. Two migrations amending one anchor point is
-- the failure mode this file was written to avoid.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  -- None of the anchors below is `constant`: every one is rewritten into
  -- the template's own line-ending convention before it is used. See the
  -- header, and the normalisation block at the top of the body.

  -- 2a. the table, immediately above `leads` — so it lands under §8's
  --     own banner, and above the table whose FK points at it. The
  --     anchor is 0009's leads CREATE TABLE opener, which appears
  --     exactly once (lead_comments' opener is a different string).
  c_tbl_from text := $k1$create table if not exists leads ($k1$;
  c_tbl_to   text := $k2$-- ------------------------------------------------------------
-- 8-bis. CUSTOMERS  (0031)
--
-- The person, as opposed to the enquiry. `leads` is one salesperson's
-- work on one occasion and it ends; this row outlives it and is shared
-- across every branch in the group.
--
-- national_id  the dedupe key, same 14-digit shape as leads' (0020) and
--              profiles' (0018). UNIQUE, and nullable — Postgres lets
--              NULLs repeat under a unique constraint, which is exactly
--              what is wanted here: a customer whose ID has not been
--              collected yet must not collide with every other customer
--              in the same state.
-- phone_numbers  every number this person has been reached on. An array
--              rather than a child table because there are exactly two
--              operations — "does this number belong to anybody" and
--              "add it if it is new" — and a customer_phones table would
--              add a join and a second RLS surface to answer both. The
--              GIN index is what makes the first one an index lookup.
-- notes        the customer-level scrap, distinct from leads.client_notes
--              which is about one enquiry ("wants it before Eid").
-- ------------------------------------------------------------
create table if not exists customers (
  id             uuid        primary key default gen_random_uuid(),
  full_name      text        not null,
  national_id    text        unique,
  phone_numbers  text[]      not null default '{}',
  address        text,
  nationality    text,
  notes          text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  constraint customers_national_id_check check (
    national_id is null
    or national_id ~ '^[0-9]{14}$'
  )
);

-- The only lookup the link-or-create step makes that is not on the
-- primary key or the unique index: "is this phone number anybody's?"
create index if not exists idx_customers_phones on customers using gin (phone_numbers);

create table if not exists leads ($k2$;

  -- 2b. the column on leads. Placed above national_id rather than at the
  --     tail so the two identity columns read together.
  c_col_from text := $k3$  national_id               text,$k3$;
  c_col_to   text := $k4$  -- The durable identity behind this enquiry (0031). NULLABLE and it
  -- stays that way: a lead exists the moment somebody walks in, the
  -- referral form mints leads with no staff member present at all, and
  -- every row that predates this migration was linked by a backfill
  -- rather than by a claim that it always had one.
  customer_id               uuid        references customers(id),
  national_id               text,$k4$;

  -- 2c. the index, after the four 0001 put on leads.
  c_idx_from text := $k5$create index if not exists idx_leads_status      on leads(status);$k5$;
  c_idx_to   text := $k6$create index if not exists idx_leads_status      on leads(status);
-- Every lead this customer has ever been, which is the query the
-- customer card on the lead page is made of.
create index if not exists idx_leads_customer    on leads(customer_id);$k6$;

  -- 2d. RLS
  c_rls_from text := $k7$alter table leads                  enable row level security;$k7$;
  c_rls_to   text := $k8$alter table customers              enable row level security;
alter table leads                  enable row level security;$k8$;

  -- 2e. the policies, after leads' four
  c_pol_from text := $k9$drop policy if exists "leads_delete" on leads;
create policy "leads_delete" on leads for delete using (is_manager_or_above());$k9$;
  c_pol_to   text := $p1$drop policy if exists "leads_delete" on leads;
create policy "leads_delete" on leads for delete using (is_manager_or_above());

-- ------------------------------------------------------------
-- 5i-bis. CUSTOMERS — 0031
--
-- ORG-WIDE READ FOR EVERY STAFF MEMBER, WITH NO BRANCH PREDICATE, AND
-- THAT IS THE POINT. A dedupe key that stops at the branch boundary
-- dedupes nothing: the whole reason this table exists is that the same
-- person walks into three branches. See the file header for why it is
-- safe — in short, the sensitive rows (leads, deal_tickets, contracts,
-- ledger_entries) keep their branch-scoped policies untouched, so what
-- crosses the boundary is the phone-book entry and not the file.
--
-- INSERT and UPDATE are is_staff() because the link-or-create step runs
-- as the salesperson who is saving the lead, on their own session, under
-- their own RLS — there is no privileged path and no service-role
-- shortcut. Widening a customer's phone list is the ordinary case of
-- that UPDATE.
--
-- NO DELETE POLICY, and §6d withholds the grant besides. Two rows that
-- turn out to be one person are merged by a screen nobody has built
-- yet; until then they stay two rows. A delete here would erase the
-- identity every lead and ticket in the group points at.
-- ------------------------------------------------------------
drop policy if exists "customers_select" on customers;
create policy "customers_select" on customers for select
  using (is_staff());

drop policy if exists "customers_insert" on customers;
create policy "customers_insert" on customers for insert
  with check (is_staff());

drop policy if exists "customers_update" on customers;
create policy "customers_update" on customers for update
  using (is_staff()) with check (is_staff());$p1$;

  -- 2f. the triggers, after leads'
  c_trg_from text := $p2$drop trigger if exists trg_audit_leads on leads;
create trigger trg_audit_leads
  after insert or update or delete on leads
  for each row execute function record_audit();$p2$;
  c_trg_to   text := $p3$drop trigger if exists trg_audit_leads on leads;
create trigger trg_audit_leads
  after insert or update or delete on leads
  for each row execute function record_audit();

-- customers (0031). updated_at is what tells a salesperson whether the
-- address they are reading was confirmed this year or in 2019; audited
-- for the same reason leads is — a phone number quietly moved from one
-- identity to another is the single most damaging edit this table
-- allows, and it must leave a trace.
drop trigger if exists trg_customers_updated_at on customers;
create trigger trg_customers_updated_at
  before update on customers
  for each row execute function set_updated_at();

drop trigger if exists trg_audit_customers on customers;
create trigger trg_audit_customers
  after insert or update or delete on customers
  for each row execute function record_audit();$p3$;

  -- 2g. the grants, beside leads' in §6d.
  c_gnt_from text := $p4$grant select, insert, update on leads to {{ROLE}};$p4$;
  c_gnt_to   text := $p5$grant select, insert, update on leads to {{ROLE}};

-- lib/customer-link.ts inserts a customer the first time somebody is
-- seen, updates one to append a phone number, and selects to find out
-- which. No DELETE, matching every other table in 6d — see the policy
-- note above for why a customer is never removed.
grant select, insert, update on customers to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on customers to service_role;$p5$;
begin
  -- The template's own line-ending convention decides the anchors'. Both
  -- directions matter: an LF anchor never matches CRLF text, and a CRLF
  -- replacement spliced into an LF template leaves a mixture that breaks
  -- whichever migration comes next. Each string is flattened to LF first
  -- — the operator's runbook converts this whole FILE to CRLF before
  -- applying it, so the anchors can arrive either way — and then
  -- rewritten in the template's convention. Same shape as 0030 §2.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_tbl_from := replace(replace(c_tbl_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_col_from := replace(replace(c_col_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_col_to   := replace(replace(c_col_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_idx_from := replace(replace(c_idx_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_idx_to   := replace(replace(c_idx_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_from := replace(replace(c_trg_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_to   := replace(replace(c_trg_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists customers' in v_tpl) > 0 then
    raise notice '0031: template already carries customers — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2a (customers table) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2b (leads.customer_id) did not match. Template drifted from 0020.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_idx_from, c_idx_to);
    if position(c_idx_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2c (leads index) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2d (rls) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2e (policies) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2f (triggers) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0031: template anchor 2g (grants) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    -- Every anchor above is a prefix or a suffix of its replacement, so
    -- `replace` would fire twice if the template ever carried two copies
    -- of one of them. 36 = length('create table if not exists customers').
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists customers', ''))) <> 36 then
      raise exception '0031: the template carries more than one customers table.';
    end if;
    -- 30 = length('customer_id               uuid'). The leads column is
    -- the one substitution whose anchor is a plain column line, so it is
    -- worth counting separately.
    if (length(v_tpl) - length(replace(v_tpl, 'customer_id               uuid', ''))) <> 30 then
      raise exception '0031: the template carries more than one leads.customer_id.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0027.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0031$ select %L::text $felix_0031$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0031: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0016 §3 and
-- 0027 §3: the FK targets, the policy expressions and the triggers'
-- functions are resolved and frozen HERE, and each showroom's must bind
-- to its own is_staff(), its own set_updated_at(), its own record_audit().
--
-- The FK on leads is dropped-then-added rather than probed, for 0018's
-- reason: conname is not database-unique, so an EXISTS check without a
-- schema qualifier silently skips every tenant after the first.
-- Drop-then-add converges on a re-run instead.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_ddl constant text := $ddl$
create table if not exists customers (
  id             uuid        primary key default gen_random_uuid(),
  full_name      text        not null,
  national_id    text        unique,
  phone_numbers  text[]      not null default '{}',
  address        text,
  nationality    text,
  notes          text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  constraint customers_national_id_check check (
    national_id is null
    or national_id ~ '^[0-9]{14}$'
  )
);

create index if not exists idx_customers_phones on customers using gin (phone_numbers);

alter table leads add column if not exists customer_id uuid;

alter table leads drop constraint if exists leads_customer_id_fkey;
alter table leads add constraint leads_customer_id_fkey
  foreign key (customer_id) references customers(id);

create index if not exists idx_leads_customer on leads(customer_id);

alter table customers enable row level security;

drop policy if exists "customers_select" on customers;
create policy "customers_select" on customers for select
  using (is_staff());

drop policy if exists "customers_insert" on customers;
create policy "customers_insert" on customers for insert
  with check (is_staff());

drop policy if exists "customers_update" on customers;
create policy "customers_update" on customers for update
  using (is_staff()) with check (is_staff());

drop trigger if exists trg_customers_updated_at on customers;
create trigger trg_customers_updated_at
  before update on customers
  for each row execute function set_updated_at();

drop trigger if exists trg_audit_customers on customers;
create trigger trg_audit_customers
  after insert or update or delete on customers
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- leads is both the FK's dependant and the table this migration
    -- exists to serve; its absence tells a half-provisioned tenant from
    -- a complete one.
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      raise notice '0031: %.leads missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- §6b's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards — these three statements are
    -- what makes the table reachable, and by exactly whom. No DELETE for
    -- the tenant role; see the policy note in §2.
    execute format(
      'grant select, insert, update on %I.customers to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.customers to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.customers from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0031: % amended.', r.schema_name;
  end loop;

  -- §5 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0031: % tenant schema(s) carry customers.', v_count;
end
$mig$;

-- ============================================================
-- 4. BACKFILL — turn the leads that already exist into customers
--
-- Two passes per schema, described in full in the file header. The short
-- version: national_id first because it is the only key that can be
-- trusted to mean "the same person", then exact phone_number for
-- everything it did not reach.
--
-- Every statement is guarded so a second run changes nothing:
--   * inserts are NOT EXISTS / DISTINCT ON against what is already there
--   * links only touch `customer_id is null`
--   * the phone merge only fires when the array does not already contain
--     what would be merged into it
--
-- Runs unqualified under the per-tenant search_path, like §3.
-- ============================================================
do $mig$
declare
  r           record;
  v_customers int;
  v_linked    int;
  v_total     int := 0;

  c_backfill constant text := $bf$
-- ── pass 1: national_id ─────────────────────────────────────
-- One customer per distinct 14-digit ID. The OLDEST lead names them:
-- later leads are re-typings of the same person, and the first spelling
-- is the one somebody checked against a document.
--
-- phone_numbers is populated HERE, from every lead sharing the ID,
-- rather than being left to the merge at the bottom of this script.
-- Ordering matters and it is not obvious why: pass 2a below links an
-- ID-less lead by finding its number in somebody's array, so a customer
-- minted here with an empty array would be invisible to it — and the
-- ID-less lead would get a SECOND customer holding the same phone, which
-- is precisely the duplicate this migration exists to prevent.
insert into customers (full_name, national_id, phone_numbers, address, nationality)
select distinct on (l.national_id)
       l.client_name,
       l.national_id,
       (select coalesce(array_agg(distinct m.phone_number order by m.phone_number), '{}'::text[])
          from leads m
         where m.national_id = l.national_id
           and nullif(btrim(m.phone_number), '') is not null),
       l.address,
       l.nationality
  from leads l
 where l.national_id is not null
   and l.customer_id is null
   and not exists (select 1 from customers c where c.national_id = l.national_id)
 order by l.national_id, l.created_at nulls last, l.id;

update leads l
   set customer_id = c.id
  from customers c
 where l.customer_id is null
   and l.national_id is not null
   and c.national_id = l.national_id;

-- ── pass 2a: join an identity that already knows this number ──
-- Runs BEFORE any new customer is minted, so a lead with no ID but the
-- same phone as an ID-bearing lead lands on that person rather than
-- becoming a second one. `order by created_at, id` only matters when a
-- number is somehow already on two customers; it makes the choice
-- deterministic rather than whatever the planner returned first.
update leads l
   set customer_id = (
     select c.id
       from customers c
      where c.phone_numbers @> array[l.phone_number]
      order by c.created_at nulls last, c.id
      limit 1)
 where l.customer_id is null
   and nullif(btrim(l.phone_number), '') is not null
   and exists (
     select 1 from customers c
      where c.phone_numbers @> array[l.phone_number]);

-- ── pass 2b: everybody still unaccounted for ────────────────
-- Exact string match on the number, and nothing cleverer — see the file
-- header. Normalising here would risk merging two people, which is the
-- one mistake in this design with no undo.
insert into customers (full_name, phone_numbers, address, nationality)
select distinct on (l.phone_number)
       l.client_name, array[l.phone_number], l.address, l.nationality
  from leads l
 where l.customer_id is null
   and nullif(btrim(l.phone_number), '') is not null
 order by l.phone_number, l.created_at nulls last, l.id;

update leads l
   set customer_id = (
     select c.id
       from customers c
      where c.phone_numbers @> array[l.phone_number]
      order by c.created_at nulls last, c.id
      limit 1)
 where l.customer_id is null
   and nullif(btrim(l.phone_number), '') is not null
   and exists (
     select 1 from customers c
      where c.phone_numbers @> array[l.phone_number]);

-- ── sweep: every linked lead's number into its customer ─────
-- The two passes above each fill in the numbers they know about, so on a
-- first run this changes nothing. It earns its place on every run after
-- that: a customer who already existed and has since picked up a second
-- lead — a lead inserted by the referral form, by a script, or by an app
-- version whose link step was failing — carries a number their identity
-- has never been told about, and this is what tells it.
--
-- The `@>` guard is what makes a re-run a no-op. Without it this would
-- rewrite every array to an identical value on every apply, and the
-- audit trigger would faithfully record each rewrite as an edit.
update customers c
   set phone_numbers = (
     select array_agg(distinct p order by p)
       from unnest(c.phone_numbers || lp.phones) as p)
  from (
    select l.customer_id as cid,
           array_agg(distinct l.phone_number) as phones
      from leads l
     where l.customer_id is not null
       and nullif(btrim(l.phone_number), '') is not null
     group by l.customer_id
  ) lp
 where c.id = lp.cid
   and not (c.phone_numbers @> lp.phones);
$bf$;
begin
  for r in select schema_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.customers', r.schema_name)) is null then
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_backfill;

    execute 'select count(*) from customers' into v_customers;
    execute 'select count(*) from leads where customer_id is not null' into v_linked;
    raise notice '0031: % — % customer(s), % lead(s) linked.',
      r.schema_name, v_customers, v_linked;
    v_total := v_total + 1;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0031: backfill complete across % schema(s).', v_total;
end
$mig$;

-- ============================================================
-- 5. SELF-VERIFY — structure, isolation, lockdown, that every policy
-- bound to THIS schema's predicates, and that the backfill left nobody
-- behind.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_priv text;
  v_trg  text;
  n      int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.leads', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.customers', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'leads'
         and column_name = 'customer_id'
    ) then
      v_bad := v_bad || (r.schema_name || ' (leads.customer_id)');
    end if;

    -- The FK, not just the column: an unconstrained uuid would let a
    -- lead point at a customer in another schema's table, or at nothing.
    if not exists (
      select 1
        from pg_constraint c
        join pg_class t      on t.oid = c.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = r.schema_name and t.relname = 'leads'
         and c.conname = 'leads_customer_id_fkey' and c.contype = 'f'
    ) then
      v_bad := v_bad || (r.schema_name || ' (leads_customer_id_fkey)');
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'customers'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'customers';
    if n <> 3 then
      v_bad := v_bad || format('%s (%s policies, expected 3)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's is_staff().
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'customers'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    -- One privilege per call, deliberately: has_table_privilege() with a
    -- comma-separated list returns true if ANY of them is held, so a
    -- single combined call would pass on SELECT alone and say nothing
    -- about the writes the link-or-create step needs.
    foreach v_priv in array array['select', 'insert', 'update'] loop
      if not has_table_privilege(
           r.role_name, format('%I.customers', r.schema_name), v_priv) then
        v_bad := v_bad || format('%s (role has no %s)', r.schema_name, v_priv);
      end if;
    end loop;

    -- DELETE is withheld deliberately; assert it, or a later blanket
    -- grant would hand it over without anyone deciding so.
    if has_table_privilege(
         r.role_name, format('%I.customers', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (role holds delete)');
    end if;

    if not has_table_privilege(
         'service_role', format('%I.customers', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.customers', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.customers', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege)');
    end if;

    foreach v_trg in array array['trg_customers_updated_at', 'trg_audit_customers'] loop
      if not exists (
        select 1 from pg_trigger t
        join pg_class c      on c.oid = t.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = r.schema_name and c.relname = 'customers'
           and t.tgname = v_trg and not t.tgisinternal
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_trg);
      end if;
    end loop;

    -- The backfill's own postcondition. Every lead carries a phone
    -- (leads.phone_number is NOT NULL since 0001), so after §4 there is
    -- no honest reason for one to be left without an identity.
    execute format(
      'select count(*) from %I.leads
        where customer_id is null and nullif(btrim(phone_number), '''') is not null',
      r.schema_name
    ) into n;
    if n > 0 then
      v_bad := v_bad || format('%s (%s lead(s) left unlinked)', r.schema_name, n);
    end if;

    -- Two customers sharing a national ID would mean the unique
    -- constraint is not there, which would mean the dedupe key is not a
    -- key at all.
    execute format(
      'select count(*) from (select national_id from %I.customers
         where national_id is not null group by national_id having count(*) > 1) d',
      r.schema_name
    ) into n;
    if n > 0 then
      v_bad := v_bad || format('%s (%s duplicated national_id(s))', r.schema_name, n);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0031 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists customers' in platform.tenant_ddl_template()) = 0
     or position('customer_id               uuid' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert, update on customers' in platform.tenant_ddl_template()) = 0
     or position('on customers to service_role' in platform.tenant_ddl_template()) = 0
     or position('"customers_select" on customers' in platform.tenant_ddl_template()) = 0 then
    raise exception '0031 VERIFY FAILED: the template does not carry the new table.';
  end if;

  raise notice '0031: verified — every lead names a customer, everywhere.';
end
$$;

-- PostgREST caches the schema; without this both the new table and
-- leads.customer_id are rejected as unknown until the next unrelated
-- reload.
notify pgrst, 'reload schema';

commit;
