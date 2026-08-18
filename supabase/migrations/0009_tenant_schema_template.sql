-- ============================================================
-- 0009 — THE TENANT SCHEMA TEMPLATE
--
-- 0008 built the control plane: a registry, one Postgres role per
-- showroom, and the PostgREST wiring that exposes a schema once it
-- exists. What it never did was create one. This migration supplies the
-- other half — the complete definition of a FELIX business schema, and
-- the function that stamps a copy of it into t_<slug>.
--
-- It provisions nothing. platform.create_tenant_schema() is defined and
-- deliberately left uncalled: the flagship's own schema and the copy of
-- its live rows out of `public` are 0011's job, and the rewritten
-- provision_tenant() is 0010's. This file is machinery only.
--
-- TWO OBJECTS
-- -----------
--   platform.tenant_ddl_template()  — returns the entire DDL body as
--                                     text, with {{SCHEMA}} and {{ROLE}}
--                                     still unsubstituted.
--   platform.create_tenant_schema() — substitutes those two tokens and
--                                     executes the result into a new
--                                     schema.
--
-- Keeping the DDL as retrievable TEXT rather than as inline statements is
-- what makes 0012 possible: a per-schema migration runner can ask the
-- database what a tenant schema is supposed to look like, diff that
-- against what a given schema actually holds, and re-apply. With N
-- schemas the question that matters stops being "has this migration run"
-- and becomes "which schemas is it missing from" — and a tenant
-- provisioned halfway through a rollout is the normal way that drift
-- appears, not an edge case. It also means "what was tenant #7
-- provisioned with?" is a query rather than an archaeology exercise
-- across four migration files.
--
--
-- THE MECHANISM: SEARCH_PATH, NOT QUALIFICATION
-- ---------------------------------------------
-- create_tenant_schema() does not qualify identifiers. It sets
--
--     search_path = t_<slug>, extensions
--
-- and then runs 315 statements, 169 of them unqualified CREATEs — 19
-- tables, 37 indexes, 38 functions, 30 triggers, 45 policies. Every one
-- lands in t_<slug>, because an unqualified CREATE resolves to the first
-- schema on the path; and every reference BETWEEN them resolves the same
-- way.
-- That is why the body below is very nearly character-identical to
-- 0001/0003/0006 — the tenancy lives in the path, not in the text, which
-- is also what keeps this template diffable against its own sources.
--
-- WHY THAT BINDING IS PERMANENT, AND EXACTLY HOW FAR IT REACHES
--
-- Postgres resolves a name once, when the object containing it is
-- created, and stores the ANSWER — an OID — not the name. So:
--
--   * a policy's USING / WITH CHECK expression,
--   * a column DEFAULT and a CHECK constraint,
--   * a foreign key's target,
--   * a trigger's table (tgrelid) and its function (tgfoid),
--   * an index's expression, its collation and its operator class,
--
-- are all frozen at CREATE time against t_<slug>'s own objects. Nothing
-- later can redirect them: not a schema rename, not a different
-- search_path, not putting `public` back on somebody's path. When
-- vehicles_select says `holds_equity_in_vehicle(...)`, pg_policy holds
-- the OID of THIS tenant's copy of that function, forever.
--
-- This is also why `public` must never appear on create_tenant_schema()'s
-- search_path. With only `t_<slug>, extensions`, an object created out of
-- order raises an error here and now, loudly, and the whole provisioning
-- rolls back. Add `public` and the identical mistake instead binds the
-- tenant's policy to public's function — silently, permanently, and with
-- no test anywhere that would notice.
--
-- WHERE IT DOES **NOT** REACH — AND WHY EVERY FUNCTION IS PINNED
--
-- A plpgsql function body is not resolved at CREATE time. It is stored as
-- source text and planned on first execution, against whatever
-- search_path the SESSION happens to have — and re-planned when that
-- changes. The same is true of a `%rowtype` declaration and of the body
-- of any `language sql` function that does not get inlined.
--
-- So an unpinned prevent_split_edit_after_sale(), firing on
-- t_alpha.vehicle_equity_splits from a service-role session whose path is
-- still `public`, reads public.vehicles. It finds no sold row, concludes
-- the car was never sold, and lets an already-paid-out cap table be
-- edited. That failure is fail-OPEN and silent — the exact opposite of
-- every other guard in this file, all of which fail closed and loudly.
--
-- Every function in the template therefore carries
--     set search_path = t_<slug>, extensions
-- and not only the SECURITY DEFINER ones. There are two deliberate
-- exceptions: the seven tiny SQL predicates (is_ceo() and its siblings)
-- schema-qualify their inner calls instead, because a SET clause makes a
-- SQL function un-inlinable and those seven are evaluated against every
-- candidate row of every policy-filtered query in the application.
-- Qualification buys the identical property for free. §2 argues this at
-- length; do not "harmonise" it by doing both.
--
-- Twenty of the functions are SECURITY DEFINER. create_tenant_schema() is
-- itself SECURITY DEFINER, so everything it creates is owned by ITS
-- owner — which means those twenty run as a superuser. Their pinned
-- search_path is not hygiene and not style: it is the only thing deciding
-- which schema a superuser-privileged body reads and writes. A missed pin
-- is a privilege-escalation bug that compiles perfectly.
--
--
-- WHAT IS GLOBAL AND MUST STAY THAT WAY
-- -------------------------------------
--   auth.uid(), auth.users        — one GoTrue for the deployment.
--                                   profiles.id keeps its FK to
--                                   auth.users(id): the dependency points
--                                   OUT of the tenant schema, so
--                                   `drop schema t_<slug> cascade` stays
--                                   safe. It does NOT stop one auth user
--                                   holding a profiles row in two tenant
--                                   schemas — only platform.tenant_users
--                                   makes that mapping single-valued.
--   extensions.digest()           — pgcrypto, installed once. `extensions`
--                                   is on the search_path for exactly this
--                                   reason, and because 13 tables default
--                                   their primary key to gen_random_uuid().
--                                   Removing it from the path would fail
--                                   every CREATE TABLE below.
--   platform.*                    — the control plane (0008), always
--                                   qualified, never reachable from a
--                                   tenant role.
--
-- WHAT IS EXCLUDED FROM THE TEMPLATE, AND WHY
-- -------------------------------------------
--   handle_new_user() and the on_auth_user_created trigger. The trigger
--   is on auth.users, which exists once for the whole deployment.
--   Creating it per tenant would silently repoint every showroom's
--   signups at whichever tenant was provisioned last. Rewritten in 0010,
--   where it also has to write across schemas.
--
--   consume_rate_limit(), prune_rate_limit_buckets(), provision_tenant().
--   All three operate on control-plane tables (0008 §3).
--
--   The extension bootstrap (0001 §0, 0003 §0). Extensions are
--   database-global and installed once; 0008 already assumes `extensions`
--   exists.
--
--   Every trace of 0004/0005's row-level tenancy: the tenant_id column on
--   18 tables, its indexes and defaults, current_tenant_id(),
--   _tenant_scoped_tables(), all 20 *_tenant_isolation policies, and
--   0005's three inheritance rewrites. The schema is the boundary now.
--   Keeping the column would be worse than useless — a second, unenforced
--   answer to "whose row is this?" that no policy consults and that future
--   code would eventually trust. create_tenant_schema() asserts that not
--   one survived.
--
-- WHAT THE TEMPLATE CONTAINS
-- --------------------------
--   §1  19 tables, 37 indexes.  Nineteen, not the twenty the design brief
--       states: 0007_notification_contacts.sql creates no table, it adds
--       two COLUMNS to profiles. They are folded into the profiles
--       definition, along with their two CHECK constraints — which 0007
--       guards with `where conname = ...` and nothing else, so replayed
--       verbatim every showroom after the first would silently get
--       unvalidated columns.
--   §2  11 role/branch predicates.
--   §3   9 business-logic RPCs.
--   §4  18 trigger functions, 30 triggers.
--   §5  RLS enabled on all 19 tables, 45 policies.
--   §6  Grants, lockdown, and the privilege guard.
--   §7  The baseline rows a showroom cannot function without.
--
--
-- APPLYING THIS
-- -------------
-- create_tenant_schema() must run as a role that can create schemas,
-- create roles (through platform.create_tenant_role), and GRANT USAGE on
-- the global `auth` and `extensions` schemas. On managed Supabase that is
-- `postgres`; on the on-prem deployment, the bootstrap superuser. Same
-- requirement 0008 states, for the same reason.
--
-- The function is commit-free and every statement it issues is
-- transactional, including CREATE SCHEMA and CREATE ROLE, so a failure
-- anywhere leaves no trace of a half-built showroom. Telling PostgREST
-- about the new schema is deliberately NOT part of it:
-- platform.sync_postgrest_schemas() stays outside the transaction, where
-- 0008 put it, so a rolled-back provisioning can never have announced a
-- schema that does not exist.
-- ============================================================

begin;

-- ============================================================
-- 1. THE TEMPLATE
--
-- One function returning one string. The {{SCHEMA}} and {{ROLE}} tokens
-- are left in it on purpose — this is the schema-independent definition,
-- and the substituted form only ever exists inside create_tenant_schema()
-- for the microseconds it takes to execute.
--
-- IMMUTABLE because it is a constant. Cheap to select, which matters:
-- when provisioning fails on a syntax error at character 91,204, this is
-- how you find out what is there.
--
--     select substr(platform.tenant_ddl_template(), 91000, 400);
--
-- The DDL body is dollar-quoted, nested inside this function's own
-- quoting, so every tag in the file has to be distinct. Each section of
-- the template uses its own named tag and none of them collides with the
-- two used here. That is not an accident: a section added later that
-- reaches for the default empty tag would terminate the template early,
-- and the resulting error points at a line hundreds of statements away
-- from the cause.
--
-- Deliberately, no tag is written out in the prose of this file, so that
--     grep -o '\$[a-z_]*\$' 0009_tenant_schema_template.sql | sort | uniq -c
-- returns an even count for every one of them. An odd count means an
-- unterminated body.
-- ============================================================
create or replace function platform.tenant_ddl_template()
returns text
language sql
immutable
set search_path = pg_catalog
as $template$
select $ddl$
-- ============================================================
-- SECTION 1 — TABLES, COLUMNS, CONSTRAINTS, INDEXES
--
-- The end state of the FELIX business schema, collapsed from
-- 0001 (creates), 0003 (constraints, unique indexes, audit_log's
-- two jsonb columns), 0006 (the calendar) and 0007 (notification
-- contacts) into one forward pass of CREATE TABLE statements.
--
-- WHY COLLAPSED RATHER THAN REPLAYED
--
-- The obvious way to build this body is to paste 0001, then 0003's
-- ALTERs, then 0007's. Three reasons not to:
--
--   1. 0007 guards its two ADD CONSTRAINT calls with
--      `if not exists (select 1 from pg_constraint where conname = ...)`.
--      conname is unique per table, NOT per database, and that query
--      filters on nothing else. Replayed verbatim, tenant #1 creates
--      the constraints and every tenant after it silently skips them —
--      unvalidated notification_email and whatsapp_number columns in
--      every showroom but the first, with 0007's own verification block
--      passing spuriously because it makes the same mistake. Defining
--      the checks inline removes the guard and the bug together.
--   2. An ALTER against a table created 400 lines earlier in the same
--      dynamic body is pure noise: nothing has happened in between that
--      the CREATE could not have said directly.
--   3. Every constraint here is now part of the answer to "what does a
--      tenant schema look like?", and that answer should be readable in
--      one place rather than reconstructed from four files.
--
-- NAMES ARE UNQUALIFIED, DELIBERATELY
--
-- `set local search_path = t_<slug>, extensions` is in force, and an
-- unqualified CREATE resolves to the FIRST schema on that path — so
-- every table, index and constraint below both lands in and is checked
-- against t_<slug>. Nothing here needs the schema name interpolated:
-- the only cross-schema references in this section are
-- `auth.users(id)` on profiles.id, which is global and must stay
-- written exactly as it is, and gen_random_uuid(), which resolves
-- through `extensions`. That is why `extensions` cannot be dropped
-- from the search_path — without it every CREATE TABLE below fails on
-- its own primary key default.
--
-- WHAT IS ABSENT
--
-- tenant_id, on all of them. 0004 put it on 18 tables and 0006 added
-- it to the two calendar tables; the schema is the boundary now, so
-- the column, its 18 indexes, its defaults and its NOT NULLs are all
-- gone. A stray idx_*_tenant anywhere below would mean a tenant_id
-- column survived. Also absent: tenants, staff_invitations,
-- rate_limit_buckets, tenant_users and schema_migrations, which are
-- the control plane and live in `platform` (0008).
--
-- There is no sequence anywhere in this schema — every primary key is
-- a uuid — so nothing downstream needs to grant USAGE on sequences.
-- ============================================================

-- ============================================================
-- 1. BRANCHES
--
-- First because everything else hangs off it. A showroom always has
-- at least one, planted at provision time; several of the RPCs raise
-- errors that read like bugs if it is missing.
-- ============================================================
create table if not exists branches (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  address     text,
  created_at  timestamptz default now()
);

-- ============================================================
-- 2. PROFILES
--    Mirrors auth.users 1:1. Carries role + branch scope.
--
-- The FK to auth.users is the one deliberate cross-schema reference
-- in this whole template. Two consequences worth stating out loud:
-- the dependency points OUT of the tenant schema, so `drop schema
-- t_<slug> cascade` stays safe; but it does NOT stop the same auth
-- user holding a profiles row in two tenant schemas. Only
-- platform.tenant_users (0008) makes that mapping single-valued.
--
-- notification_email and whatsapp_number arrive from 0007 and are
-- defined here rather than bolted on — see the header for why 0007's
-- pg_constraint guard cannot be carried over.
-- ============================================================
create table if not exists profiles (
  id                  uuid        primary key references auth.users(id) on delete cascade,
  full_name           text        not null,
  role                text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor')),
  branch_id           uuid        references branches(id),
  phone               text,
  avatar_url          text,
  notification_email  text,
  whatsapp_number     text,
  created_at          timestamptz default now(),
  -- Both checks only guarantee "looks vaguely like an email" / "looks
  -- vaguely dialable". FELIX serves Arabic- and English-speaking
  -- markets, so no country-specific phone format is assumed; the bar
  -- is what the 508.world router Worker needs to attempt a send, never
  -- strong enough to reject a real address.
  constraint profiles_notification_email_check check (
    notification_email is null
    or (position('@' in notification_email) > 1 and length(notification_email) <= 254)
  ),
  constraint profiles_whatsapp_number_check check (
    whatsapp_number is null
    or whatsapp_number ~ '^[+0-9() -]{6,32}$'
  )
);

comment on column profiles.notification_email is
  'Self-editable contact address for meeting invites, the 1-hour reminder cron, and FELIX product updates — sent by the 508.world router Worker, not by FELIX. Deliberately outside guard_profile_privilege_columns(): this is a contact preference, not a privilege column, and profiles_update_self already scopes the write to the owner (plus CEO).';

comment on column profiles.whatsapp_number is
  'Self-editable WhatsApp contact number for the same notifications as notification_email. Same self-service rationale — see the comment on that column.';

-- ============================================================
-- 3. INVESTORS (1:1 with a profiles row where role='investor')
--
-- Exists because vehicle_equity_splits.holder_id points here, not at
-- profiles. Without the mirrored row, funding an investor fails on a
-- raw foreign-key violation — which is what 0001 shipped and 0003
-- fixed by provisioning the row alongside the profile.
-- ============================================================
create table if not exists investors (
  id          uuid        primary key references profiles(id) on delete cascade,
  notes       text,
  created_at  timestamptz default now()
);

-- ============================================================
-- 4. VEHICLES
-- ============================================================
create table if not exists vehicles (
  id              uuid        primary key default gen_random_uuid(),
  branch_id       uuid        not null references branches(id),
  -- UNIQUE is now per-showroom rather than platform-wide, which is
  -- looser than before and correct: two showrooms trading the same
  -- car at different times is legitimate, and a VIN collision across
  -- tenants was never a real constraint, only an artefact of one
  -- shared table.
  vin             text        unique,
  year            int         not null,
  make            text        not null,
  model           text        not null,
  trim            text,
  purchase_price  numeric     not null check (purchase_price > 0),
  status          text        not null default 'in_stock' check (status in ('in_stock','reserved','sold')),
  photos          text[]      not null default '{}',
  created_by      uuid        references profiles(id),
  created_at      timestamptz default now(),
  sold_at         timestamptz
);

create index if not exists idx_vehicles_branch  on vehicles(branch_id);
create index if not exists idx_vehicles_status  on vehicles(status);
create index if not exists idx_vehicles_created on vehicles(created_at desc);

-- Free-text search over the columns the inventory list screen filters
-- on. 'simple' is a regconfig resolved through pg_catalog and stored
-- by OID, so it needs no qualification here.
create index if not exists idx_vehicles_search on vehicles
  using gin (to_tsvector('simple', coalesce(make,'') || ' ' || coalesce(model,'') || ' ' || coalesce(vin,'')));

-- ============================================================
-- 5. VEHICLE EQUITY SPLITS — the cap table
--
-- Immutable once the vehicle is sold; the lock lives in a trigger,
-- not here, because it has to read the vehicle's status.
-- ============================================================
create table if not exists vehicle_equity_splits (
  id                uuid        primary key default gen_random_uuid(),
  vehicle_id        uuid        not null references vehicles(id) on delete cascade,
  holder_type       text        not null check (holder_type in ('ceo','investor')),
  holder_id         uuid        references investors(id),
  amount_invested   numeric     not null check (amount_invested >= 0),
  percentage        numeric     not null check (percentage >= 0 and percentage <= 100),
  created_at        timestamptz default now(),
  constraint holder_id_matches_type check (
    (holder_type = 'ceo' and holder_id is null) or
    (holder_type = 'investor' and holder_id is not null)
  )
);

create index if not exists idx_equity_splits_vehicle on vehicle_equity_splits(vehicle_id);
create index if not exists idx_equity_splits_holder  on vehicle_equity_splits(holder_id);

-- One row per holder per vehicle. 0001 allowed a double-click during
-- intake to create two rows for the same investor, who was then paid
-- twice out of an immutable ledger. Partial indexes rather than a
-- table constraint because the CEO line carries a NULL holder_id and
-- NULLs do not collide in a plain UNIQUE.
create unique index if not exists uniq_split_investor_per_vehicle
  on vehicle_equity_splits(vehicle_id, holder_id) where holder_id is not null;
create unique index if not exists uniq_split_ceo_per_vehicle
  on vehicle_equity_splits(vehicle_id) where holder_type = 'ceo';

-- ============================================================
-- 6. VEHICLE EXPENSES (CEO override -> locked audit rule)
-- ============================================================
create table if not exists vehicle_expenses (
  id                uuid        primary key default gen_random_uuid(),
  vehicle_id        uuid        not null references vehicles(id) on delete cascade,
  category          text        not null,
  amount            numeric     not null check (amount > 0),
  note              text,
  created_by        uuid        references profiles(id),
  is_ceo_override   boolean     not null default false,
  created_at        timestamptz default now()
);

create index if not exists idx_vehicle_expenses_vehicle on vehicle_expenses(vehicle_id);

-- ============================================================
-- 7. OVERHEAD CONFIG (per-branch monthly OpEx, CEO-set)
--
-- Keyed on branch_id, unchanged. 0004 considered re-keying it per
-- tenant and correctly decided not to, because branches were already
-- tenant-scoped; inside a per-schema branches table that reasoning is
-- trivially true. Recorded so the question is not re-asked.
--
-- The row for each branch must exist even at zero. compute_sale_waterfall()
-- reads it with `coalesce(monthly_opex_amount,0)`, so a missing row is
-- not an error — it silently books zero overhead and overstates profit
-- on every sale that showroom ever makes.
-- ============================================================
create table if not exists overhead_config (
  branch_id            uuid        primary key references branches(id),
  monthly_opex_amount  numeric     not null default 0,
  updated_at           timestamptz default now(),
  constraint overhead_config_non_negative check (monthly_opex_amount >= 0)
);

-- ============================================================
-- 8. LEADS / CRM
-- ============================================================
create table if not exists leads (
  id                        uuid        primary key default gen_random_uuid(),
  branch_id                 uuid        references branches(id),
  salesperson_id            uuid        references profiles(id),
  client_name               text        not null,
  phone_number              text        not null,
  address                   text,
  company_name              text,
  job_title                 text,
  income                    numeric,
  car_interest              text,
  source                    text        not null default 'manual' check (source in ('manual','link')),
  status                    text        not null default 'pending' check (status in ('pending','ticket_created','closed')),
  contact_time_preference   text,
  client_notes              text,
  created_at                timestamptz default now()
);

create index if not exists idx_leads_branch      on leads(branch_id);
create index if not exists idx_leads_salesperson on leads(salesperson_id);
create index if not exists idx_leads_created     on leads(created_at desc);
create index if not exists idx_leads_status      on leads(status);

create index if not exists idx_leads_search on leads
  using gin (to_tsvector('simple', coalesce(client_name,'') || ' ' || coalesce(phone_number,'')));

create table if not exists lead_comments (
  id              uuid        primary key default gen_random_uuid(),
  lead_id         uuid        not null references leads(id) on delete cascade,
  author_id       uuid        references profiles(id),
  contact_method  text,
  contact_time    timestamptz,
  body            text        not null,
  created_at      timestamptz default now()
);

create index if not exists idx_lead_comments_lead on lead_comments(lead_id);

-- ============================================================
-- 9. FINANCING PARTNERS (bank contract upload gate)
--
-- status='active' additionally requires a real https contract URL —
-- that check needs no other row, but it is enforced in a trigger
-- rather than here because 0003 wanted the error message, and because
-- a CHECK cannot be relaxed later without a table rewrite.
-- ============================================================
create table if not exists financing_partners (
  id                  uuid        primary key default gen_random_uuid(),
  bank_name           text        not null,
  product_name        text        not null,
  rate                numeric,
  term_months         int,
  min_down_payment    numeric,
  contract_file_url   text,
  status              text        not null default 'pending_upload' check (status in ('pending_upload','active')),
  created_by          uuid        references profiles(id),
  created_at          timestamptz default now(),
  -- 0001 left both unconstrained. A rate of 4000 or a 900-month term
  -- is a typo, and both feed numbers a customer signs.
  constraint financing_partners_rate_sane check (rate is null or (rate >= 0 and rate <= 100)),
  constraint financing_partners_term_sane check (term_months is null or (term_months > 0 and term_months <= 480))
);

-- ============================================================
-- 10. DEAL TICKETS (the approval workflow)
-- ============================================================
create table if not exists deal_tickets (
  id                        uuid        primary key default gen_random_uuid(),
  lead_id                   uuid        references leads(id),
  vehicle_id                uuid        not null references vehicles(id),
  branch_id                 uuid        not null references branches(id),
  salesperson_id            uuid        not null references profiles(id),
  agreed_price              numeric     not null check (agreed_price > 0),
  financing_type            text        not null check (financing_type in ('cash','installments')),
  financing_partner_id      uuid        references financing_partners(id),
  down_payment              numeric,
  discount_amount           numeric     not null default 0,
  status                    text        not null default 'submitted' check (status in ('submitted','approved','rejected','executed')),
  financial_check_passed    boolean     not null default false,
  discount_validated        boolean     not null default false,
  rate_revalidated          boolean     not null default false,
  rejection_reason          text,
  reviewed_by               uuid        references profiles(id),
  reviewed_at               timestamptz,
  executed_at               timestamptz,
  created_at                timestamptz default now(),
  -- 0001 checked agreed_price > 0 and left these two open, so a
  -- NEGATIVE discount added phantom profit which was then paid out in
  -- ledger rows no policy can reverse.
  constraint deal_tickets_discount_sane check (
    discount_amount >= 0 and discount_amount <= agreed_price
  ),
  constraint deal_tickets_down_payment_sane check (
    down_payment is null or (down_payment >= 0 and down_payment <= agreed_price)
  )
);

create index if not exists idx_deal_tickets_branch      on deal_tickets(branch_id);
create index if not exists idx_deal_tickets_salesperson on deal_tickets(salesperson_id);
create index if not exists idx_deal_tickets_status      on deal_tickets(status);
create index if not exists idx_deal_tickets_vehicle     on deal_tickets(vehicle_id);
create index if not exists idx_deal_tickets_lead        on deal_tickets(lead_id);
create index if not exists idx_deal_tickets_created     on deal_tickets(created_at desc);

-- Only one live (approved-but-unexecuted) ticket per vehicle, so two
-- managers cannot settle the same car concurrently. This is the
-- structural half of the double-post defence; execute_vehicle_sale()
-- carries the other half as an explicit ledger check.
create unique index if not exists uniq_active_ticket_per_vehicle
  on deal_tickets(vehicle_id) where status = 'approved';

create table if not exists deal_ticket_events (
  id               uuid        primary key default gen_random_uuid(),
  deal_ticket_id   uuid        not null references deal_tickets(id) on delete cascade,
  actor_id         uuid        references profiles(id),
  from_status      text,
  to_status        text        not null,
  note             text,
  created_at       timestamptz default now()
);

create index if not exists idx_deal_ticket_events_ticket on deal_ticket_events(deal_ticket_id);

-- ============================================================
-- 11. FINANCING REQUESTS
--     Ticket-based tracker for bank installment approval —
--     intentionally NOT an auto-amortization calculator since
--     bank terms vary too much; the source-of-truth is the
--     uploaded bank contract file on financing_partners.
-- ============================================================
create table if not exists financing_requests (
  id                      uuid        primary key default gen_random_uuid(),
  deal_ticket_id          uuid        not null references deal_tickets(id) on delete cascade,
  financing_partner_id    uuid        not null references financing_partners(id),
  status                  text        not null default 'submitted' check (status in ('submitted','in_review','approved_by_bank','rejected_by_bank')),
  notes                   text,
  supporting_doc_urls     text[]      not null default '{}',
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

create index if not exists idx_financing_requests_ticket on financing_requests(deal_ticket_id);

-- ============================================================
-- 12. CONTRACTS (cryptographic serial + vault lock)
--
-- The row's mere existence is what unlocks sales-exec visibility of a
-- deal — no row means still locked — so it is minted by the approval
-- trigger and never written by a client.
--
-- serial's UNIQUE is now per-showroom rather than platform-wide.
-- Harmless: the serial is a SHA-256 prefix over the ticket uuid, the
-- VIN and a clock reading, so a collision was never what the
-- constraint was protecting against.
-- ============================================================
create table if not exists contracts (
  id               uuid        primary key default gen_random_uuid(),
  deal_ticket_id   uuid        not null unique references deal_tickets(id) on delete cascade,
  serial           text        not null unique,
  pdf_url          text,
  generated_at     timestamptz default now(),
  unlocked_at      timestamptz
);

-- ============================================================
-- 13. COMMISSION TIERS
--
-- Back to `primary key (tier_index)`. 0004 re-keyed this to
-- (tenant_id, tier_index) for a real reason — with one shared table,
-- the second showroom provisioned collided with the first on tier 1 —
-- but inside a per-tenant schema "unique within a showroom" and
-- "unique within the table" are the same statement, so the composite
-- key is not merely unnecessary, it is unexpressible.
--
-- Knock-on for whoever plants the seed ladder: the conflict target is
-- `on conflict (tier_index)`, not 0004's `(tenant_id, tier_index)`.
-- And it must be planted. commission_for_sale() answers an unseeded
-- ladder with `if max_tier is null then return 0`, so a showroom
-- without these rows pays every salesperson nothing, silently, forever.
-- ============================================================
create table if not exists commission_tiers (
  tier_index          int         primary key check (tier_index between 1 and 10),
  cumulative_amount   numeric     not null
);

-- ============================================================
-- 14. LEDGER ENTRIES (unified CEO / investor / salesperson wallet)
--
-- holder_id has no FK on purpose: it points at investors for one
-- holder_type and at profiles for another, and the CEO line carries
-- NULL. The check below is what keeps that union honest.
-- ============================================================
create table if not exists ledger_entries (
  id                    uuid        primary key default gen_random_uuid(),
  holder_type           text        not null check (holder_type in ('ceo','investor','sales_exec')),
  holder_id             uuid,
  type                  text        not null check (type in ('sale_profit_share','deposit','withdrawal','commission','salary','opex_offset')),
  amount                numeric     not null,
  ref_deal_ticket_id    uuid        references deal_tickets(id),
  ref_vehicle_id        uuid        references vehicles(id),
  note                  text,
  created_at            timestamptz default now(),
  constraint holder_id_required_unless_ceo check (
    (holder_type = 'ceo') or (holder_id is not null)
  )
);

create index if not exists idx_ledger_holder      on ledger_entries(holder_type, holder_id);
create index if not exists idx_ledger_type_created on ledger_entries(type, created_at desc);
create index if not exists idx_ledger_ref_ticket   on ledger_entries(ref_deal_ticket_id);
create index if not exists idx_ledger_ref_vehicle  on ledger_entries(ref_vehicle_id);

-- ============================================================
-- 15. AUDIT LOG
--
-- before_data / after_data are 0003's, folded in rather than ALTERed
-- on: they are what turned the audit trail from "one row per sale"
-- into a full record of every mutation.
--
-- One capability this design gives up, stated rather than discovered:
-- with a shared table and a tenant_id column, a platform operator
-- could answer "what happened across all showrooms" with one query.
-- There are now N independent audit_log tables and no union view.
-- That is exactly the isolation being bought, but it is a loss.
-- ============================================================
create table if not exists audit_log (
  id            uuid        primary key default gen_random_uuid(),
  actor_id      uuid        references profiles(id),
  action        text        not null,
  entity_type   text,
  entity_id     uuid,
  detail        jsonb,
  before_data   jsonb,
  after_data    jsonb,
  created_at    timestamptz default now()
);

create index if not exists idx_audit_log_created on audit_log(created_at desc);
create index if not exists idx_audit_log_entity  on audit_log(entity_type, entity_id);
create index if not exists idx_audit_log_actor   on audit_log(actor_id);

-- ============================================================
-- 16. PROFILES INDEXES
--
-- Deferred to here only because profiles had to be created before
-- branches could be referenced from it; the indexes themselves belong
-- with the table and are grouped for the reader's benefit.
-- ============================================================
create index if not exists idx_profiles_branch on profiles(branch_id);
create index if not exists idx_profiles_role   on profiles(role);

-- ============================================================
-- 17. CALENDAR (0006)
--
-- Neither table gets an INSERT policy later, and that is load-bearing
-- rather than an oversight: create_meeting() is the only authenticated
-- write path. Nor is there a DELETE policy — a meeting is cancelled,
-- never erased, so the people who rearranged their day around it can
-- still see what happened to it.
-- ============================================================
create table if not exists meetings (
  id            uuid        primary key default gen_random_uuid(),
  -- NULL means showroom-wide. Only a CEO can produce that: a branch
  -- manager's branch is forced to their own in create_meeting().
  branch_id     uuid        references branches(id) on delete set null,
  organizer_id  uuid        not null references profiles(id) on delete cascade,
  title         text        not null check (length(btrim(title)) between 1 and 120),
  agenda        text        check (agenda is null or length(agenda) <= 2000),
  location      text        check (location is null or length(location) <= 160),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        text        not null default 'scheduled'
                            check (status in ('scheduled','cancelled')),
  created_at    timestamptz not null default now(),
  constraint meetings_end_after_start check (ends_at > starts_at),
  -- A typo in a datetime-local field is otherwise indistinguishable
  -- from a deliberate multi-day block, and would smear one row across
  -- every cell of the month grid.
  constraint meetings_duration_sane  check (ends_at <= starts_at + interval '12 hours')
);

create table if not exists meeting_invitees (
  meeting_id    uuid        not null references meetings(id) on delete cascade,
  profile_id    uuid        not null references profiles(id) on delete cascade,
  response      text        not null default 'pending'
                            check (response in ('pending','accepted','declined')),
  responded_at  timestamptz,
  created_at    timestamptz not null default now(),
  primary key (meeting_id, profile_id)
);

create index if not exists idx_meetings_starts          on meetings(starts_at);
create index if not exists idx_meetings_branch          on meetings(branch_id);
create index if not exists idx_meetings_organizer       on meetings(organizer_id);
create index if not exists idx_meeting_invitees_profile on meeting_invitees(profile_id);

-- ============================================================
-- END OF SECTION 1
--
-- 19 tables, 37 indexes (3 of them unique, 2 of them GIN), 4 inline
-- UNIQUE constraints (vehicles.vin, contracts.deal_ticket_id,
-- contracts.serial, and meeting_invitees' composite primary key).
--
-- The count is 19 and not the 20 the brief states: 0007 creates no
-- notification-contacts table, it adds two COLUMNS to profiles, which
-- are in section 2 above. Anyone hunting for a twentieth table will
-- either invent one or skip 0007 — and skipping 0007 quietly removes
-- the two columns the 508.world router Worker reads with the service
-- role, which then fails with column-not-found against every tenant
-- schema.
-- ============================================================
-- ============================================================
-- 2. ROLE / BRANCH PREDICATE FUNCTIONS
--
-- The eleven small helpers every RLS policy in this schema is built
-- out of. Two of them (current_role_name, current_branch_id) read the
-- profiles row of the calling auth user; everything else is a thin
-- boolean on top of those two, plus the two lookups that break the
-- vehicles <-> vehicle_equity_splits policy cycle.
--
-- ORDER IS LOAD-BEARING. Postgres validates a SQL-language function
-- body at CREATE time (check_function_bodies), so a helper cannot be
-- created before the helper it calls, and none of them before the
-- tables they read. Hence: current_role_name/current_branch_id first,
-- then the is_* predicates, then can_*_branch, then the two
-- cycle-breakers — and this whole section AFTER the tables.
--
-- THE SEARCH_PATH RULE, AND WHY IT IS APPLIED TWO DIFFERENT WAYS
-- --------------------------------------------------------------
-- Everything create_tenant_schema() emits is owned by the function's
-- own owner (postgres), so every SECURITY DEFINER helper below runs
-- with superuser rights. A SECURITY DEFINER function whose search_path
-- is not pinned is a privilege-escalation primitive, full stop — the
-- caller chooses which schema's `profiles` decides their role. So the
-- four SECURITY DEFINER helpers carry an explicit, interpolated
--   set search_path = {{SCHEMA}}, extensions
-- and reference their tables unqualified; the pinned path is what
-- binds them. (The `public.` prefixes the originals carried are
-- dropped rather than rewritten — see the reference map.)
--
-- The seven plain `language sql stable` predicates are handled the
-- OTHER way round: their inner calls are schema-qualified with
-- {{SCHEMA}}. and they get NO set clause. This is deliberate and is
-- the one place this section departs from "pin every function".
--
--   * A SQL function body is stored as text and re-resolved against
--     the SESSION search_path, not frozen at CREATE time. A policy on
--     t_<slug> binds to t_<slug>.is_ceo() by OID and is safe — but the
--     moment that body runs under a session whose search_path still
--     contains `public` (Supabase's authenticator sets
--     pgrst.db_extra_search_path = public, extensions), an unqualified
--     current_role_name() can bind to a leftover public.current_role_name(),
--     which reads public.profiles. Best case the user resolves to role
--     NULL and every policy denies; worst case — while 0011's copy out
--     of public is still in flight and public.profiles is populated — a
--     tenant session evaluates its role against another showroom's rows.
--     Qualifying the inner call removes the ambiguity outright.
--
--   * A SET clause would fix it too, but it also makes the function
--     un-inlinable: the planner refuses to inline any SQL function
--     carrying proconfig. These seven sit inside the USING/WITH CHECK
--     of nearly every policy in the schema, i.e. they are evaluated
--     against every candidate row of every query. Losing inlining here
--     is a whole-application cost paid to buy a property that the
--     qualification already buys for free.
--
--   * The four SECURITY DEFINER helpers below are never inlined anyway
--     (the planner will not inline prosecdef functions), so pinning
--     their search_path costs nothing — which is why they get the SET
--     clause and the others do not.
--
-- Do NOT "harmonise" this by stripping the {{SCHEMA}}. prefixes and
-- adding SET clauses instead. The result compiles, passes every test,
-- and is slower.
--
-- PRIVILEGES: no migration ever granted EXECUTE on these eleven — they
-- have always relied on Postgres's default grant to PUBLIC. RLS policy
-- expressions are evaluated as the INVOKING role and function EXECUTE
-- privilege IS checked there, so the tenant role must hold EXECUTE on
-- all eleven or every table in this schema answers "permission denied
-- for function is_ceo" instead of returning rows. The grants section
-- owns that; it must not treat these as internal-only functions.
-- ============================================================

-- ── The two profile lookups everything else funnels through ──
--
-- SECURITY DEFINER because they are read from inside the very policies
-- that protect profiles: without it, resolving "what is my role?" would
-- require already having passed the check that needs the answer.
create or replace function current_role_name() returns text as $fn$
  select role from profiles where id = auth.uid();
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;

create or replace function current_branch_id() returns uuid as $fn$
  select branch_id from profiles where id = auth.uid();
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;

-- ── Role predicates ─────────────────────────────────────────
--
-- Note these are ranks, not sets: is_manager_or_above() admits the CEO,
-- is_accountant_or_above() admits the CEO, and is_staff() admits
-- everyone except investors. Investors are deliberately outside the
-- staff ladder rather than at the bottom of it — they see their own
-- equity and nothing else, so no "or above" predicate should ever
-- include them.
create or replace function is_ceo() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() = 'ceo';
$fn$ language sql stable;

create or replace function is_manager_or_above() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() in ('ceo','branch_manager');
$fn$ language sql stable;

create or replace function is_accountant_or_above() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() in ('ceo','accountant');
$fn$ language sql stable;

create or replace function is_staff() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() in ('ceo','accountant','branch_manager','sales_exec');
$fn$ language sql stable;

create or replace function is_investor() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() = 'investor';
$fn$ language sql stable;

-- ── Branch scoping ──────────────────────────────────────────
--
-- "Can this actor act on this branch?" — the check that was missing
-- from almost every write path in 0001. CEO and accountants are
-- org-wide; everyone else is confined to the branch on their profile.
--
-- The schema-per-tenant split does NOT make these redundant. The schema
-- is the boundary between showrooms; this is the boundary between
-- branches INSIDE one showroom, and it is still the only thing stopping
-- a branch manager from settling another branch's deal.
--
-- The null test matters: current_branch_id() is null for the CEO and
-- for accountants, and `null = null` is null, not true — so without it
-- an unassigned profile would compare equal to a null branch_id column
-- and quietly widen its own scope.
create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id());
$fn$ language sql stable;

-- Textually identical to can_act_on_branch() today, and kept separate
-- on purpose: read and write scope are the same rule by coincidence,
-- not by definition. Policies name whichever one they mean, so a future
-- widening of read scope (e.g. letting managers see sibling branches'
-- stock) is a one-function change rather than an audit of every policy.
create or replace function can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id());
$fn$ language sql stable;

-- ── The two cycle-breakers ──────────────────────────────────
--
-- Two lookups the policies need across the vehicles <->
-- vehicle_equity_splits boundary:
--
--   vehicles_select       must know "does the caller hold equity in this car?"
--   equity_splits_select  must know "which branch does this car belong to?"
--
-- Written as `exists (select ... from <the other table>)` inside the
-- policies, those two cross-reference each other, and Postgres expands
-- policy subqueries at PLAN time — so it detects the cycle and every
-- query against either table fails outright with "infinite recursion
-- detected in policy for relation ...". The OR short-circuit does not
-- save it: planning happens before any row is evaluated, so this breaks
-- for every role, CEO included, and takes vehicle_expenses down with it
-- (its policies read vehicles).
--
-- SECURITY DEFINER is the fix: the function reads the table directly
-- without policy expansion, so no cycle can form. Safe here because
-- neither function returns anything the caller can act on beyond a
-- boolean and a branch id, and both are already reachable facts for
-- anyone the surrounding policy admits.
--
-- Both must exist before vehicles_select and equity_splits_select are
-- created, so that those policies bind to THIS schema's copies by OID.
create or replace function holds_equity_in_vehicle(p_vehicle_id uuid) returns boolean as $fn$
  select exists (
    select 1 from vehicle_equity_splits
     where vehicle_id = p_vehicle_id and holder_id = auth.uid());
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;

create or replace function vehicle_branch(p_vehicle_id uuid) returns uuid as $fn$
  select branch_id from vehicles where id = p_vehicle_id;
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;
-- ============================================================
-- SECTION 3. BUSINESS-LOGIC RPCs
--
-- Every function below is SECURITY DEFINER (the one exception,
-- generate_contract_serial, is called only from one that is), which means
-- it runs as the owner of create_tenant_schema — postgres — and RLS does
-- not apply to a single statement inside it. Under 0004 that was survivable
-- because the RESTRICTIVE *_tenant_isolation policies still fenced the
-- tables these functions read. That backstop is gone: the schema IS the
-- fence now, and the only thing that decides which schema a plpgsql body
-- resolves `vehicles` to is the function's own pinned search_path.
--
-- So `set search_path = {{SCHEMA}}, extensions` here is not hygiene, it is
-- the authorization boundary. A plpgsql body is stored as source text and
-- planned at first execution against the FUNCTION's search_path (only
-- DDL-embedded expressions — policy USING/WITH CHECK, column defaults,
-- CHECK constraints — are frozen as OIDs at creation). The same is true of
-- the `%rowtype` declarations below. Leave `public` in any of these and a
-- superuser-privileged function reads another schema's cars.
--
-- What changed relative to 0004: every tenant_id predicate, column and
-- declaration is gone, because an id parameter can no longer name another
-- showroom's row. What did NOT change: every role check, every branch
-- check, and every business invariant. Those guard a showroom's internals,
-- not its perimeter, and 0004's tenant guards were deliberately written to
-- sit immediately adjacent to them with the same if-not-X-raise shape.
-- Read the two together before deleting either.
--
-- {{SCHEMA}} is the tenant schema (t_<slug>); {{ROLE}} is the tenant role
-- (felix_<slug>, created by platform.create_tenant_role in 0008). The role
-- has to be interpolated for the same reason the schema does: a grant to
-- `authenticated` — which is what every source migration wrote — names a
-- role that holds nothing on this schema and can never reach these
-- functions.
--
-- WHERE THE PRIVILEGES ON THESE NINE ARE
--
-- Not here. 0001 and 0003 put each `grant execute` immediately after its
-- function, and this section was drafted that way; the statements were
-- pulled out during assembly and now live in §6h, together with the
-- schema, table and default-privilege statements.
--
-- The reason is that a privilege list which appears twice is a privilege
-- list that will eventually disagree with itself, and the disagreement is
-- silent in the dangerous direction: closing a function in one list while
-- the other still opens it reads, on review, exactly like closing it. §6h
-- is the single answer to "what can a signed-in user of this showroom
-- call?", and §6j asserts that answer against the catalogue before
-- create_tenant_schema() returns.
--
-- The per-function reasoning stays here, next to the function it is about
-- — including for the two that are deliberately NOT granted
-- (generate_contract_serial and commission_for_sale), because the argument
-- for withholding a privilege is worth more next to the code than in a
-- grant list that does not mention it.
-- ============================================================


-- ── Contract serials ────────────────────────────────────────
-- 0001 §12. NOT security definer, yet it carries a pinned search_path —
-- which is exactly why it is easy to miss: a grep for `security definer`
-- does not find it. Its only non-local reference is extensions.digest(),
-- so leaving `public` pinned here would be latent rather than live, but it
-- would still name a schema that 0011 empties, and a pinned search_path
-- containing a schema someone else can create objects in is a standing
-- hijack surface for a function called inside an approval trigger.
--
-- Side effect of the migration, stated so it is a decision and not a
-- discovery: contracts.serial's UNIQUE constraint is now per-showroom
-- rather than platform-wide. The serial embeds a sha256 of the ticket id
-- and a clock_timestamp(), so a cross-tenant collision was never load
-- bearing anyway.
create or replace function generate_contract_serial(p_deal_ticket_id uuid, p_vin text) returns text as $fn$
declare
  raw text;
  digest_hex text;
  yr text := to_char(now(), 'YYYY');
begin
  raw := p_deal_ticket_id::text || '|' || coalesce(p_vin,'') || '|' || extract(epoch from clock_timestamp())::text;
  digest_hex := encode(extensions.digest(raw, 'sha256'), 'hex');
  return 'FILEX-' || yr || '-' || upper(substr(digest_hex,1,4)) || '-' || upper(substr(digest_hex,5,4)) || '-' || upper(substr(digest_hex,9,4));
end;
$fn$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- PRIVILEGE (see §6h): revoked from PUBLIC with every other function in
-- the schema, and granted to nobody. Postgres grants EXECUTE on a new
-- function to PUBLIC by default, and this one is not an RPC —
-- handle_deal_ticket_approval() calls it, and that function runs as this
-- function's owner, so the owner's own privilege is what gets checked.
-- Nothing needs it granted.


-- ── The waterfall ───────────────────────────────────────────
-- Both the preview and the commit need identical inputs, or a manager
-- approves one number and books another. This single source of truth is
-- SECURITY DEFINER so every role — including a sales_exec, who cannot read
-- vehicle_expenses or overhead_config — sees the true figures instead of
-- silently getting zeros. It takes an explicit as-of timestamp so the
-- preview and the execution agree on months_in_inventory.
--
-- DROPPED from 0004: `if v.tenant_id is distinct from current_tenant_id()
-- then raise 'Vehicle not found'`. It sat directly above the branch/equity
-- check below and shared its wording with the `if not found` check above,
-- so all three read as one block — but only the outer two survive. The
-- tenant guard existed because a shared table let an id parameter name
-- another showroom's car; `vehicles` now resolves to this schema and
-- nowhere else.
create or replace function compute_sale_waterfall(
  p_vehicle_id uuid,
  p_agreed_price numeric,
  p_discount numeric default 0,
  p_as_of timestamptz default now()
) returns jsonb as $fn$
declare
  v vehicles%rowtype;
  months_in_inventory numeric;
  overhead_total numeric;
  total_expenses numeric;
  net_profit numeric;
  shares jsonb;
  allocated numeric;
  remainder numeric;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;

  -- ROLE + BRANCH + equity-holder check (0003 §7). KEEP VERBATIM. This is
  -- the whole of the authorisation: SECURITY DEFINER means vehicles_select
  -- never runs. An accountant sees every branch; everyone else sees their
  -- own branch's cars, or a car they personally hold equity in.
  if not (is_ceo() or is_accountant_or_above()
          or v.branch_id = current_branch_id()
          or exists (select 1 from vehicle_equity_splits s
                      where s.vehicle_id = v.id and s.holder_id = auth.uid())) then
    raise exception 'Not authorized to view this vehicle''s waterfall';
  end if;

  months_in_inventory := greatest(extract(epoch from (p_as_of - v.created_at)) / (30*86400), 0);

  select coalesce(sum(amount),0) into total_expenses
    from vehicle_expenses where vehicle_id = v.id;

  select coalesce(monthly_opex_amount,0) * months_in_inventory into overhead_total
    from overhead_config where branch_id = v.branch_id;
  overhead_total := round(coalesce(overhead_total, 0), 2);

  net_profit := round(
    p_agreed_price - v.purchase_price - total_expenses - overhead_total - coalesce(p_discount,0), 2);

  select coalesce(jsonb_agg(jsonb_build_object(
    'holder_type', s.holder_type,
    'holder_id',   s.holder_id,
    'percentage',  s.percentage,
    'share',       round(net_profit * s.percentage / 100, 2)
  ) order by s.holder_type, s.holder_id), '[]'::jsonb) into shares
  from vehicle_equity_splits s where s.vehicle_id = v.id;

  -- Per-holder round() leaves a cent or two unallocated. Push the residual
  -- onto the CEO line so the shares always sum exactly to net_profit.
  select coalesce(sum((e->>'share')::numeric), 0) into allocated
    from jsonb_array_elements(shares) e;
  remainder := round(net_profit - allocated, 2);

  if remainder <> 0 and jsonb_array_length(shares) > 0 then
    select jsonb_agg(
      case when (e->>'holder_type') = 'ceo'
        then jsonb_set(e, '{share}', to_jsonb(round((e->>'share')::numeric + remainder, 2)))
        else e end
    ) into shares
    from jsonb_array_elements(shares) e;
  end if;

  return jsonb_build_object(
    'sale_price',          p_agreed_price,
    'purchase_price',      v.purchase_price,
    'total_expenses',      total_expenses,
    'months_in_inventory', round(months_in_inventory, 2),
    'overhead_total',      overhead_total,
    'discount',            coalesce(p_discount, 0),
    'net_profit',          net_profit,
    'shares',              shares
  );
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;


-- Keep the original name working for the existing UI call site.
-- language sql, so check_function_bodies validates this body AT CREATE
-- TIME: compute_sale_waterfall must already exist in {{SCHEMA}} when this
-- runs, or the whole provisioning transaction aborts here. That ordering
-- requirement is a feature — it is also what binds this call to the tenant
-- copy rather than a leftover public one.
create or replace function preview_vehicle_sale_waterfall(
  p_vehicle_id uuid,
  p_agreed_price numeric,
  p_discount numeric default 0
) returns jsonb as $fn$
  select compute_sale_waterfall(p_vehicle_id, p_agreed_price, p_discount, now());
$fn$ language sql stable security definer set search_path = {{SCHEMA}}, extensions;



-- ── Commission ──────────────────────────────────────────────
-- commission_tiers has existed since 0001 and nothing has ever read it;
-- the 'commission' ledger type was likewise dead. Semantics implemented
-- here: tiers form a CUMULATIVE ladder keyed by the salesperson's count of
-- executed sales in the calendar month. Reaching tier N entitles them to
-- cumulative_amount(N) for the month, so a given sale pays the difference
-- between the new tier and the previous one. With the seeded ladder
-- (tier_index * 6000) that is a flat 6,000 per unit, but the table can
-- express any accelerating schedule.
--
-- DROPPED from 0004: `v_tenant := current_tenant_id()` and the four
-- `tenant_id = v_tenant` predicates (one on the unit count, three on the
-- ladder). 0004 was right that the ladder lookups had become ambiguous as
-- well as leaky — with a shared table, `where tier_index = N` could match
-- one row per showroom. commission_tiers' primary key is back to
-- (tier_index) alone, so the unqualified lookup is single-valued again.
--
-- This function has NO authorization check, in this version or any
-- previous one, and that is deliberate: its only caller is
-- execute_vehicle_sale(), which has already enforced is_manager_or_above()
-- and can_act_on_branch(). Do not read the removal of four predicates as
-- having left it unguarded, and do not add a role check that was never
-- here — that would change commission behaviour, not security.
create or replace function commission_for_sale(p_salesperson_id uuid, p_as_of timestamptz)
returns numeric as $fn$
declare
  units int;
  max_tier int;
  cur numeric;
  prev numeric;
begin
  select count(*) into units
    from deal_tickets
   where salesperson_id = p_salesperson_id
     and status = 'executed'
     and executed_at >= date_trunc('month', p_as_of)
     and executed_at <  date_trunc('month', p_as_of) + interval '1 month';

  if units = 0 then return 0; end if;

  -- With the isolation policy gone this null-check is the ONLY thing
  -- standing between an unseeded ladder and every salesperson silently
  -- earning nothing, forever. It returns 0 rather than raising, so the
  -- 10-tier seed ladder must be planted at provision time or the failure
  -- is invisible.
  select max(tier_index) into max_tier from commission_tiers;
  if max_tier is null then return 0; end if;

  select cumulative_amount into cur  from commission_tiers where tier_index = least(units, max_tier);
  select cumulative_amount into prev from commission_tiers where tier_index = least(units, max_tier) - 1;

  return greatest(coalesce(cur,0) - coalesce(prev,0), 0);
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;

-- PRIVILEGE (see §6h): revoked from PUBLIC, and granted to nobody — the
-- one function in this section whose omission from the grant list is a
-- security decision rather than a consequence.
--
-- It was never granted to `authenticated` by any migration, but PUBLIC
-- holds EXECUTE on a new function by default, and under 0004 a stray
-- direct call was still bounded by commission_tiers' RESTRICTIVE isolation
-- policy. That bound no longer exists. Do not grant it to the tenant role
-- to "make the RPC list complete": execute_vehicle_sale() runs as this
-- function's owner and reaches it that way, and a caller who can price
-- their own commission can read the whole ladder off the error surface.


-- ── Execution ───────────────────────────────────────────────
-- 0004 called this the most damaging of the four, and it was right: a
-- manager settling another showroom's approved ticket posts real,
-- irreversible ledger rows against that showroom's investors.
--
-- DROPPED from 0004: `if t.tenant_id is distinct from current_tenant_id()`,
-- and the explicit tenant_id column/value on both ledger_entries inserts
-- and the audit_log insert. The dropped guard sat BETWEEN the `if not
-- found` check and the can_act_on_branch() check — the branch check below
-- has the identical shape and must survive.
create or replace function execute_vehicle_sale(p_deal_ticket_id uuid)
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
begin
  -- ROLE check (0001). KEEP VERBATIM.
  if not is_manager_or_above() then
    raise exception 'Only a branch manager or CEO can execute a sale';
  end if;

  select * into t from deal_tickets where id = p_deal_ticket_id for update;
  if not found then
    raise exception 'Deal ticket not found';
  end if;

  -- BRANCH check (0003). KEEP VERBATIM. Missing from 0001: SECURITY
  -- DEFINER bypasses the branch filter in RLS, so without this a manager
  -- could settle any branch's ticket. Separating showrooms does nothing
  -- about branches WITHIN a showroom — this is still the only thing
  -- stopping the Alexandria manager from settling Cairo's sale.
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

  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
  values (auth.uid(), 'execute_vehicle_sale', 'deal_ticket', t.id, w || jsonb_build_object('commission', coalesce(commission,0)));

  return w || jsonb_build_object('commission', coalesce(commission, 0));
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;



-- ── Vehicle intake ──────────────────────────────────────────
-- Managers may take in stock, but the cap table stays a CEO instrument.
-- 0001 let a manager write splits through this SECURITY DEFINER function
-- even though equity_splits_write is CEO-only; 0003 closed that.
--
-- DROPPED from 0004: `v_tenant := current_tenant_id()`, the
-- 'No tenant on the acting profile' raise, `and tenant_id = v_tenant` from
-- both existence checks, and tenant_id from both inserts.
--
-- KEPT from 0004, and this is the single most easily deleted improvement
-- in the whole migration: the two exists() checks. 0004 introduced them
-- with a tenant predicate interleaved, so they LOOK like tenancy code.
-- They are not. 0003 had no existence check on either the branch id or the
-- holder id, so a bogus value surfaced as a raw foreign-key violation in
-- the UI. Only the predicate leaves. The v_holder hoist out of the insert
-- goes with them — it is what makes the investor check expressible at all.
create or replace function create_vehicle_with_equity_splits(
  p_branch_id uuid,
  p_vin text,
  p_year int,
  p_make text,
  p_model text,
  p_trim text,
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

  insert into vehicles (branch_id, vin, year, make, model, trim, purchase_price, photos, created_by)
  values (p_branch_id, nullif(p_vin,''), p_year, p_make, p_model, nullif(p_trim,''),
          p_purchase_price, coalesce(p_photos,'{}'), auth.uid())
  returning id into v_id;

  for split in select * from jsonb_array_elements(p_splits) loop
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
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;



-- ── Calendar: create_meeting() — the authority gate ──────────
-- meetings has no INSERT policy and the tenant role holds no INSERT
-- privilege on it (see the grants section), so this function is the only
-- way a meeting comes into existence. That makes the checks below the
-- entirety of the calendar's write authorisation.
--
-- DROPPED from 0006: `v_tenant := current_tenant_id()`, the
-- `or v_tenant is null` half of the not-authenticated guard,
-- `b.tenant_id = v_tenant` from the branch check, `p.tenant_id = v_tenant`
-- from the entitlement count, and tenant_id from both inserts. After the
-- predicate leaves, the branch check is a plain existence test — still a
-- real validation, do not delete it with the predicate.
create or replace function create_meeting(
  p_title      text,
  p_agenda     text,
  p_location   text,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz,
  p_branch_id  uuid,
  p_invitees   uuid[]
) returns uuid as $fn$
declare
  v_uid     uuid := auth.uid();
  v_role    text := current_role_name();
  v_branch  uuid := current_branch_id();
  v_ids     uuid[];
  v_n       int;
  v_ok      int;
  v_meeting uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  -- SECURITY DEFINER, so this is the whole of the authorisation.
  -- A sales_exec reaching the RPC directly stops here.
  if v_role not in ('ceo', 'branch_manager') then
    raise exception 'Only a branch manager or the CEO may schedule a meeting';
  end if;

  -- Inviting yourself is meaningless: the organizer always sees
  -- their own meeting. Dropping the id rather than rejecting it
  -- keeps a "select all" in the UI from failing.
  select coalesce(array_agg(distinct x), '{}'::uuid[])
    into v_ids
    from unnest(coalesce(p_invitees, '{}'::uuid[])) as x
   where x <> v_uid;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0   then raise exception 'A meeting needs at least one invitee'; end if;
  if v_n > 100 then raise exception 'A meeting may not have more than 100 invitees'; end if;

  if p_ends_at <= p_starts_at then
    raise exception 'A meeting must end after it starts';
  end if;
  if p_ends_at > p_starts_at + interval '12 hours' then
    raise exception 'A meeting may not run longer than 12 hours';
  end if;

  if v_role = 'branch_manager' then
    -- Forced, not validated: whatever branch the client asked for is
    -- irrelevant, a manager schedules into their own.
    if v_branch is null then
      raise exception 'Your account is not assigned to a branch';
    end if;
    p_branch_id := v_branch;
  elsif p_branch_id is not null then
    if not exists (
      select 1 from branches b where b.id = p_branch_id
    ) then
      raise exception 'Unknown branch';
    end if;
  end if;

  -- Count the invitees this caller is actually entitled to invite,
  -- then require that it equals the number asked for. Counting
  -- rather than looping means one unauthorised id fails the whole
  -- call, so a manager cannot slip the CEO into an otherwise valid
  -- list and have the rest go through.
  select count(*)
    into v_ok
    from profiles p
   where p.id = any(v_ids)
     and (
       v_role = 'ceo'
       or (p.role = 'sales_exec' and p.branch_id = v_branch)
     );

  if v_ok <> v_n then
    if v_role = 'branch_manager' then
      raise exception 'A branch manager may only invite sales staff from their own branch';
    else
      -- Reworded, not removed. Under 0004 this fired when an id belonged
      -- to another showroom; now `profiles` only ever holds this
      -- showroom's staff, so the only way a CEO can fail the count is an
      -- id that names no staff account at all.
      raise exception 'One or more invitees do not have a staff account here';
    end if;
  end if;

  insert into meetings (
    branch_id, organizer_id, title, agenda, location, starts_at, ends_at
  ) values (
    p_branch_id,
    v_uid,
    btrim(p_title),
    nullif(btrim(coalesce(p_agenda, '')), ''),
    nullif(btrim(coalesce(p_location, '')), ''),
    p_starts_at,
    p_ends_at
  )
  returning id into v_meeting;

  insert into meeting_invitees (meeting_id, profile_id)
  select v_meeting, x from unnest(v_ids) as x;

  return v_meeting;
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;



-- ── Calendar: calendar_meetings() — the read side ────────────
-- Returns the caller's visible meetings for a window, with the organizer's
-- and attendees' names resolved. Same visibility rule as meetings_select,
-- restated here because SECURITY DEFINER means the policy does not apply
-- to this query.
--
-- DROPPED from 0006: `v_tenant`, the `or v_tenant is null` half of the
-- early return, and `m.tenant_id = v_tenant` from the WHERE clause. The
-- three-line visibility disjunction that followed that predicate in the
-- same WHERE clause is the restated policy and stays exactly as written.
create or replace function calendar_meetings(p_from timestamptz, p_to timestamptz)
returns table (
  id             uuid,
  title          text,
  agenda         text,
  location       text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  status         text,
  branch_id      uuid,
  branch_name    text,
  organizer_id   uuid,
  organizer_name text,
  is_organizer   boolean,
  my_response    text,
  attendees      jsonb
) as $fn$
declare
  v_uid    uuid := auth.uid();
  v_role   text := current_role_name();
  v_branch uuid := current_branch_id();
begin
  if v_uid is null then
    return;
  end if;

  -- A window is required; an unbounded call would let one request
  -- pull every meeting the showroom has ever held.
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A calendar window must be a from/to pair';
  end if;
  if p_to > p_from + interval '400 days' then
    raise exception 'A calendar window may not span more than 400 days';
  end if;

  return query
  select
    m.id,
    m.title,
    m.agenda,
    m.location,
    m.starts_at,
    m.ends_at,
    m.status,
    m.branch_id,
    b.name,
    m.organizer_id,
    o.full_name,
    (m.organizer_id = v_uid),
    mine.response,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id',        p.id,
                   'full_name', p.full_name,
                   'role',      p.role,
                   'response',  mi.response
                 )
                 order by p.full_name
               )
          from meeting_invitees mi
          join profiles p on p.id = mi.profile_id
         where mi.meeting_id = m.id
      ),
      '[]'::jsonb
    )
  from meetings m
  left join branches b   on b.id = m.branch_id
  left join profiles o   on o.id = m.organizer_id
  left join meeting_invitees mine
         on mine.meeting_id = m.id and mine.profile_id = v_uid
  where m.starts_at < p_to
    and m.ends_at   > p_from
    and (
      m.organizer_id = v_uid
      or mine.profile_id is not null
      or v_role = 'ceo'
      or (v_role = 'branch_manager' and m.branch_id = v_branch)
    )
  order by m.starts_at;
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;



-- ── Calendar: calendar_invitable_people() — the picker ───────
-- Exactly the set create_meeting() will accept from this caller, so the
-- form cannot offer a choice the RPC would then reject. Returns nothing at
-- all for roles that may not schedule, which is what makes it safe to
-- expose to every signed-in user. The entitlement disjunction below must
-- stay character-for-character identical to create_meeting()'s or the two
-- drift apart silently.
--
-- DROPPED from 0006: `v_tenant`, the `or v_tenant is null` half of the
-- early return, and `p.tenant_id = v_tenant` from the WHERE clause.
create or replace function calendar_invitable_people()
returns table (id uuid, full_name text, role text, branch_id uuid) as $fn$
declare
  v_uid    uuid := auth.uid();
  v_role   text := current_role_name();
  v_branch uuid := current_branch_id();
begin
  if v_uid is null then return; end if;
  if v_role not in ('ceo', 'branch_manager') then return; end if;

  return query
  select p.id, p.full_name, p.role, p.branch_id
    from profiles p
   where p.id <> v_uid
     and (
       v_role = 'ceo'
       or (p.role = 'sales_exec' and p.branch_id = v_branch)
     )
   order by p.full_name;
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- SECTION 4 — TRIGGER FUNCTIONS AND TRIGGERS
--
-- 18 trigger functions and the 30 triggers that attach them. Every
-- body is the FINAL pre-0009 definition of that function with the
-- tenancy layer removed; nothing here is newly invented, and where a
-- line differs from its source the comment says which line and why.
--
-- WHY EVERY FUNCTION CARRIES `set search_path`, NOT JUST THE
-- SECURITY DEFINER ONES
--
-- The template's mechanism is that create_tenant_schema() runs this
-- DDL under `search_path = t_<slug>, extensions`, so references bind
-- to the tenant's objects. That is true for anything Postgres
-- resolves and stores as an OID at CREATE time — policy expressions,
-- column defaults, check constraints, and the trigger→function link
-- below. It is NOT true for a plpgsql body: the body is stored as
-- source text and re-planned at execution against whatever
-- search_path the SESSION happens to have.
--
-- So an unpinned prevent_split_edit_after_sale() firing on
-- t_alpha.vehicle_equity_splits, from a service-role session whose
-- search_path is still `public`, reads public.vehicles instead of
-- t_alpha.vehicles. It finds no row, concludes the car is not sold,
-- and lets an already-paid-out cap table be edited. That failure is
-- fail-OPEN and silent — the opposite of every other guard here.
-- Pinning is therefore a correctness control on all 18, including the
-- five that only touch NEW/OLD and cannot currently mis-resolve;
-- uniformity is also what makes the closing assertion ("no function
-- in t_<slug> has a proconfig search_path naming public") checkable
-- as a count rather than a hand-maintained exception list.
--
-- WHY THE SECURITY DEFINER ONES ARE MORE THAN A STYLE POINT
--
-- create_tenant_schema() is itself SECURITY DEFINER owned by
-- postgres, so every function it emits is owned by postgres too. The
-- eight SECURITY DEFINER functions below therefore run as a
-- superuser. Their pinned search_path is the only thing deciding
-- which schema a superuser-privileged body reads and writes.
--
-- EXCLUDED FROM THIS SECTION
--   handle_new_user() and its on_auth_user_created trigger. The
--   trigger is on auth.users, which exists once for the whole
--   deployment — creating it per tenant would silently repoint every
--   showroom's signups at whichever tenant was provisioned last.
--   Both are rewritten in 0010, which writes across schemas.
--
--   0005's three tenant-inheritance rewrites. The column they read
--   from is gone; each function below reverts to its pre-0005 body,
--   with one deliberate exception noted at record_audit().
-- ============================================================

-- ============================================================
-- 4.1 SHARED
-- ============================================================

-- 0003 §1, body unchanged. Touches only NEW, so it cannot resolve
-- into the wrong schema today; pinned anyway so the whole template
-- presents one uniform search_path and a future edit that adds a
-- table read does not silently become the hazard described above.
create or replace function set_updated_at() returns trigger as $trg$
begin
  new.updated_at := now();
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.2 IDENTITY — profiles
-- ============================================================

-- 0003 §2b, minus 0004's first branch.
--
-- 0004 added a TENANT_LOCKED conjunct pinning tenant_id alongside
-- role and branch_id. It is dropped, not relaxed: there is no
-- tenant_id column, and moving a profile between showrooms would now
-- mean moving a row between schemas, which no UPDATE can express.
--
-- The two rules that remain are ROLE checks, not tenant checks. They
-- sit in the same three-branch function 0004 edited, which makes them
-- the easiest thing in this migration to delete by association.
create or replace function guard_profile_privilege_columns() returns trigger as $trg$
begin
  -- 0003's fix for the total-compromise path: profiles_update_self had
  -- no column restriction, so `update profiles set role='ceo' where
  -- id = auth.uid()` passed both USING and WITH CHECK. Every other
  -- policy in the system trusts profiles.role.
  if (new.role is distinct from old.role or new.branch_id is distinct from old.branch_id)
     and not is_ceo() then
    raise exception 'Only the CEO can change a role or branch assignment (PRIVILEGE_LOCKED)';
  end if;

  -- Nobody may demote the last remaining CEO — that would lock the
  -- showroom out of its own administration screens permanently.
  --
  -- 0004 scoped this count with `and tenant_id = old.tenant_id`,
  -- because on a shared table an unscoped count let tenant A demote
  -- its own last CEO while the platform-wide total stayed above 1.
  -- That reasoning was right and the improvement survives here by
  -- construction: `profiles` resolves to this showroom's table, so
  -- the unqualified count IS the per-showroom count. Do not
  -- re-introduce a scoping predicate — there is nothing left to
  -- scope by, and adding one would only narrow a count that is
  -- already exactly right.
  if old.role = 'ceo' and new.role is distinct from 'ceo'
     and (select count(*) from profiles where role = 'ceo') <= 1 then
    raise exception 'Cannot remove the last CEO account (LAST_CEO)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0003 §2b. 0004's version added tenant_id to the insert; that goes,
-- the function does not. Without it, funding an investor fails on
-- vehicle_equity_splits.holder_id -> investors(id) because no
-- investors row was ever created for the profile.
--
-- `public.investors` in 0003:205 becomes an unqualified `investors`:
-- with the pinned search_path this is the tenant's table, and leaving
-- the prefix would write every showroom's investors into public.
create or replace function sync_investor_row() returns trigger as $trg$
begin
  if new.role = 'investor' then
    insert into investors (id) values (new.id) on conflict (id) do nothing;
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.3 VEHICLES AND THE CAP TABLE
-- ============================================================

-- 0003 §4, superseding 0001's INSERT-only, over-100-only check.
-- Reads vehicle_equity_splits by bare name and fires DEFERRED, at
-- COMMIT — by which point the transaction's search_path is whatever
-- the session set, not whatever the write path set. The pin is what
-- makes a deferred constraint trigger judge the right showroom's
-- cap table.
create or replace function check_equity_splits_sum() returns trigger as $trg$
declare
  v_vehicle uuid := coalesce(new.vehicle_id, old.vehicle_id);
  total numeric;
  n int;
begin
  select coalesce(sum(percentage),0), count(*) into total, n
    from vehicle_equity_splits where vehicle_id = v_vehicle;

  -- All rows removed (vehicle being deleted) — nothing to assert.
  if n = 0 then return null; end if;

  if abs(total - 100) > 0.01 then
    raise exception 'Equity splits for vehicle % must sum to 100%% (currently %)', v_vehicle, total;
  end if;
  return null;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- 0003 §4. "Immutable once sold" covers INSERT too.
create or replace function prevent_split_edit_after_sale() returns trigger as $trg$
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

-- 0003 §5. A sold vehicle must stay sold: 0001 let a manager flip it
-- back to in_stock and run the whole sale again, writing a second
-- full set of profit-share rows that no policy can reverse.
create or replace function guard_vehicle_status() returns trigger as $trg$
begin
  if old.status = 'sold' and new.status is distinct from 'sold' then
    raise exception 'A sold vehicle cannot be returned to inventory (SOLD_FINAL)';
  end if;
  if old.status = 'sold'
     and (new.purchase_price is distinct from old.purchase_price
       or new.branch_id      is distinct from old.branch_id
       or new.vin            is distinct from old.vin) then
    raise exception 'A sold vehicle''s cost basis is locked (SOLD_FINAL)';
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.4 EXPENSES
-- ============================================================

-- 0003 §5, superseding 0001's UPDATE-only version. is_ceo_override
-- permanently locks a row from non-CEO edits, so it was a privilege
-- the client should never have been able to grant itself on INSERT.
create or replace function lock_ceo_override_expense() returns trigger as $trg$
begin
  if tg_op = 'INSERT' then
    if new.is_ceo_override and not is_ceo() then
      raise exception 'Only the CEO can record a CEO-override expense (CEO_OVERRIDE)';
    end if;
    new.created_by := coalesce(new.created_by, auth.uid());
    return new;
  end if;

  if old.is_ceo_override and not is_ceo() then
    raise exception 'This expense entry was CEO-overridden and is locked from further edits (CEO_OVERRIDE)';
  end if;
  if new.is_ceo_override and not old.is_ceo_override and not is_ceo() then
    raise exception 'Only the CEO can mark an expense as a CEO override (CEO_OVERRIDE)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0003 §5. Expenses on a sold vehicle would silently change a cost
-- basis that has already been paid out.
create or replace function prevent_expense_after_sale() returns trigger as $trg$
begin
  if exists (
    select 1 from vehicles
    where id = coalesce(new.vehicle_id, old.vehicle_id) and status = 'sold'
  ) then
    raise exception 'Cannot change expenses after the vehicle has been sold';
  end if;
  return coalesce(new, old);
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.5 FINANCING
-- ============================================================

-- 0003 §6, superseding 0001's NULL-only test — contract_file_url = '-'
-- was enough to activate a partner.
create or replace function enforce_financing_partner_upload_gate() returns trigger as $trg$
begin
  if new.status = 'active' then
    if new.contract_file_url is null or new.contract_file_url !~ '^https://[^/]+/.+' then
      raise exception 'A financing partner cannot be activated without an uploaded bank contract file';
    end if;
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- 0003 §3c, superseding 0001's version, whose check was conditional on
-- the partner being non-null — so an installments deal with a NULL
-- partner slipped straight through the gate.
create or replace function enforce_financing_partner_active() returns trigger as $trg$
begin
  if new.financing_type = 'installments' then
    if new.financing_partner_id is null then
      raise exception 'An installments deal requires a financing partner';
    end if;
    if not exists (
      select 1 from financing_partners
      where id = new.financing_partner_id and status = 'active'
    ) then
      raise exception 'Selected financing partner is not active yet (bank contract not uploaded)';
    end if;
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.6 DEAL TICKETS — the approval gate
-- ============================================================

-- 0003 §3b. Nothing here is tenancy: every clause is a ROLE, BRANCH,
-- or state-machine check, and all of them stay. 0001's approval
-- trigger was BEFORE UPDATE only, so a ticket could simply be
-- INSERTed with status='approved' — skipping the three-flag checklist
-- entirely — or even 'executed'.
create or replace function guard_deal_ticket_status() returns trigger as $trg$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'submitted' then
      raise exception 'A new deal ticket must start as submitted (got %)', new.status;
    end if;
    if new.financial_check_passed or new.discount_validated or new.rate_revalidated then
      raise exception 'Review flags cannot be pre-set on a new deal ticket';
    end if;
    return new;
  end if;

  -- Only a reviewer may move the ticket or touch the review flags.
  if (new.status is distinct from old.status
      or new.financial_check_passed is distinct from old.financial_check_passed
      or new.discount_validated    is distinct from old.discount_validated
      or new.rate_revalidated      is distinct from old.rate_revalidated)
     and not is_manager_or_above() then
    raise exception 'Only a branch manager or the CEO can review a deal ticket (REVIEW_LOCKED)';
  end if;

  -- A reviewer must be scoped to the ticket's branch. The schema is
  -- the showroom boundary; this is the boundary WITHIN a showroom,
  -- and it is exactly the check RLS cannot make on behalf of a
  -- SECURITY DEFINER caller.
  if new.status is distinct from old.status and not can_act_on_branch(old.branch_id) then
    raise exception 'Not authorized to review a deal ticket for this branch';
  end if;

  -- Commercial terms freeze once the ticket leaves review.
  if old.status <> 'submitted'
     and (new.agreed_price   is distinct from old.agreed_price
       or new.discount_amount is distinct from old.discount_amount
       or new.vehicle_id      is distinct from old.vehicle_id
       or new.branch_id       is distinct from old.branch_id
       or new.salesperson_id  is distinct from old.salesperson_id) then
    raise exception 'Commercial terms are locked once a ticket has been reviewed (TERMS_LOCKED)';
  end if;

  -- Legal transitions only.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'submitted' and new.status in ('approved','rejected'))
      or (old.status = 'approved'  and new.status in ('executed','rejected'))
    ) then
      raise exception 'Illegal deal ticket transition: % -> %', old.status, new.status;
    end if;
  end if;

  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0003 §3d. Without this a salesperson could raise a ticket on
-- another branch's car and have their own manager approve it. The
-- bare `vehicles` read is resolved at execution from this function's
-- own search_path, so a stale `public` here would compare the ticket
-- against a different showroom's inventory.
create or replace function enforce_ticket_matches_vehicle() returns trigger as $trg$
declare
  v_branch uuid;
  v_status text;
begin
  select branch_id, status into v_branch, v_status from vehicles where id = new.vehicle_id;
  if not found then
    raise exception 'Vehicle not found';
  end if;
  if new.branch_id is distinct from v_branch then
    raise exception 'Deal ticket branch must match the vehicle''s branch';
  end if;
  if tg_op = 'INSERT' and v_status = 'sold' then
    raise exception 'Cannot raise a deal ticket against a vehicle that is already sold';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0003 §3e — NOT 0001's and NOT 0005's.
--
-- 0005 only added tenant_id to the contracts insert, so the revert is
-- two tokens; but it must land on 0003's body, not 0001's. 0003 added
-- the `rejected` branch that stamps reviewed_at/reviewed_by on
-- rejection. Reverting one migration too far compiles fine and
-- silently stops recording who rejected a ticket.
--
-- generate_contract_serial() is called by bare name and is created
-- earlier in this template; the contract row's mere existence is what
-- unlocks sales-exec visibility, so `do nothing` on conflict is the
-- idempotency, not an error swallow.
create or replace function handle_deal_ticket_approval() returns trigger as $trg$
declare
  v_vin text;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if not (new.financial_check_passed and new.discount_validated and new.rate_revalidated) then
      raise exception 'Cannot approve: financial check, discount validation, and rate revalidation must all pass first';
    end if;
    select vin into v_vin from vehicles where id = new.vehicle_id;
    insert into contracts (deal_ticket_id, serial, unlocked_at)
    values (new.id, generate_contract_serial(new.id, v_vin), now())
    on conflict (deal_ticket_id) do nothing;
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0001 §10. 0005's only change was tenant_id on the
-- deal_ticket_events insert, so this reverts to 0001's body exactly:
-- the INSERT-or-status-changed firing condition, actor_id from
-- auth.uid(), the from_status CASE on tg_op, and the rejection note.
--
-- No authorization check exists here and none should be added — the
-- guard is guard_deal_ticket_status(), a separate trigger on the same
-- table.
create or replace function log_deal_ticket_status_change() returns trigger as $trg$
begin
  if (tg_op = 'INSERT') or (old.status is distinct from new.status) then
    insert into deal_ticket_events (deal_ticket_id, actor_id, from_status, to_status, note)
    values (
      new.id, auth.uid(),
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      case when new.status = 'rejected' then new.rejection_reason else null end
    );
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.7 AUDIT
-- ============================================================

-- 0003 §8's insert list, with 0005's local refactor kept.
--
-- Two changes are being made in opposite directions here, and
-- conflating them is the trap:
--
--   DROPPED — 0005's `v_tenant := coalesce((v_row->>'tenant_id')::uuid,
--   current_tenant_id())` and the tenant_id column on the insert.
--   Both die with the column.
--
--   KEPT — 0005's `v_row := to_jsonb(coalesce(new, old))` in place of
--   0003's `case when tg_op = 'DELETE' then (to_jsonb(old)->>'id')...`.
--   That was never a tenancy change; it arrived in the tenancy
--   migration by coincidence. Blanket-reverting record_audit() to
--   0003's body silently discards a behaviour-preserving
--   simplification for no reason.
--
-- The audit_log this writes to is per-schema, so one showroom's trail
-- is physically unreadable from another. The capability 0004 had — one
-- query answering "what happened across all showrooms" — is gone with
-- it. That is the isolation being bought, not an oversight, but it is
-- a real loss and should be a stated decision rather than a discovery
-- made during the first incident.
create or replace function record_audit() returns trigger as $trg$
declare
  v_entity uuid;
  v_row    jsonb;
begin
  v_row    := to_jsonb(coalesce(new, old));
  v_entity := (v_row->>'id')::uuid;

  insert into audit_log (actor_id, action, entity_type, entity_id, detail, before_data, after_data)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity,
    jsonb_build_object('table', tg_table_name, 'op', tg_op),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0003 §8. The trail is append-only, even for the CEO. Worth knowing
-- when 0011 copies the flagship's rows out of public: this trigger
-- rejects UPDATE outright, so a data migration has to suspend it.
create or replace function reject_audit_mutation() returns trigger as $trg$
begin
  raise exception 'The audit log is append-only';
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.8 CALENDAR
--
-- The UPDATE policies on both tables are broad on purpose (an
-- organizer may reschedule; an invitee may answer). These two pin
-- down the columns that decide who the row belongs to, so a
-- legitimate UPDATE cannot be turned into a privilege change.
-- ============================================================

-- 0006 §2, minus the tenant_id conjunct. The message loses the word
-- "showroom" with it: the showroom is now the schema, so claiming a
-- meeting's showroom cannot be changed would be describing a column
-- that does not exist. Reworded rather than deleted — the organizer
-- and branch halves are the ones doing the work.
create or replace function guard_meeting_columns() returns trigger as $trg$
begin
  if new.organizer_id is distinct from old.organizer_id
  or new.branch_id    is distinct from old.branch_id then
    raise exception 'A meeting''s branch and organizer cannot be changed';
  end if;
  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- 0006 §2, minus the tenant_id conjunct. Both remaining halves stay:
-- without them an invitee could repoint their own row at a meeting
-- they were never invited to, because meeting_invitees_respond only
-- checks profile_id — which they are not changing.
create or replace function guard_meeting_invitee_columns() returns trigger as $trg$
begin
  if new.meeting_id is distinct from old.meeting_id
  or new.profile_id is distinct from old.profile_id then
    raise exception 'An invitation cannot be reassigned';
  end if;

  -- Stamped here rather than trusted from the client, so the
  -- attendance record reflects when the answer actually landed.
  if new.response is distinct from old.response then
    new.responded_at := now();
  else
    new.responded_at := old.responded_at;
  end if;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;

-- ============================================================
-- 4.9 TRIGGER ATTACHMENTS
--
-- Unlike the function bodies above, these bind at CREATE time:
-- pg_trigger stores tgrelid and tgfoid as OIDs, resolved from the
-- search_path in force right now. That is what makes an unqualified
-- `on deal_tickets ... execute function record_audit()` permanently
-- mean this tenant's table and this tenant's function, and it is also
-- why nothing below may run before section 4.1-4.8 and the table
-- section have.
--
-- Trigger names are scoped to their table, so t_a and t_b carry
-- identically-named triggers without collision.
--
-- The `drop trigger if exists` before each `create` is a no-op in a
-- freshly created schema. It is kept because 0012's per-schema
-- migration runner re-applies template sections to schemas that
-- already exist, and because `create constraint trigger` and
-- `create trigger` have no IF NOT EXISTS form.
-- ============================================================

-- ── profiles ────────────────────────────────────────────────
drop trigger if exists trg_guard_profile_privileges on profiles;
create trigger trg_guard_profile_privileges
  before update on profiles
  for each row execute function guard_profile_privilege_columns();

drop trigger if exists trg_sync_investor_row on profiles;
create trigger trg_sync_investor_row
  after insert or update of role on profiles
  for each row execute function sync_investor_row();

-- ── vehicles ────────────────────────────────────────────────
drop trigger if exists trg_guard_vehicle_status on vehicles;
create trigger trg_guard_vehicle_status
  before update on vehicles
  for each row execute function guard_vehicle_status();

-- ── vehicle_equity_splits ───────────────────────────────────
-- DEFERRABLE INITIALLY DEFERRED so a multi-row intake can reach 100
-- before it is judged, and so the rule then holds at COMMIT for every
-- path including direct SQL — not just the RPC.
drop trigger if exists trg_check_equity_splits on vehicle_equity_splits;
create constraint trigger trg_check_equity_splits
  after insert or update or delete on vehicle_equity_splits
  deferrable initially deferred
  for each row execute function check_equity_splits_sum();

drop trigger if exists trg_lock_splits on vehicle_equity_splits;
create trigger trg_lock_splits
  before insert or update or delete on vehicle_equity_splits
  for each row execute function prevent_split_edit_after_sale();

-- ── vehicle_expenses ────────────────────────────────────────
drop trigger if exists trg_lock_ceo_override on vehicle_expenses;
create trigger trg_lock_ceo_override
  before insert or update on vehicle_expenses
  for each row execute function lock_ceo_override_expense();

drop trigger if exists trg_expense_after_sale on vehicle_expenses;
create trigger trg_expense_after_sale
  before insert or update or delete on vehicle_expenses
  for each row execute function prevent_expense_after_sale();

-- ── financing_partners ──────────────────────────────────────
drop trigger if exists trg_financing_partner_gate on financing_partners;
create trigger trg_financing_partner_gate
  before insert or update on financing_partners
  for each row execute function enforce_financing_partner_upload_gate();

-- ── financing_requests ──────────────────────────────────────
drop trigger if exists trg_financing_requests_updated_at on financing_requests;
create trigger trg_financing_requests_updated_at
  before update on financing_requests
  for each row execute function set_updated_at();

-- ── deal_tickets ────────────────────────────────────────────
drop trigger if exists trg_guard_deal_ticket_status on deal_tickets;
create trigger trg_guard_deal_ticket_status
  before insert or update on deal_tickets
  for each row execute function guard_deal_ticket_status();

drop trigger if exists trg_ticket_matches_vehicle on deal_tickets;
create trigger trg_ticket_matches_vehicle
  before insert or update on deal_tickets
  for each row execute function enforce_ticket_matches_vehicle();

drop trigger if exists trg_deal_ticket_financing_gate on deal_tickets;
create trigger trg_deal_ticket_financing_gate
  before insert or update on deal_tickets
  for each row execute function enforce_financing_partner_active();

drop trigger if exists trg_deal_ticket_approval on deal_tickets;
create trigger trg_deal_ticket_approval
  before update on deal_tickets
  for each row execute function handle_deal_ticket_approval();

drop trigger if exists trg_log_deal_ticket on deal_tickets;
create trigger trg_log_deal_ticket
  after insert or update on deal_tickets
  for each row execute function log_deal_ticket_status_change();

-- ── audit_log ───────────────────────────────────────────────
drop trigger if exists trg_audit_immutable on audit_log;
create trigger trg_audit_immutable
  before update or delete on audit_log
  for each row execute function reject_audit_mutation();

-- ── meetings / meeting_invitees ─────────────────────────────
drop trigger if exists trg_guard_meeting_columns on meetings;
create trigger trg_guard_meeting_columns
  before update on meetings
  for each row execute function guard_meeting_columns();

drop trigger if exists trg_guard_meeting_invitee_columns on meeting_invitees;
create trigger trg_guard_meeting_invitee_columns
  before update on meeting_invitees
  for each row execute function guard_meeting_invitee_columns();

-- ============================================================
-- 4.10 THE UNIVERSAL AUDIT TRAIL — 13 tables
--
-- 0003 §8 built these with a DO loop over a text[] and
-- `execute format('... on %1$I ...')`. The loop is unrolled here
-- deliberately.
--
-- %1$I quotes an identifier but does not schema-qualify it, and
-- EXECUTE resolves against the search_path in force at that instant —
-- not the one in force when the enclosing body was compiled. Inside
-- create_tenant_schema() that means the loop works only for as long
-- as nothing between `set local search_path = t_<slug>, extensions`
-- and the nested DO block perturbs it, and a nested block carrying a
-- SET of its own would silently attach 13 audit triggers to public's
-- tables instead. Written out, each statement is parsed and bound in
-- the same context as every other CREATE TRIGGER above, and the
-- failure mode for a missing table is an error rather than a
-- mis-binding.
--
-- The list is 0003's, unchanged: 13 tables. It deliberately omits
-- lead_comments, deal_ticket_events, contracts, meetings and
-- meeting_invitees — the first three are already append-only records
-- of something else, and 0006 never added the calendar. audit_log
-- itself is excluded for the obvious reason.
-- ============================================================

drop trigger if exists trg_audit_vehicles on vehicles;
create trigger trg_audit_vehicles
  after insert or update or delete on vehicles
  for each row execute function record_audit();

drop trigger if exists trg_audit_vehicle_equity_splits on vehicle_equity_splits;
create trigger trg_audit_vehicle_equity_splits
  after insert or update or delete on vehicle_equity_splits
  for each row execute function record_audit();

drop trigger if exists trg_audit_vehicle_expenses on vehicle_expenses;
create trigger trg_audit_vehicle_expenses
  after insert or update or delete on vehicle_expenses
  for each row execute function record_audit();

drop trigger if exists trg_audit_deal_tickets on deal_tickets;
create trigger trg_audit_deal_tickets
  after insert or update or delete on deal_tickets
  for each row execute function record_audit();

drop trigger if exists trg_audit_financing_partners on financing_partners;
create trigger trg_audit_financing_partners
  after insert or update or delete on financing_partners
  for each row execute function record_audit();

drop trigger if exists trg_audit_financing_requests on financing_requests;
create trigger trg_audit_financing_requests
  after insert or update or delete on financing_requests
  for each row execute function record_audit();

drop trigger if exists trg_audit_overhead_config on overhead_config;
create trigger trg_audit_overhead_config
  after insert or update or delete on overhead_config
  for each row execute function record_audit();

drop trigger if exists trg_audit_commission_tiers on commission_tiers;
create trigger trg_audit_commission_tiers
  after insert or update or delete on commission_tiers
  for each row execute function record_audit();

drop trigger if exists trg_audit_ledger_entries on ledger_entries;
create trigger trg_audit_ledger_entries
  after insert or update or delete on ledger_entries
  for each row execute function record_audit();

drop trigger if exists trg_audit_profiles on profiles;
create trigger trg_audit_profiles
  after insert or update or delete on profiles
  for each row execute function record_audit();

drop trigger if exists trg_audit_branches on branches;
create trigger trg_audit_branches
  after insert or update or delete on branches
  for each row execute function record_audit();

drop trigger if exists trg_audit_investors on investors;
create trigger trg_audit_investors
  after insert or update or delete on investors
  for each row execute function record_audit();

drop trigger if exists trg_audit_leads on leads;
create trigger trg_audit_leads
  after insert or update or delete on leads
  for each row execute function record_audit();

-- ============================================================
-- 4.11 A NOTE FOR THE GRANTS SECTION
--
-- Not one of the 18 functions above is an RPC. Postgres grants
-- EXECUTE on every new function to PUBLIC by default, and eight of
-- these are SECURITY DEFINER owned by the superuser that ran
-- create_tenant_schema(). Under 0004 a stray direct call was still
-- bounded by the RESTRICTIVE isolation policy; that backstop is gone.
-- record_audit() in particular would let any caller forge an
-- arbitrary row into an append-only trail.
--
-- The grants section must therefore revoke EXECUTE on all functions
-- in this schema from public (and from anon/authenticated), and must
-- grant EXECUTE to felix_<slug> on the app-facing RPCs ONLY — none of
-- which are in this section. A trigger function needs no EXECUTE
-- grant to fire: the trigger runs it regardless of the caller's
-- privileges on it.
-- ============================================================
-- ============================================================
-- 5. ROW LEVEL SECURITY — ENABLEMENT AND POLICIES
--
-- RLS stays ON inside every tenant schema. The schema boundary answers
-- "whose showroom is this?"; these policies answer "who inside the
-- showroom may see or touch this row?". They are two different
-- questions, and 0004's mistake would be to assume the first one
-- subsumes the second. A branch manager must still not read another
-- branch's cap table, and a sales exec must still not rewrite the
-- commission ladder — none of that is tenancy, and none of it is
-- delivered by putting the tables in a separate schema.
--
-- WHAT IS ABSENT, DELIBERATELY
-- ----------------------------
-- No <table>_tenant_isolation policy appears below. 0004 created 18 of
-- them (plus 2 more in 0006) as RESTRICTIVE conjuncts on tenant_id.
-- There is no tenant_id column here, and the predicate they enforced is
-- now enforced by the fact that felix_<slug> holds no privilege on any
-- other showroom's schema. A stray *_tenant_isolation policy in this
-- file would be a signal that a tenant_id column survived section 1.
--
-- WHY NO `TO <role>` CLAUSE ON ANY POLICY
-- ---------------------------------------
-- Every one of the ~66 policies in 0001 §17, 0003 §10 and 0006 §3 is
-- written `to authenticated`. Carried over verbatim that is not a style
-- wart, it is inert: under this design a session SET ROLEs into
-- felix_<slug>, which 0008 §4 creates NOINHERIT and never makes a member
-- of `authenticated`. A policy naming a role the session does not hold
-- simply does not apply — and with RLS enabled and no applicable
-- permissive policy, every table returns zero rows for every user in
-- every showroom. Worse, the failure is silent: no error, no warning,
-- just an empty app.
--
-- The TO clause is therefore dropped entirely rather than re-pointed at
-- an interpolated felix_<slug>. The reason is naming, not safety: a
-- policy with no TO clause cannot desynchronise from
-- platform.create_tenant_role()'s naming, so 'felix_' || slug is spelled
-- out in one fewer place.
--
-- BE CLEAR ABOUT THE TRADE, because an earlier draft of this comment had
-- it exactly backwards and a future reviewer will trust what is written
-- here when deciding whether to add a role:
--
--   Omitting TO is the WIDER choice, not the more conservative one.
--   No TO clause means TO PUBLIC — the policy applies to every role,
--   including one that unexpectedly acquires privileges here, and is
--   then EVALUATED for it. Naming the role would mean an unexpected role
--   matches no permissive policy at all and reads zero rows, which is
--   the genuinely fail-closed outcome.
--
-- Omission is safe here only because of a property that must hold for
-- every policy below: each predicate is auth-dependent, so for a role
-- with no session it resolves through auth.uid() = NULL to false. That
-- makes 44 of the 45 deny by evaluation rather than by inapplicability.
-- The 45th — branches_select — was `using (true)`, which no amount of
-- missing session makes false; it is tightened below for exactly this
-- reason. If a future policy is written unconditionally, it MUST carry
-- an explicit TO {{ROLE}} or this whole argument stops holding.
--
-- The roles that must not be filtered are unaffected either way: RLS
-- never applies to the table owner (these objects are owned by
-- create_tenant_schema()'s definer) or to BYPASSRLS roles such as
-- service_role.
--
-- ORDERING
-- --------
-- This section MUST run after the tables and after every helper it
-- names. Postgres stores a policy expression's function and table
-- references as OIDs in pg_policy at CREATE POLICY time, resolved
-- against the search_path then in force. That is exactly what binds
-- these policies permanently to t_<slug>.is_ceo(), t_<slug>.vehicles
-- and so on. It is also why `public` must not be on the search_path:
-- with only t_<slug>, extensions, a missing or mis-ordered object
-- raises here and now, loudly.
-- ============================================================

-- ------------------------------------------------------------
-- 5a. Enable RLS on all 19 tenant tables.
--
-- 19, not 20: 0007_notification_contacts.sql creates no table. It adds
-- notification_email and whatsapp_number as COLUMNS on profiles, which
-- section 1 folds into the profiles definition. staff_invitations and
-- rate_limit_buckets, the other two tables 0001/0003 enabled RLS on,
-- now live in `platform` (0008 §3) and are not ours.
-- ------------------------------------------------------------
alter table branches               enable row level security;
alter table profiles               enable row level security;
alter table investors              enable row level security;
alter table vehicles               enable row level security;
alter table vehicle_equity_splits  enable row level security;
alter table vehicle_expenses       enable row level security;
alter table overhead_config        enable row level security;
alter table leads                  enable row level security;
alter table lead_comments          enable row level security;
alter table financing_partners     enable row level security;
alter table deal_tickets           enable row level security;
alter table deal_ticket_events     enable row level security;
alter table financing_requests     enable row level security;
alter table contracts              enable row level security;
alter table commission_tiers       enable row level security;
alter table ledger_entries         enable row level security;
alter table audit_log              enable row level security;
alter table meetings               enable row level security;
alter table meeting_invitees       enable row level security;

-- ------------------------------------------------------------
-- 5b. BRANCHES — 0001 §17
--
-- Every signed-in member of the showroom needs the branch list to read
-- any record that names a branch; only the CEO opens or closes one.
--
-- This was `using (true)`, and it is the one policy in the section that
-- the no-TO-clause argument above does NOT cover. Without a TO clause a
-- policy applies TO PUBLIC, and an unconditional predicate stays true for
-- a role with no session — so any role that ever obtained USAGE on this
-- schema plus SELECT on branches would read the branch list of a
-- showroom it has no account in. The blanket revokes in §6a are what stop
-- that today; this predicate is the second lock, so neither one alone is
-- load-bearing.
--
-- `current_role_name() is not null` is true for exactly the members of
-- THIS showroom — the function reads profiles for auth.uid() within this
-- schema — and false for any sessionless or foreign role. That is what
-- `using (true)` was always intended to mean.
-- ------------------------------------------------------------
drop policy if exists "branches_select" on branches;
create policy "branches_select" on branches for select
  using (current_role_name() is not null);

drop policy if exists "branches_write" on branches;
create policy "branches_write" on branches for all
  using (is_ceo()) with check (is_ceo());

-- ------------------------------------------------------------
-- 5c. PROFILES — select/insert/delete from 0003 §10, update from 0001 §17
--
-- 0003 replaced 0001's profiles_select because the original let any
-- manager or accountant read every profile in the company; the branch
-- predicate confines a manager to their own staff (plus unassigned
-- accounts, which are the ones they are about to place).
--
-- profiles_update_self is 0001's and survives untouched: 0003 did not
-- narrow the policy, it added guard_profile_privilege_columns() as a
-- trigger instead, because a policy cannot express "you may edit this
-- row but not these three columns of it". That trigger (section 4) is
-- what stops `update profiles set role = 'ceo' where id = auth.uid()`.
-- ------------------------------------------------------------
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using (
    id = auth.uid()
    or is_ceo()
    or is_accountant_or_above()
    or (is_manager_or_above() and (branch_id = current_branch_id() or branch_id is null))
  );

drop policy if exists "profiles_insert" on profiles;
create policy "profiles_insert" on profiles for insert
  with check (is_ceo());

drop policy if exists "profiles_update_self" on profiles;
create policy "profiles_update_self" on profiles for update
  using (id = auth.uid() or is_ceo()) with check (id = auth.uid() or is_ceo());

drop policy if exists "profiles_delete" on profiles;
create policy "profiles_delete" on profiles for delete
  using (is_ceo() and id <> auth.uid());

-- ------------------------------------------------------------
-- 5d. INVESTORS — select from 0003 §10, write from 0001 §17
--
-- 0003 widened the read to managers: they run vehicle intake, and
-- create_vehicle_with_equity_splits() makes them pick a holder from a
-- list they could not previously see.
-- ------------------------------------------------------------
drop policy if exists "investors_select" on investors;
create policy "investors_select" on investors for select
  using (id = auth.uid() or is_ceo() or is_accountant_or_above() or is_manager_or_above());

drop policy if exists "investors_write" on investors;
create policy "investors_write" on investors for all
  using (is_ceo()) with check (is_ceo());

-- ------------------------------------------------------------
-- 5e. VEHICLES — select from 0003 §10, the rest from 0001 §17
--
-- 0003 replaced 0001's vehicles_select for two reasons: accountants own
-- the cost base org-wide and had no read path, and the equity check had
-- to move out of an inline subquery. Written as
-- `exists (select 1 from vehicle_equity_splits ...)` it cross-references
-- equity_splits_select, which reads vehicles — Postgres expands policy
-- subqueries at PLAN time, detects the cycle, and every query against
-- either table fails with "infinite recursion detected in policy". The
-- OR short-circuit does not save it. holds_equity_in_vehicle() is
-- SECURITY DEFINER precisely so the read happens without policy
-- expansion. It must already exist when this statement runs.
-- ------------------------------------------------------------
drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
  );

drop policy if exists "vehicles_insert" on vehicles;
create policy "vehicles_insert" on vehicles for insert
  with check (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));

drop policy if exists "vehicles_update" on vehicles;
create policy "vehicles_update" on vehicles for update
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()));

drop policy if exists "vehicles_delete" on vehicles;
create policy "vehicles_delete" on vehicles for delete using (is_ceo());

-- ------------------------------------------------------------
-- 5f. VEHICLE EQUITY SPLITS — select from 0003 §10, write from 0001 §17
--
-- The other half of the recursion fix: vehicle_branch() rather than a
-- subquery on vehicles. 0003 also narrowed the manager's read from
-- "every branch's confidential funding structure" to their own.
-- ------------------------------------------------------------
drop policy if exists "equity_splits_select" on vehicle_equity_splits;
create policy "equity_splits_select" on vehicle_equity_splits for select
  using (
    is_ceo()
    or is_accountant_or_above()
    or holder_id = auth.uid()
    or (is_manager_or_above()
        and vehicle_branch(vehicle_equity_splits.vehicle_id) = current_branch_id())
  );

drop policy if exists "equity_splits_write" on vehicle_equity_splits;
create policy "equity_splits_write" on vehicle_equity_splits for all
  using (is_ceo()) with check (is_ceo());

-- ------------------------------------------------------------
-- 5g. VEHICLE EXPENSES — select/insert/update from 0003 §10, delete from 0001 §17
--
-- 0001 gated these on role alone, so any manager could book costs
-- against any branch's car. 0003 scoped every verb to the vehicle's
-- own branch via can_read_branch()/can_act_on_branch(). Deletion stayed
-- CEO-only from the start — an expense is corrected, not erased.
-- ------------------------------------------------------------
drop policy if exists "vehicle_expenses_select" on vehicle_expenses;
create policy "vehicle_expenses_select" on vehicle_expenses for select
  using (exists (
    select 1 from vehicles v where v.id = vehicle_expenses.vehicle_id and can_read_branch(v.branch_id)));

drop policy if exists "vehicle_expenses_insert" on vehicle_expenses;
create policy "vehicle_expenses_insert" on vehicle_expenses for insert
  with check (
    (is_accountant_or_above() or is_manager_or_above())
    and exists (select 1 from vehicles v where v.id = vehicle_id and can_act_on_branch(v.branch_id)));

drop policy if exists "vehicle_expenses_update" on vehicle_expenses;
create policy "vehicle_expenses_update" on vehicle_expenses for update
  using (
    (is_accountant_or_above() or is_manager_or_above())
    and exists (select 1 from vehicles v where v.id = vehicle_expenses.vehicle_id and can_act_on_branch(v.branch_id)));

drop policy if exists "vehicle_expenses_delete" on vehicle_expenses;
create policy "vehicle_expenses_delete" on vehicle_expenses for delete using (is_ceo());

-- ------------------------------------------------------------
-- 5h. OVERHEAD CONFIG — 0001 §17
--
-- Monthly opex feeds straight into compute_sale_waterfall()'s net
-- profit, so it decides what every investor is paid. Read by anyone who
-- has to explain a waterfall; written only by the CEO.
-- ------------------------------------------------------------
drop policy if exists "overhead_config_select" on overhead_config;
create policy "overhead_config_select" on overhead_config for select
  using (is_manager_or_above() or is_accountant_or_above());

drop policy if exists "overhead_config_write" on overhead_config;
create policy "overhead_config_write" on overhead_config for all
  using (is_ceo()) with check (is_ceo());

-- ------------------------------------------------------------
-- 5i. LEADS — 0001 §17, all four untouched by 0003
--
-- A sales exec owns their own pipeline, a manager owns their branch's,
-- the CEO sees everything. Deletion is manager+ because a lead deleted
-- by its owner is the easy way to hide a mishandled customer.
-- ------------------------------------------------------------
drop policy if exists "leads_select" on leads;
create policy "leads_select" on leads for select
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()) or salesperson_id = auth.uid());

drop policy if exists "leads_insert" on leads;
create policy "leads_insert" on leads for insert
  with check (is_staff() and (salesperson_id = auth.uid() or is_manager_or_above()));

drop policy if exists "leads_update" on leads;
create policy "leads_update" on leads for update
  using (is_ceo() or (is_manager_or_above() and branch_id = current_branch_id()) or salesperson_id = auth.uid());

drop policy if exists "leads_delete" on leads;
create policy "leads_delete" on leads for delete using (is_manager_or_above());

-- ------------------------------------------------------------
-- 5j. LEAD COMMENTS — select from 0001 §17, insert from 0003 §10
--
-- 0001's insert checked only is_staff(), so any staff member could
-- write a comment onto any lead and sign it as anybody. 0003 pinned
-- authorship to auth.uid() and made the insert mirror the parent lead's
-- own visibility rule.
-- ------------------------------------------------------------
drop policy if exists "lead_comments_select" on lead_comments;
create policy "lead_comments_select" on lead_comments for select
  using (exists (
    select 1 from leads l where l.id = lead_comments.lead_id
    and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id()) or l.salesperson_id = auth.uid())
  ));

drop policy if exists "lead_comments_insert" on lead_comments;
create policy "lead_comments_insert" on lead_comments for insert
  with check (
    is_staff()
    and author_id = auth.uid()
    and exists (
      select 1 from leads l where l.id = lead_id
      and (is_ceo() or (is_manager_or_above() and l.branch_id = current_branch_id())
           or l.salesperson_id = auth.uid())));

-- ------------------------------------------------------------
-- 5k. FINANCING PARTNERS — 0001 §17
--
-- Every salesperson needs the partner list to raise a ticket; only the
-- accountant and CEO decide who the showroom deals with and on what
-- terms.
-- ------------------------------------------------------------
drop policy if exists "financing_partners_select" on financing_partners;
create policy "financing_partners_select" on financing_partners for select using (is_staff());

drop policy if exists "financing_partners_write" on financing_partners;
create policy "financing_partners_write" on financing_partners for all
  using (is_accountant_or_above()) with check (is_accountant_or_above());

-- ------------------------------------------------------------
-- 5l. DEAL TICKETS — select/insert from 0003 §10, update from 0001 §17
--
-- 0003 replaced the select because the accountant's own navigation
-- points at /deals and 0001 gave them no read path, so the page was
-- permanently empty. It replaced the insert to add `status = 'submitted'`
-- — a ticket must start life submitted and advance only through
-- guard_deal_ticket_status(); without the conjunct a salesperson could
-- INSERT one already marked approved and skip the entire gate.
--
-- deal_tickets_update is 0001's and stands: the salesperson keeps write
-- access only while the ticket is still 'submitted'.
-- ------------------------------------------------------------
drop policy if exists "deal_tickets_select" on deal_tickets;
create policy "deal_tickets_select" on deal_tickets for select
  using (
    is_ceo()
    or is_accountant_or_above()
    or (is_manager_or_above() and branch_id = current_branch_id())
    or salesperson_id = auth.uid()
  );

drop policy if exists "deal_tickets_insert" on deal_tickets;
create policy "deal_tickets_insert" on deal_tickets for insert
  with check (
    is_staff()
    and (salesperson_id = auth.uid() or is_manager_or_above())
    and status = 'submitted'
  );

drop policy if exists "deal_tickets_update" on deal_tickets;
create policy "deal_tickets_update" on deal_tickets for update
  using (
    is_ceo()
    or (is_manager_or_above() and branch_id = current_branch_id())
    or (salesperson_id = auth.uid() and status = 'submitted')
  );

-- ------------------------------------------------------------
-- 5m. DEAL TICKET EVENTS — 0003 §10
--
-- Read-only status history. The absence of an INSERT policy is the
-- point: rows arrive only from log_deal_ticket_status_change(), so the
-- trail cannot be authored by hand. Visibility follows the parent
-- ticket, with 0003's accountant clause added.
-- ------------------------------------------------------------
drop policy if exists "deal_ticket_events_select" on deal_ticket_events;
create policy "deal_ticket_events_select" on deal_ticket_events for select
  using (exists (
    select 1 from deal_tickets t where t.id = deal_ticket_events.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

-- ------------------------------------------------------------
-- 5n. FINANCING REQUESTS — all three from 0003 §10
--
-- 0001 let any staff member INSERT a request against any ticket and any
-- manager or accountant UPDATE any request in the company. 0003 tied
-- both to the parent ticket's branch through can_act_on_branch().
-- ------------------------------------------------------------
drop policy if exists "financing_requests_select" on financing_requests;
create policy "financing_requests_select" on financing_requests for select
  using (exists (
    select 1 from deal_tickets t where t.id = financing_requests.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

drop policy if exists "financing_requests_insert" on financing_requests;
create policy "financing_requests_insert" on financing_requests for insert
  with check (exists (
    select 1 from deal_tickets t where t.id = deal_ticket_id
    and (is_staff() and (t.salesperson_id = auth.uid() or can_act_on_branch(t.branch_id)))));

drop policy if exists "financing_requests_update" on financing_requests;
create policy "financing_requests_update" on financing_requests for update
  using (
    (is_accountant_or_above() or is_manager_or_above())
    and exists (select 1 from deal_tickets t
                 where t.id = financing_requests.deal_ticket_id and can_act_on_branch(t.branch_id)));

-- ------------------------------------------------------------
-- 5o. CONTRACTS — 0003 §10
--
-- The row's mere existence is the unlock: handle_deal_ticket_approval()
-- mints it at approval and nothing else ever writes here, which is why
-- there is no INSERT, UPDATE or DELETE policy. 0003 added the
-- accountant to the read.
-- ------------------------------------------------------------
drop policy if exists "contracts_select" on contracts;
create policy "contracts_select" on contracts for select
  using (exists (
    select 1 from deal_tickets t where t.id = contracts.deal_ticket_id
    and (is_ceo() or is_accountant_or_above()
         or (is_manager_or_above() and t.branch_id = current_branch_id())
         or t.salesperson_id = auth.uid())));

-- ------------------------------------------------------------
-- 5p. COMMISSION TIERS — select from 0001 §17, write from 0003 §10
--
-- Staff read their own ladder. 0003 narrowed the write from
-- is_manager_or_above() to is_ceo(): the schedule is org-wide, and a
-- branch manager could previously rewrite every salesperson's pay in
-- every branch. Inside a tenant schema "org-wide" now means "this
-- showroom", which is what the rule always intended.
-- ------------------------------------------------------------
drop policy if exists "commission_tiers_select" on commission_tiers;
create policy "commission_tiers_select" on commission_tiers for select using (is_staff());

drop policy if exists "commission_tiers_write" on commission_tiers;
create policy "commission_tiers_write" on commission_tiers for all
  using (is_ceo()) with check (is_ceo());

-- ------------------------------------------------------------
-- 5q. LEDGER ENTRIES — select from 0003 §10, insert from 0001 §17
--
-- 0003 gave the accountant a read: 0001 let them INSERT rows they could
-- never see afterwards. The insert's `type <> 'sale_profit_share'` is
-- load-bearing — profit-share rows are real, irreversible money and are
-- only ever posted by execute_vehicle_sale(), which runs SECURITY
-- DEFINER and so is not subject to this check.
-- ------------------------------------------------------------
drop policy if exists "ledger_entries_select" on ledger_entries;
create policy "ledger_entries_select" on ledger_entries for select
  using (
    is_ceo()
    or is_accountant_or_above()
    or (holder_type = 'investor'   and holder_id = auth.uid())
    or (holder_type = 'sales_exec' and holder_id = auth.uid())
  );

drop policy if exists "ledger_entries_insert" on ledger_entries;
create policy "ledger_entries_insert" on ledger_entries for insert
  with check (is_accountant_or_above() and type <> 'sale_profit_share');

-- ------------------------------------------------------------
-- 5r. AUDIT LOG — 0003 §10
--
-- 0001 let investors read the whole log. Once 0003's record_audit()
-- began capturing every mutation on 13 tables, that became an unscoped
-- window onto the entire company's books, so the investor clause went.
-- No write policy at any verb: rows come from the trigger, and
-- reject_audit_mutation() refuses UPDATE and DELETE outright.
-- ------------------------------------------------------------
drop policy if exists "audit_log_select" on audit_log;
create policy "audit_log_select" on audit_log for select
  using (is_ceo() or is_accountant_or_above());

-- ------------------------------------------------------------
-- 5s. MEETINGS and MEETING INVITEES — 0006 §3
--
-- Note what is absent, and that it is absent on purpose: neither table
-- has an INSERT policy, so the only write path is create_meeting();
-- and neither has a DELETE policy, because a meeting is cancelled,
-- never erased, so the people who rearranged their day around it can
-- still see what happened to it.
--
-- An accountant and an investor are org-wide for money, not for
-- diaries, so they fall through to "only my own invitations" —
-- deliberately narrower than can_read_branch().
--
-- 0006's two *_tenant_isolation policies are NOT reproduced here.
-- ------------------------------------------------------------
drop policy if exists "meetings_select" on meetings;
create policy "meetings_select" on meetings for select
  using (
    organizer_id = auth.uid()
    or exists (
      select 1 from meeting_invitees mi
      where mi.meeting_id = meetings.id and mi.profile_id = auth.uid()
    )
    or is_ceo()
    or (current_role_name() = 'branch_manager' and branch_id = current_branch_id())
  );

drop policy if exists "meetings_update" on meetings;
create policy "meetings_update" on meetings for update
  using (organizer_id = auth.uid() or is_ceo())
  with check (organizer_id = auth.uid() or is_ceo());

-- Attendee lists are visible to whoever can see the meeting itself.
drop policy if exists "meeting_invitees_select" on meeting_invitees;
create policy "meeting_invitees_select" on meeting_invitees for select
  using (
    profile_id = auth.uid()
    or exists (
      select 1 from meetings m
      where m.id = meeting_invitees.meeting_id
        and (
          m.organizer_id = auth.uid()
          or is_ceo()
          or (current_role_name() = 'branch_manager' and m.branch_id = current_branch_id())
        )
    )
  );

-- Answering an invitation is the one write a salesperson gets. The
-- policy checks only profile_id, which is why
-- guard_meeting_invitee_columns() must also pin meeting_id and
-- profile_id — otherwise an invitee could repoint their own row at a
-- meeting they were never invited to.
drop policy if exists "meeting_invitees_respond" on meeting_invitees;
create policy "meeting_invitees_respond" on meeting_invitees for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ============================================================
-- END OF SECTION 5. 45 policies over 19 tables:
--   21 inherited unchanged from 0001 §17
--   20 from 0003 §10 — see the OUTSTANDING note below about its 21st
--    4 from 0006 §3
--
-- OUTSTANDING — staff_invitations_ceo, owed by 0010. DO NOT LOSE THIS.
-- --------------------------------------------------------------------
-- 0003 §10 created:
--     create policy staff_invitations_ceo on staff_invitations
--       for all to authenticated using (is_ceo()) with check (is_ceo());
-- That policy is the WRITE GATE ON PRIVILEGE ASSIGNMENT. handle_new_user()
-- reads the invitation row to decide a new account's role, branch and
-- tenant, so whoever can insert an invitation can mint a CEO.
--
-- src/app/[locale]/(app)/employees/actions.ts:57 deliberately inserts
-- through the CEO's OWN session precisely so this policy applies — its
-- comment states that the service role plays no part in deciding what the
-- new account becomes.
--
-- The table moved to platform.staff_invitations (0008 §3), which has no
-- RLS and no policies, and 0008 §6 leaves `authenticated` and every
-- felix_<slug> role with zero privilege on schema platform. So once 0011
-- drops public.staff_invitations, the CEO's session cannot write an
-- invitation at all: the flow must move to a service-role RPC, and at
-- that moment the only surviving is_ceo() check is authorize(["ceo"]) in
-- TypeScript. That is a demotion from database-enforced to
-- application-enforced, and it must not happen silently.
--
-- 0010 MUST therefore either:
--   (a) enable RLS on platform.staff_invitations with an equivalent
--       policy, or
--   (b) make its invitation RPC SECURITY DEFINER, resolve the caller's
--       tenant from platform.tenant_users, and re-check
--       t_<slug>.is_ceo() server-side before inserting.
-- It must also restore the `invited_by uuid` column 0003 defined and
-- employees/actions.ts:62 still writes — the only record of who invited
-- whom.
-- 18 of 0001's 39 policies were dropped and recreated by 0003 under the
-- same name; only 0003's version of each is emitted above.
-- ============================================================
-- ============================================================
-- 6. GRANTS AND LOCKDOWN
--
-- Where physical separation actually becomes isolation. Everything
-- above this point merely put a showroom's tables in their own schema;
-- separate tables are not a boundary until the privilege list says so.
--
-- THE ROLE STARTS WITH NOTHING
-- ----------------------------
-- felix_<slug> is created NOLOGIN NOINHERIT (0008 §4) and is a member of
-- no group. It therefore holds no privilege from any source except the
-- statements below — not from `authenticated`, not from `authenticator`
-- (which is granted felix_<slug>, not the other way round), not from
-- Supabase's blanket grants on `public`. Read this section as the
-- complete and exhaustive answer to "what can a signed-in user of this
-- showroom do?", because it is.
--
-- WHY RLS STAYS ENABLED ON EVERY TABLE
-- ------------------------------------
-- The grant and the policy answer different questions. The grant decides
-- which VERBS exist for this showroom's role — and, because no other
-- showroom's role is named here, which showroom's rows are reachable at
-- all. The policy decides which ROWS within that showroom a given person
-- sees: a sales exec still sees only their own leads, a branch manager
-- only their own branch. Dropping RLS would collapse a five-role
-- authorization model into "everyone in the showroom sees everything".
--
-- WHY THE VERBS ARE PER-TABLE
-- ---------------------------
-- Each grant below was derived by reading what the application actually
-- does, not by copying the RLS policies. Those disagree in several
-- places: 0001 wrote `for all` policies on tables no screen has ever
-- written to. Where a policy permits a verb that no code path uses, the
-- verb is withheld here. That is 0006 §3's model — it granted only
-- select+update on the calendar tables and revoked insert precisely to
-- state out loud that create_meeting() is the only write path — applied
-- to all 19 tables instead of 2.
--
-- The consequence is worth stating plainly: those unused write policies
-- become unreachable. `vehicles_delete`, `leads_delete`,
-- `profiles_delete`, `commission_tiers_write`, `ledger_entries_insert`
-- and friends still exist and still say what they say, but with no
-- matching GRANT they can never be evaluated. The day a screen needs
-- one, the fix is one line here — and the reviewer of that line gets to
-- ask whether the money table really should be writable from a browser.
--
-- WHY THE FUNCTION REVOKE IS THE MOST IMPORTANT STATEMENT HERE
-- -----------------------------------------------------------
-- Postgres grants EXECUTE on every new function to PUBLIC by default.
-- create_tenant_schema() creates ~40 functions per showroom, ~20 of them
-- SECURITY DEFINER and owned by the superuser that owns
-- create_tenant_schema itself — so each one runs with that owner's
-- rights. Several were never meant to be callable over HTTP at all:
-- commission_for_sale() computes pay, record_audit() writes the audit
-- trail, the guard_* functions ARE the authorization checks. Under
-- 0004 a stray direct call was still bounded by the RESTRICTIVE
-- tenant-isolation policy; that backstop no longer exists. 0004 §8
-- already knew this — `revoke all on function provision_tenant(...)
-- from public` — and this section generalises that one line.
-- ============================================================

-- ------------------------------------------------------------
-- 6a. SCHEMA REACHABILITY
--
-- USAGE on the schema is the outer door. Without it every object
-- privilege below is unreachable, which is why the revoke of USAGE from
-- anon/authenticated is load-bearing rather than decorative: it means a
-- session that falls back to `authenticated` (a missing role claim, a
-- GoTrue change, a bug in 0010's hook) sees nothing at all rather than
-- seeing the wrong showroom. Fail-closed by construction.
-- ------------------------------------------------------------
revoke all on schema {{SCHEMA}} from public, anon, authenticated;

-- The object-level counterparts, mirroring 0008 §6 statement for
-- statement. These are NOT redundant with §6i's ALTER DEFAULT PRIVILEGES,
-- and assuming they were is a real hole:
--
-- `alter default privileges ... revoke all on tables from anon` writes NO
-- pg_default_acl row, because Postgres's built-in default for tables
-- already grants those roles nothing — the resulting ACL equals
-- acldefault(), so the catalogue stores nothing and `\ddp` shows an empty
-- list for this schema. Privilege lookup then falls back to the
-- schema-UNQUALIFIED default-privileges entry for the creating role,
-- which on a stock Supabase database is exactly
-- `ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated,
-- service_role`. On such a deployment every table created inside this
-- schema is born readable by anon. Only the FUNCTIONS revoke persists a
-- row, because there the built-in default does grant EXECUTE to PUBLIC.
--
-- So the explicit revokes below are what actually strip the privilege,
-- and §6j check (2) is the assertion that they worked.
revoke all on all tables    in schema {{SCHEMA}} from public, anon, authenticated;
revoke all on all sequences in schema {{SCHEMA}} from public, anon, authenticated;

-- CREATE is not granted to PUBLIC on a new schema, so this changes
-- nothing today. It is here so that a future `grant all on schema` typed
-- by someone in a hurry does not silently hand out object creation, and
-- because 0008 §6 makes the same statement about `platform` for the same
-- reason.
revoke create on schema {{SCHEMA}} from public;

grant usage on schema {{SCHEMA}} to {{ROLE}};

-- Two GLOBAL schemas the tenant role cannot do without. `authenticated`
-- holds USAGE on both by Supabase default; felix_<slug> is NOINHERIT and
-- a member of nothing, so it inherits neither and must be named.
--
--   auth        — auth.uid() appears in ~30 policy expressions across
--                 0001 §17, 0003 §10 and 0006 §3. A policy qual is
--                 evaluated with the querying role's privileges, so
--                 without USAGE here every single policy on every single
--                 table fails with "permission denied for schema auth".
--                 USAGE on the schema is not access to auth.users: no
--                 table privilege on that table is granted anywhere.
--   extensions  — `default gen_random_uuid()` on 13 tables. On PG13+ the
--                 bare name resolves to the pg_catalog built-in, because
--                 pg_catalog is searched implicitly first; but 0003 §0
--                 deliberately relocates pgcrypto into `extensions`, and
--                 a column default is bound by OID at CREATE TABLE time.
--                 If that binding landed on extensions.gen_random_uuid()
--                 then every INSERT by this role fails. Cheap insurance
--                 against a difference between the managed and on-prem
--                 Postgres builds.
grant usage on schema auth       to {{ROLE}};
grant usage on schema extensions to {{ROLE}};

-- ------------------------------------------------------------
-- 6b. TABLE PRIVILEGES — READ ONLY
--
-- Nine tables the application only ever reads. Every one of them IS
-- written — but always by a SECURITY DEFINER function or a trigger,
-- which runs as its owner and therefore needs no privilege from the
-- calling role. Withholding the write verb here is what makes those
-- functions the *only* write path rather than merely the intended one.
-- ------------------------------------------------------------

-- Read at employees/actions.ts:45 and :154 (resolve a branch id before
-- an invitation names it), accountant/page.tsx:26, calendar/page.tsx:44,
-- inventory/page.tsx:20, print/contracts/[ticketId]/page.tsx:59 and
-- api/health/route.ts:33. Branches are planted at provisioning; no
-- screen creates, renames or removes one.
grant select on branches to {{ROLE}};

-- Read for the equity-holder picker (inventory/actions.ts:119),
-- ceo/page.tsx:33 and print/reports/[kind]/page.tsx:243. Rows appear
-- only via sync_investor_row() and handle_new_user(), both SECURITY
-- DEFINER — an investor record is a consequence of a role, never a
-- thing anyone creates directly.
grant select on investors to {{ROLE}};

-- Every write to a vehicle goes through create_vehicle_with_equity_splits()
-- or execute_vehicle_sale(). Both are SECURITY DEFINER and both carry
-- authorization checks the table's own policies cannot express — the
-- splits must sum to 100%, only the CEO may allocate investor equity, a
-- sold car's cost basis is frozen. A direct UPDATE privilege would let a
-- crafted PATCH set status='sold' with no ledger row behind it.
grant select on vehicles to {{ROLE}};

-- The cap table. Written only inside create_vehicle_with_equity_splits(),
-- and frozen after sale by prevent_split_edit_after_sale(). Read at
-- inventory/[vehicleId]/page.tsx:35, deals/[ticketId]/page.tsx:34,
-- investor/page.tsx:21 and print/reports/[kind]/page.tsx:244.
grant select on vehicle_equity_splits to {{ROLE}};

-- Written only by log_deal_ticket_status_change(). Consistent with 0001,
-- which gave this table a SELECT policy and deliberately no INSERT
-- policy: a status history nobody can forge is the point of it.
grant select on deal_ticket_events to {{ROLE}};

-- Minted by handle_deal_ticket_approval() when the three-flag checklist
-- passes. The mere EXISTENCE of the row is what unlocks the contract for
-- the sales exec, so an INSERT privilege here would let a salesperson
-- unlock their own contract without ever being approved.
grant select on contracts to {{ROLE}};

-- The commission ladder, planted at provisioning. No screen reads or
-- writes it today; commission_for_sale() reads it as the definer.
-- SELECT is granted because commission_tiers_select already admits
-- is_staff() and a "what do I earn at the next tier" screen is the
-- obvious next feature; the write verb stays out, because editing the
-- ladder retroactively repays every sale in the current month.
grant select on commission_tiers to {{ROLE}};

-- Money. Read at api/export/ledger/route.ts:24, ceo/page.tsx:31-32,
-- investor/page.tsx:22 and print/reports/[kind]/page.tsx:116, :245, :419.
--
-- NOTE the deliberate omission: ledger_entries_insert (0001 §17) permits
-- an accountant to post manual entries of any type except
-- sale_profit_share, but nothing in the application has ever inserted
-- one — the seed script does it with the service role. Until the
-- manual-entry screen ships, INSERT stays out, so the only writer of
-- this table is execute_vehicle_sale() with its double-post guard.
grant select on ledger_entries to {{ROLE}};

-- Append-only, and this grant is what makes that true rather than
-- merely enforced. reject_audit_mutation() already raises on UPDATE and
-- DELETE, but a trigger is a rule the database applies after accepting
-- the statement; the absence of the privilege means the statement is
-- never accepted at all. Read at ceo/page.tsx:34.
grant select on audit_log to {{ROLE}};

-- ------------------------------------------------------------
-- 6c. TABLE PRIVILEGES — APPEND ONLY
--
-- Two tables the application adds to and never edits. Both are records
-- of something that happened, and a record of something that happened is
-- corrected by a new row, not by rewriting the old one.
-- ------------------------------------------------------------

-- inventory/actions.ts:100 inserts; inventory/[vehicleId]/page.tsx:39 and
-- print/reports/[kind]/page.tsx:342 read. No screen edits or removes an
-- expense — it reduces what every equity holder is paid, and
-- lock_ceo_override_expense() exists precisely to keep a CEO override
-- from being quietly walked back.
grant select, insert on vehicle_expenses to {{ROLE}};

-- crm/actions.ts:69 inserts; crm/[leadId]/page.tsx:24 reads. This one
-- needs no judgement call: 0001 and 0003 give lead_comments a SELECT and
-- an INSERT policy and nothing else, so the grant and the policy set
-- agree exactly. A note about a phone call is not editable after the
-- call.
grant select, insert on lead_comments to {{ROLE}};

-- ------------------------------------------------------------
-- 6d. TABLE PRIVILEGES — READ / WRITE
--
-- The five tables the working day actually mutates. Still no DELETE:
-- see 6f.
-- ------------------------------------------------------------

-- crm/actions.ts:31 inserts a manual lead, :160 flips status to
-- 'ticket_created'. The public referral form also inserts here
-- (refer/[salespersonId]/actions.ts:56) but through the service role —
-- see 6g.
grant select, insert, update on leads to {{ROLE}};

-- crm/actions.ts:119 raises the ticket; deals/actions.ts:63 (checklist),
-- :91 (approve) and :116 (reject) move it. guard_deal_ticket_status()
-- and handle_deal_ticket_approval() police the transitions — this grant
-- only says a ticket is a living document.
grant select, insert, update on deal_tickets to {{ROLE}};

-- crm/actions.ts:149 opens the request when a deal is on installments;
-- accountant/actions.ts:104 records the bank's decision.
grant select, insert, update on financing_requests to {{ROLE}};

-- accountant/actions.ts:41 creates the partner in pending_upload,
-- :70 attaches the signed contract and flips it to active.
-- enforce_financing_partner_upload_gate() is what makes that ordering
-- mandatory.
grant select, insert, update on financing_partners to {{ROLE}};

-- accountant/actions.ts:123 UPSERTs. PostgREST's upsert is
-- INSERT ... ON CONFLICT DO UPDATE, which needs BOTH verbs — granting
-- only UPDATE here would fail the first time a branch's overhead is ever
-- set, and only then.
grant select, insert, update on overhead_config to {{ROLE}};

-- ------------------------------------------------------------
-- 6e. TABLE PRIVILEGES — READ / UPDATE, NO INSERT
--
-- Three tables whose rows are created by something other than the person
-- editing them.
-- ------------------------------------------------------------

-- account/actions.ts:33 (the user's own notification contacts) and
-- employees/actions.ts:165 (the CEO editing an employee). INSERT belongs
-- to handle_new_user(), which is the whole of the no-self-signup rule:
-- a profile exists because an invitation existed. DELETE is withheld
-- even though profiles_delete (0003 §10) permits it — no screen removes
-- an employee, and a profile row is referenced by every lead, ticket and
-- ledger entry that person ever touched.
grant select, update on profiles to {{ROLE}};

-- 0006 §3 restated against the right grantee. Its original
--   grant  select, update           on meetings         to authenticated;
--   revoke insert, delete, truncate on meetings         from authenticated;
-- is a pair of no-ops in this design, because `authenticated` never
-- reaches this schema at all. The privilege shape it was asserting is
-- reproduced here instead: create_meeting() is the only INSERT path, and
-- a meeting is cancelled (calendar/actions.ts:125) rather than erased,
-- so the people who rearranged their day around it can still see what
-- became of it.
grant select, update on meetings to {{ROLE}};

-- Answering an invitation (calendar/actions.ts:98) is the one calendar
-- write every role gets. guard_meeting_invitee_columns() pins meeting_id
-- and profile_id so the UPDATE cannot be repointed at someone else's
-- invitation.
grant select, update on meeting_invitees to {{ROLE}};

-- ------------------------------------------------------------
-- 6f. WHAT IS DELIBERATELY ABSENT
--
-- DELETE appears nowhere above, on any of the 19 tables. That is not an
-- oversight to be corrected later: a search of every server action and
-- route handler under src/app finds exactly one delete, and it is
-- `staff_invitations` (employees/actions.ts:87), which now lives in the
-- control plane and is reached with the service role. FELIX's model is
-- that business records are superseded, not removed — a meeting is
-- cancelled, a ticket is rejected, a vehicle is sold. Nothing a showroom
-- session can send removes evidence.
--
-- TRUNCATE, REFERENCES and TRIGGER are likewise never granted. The first
-- would empty a table in one statement; the last two let a role attach
-- its own constraints and triggers to a table it does not own.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 6g. service_role
--
-- Not a tenant, and not covered by the lockdown below — service_role is
-- the deployment's own client, reachable only with the secret key from
-- server-side code. Three live paths need it inside a tenant schema:
--
--   1. the public referral form, the only unauthenticated write in the
--      product, which reads profiles and inserts a lead with the admin
--      client (refer/[salespersonId]/actions.ts:43 and :56);
--   2. the 508.world router Worker, which reads
--      profiles.notification_email / whatsapp_number (0007) and the
--      meetings table to send invites and the 1-hour reminder;
--   3. scripts/seed-demo.mjs.
--
-- Granting it is necessary but NOT sufficient: none of those callers
-- names a schema today (src/lib/supabase/admin.ts sets no `db.schema`,
-- so PostgREST defaults them to `public`). This is 0005's root cause in
-- new clothes — a sessionless caller used to lack a tenant_id and got a
-- loud NOT NULL violation; it now lacks a search_path and gets an empty
-- result set, or a write into whatever `public` still holds. Every one
-- of those callers must be changed to select its schema explicitly
-- before 0011 empties `public`.
-- ------------------------------------------------------------
-- Narrower than 0008 §6's `grant all` on the control plane: DML only, so
-- TRUNCATE, REFERENCES and TRIGGER stay out of reach of a leaked service
-- key. DELETE is included — nothing in the codebase uses it today, but
-- this role is the operator's escape hatch for data repair, and a repair
-- that cannot remove a bad row is not a repair.
grant usage on schema {{SCHEMA}} to service_role;
grant select, insert, update, delete on all tables in schema {{SCHEMA}} to service_role;

-- Note what is NOT mirrored from 0008 §6: no ALTER DEFAULT PRIVILEGES
-- granting service_role future tables. In the control plane that was
-- convenience; here it would mean a table added by 0012 becomes
-- service-role writable without anyone deciding so. Every new tenant
-- table should have to state its privileges, exactly as the 19 above do.
--
-- Nothing is granted to supabase_auth_admin either, deliberately.
-- 0008 §6 grants it access to `platform` because the access-token hook
-- reads that schema in its own session; but the trigger it fires on
-- auth.users runs handle_new_user(), which is SECURITY DEFINER and
-- therefore writes t_<slug>.profiles with its OWNER's rights, not the
-- auth admin's. Adding a grant here would widen the reach of the one
-- role that runs on every signup, for no reason.

-- ------------------------------------------------------------
-- 6h. FUNCTION PRIVILEGES
--
-- The default EXECUTE-to-PUBLIC is stripped from every function in the
-- schema first, and then handed back one signature at a time. Both
-- halves matter: the revoke closes ~40 functions per showroom, and the
-- grants are what keep the schema from being inert.
-- ------------------------------------------------------------
revoke all on all functions in schema {{SCHEMA}} from public, anon, authenticated;

-- (i) THE RLS EVALUATION CHAIN.
--
-- Easy to miss, and fatal if missed. A policy's USING/WITH CHECK
-- expression is evaluated with the privileges of the role running the
-- query — which is exactly why these ten have never needed an explicit
-- grant before: PUBLIC held EXECUTE on them by default and every policy
-- silently relied on it. The revoke above removes that. Without the
-- grants below, every SELECT on every table in this schema fails with
-- "permission denied for function is_ceo" — for every role, CEO
-- included.
--
-- is_ceo() and its three siblings are SECURITY INVOKER, so their bodies
-- run as the caller too and need current_role_name() in their own right;
-- can_act_on_branch() and can_read_branch() call all of the above.
-- holds_equity_in_vehicle() and vehicle_branch() are named directly by
-- vehicles_select and equity_splits_select (0003 §10).
grant execute on function current_role_name()             to {{ROLE}};
grant execute on function current_branch_id()             to {{ROLE}};
grant execute on function is_ceo()                        to {{ROLE}};
grant execute on function is_manager_or_above()           to {{ROLE}};
grant execute on function is_accountant_or_above()        to {{ROLE}};
grant execute on function is_staff()                      to {{ROLE}};
grant execute on function can_act_on_branch(uuid)         to {{ROLE}};
grant execute on function can_read_branch(uuid)           to {{ROLE}};
grant execute on function holds_equity_in_vehicle(uuid)   to {{ROLE}};
grant execute on function vehicle_branch(uuid)            to {{ROLE}};

-- is_investor() is defined (0003 §1) but referenced by no policy and no
-- function body in any migration. It is left ungranted rather than
-- granted "for symmetry" — an ungranted dead function is a fact a future
-- reader can act on.

-- auth.uid() is global and shared by every tenant. Supabase grants it to
-- PUBLIC by default; naming the tenant role explicitly means this
-- section does not depend on that default surviving a platform upgrade.
grant execute on function auth.uid() to {{ROLE}};

-- (ii) THE RPCs THE APPLICATION CALLS.
--
-- Exactly the set the source migrations granted to `authenticated` —
-- 0003:634, :645, :762, :823 and 0006:338, :434, :468, which between
-- them supersede 0001:500, :557 and :625 — re-pointed at the role that
-- can now actually reach this schema. Seven functions, seven grants: if
-- this list ever grows, the question to answer first is why the app is
-- calling a definer function it was not calling before.
--
-- Every one is SECURITY DEFINER and every one re-checks role and branch
-- internally, because bypassing RLS is the reason they exist.
grant execute on function create_vehicle_with_equity_splits(
  uuid, text, int, text, text, text, numeric, text[], jsonb)      to {{ROLE}};
grant execute on function execute_vehicle_sale(uuid)              to {{ROLE}};
grant execute on function preview_vehicle_sale_waterfall(
  uuid, numeric, numeric)                                         to {{ROLE}};
-- compute_sale_waterfall carries the same four-way authorization check
-- as its wrapper (CEO, accountant, own branch, or equity holder), and
-- 0003:634 granted it. The application reaches it only through
-- preview_vehicle_sale_waterfall today, so this grant could be dropped —
-- but dropping it is a behaviour change that belongs in its own commit,
-- not smuggled into the migration that moves the schema.
grant execute on function compute_sale_waterfall(
  uuid, numeric, numeric, timestamptz)                            to {{ROLE}};
grant execute on function create_meeting(
  text, text, text, timestamptz, timestamptz, uuid, uuid[])       to {{ROLE}};
grant execute on function calendar_meetings(timestamptz, timestamptz) to {{ROLE}};
grant execute on function calendar_invitable_people()             to {{ROLE}};

-- (iii) EVERYTHING ELSE STAYS CLOSED.
--
-- Named here so the omission reads as a decision:
--   commission_for_sale()        — computes pay; called only by
--                                  execute_vehicle_sale(), which has
--                                  already checked role and branch. It
--                                  contains no authorization check of
--                                  its own, by design.
--   generate_contract_serial()   — called only by the approval trigger.
--   record_audit()               — a direct call would forge audit rows.
--   set_updated_at(), check_equity_splits_sum(), guard_*, prevent_*,
--   enforce_*, reject_audit_mutation(), log_deal_ticket_status_change(),
--   handle_deal_ticket_approval(), sync_investor_row(),
--   lock_ceo_override_expense()  — trigger functions. Postgres checks
--                                  EXECUTE on a trigger function when
--                                  the trigger is CREATED, not when it
--                                  fires, so withholding it costs
--                                  nothing and closes a direct call that
--                                  would run the guard's body with
--                                  attacker-chosen NEW/OLD records.

-- ------------------------------------------------------------
-- 6i. FUTURE OBJECTS
--
-- Everything above describes the objects this function just created.
-- 0012 will add more, and the default EXECUTE-to-PUBLIC would come back
-- with each one. ALTER DEFAULT PRIVILEGES is keyed to the role that
-- creates the object and applies from the moment it is set, so this only
-- covers objects created later BY THE SAME ROLE that owns
-- create_tenant_schema(). That is the correct assumption today — 0008
-- and 0009 are both applied as the superuser and 0012's runner will be
-- too — but it is an assumption, and if the per-tenant migration runner
-- ever runs as someone else these entries silently stop applying. That
-- is what the guard in 6j is for: it re-asserts the property rather than
-- trusting the mechanism.
-- ------------------------------------------------------------
alter default privileges in schema {{SCHEMA}}
  revoke all on tables    from public, anon, authenticated;
alter default privileges in schema {{SCHEMA}}
  revoke all on functions from public, anon, authenticated;
-- No sequence exists in this schema — every primary key is a uuid with a
-- gen_random_uuid() default, not a serial. This entry is here for the
-- day one does, so it cannot arrive already readable by `authenticated`.
alter default privileges in schema {{SCHEMA}}
  revoke all on sequences from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6j. GUARD — the property this whole design rests on
--
-- Same shape as 0008 §7, and the same reasoning: a lockdown that is
-- asserted is worth more than a lockdown that is merely written, because
-- the failure mode of a missed REVOKE is a schema that looks completely
-- normal and leaks. This runs before create_tenant_schema() returns, so
-- a showroom that fails it is never created at all rather than created
-- and then reported on by 0013 — tenants get provisioned in between.
--
-- Three checks are negative and two are positive. The positive ones
-- matter as much: with `authenticated` holding nothing, "the lockdown
-- worked" and "the tenant role was never granted anything and every
-- query returns empty" look identical from outside, and the second is a
-- total outage that nobody notices until a customer calls.
-- ------------------------------------------------------------
do $guard$
declare
  n_grants int;
  n_tables int;
  n_funcs  int;
  n_norole int;
begin
  -- (1) The catalogue view 0008 §7 uses, kept for continuity.
  select count(*) into n_grants
    from information_schema.role_table_grants
   where table_schema = '{{SCHEMA}}'
     and grantee in ('authenticated', 'anon', 'PUBLIC');

  if n_grants > 0 then
    raise exception
      'Lockdown failed: % table privilege(s) on %.* still held by anon/authenticated',
      n_grants, '{{SCHEMA}}';
  end if;

  -- (2) The authoritative version. information_schema only shows rows
  -- whose grantor or grantee is an enabled role, so it can under-report
  -- a privilege granted by somebody else; has_table_privilege() asks the
  -- planner the same question the planner will ask at query time, and
  -- accounts for PUBLIC and for role membership.
  select count(*) into n_tables
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = '{{SCHEMA}}'
     and c.relkind in ('r', 'p')
     and (has_table_privilege('authenticated', c.oid,
            'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege('anon', c.oid,
            'select, insert, update, delete, truncate, references, trigger'));

  if n_tables > 0 then
    raise exception
      'Lockdown failed: anon/authenticated hold a privilege on % table(s) in %',
      n_tables, '{{SCHEMA}}';
  end if;

  -- (3) Functions. This is the check that catches the Postgres default
  -- coming back — a single function created after 6h without its revoke
  -- is EXECUTE-to-PUBLIC, and if it is SECURITY DEFINER it runs as the
  -- superuser that owns this schema.
  select count(*) into n_funcs
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = '{{SCHEMA}}'
     and (has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('anon', p.oid, 'execute'));

  if n_funcs > 0 then
    raise exception
      'Lockdown failed: anon/authenticated can execute % function(s) in %',
      n_funcs, '{{SCHEMA}}';
  end if;

  if has_schema_privilege('authenticated', '{{SCHEMA}}', 'usage')
     or has_schema_privilege('anon', '{{SCHEMA}}', 'usage') then
    raise exception 'Lockdown failed: anon/authenticated retain USAGE on schema %',
      '{{SCHEMA}}';
  end if;

  -- (4) Positive: the tenant role can open the door.
  if not has_schema_privilege('{{ROLE}}', '{{SCHEMA}}', 'usage') then
    raise exception 'Provisioning failed: % holds no USAGE on schema %',
      '{{ROLE}}', '{{SCHEMA}}';
  end if;

  -- (5) Positive: it can read every table. The grant list in 6b-6e is
  -- 19 hand-written statements; a typo in one of them produces a table
  -- that is simply invisible to the whole showroom, with no error
  -- anywhere. This is the cheapest possible check for that.
  select count(*) into n_norole
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = '{{SCHEMA}}'
     and c.relkind in ('r', 'p')
     and not has_table_privilege('{{ROLE}}', c.oid, 'select');

  if n_norole > 0 then
    raise exception
      'Provisioning failed: % has no SELECT on % table(s) in % — the grant list has a gap',
      '{{ROLE}}', n_norole, '{{SCHEMA}}';
  end if;

  -- (6) Positive: the root of the RLS chain is callable. Every is_*()
  -- helper and therefore every policy funnels through this one function.
  -- If it is not executable, RLS denies everything, everywhere, silently.
  -- coalesce, not a bare NOT: to_regprocedure() returns NULL when the
  -- function is absent entirely, and NULL would slip through the IF —
  -- turning the worst case into the one case this check misses.
  if not coalesce(has_function_privilege(
       '{{ROLE}}', to_regprocedure('{{SCHEMA}}.current_role_name()'), 'execute'), false) then
    raise exception
      'Provisioning failed: % cannot execute %.current_role_name() — every policy would deny',
      '{{ROLE}}', '{{SCHEMA}}';
  end if;
end
$guard$;
-- ============================================================
-- 7. BASELINE DATA — the rows a showroom cannot function without
--
-- The only non-DDL section, and the one this migration was closest to
-- losing entirely.
--
-- 0004 §8's provision_tenant() planted three things: a first branch, that
-- branch's overhead_config row at zero, and the ten-tier commission
-- ladder. The 0009 brief describes DDL, and 0008 describes roles and a
-- registry, so between them nothing owned these inserts. They are placed
-- here, at the tail of the template, so that "a tenant schema is complete
-- when create_tenant_schema() returns" stays literally true rather than
-- becoming a thing provisioning is also supposed to remember.
--
-- WHY THE OMISSION WOULD NOT HAVE BEEN NOTICED
--
-- Every one of the three fails silently, and two of them fail as money:
--
--   * No commission_tiers rows. commission_for_sale() answers an unseeded
--     ladder with `if max_tier is null then return 0` — deliberately, so
--     that a showroom that has not configured commission does not error
--     on every sale. The consequence is that every salesperson earns
--     nothing, on every sale, forever, and the first symptom is a payroll
--     dispute months later.
--   * No overhead_config row. compute_sale_waterfall() reads it with
--     `coalesce(monthly_opex_amount, 0)`, so a missing row is not an
--     error — it books zero overhead, overstates net profit on every sale
--     the showroom ever makes, and pays that overstatement out to
--     investors in irreversible ledger rows.
--   * No branch. This one is at least loud, but it lies: vehicle intake
--     and create_meeting() fail on 'Branch not found' / 'Unknown branch',
--     which reads like a bug in the caller.
--
-- ON THE BRANCH, AND WHAT PROVISIONING MUST DO WITH IT
--
-- create_tenant_schema() takes a slug and nothing else — it has no
-- showroom name, and the registry row does not necessarily exist yet when
-- it runs. So the branch is planted under a placeholder name, guarded on
-- the table being empty so a re-run cannot produce a second one.
--
-- provision_tenant() (0010) must UPDATE this row's name, not INSERT
-- another, and must read its id for the CEO invitation's branch_id —
-- platform.staff_invitations.branch_id is deliberately not a foreign key
-- (0008 §3), because branches live in a schema the control plane cannot
-- reference, so nothing will catch a wrong value.
--
-- The ladder is `i * 6000`, which is a flat 6,000 per unit; the table can
-- express any accelerating schedule, and the conflict target is
-- (tier_index) alone now that 0004's composite key is gone.
--
-- These inserts fire the audit triggers from §4, writing about a dozen
-- audit_log rows with actor_id = NULL, because auth.uid() is null for the
-- provisioning session. That is correct and worth having: the audit trail
-- for a showroom starts by recording how it was built.
--
-- The lockdown guard in §6j runs BEFORE this section, so a schema that
-- fails its privilege assertions never receives a single row.
-- ============================================================
do $seed$
declare
  v_branch uuid;
begin
  if not exists (select 1 from branches) then
    insert into branches (name) values ('Main Branch')
    returning id into v_branch;

    insert into overhead_config (branch_id, monthly_opex_amount)
    values (v_branch, 0)
    on conflict (branch_id) do nothing;
  end if;

  insert into commission_tiers (tier_index, cumulative_amount)
  select i, i * 6000
    from generate_series(1, 10) as i
  on conflict (tier_index) do nothing;
end
$seed$;

-- ============================================================
-- END OF THE TENANT DDL TEMPLATE
-- ============================================================
$ddl$::text
$template$;

comment on function platform.tenant_ddl_template() is
  'The complete definition of a FELIX business schema, as text, with {{SCHEMA}} and {{ROLE}} unsubstituted. Executed by create_tenant_schema(); read by 0012 to diff a live tenant schema against what it should contain.';

-- Not secret — it is DDL — but there is no reason for a tenant session to
-- read the shape of the schema it lives in, and PUBLIC holds EXECUTE on a
-- new function by default. 0012's runner reads it as the migrating role.
revoke all on function platform.tenant_ddl_template() from public;


-- ============================================================
-- 2. THE INSTANTIATOR
--
-- Takes a slug, returns the schema name, and leaves behind a complete,
-- locked-down, seeded showroom schema. Idempotent: every statement it
-- issues, directly or through the template, is either IF NOT EXISTS,
-- OR REPLACE, DROP-then-CREATE, or ON CONFLICT DO NOTHING.
--
-- CONVERGENCE IS PARTIAL, AND THE GAP IS TABLE SHAPE
-- --------------------------------------------------
-- Re-running this converges FUNCTIONS (create or replace), TRIGGERS and
-- POLICIES (drop then create), GRANTS (re-issued) and SEED ROWS
-- (on conflict). It does NOT converge table shape, because §1's tables
-- are `create table if not exists` — against an existing schema that is a
-- no-op. A later migration that adds a column, tightens a CHECK or adds a
-- NOT NULL to the template will therefore never reach a tenant
-- provisioned before the change, and assertion (a) will not notice: it
-- tests `to_regclass(...) is not null`, i.e. that the table exists, never
-- its columns or constraints.
--
-- That is the same class of silent per-tenant constraint drift §1
-- diagnoses in 0007 — 0007 guarded on `conname` alone, which is not
-- database-unique, so tenant #1 got the two profiles CHECKs and every
-- tenant after it silently skipped them. Defining them inline fixes that
-- for schemas created from scratch; it does not fix re-application.
--
-- Closing the gap is 0012's job, not this function's: its runner must
-- carry explicit ALTER TABLE steps per version rather than assuming a
-- re-run of the template picks shape changes up. Until then, treat a
-- schema created by an older c_version as needing a hand-written
-- migration, and use platform.schema_migrations to find them.
--
-- THE SLUG IS AN IDENTIFIER NOW, NOT A ROUTING LABEL
--
-- Under 0004 a bad slug produced a confusing subdomain and a 404. Here it
-- becomes a schema name and a role name, both interpolated into DDL that
-- runs as a superuser. So it is validated here, from scratch, rather than
-- trusted from the registry row — platform.create_tenant_role() already
-- re-validates independently for the same reason, and neither should
-- assume the other ran.
--
-- Note what the `t_` and `felix_` prefixes buy: slug -> schema name is
-- injective and cannot collide with anything Postgres or Supabase owns,
-- so the RESERVED_SLUGS list in src/app/api/provision/route.ts is
-- protecting subdomain routing, not this function. That is worth knowing
-- because it means a caller reaching past that list with the service key
-- cannot collide two showrooms into one schema — it can only create an
-- oddly-named one.
--
-- WHY format('%I') APPEARS IN ONE PLACE AND NOT THE OTHER
--
-- The CREATE SCHEMA below quotes through format('%I'), as it must. The
-- template substitution cannot: {{SCHEMA}} appears inside SQL string
-- literals — `where table_schema = '{{SCHEMA}}'` in the guard block,
-- `to_regprocedure('{{SCHEMA}}.current_role_name()')` — where identifier
-- quoting would be exactly the wrong transformation. The safety therefore
-- has to come from the VALUE being known-safe before substitution, which
-- is what the regex above it is for, and not from the interpolation site.
--
-- HOW THE BODY IS EXECUTED, AND WHY NOT ANY OF THE OBVIOUS WAYS
--
-- The template is one string holding 315 statements and about 160 kB.
-- Three plausible approaches to running it are wrong:
--
--   * Splitting on ';'. The string is mostly function bodies, and a
--     function body is a dollar-quoted literal full of semicolons. Any
--     splitter short of a full Postgres lexer will cut
--     `raise exception '...';` out of the middle of a plpgsql body and
--     hand the parser two fragments, neither valid.
--   * Splitting on ';' at end-of-line, or on blank lines. The same bug,
--     with a coat of plausibility on it.
--   * format(). The body contains literal percent signs —
--     `must sum to 100%% (got %)`, `Illegal deal ticket transition:
--     % -> %`, `v vehicles%rowtype`, and two format() calls of its own
--     inside execute_vehicle_sale(). format() would consume them as its
--     own specifiers and either fail with "too few arguments" or, worse,
--     succeed and quietly corrupt a message. Substitution is replace(),
--     twice, and the assertion below catches a token it did not know.
--
-- What is correct is to hand the whole string to a single EXECUTE.
-- PL/pgSQL's EXECUTE goes to SPI, and SPI accepts a multi-command string:
-- it raw-parses the whole thing up front, then analyses, plans and
-- executes each command in turn, incrementing the command counter between
-- them. That last part is the part that matters — command N+1 is analysed
-- AFTER command N has executed, so CREATE POLICY sees the table CREATE
-- TABLE just made, and CREATE TRIGGER sees the function. Postgres's own
-- multi-statement simple-query path behaves identically; this is the
-- normal mechanism, not a trick.
--
-- Two consequences worth stating:
--   * Raw parsing covers the whole string, so a syntax error anywhere
--     aborts before any statement runs. Welcome.
--   * A failure reports a character position into a ~150 kB string. That
--     is the price, and it is why the template is a function you can
--     select a substring of.
--
-- ORDER INSIDE THE TEMPLATE IS LOAD-BEARING, and 0004 §2 is where that
-- was first written down: Postgres validates a SQL-LANGUAGE function body
-- at CREATE time (plpgsql bodies are not validated), so a helper cannot
-- be created before the helper it calls, nor before the tables it reads.
-- Concretely: current_role_name/current_branch_id/holds_equity_in_vehicle/
-- vehicle_branch need profiles, vehicles and vehicle_equity_splits;
-- is_ceo() and friends need current_role_name();
-- preview_vehicle_sale_waterfall is SQL and calls compute_sale_waterfall,
-- so it must follow it; and every policy must follow the helper it names,
-- which is also what makes the policy bind by OID to the tenant's copy.
-- Hence the fixed section order: tables -> SQL helpers -> plpgsql
-- functions -> triggers -> RLS and policies -> grants -> data.
-- ============================================================
create or replace function platform.create_tenant_schema(p_slug text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, platform
as $body$
declare
  -- Bumped by whichever migration next changes the template. 0012's drift
  -- report compares this against platform.schema_migrations to find the
  -- schemas a rollout has not reached.
  c_version constant text := '0009';

  -- The seven functions that deliberately carry no pinned search_path.
  -- They are `language sql` predicates evaluated inside nearly every RLS
  -- policy in the schema, and a SET clause would make the planner refuse
  -- to inline them; they schema-qualify their inner calls instead. Listed
  -- here so assertion (e) can be a count rather than an eyeball.
  c_unpinned constant text[] := array[
    'is_ceo', 'is_manager_or_above', 'is_accountant_or_above', 'is_staff',
    'is_investor', 'can_act_on_branch', 'can_read_branch'];

  c_tables constant text[] := array[
    'branches', 'profiles', 'investors', 'vehicles', 'vehicle_equity_splits',
    'vehicle_expenses', 'overhead_config', 'leads', 'lead_comments',
    'financing_partners', 'deal_tickets', 'deal_ticket_events',
    'financing_requests', 'contracts', 'commission_tiers', 'ledger_entries',
    'audit_log', 'meetings', 'meeting_invitees'];

  v_schema  text;
  v_role    text;
  v_ddl     text;
  v_missing text;
  v_at      int;
  n         int;
begin
  -- ── 1. VALIDATE THE SLUG ───────────────────────────────────
  -- Same rule as platform.tenants' own CHECK constraint, restated rather
  -- than inherited. This function must not assume the registry row was
  -- written correctly, or that a registry row exists at all — 0012 calls
  -- it for schemas that predate whatever the registry says today.
  if p_slug is null
     or p_slug !~ '^[a-z0-9]+$'
     or length(p_slug) not between 2 and 40 then
    raise exception 'Illegal tenant slug %', coalesce(quote_literal(p_slug), 'NULL')
      using hint = 'A slug is 2-40 lowercase alphanumeric characters. It becomes a schema name and a role name, both interpolated into DDL that runs as a superuser.';
  end if;

  v_schema := 't_' || p_slug;
  v_role   := 'felix_' || p_slug;

  -- THE REGISTRY ROW MUST ALREADY EXIST.
  --
  -- Found by running this against a live Postgres rather than by reading
  -- it: create_tenant_schema('testco') with no platform.tenants row
  -- succeeded and produced a fully-formed, correctly-locked-down schema
  -- that platform.sync_postgrest_schemas() then omitted — because that
  -- function recomputes the exposed list FROM THE REGISTRY (0008 §5).
  -- The result is a showroom that exists, passes every assertion below,
  -- and is unreachable through the API, with nothing anywhere reporting
  -- a problem. The operator sees a successful provision and a 404.
  --
  -- Ordering is therefore part of the contract, not a convention:
  -- register the tenant, then create its schema, then sync. Asserted
  -- here because this is the step that would otherwise succeed
  -- misleadingly.
  --
  -- Deliberately does NOT require status = 'active': re-running against
  -- a suspended tenant is legitimate (0012 must still reach it to keep
  -- its schema current), and only the exposure list cares about status.
  if not exists (
    select 1 from platform.tenants
     where slug = p_slug and schema_name = v_schema and role_name = v_role
  ) then
    raise exception
      'No platform.tenants row for slug % — register the tenant before creating its schema', p_slug
      using hint = 'sync_postgrest_schemas() builds the exposed-schema list from the registry, so a schema with no registry row is created correctly and then never served. Insert the tenants row first.';
  end if;

  -- ── 2. THE ROLE ────────────────────────────────────────────
  -- Before the schema, because §6 grants to it by name and a GRANT to a
  -- role that does not exist is an error rather than a no-op. Idempotent
  -- (0008 §4), and it re-validates the slug a second time.
  perform platform.create_tenant_role(p_slug);

  -- ── 3. THE SCHEMA ──────────────────────────────────────────
  execute format('create schema if not exists %I', v_schema);

  -- ── 4. THE SEARCH PATH ─────────────────────────────────────
  -- The whole mechanism, in one statement. `true` makes it local: it is
  -- unwound when this function returns, so a caller's path is never left
  -- pointing at a tenant schema. `public` is absent on purpose — see the
  -- file header. `extensions` is not optional: without it every CREATE
  -- TABLE in §1 fails on its own gen_random_uuid() default.
  perform set_config('search_path', quote_ident(v_schema) || ', extensions', true);

  -- ── 5. SUBSTITUTE ──────────────────────────────────────────
  v_ddl := platform.tenant_ddl_template();
  v_ddl := replace(v_ddl, '{{SCHEMA}}', v_schema);
  v_ddl := replace(v_ddl, '{{ROLE}}',   v_role);

  -- A token this function does not know about — a pluralised SCHEMAS, a
  -- TENANT someone invented, a plain typo — would otherwise sail through
  -- as literal text and produce a syntax error hundreds of lines from its
  -- cause, or worse, land inside a comment or a string literal and never
  -- produce one at all. (Written out in prose rather than as examples, so
  -- that a search for unsubstituted placeholders across the repository
  -- does not match this comment.)
  v_at := position('{{' in v_ddl);
  if v_at > 0 then
    raise exception 'Tenant DDL template carries an unrecognised placeholder at character %: ...%...',
      v_at, substr(v_ddl, greatest(v_at - 40, 1), 120);
  end if;

  -- ── 6. EXECUTE ─────────────────────────────────────────────
  execute v_ddl;

  -- ── 7. ASSERT ──────────────────────────────────────────────
  -- 0004 closed by proving from the catalogue that no table had gained a
  -- tenant_id column without also gaining its isolation policy, and 0005
  -- closed by proving its three rewrites had actually taken rather than
  -- merely compiled. That habit is worth more here than it was there:
  -- this function builds ~100 relations and ~38 functions by dynamic SQL,
  -- where a single missed pin or a mis-scoped policy produces a schema
  -- that looks entirely normal and leaks, or one that is silently inert.
  --
  -- These run before the function returns, so a showroom that fails them
  -- is never created at all — as opposed to being created, provisioned,
  -- and reported on by 0013 some weeks later, with tenants having been
  -- onboarded in between. §6j has already asserted the privilege half;
  -- these are the structural half.

  -- (a) Every table is present. to_regclass() returns NULL rather than
  --     raising, so this names all of the missing ones at once instead of
  --     failing on the first.
  select string_agg(t, ', ' order by t) into v_missing
    from unnest(c_tables) as t
   where to_regclass(quote_ident(v_schema) || '.' || quote_ident(t)) is null;

  if v_missing is not null then
    raise exception 'Tenant schema % is incomplete — missing table(s): %', v_schema, v_missing;
  end if;

  -- (b) RLS is on everywhere. The schema decides which showroom; these
  --     policies decide who inside it. A table that reached this point
  --     with RLS off is readable in full by every employee of that
  --     showroom, which is a five-role authorization model collapsing
  --     into one.
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = v_schema and c.relkind = 'r' and not c.relrowsecurity;

  if n > 0 then
    raise exception 'Tenant schema %: % table(s) have row level security disabled', v_schema, n;
  end if;

  -- (c) Not one tenant_id column survived. The direct heir to 0004 §9,
  --     inverted: 0004 asserted the column was everywhere, this asserts it
  --     is nowhere. A survivor would be a second, unenforced answer to
  --     "whose row is this?" that no policy consults.
  select count(*) into n
    from pg_attribute a
    join pg_class c      on c.oid = a.attrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = v_schema
     and c.relkind = 'r'
     and a.attname = 'tenant_id'
     and not a.attisdropped;

  if n > 0 then
    raise exception 'Tenant schema %: % tenant_id column(s) survived — the schema is the boundary now', v_schema, n;
  end if;

  -- (d) No function pins a search_path naming `public`. This is the
  --     assertion that catches the single most dangerous mistake
  --     available in this migration: a SECURITY DEFINER function, owned
  --     by a superuser, reading another schema's tables. It compiles
  --     perfectly and nothing else would notice.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = v_schema
     and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                  where cfg like 'search_path=%' and cfg ~ '\mpublic\M');

  if n > 0 then
    raise exception 'Tenant schema %: % function(s) still pin a search_path naming public', v_schema, n;
  end if;

  --     ...and the ones that are pinned name THIS schema. A stale
  --     't_someothertenant' is the same bug with a different blast radius.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = v_schema
     and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                  where cfg like 'search_path=%' and cfg !~ ('\m' || v_schema || '\M'));

  if n > 0 then
    raise exception 'Tenant schema %: % function(s) pin a search_path that does not name this schema', v_schema, n;
  end if;

  -- (e) The only functions WITHOUT a pinned search_path are the seven
  --     inlinable predicates. Without this, "give every function a
  --     search_path" degrades into "give most of them one" the first time
  --     somebody adds a helper, and the omission is invisible.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = v_schema
     and p.proname <> all(c_unpinned)
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                      where cfg like 'search_path=%');

  if n > 0 then
    raise exception 'Tenant schema %: % function(s) carry no pinned search_path and are not one of the seven inlinable predicates', v_schema, n;
  end if;

  -- (f) Exactly twenty SECURITY DEFINER functions. The count is part of
  --     the template's contract, not a coincidence: each one runs as a
  --     superuser, so both directions of drift matter. One too many is a
  --     function that gained superuser rights by accident; one too few is
  --     a guard that lost its RLS bypass and will now fail closed in a way
  --     that reads like a permissions bug. A migration that legitimately
  --     changes this number should change this line in the same commit.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = v_schema and p.prosecdef;

  if n <> 20 then
    raise exception 'Tenant schema %: expected 20 SECURITY DEFINER functions, found %', v_schema, n;
  end if;

  -- (g) No policy is scoped to a role a tenant session does not hold.
  --     Every policy in 0001/0003/0006 was written `to authenticated`,
  --     and a session here SET ROLEs into felix_<slug>, which 0008 §4
  --     creates NOINHERIT and never makes a member of anything. A policy
  --     naming `authenticated` simply never applies — and with RLS on and
  --     no applicable permissive policy, every table returns zero rows for
  --     every user in every showroom. No error, no warning, just an empty
  --     application. This is the cheapest possible detector for it.
  select count(*) into n
    from pg_policies
   where schemaname = v_schema
     and roles && array['authenticated', 'anon']::name[];

  if n > 0 then
    raise exception 'Tenant schema %: % policy/policies still name authenticated or anon and would never apply', v_schema, n;
  end if;

  -- (h) 0006 §7's assertion, carried forward and re-pointed at the tenant
  --     schema. The ABSENCE of an INSERT policy on the calendar tables is
  --     what forces every meeting through create_meeting(), where the
  --     role check, the branch forcing and the invitee entitlement rules
  --     live. An INSERT or ALL policy appearing here would route around
  --     all three.
  select count(*) into n
    from pg_policies
   where schemaname = v_schema
     and tablename in ('meetings', 'meeting_invitees')
     and cmd in ('INSERT', 'ALL');

  if n > 0 then
    raise exception 'Tenant schema %: % INSERT policy/policies on the calendar tables — create_meeting() is meant to be the only write path', v_schema, n;
  end if;

  -- (i) THE GUARD TRIGGERS EXIST.
  --
  --     Assertions (a)-(h) cover the fail-CLOSED half of the model and
  --     none of the fail-OPEN half. A policy that fails to land leaves RLS
  --     enabled with no permissive policy, so the table returns zero rows
  --     — loud, and safe. A trigger that fails to land is silent, and
  --     every one of 0003's headline fixes is a trigger:
  --
  --       trg_guard_profile_privileges  — without it, 0003's total-
  --         compromise path reopens. `update profiles set role='ceo'
  --         where id = auth.uid()` passes both USING and WITH CHECK of
  --         profiles_update_self, which §5 carries verbatim.
  --       trg_audit_immutable           — the append-only trail becomes
  --         editable.
  --       trg_lock_splits / trg_expense_after_sale — an already-paid-out
  --         cap table and cost basis become editable after the sale.
  --       trg_guard_deal_ticket_status  — a ticket can be INSERTed
  --         straight to 'approved', skipping the three-flag checklist.
  --
  --     Asserted by NAME rather than by count so the error says which
  --     guard is missing. This matters most on 0012's re-apply path,
  --     where a half-applied section could drop a trigger and not
  --     recreate it. 0003 §12 and 0005 §4 both closed the same way; this
  --     is that habit carried forward.
  --     Set-based rather than a loop so the error names every missing
  --     guard at once — the same reason assertion (a) is written that way.
  select string_agg(want, ', ' order by want) into v_missing
    from unnest(array[
      'trg_guard_profile_privileges', 'trg_guard_deal_ticket_status',
      'trg_audit_immutable', 'trg_lock_splits', 'trg_expense_after_sale',
      'trg_ticket_matches_vehicle'
    ]) as want
   where not exists (
     select 1 from pg_trigger tg
       join pg_class c      on c.oid = tg.tgrelid
       join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = v_schema
        and tg.tgname  = want
        and not tg.tgisinternal
   );

  if v_missing is not null then
    raise exception
      'Tenant schema %: guard trigger(s) missing: %. These fail OPEN — the rules they enforce are simply gone, with no error at runtime', v_schema, v_missing;
  end if;

  -- (j) THE TENANT ROLE'S OWN CEILING, and no other tenant's floor.
  --
  --     §6j asserts what anon/authenticated must NOT have and what
  --     {{ROLE}} must have. Neither bounds {{ROLE}} from above, and
  --     nothing looks at any other grantee — so the isolation property
  --     this file exists to establish was the one property not asserted.
  --
  --     DELETE/TRUNCATE/REFERENCES/TRIGGER are the four that matter.
  --     TRUNCATE fires no row trigger, so it would empty the audit trail
  --     past reject_audit_mutation(). TRIGGER on a table you do not own
  --     lets the grantee attach its own function. REFERENCES leaks column
  --     values through foreign-key probing.
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = v_schema
     and c.relkind in ('r', 'p')
     and has_table_privilege(v_role, c.oid, 'delete, truncate, references, trigger');

  if n > 0 then
    raise exception
      'Tenant schema %: role % holds delete/truncate/references/trigger on % relation(s) — §6 grants none of those', v_schema, v_role, n;
  end if;

  --     And the cross-tenant check proper: no OTHER felix_* role may hold
  --     USAGE here. A stray grant from a manual psql repair, or from an
  --     edit to the grant list where {{ROLE}} was hand-substituted, passes
  --     every other assertion in this function and produces a schema that
  --     looks entirely normal and leaks.
  select count(*) into n
    from pg_roles r
   where r.rolname like 'felix\_%'
     and r.rolname <> v_role
     and has_schema_privilege(r.rolname, v_schema, 'usage');

  if n > 0 then
    raise exception
      'Tenant schema %: % other tenant role(s) hold USAGE on this schema — this is the exact cross-tenant leak the design exists to prevent', v_schema, n;
  end if;

  -- (k) NO MATERIALIZED VIEWS.
  --
  --     RLS cannot be enabled on a materialized view at all, so one in a
  --     tenant schema is an isolation hole by construction: it would hold
  --     a snapshot of every branch's rows, readable by anyone with SELECT,
  --     and assertions (b) and (c) skip it because they filter relkind to
  --     ('r','p'). Cheaper to forbid the construct than to special-case it
  --     later, and the obvious candidate — a cross-branch reporting view —
  --     is exactly the thing someone will reach for.
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = v_schema and c.relkind = 'm';

  if n > 0 then
    raise exception
      'Tenant schema %: % materialized view(s) — RLS cannot apply to them, so they cannot live in a tenant schema', v_schema, n;
  end if;

  -- ── 8. RECORD ──────────────────────────────────────────────
  insert into platform.schema_migrations (schema_name, version)
  values (v_schema, c_version)
  on conflict (schema_name, version) do nothing;

  -- Deliberately NOT called here: platform.sync_postgrest_schemas().
  -- It reaches out of the database and changes the behaviour of a running
  -- PostgREST, and 0008 keeps it outside the transaction for exactly that
  -- reason — a provisioning that rolls back must never have announced a
  -- schema that does not exist. The caller runs it after COMMIT.
  return v_schema;
end;
$body$;

comment on function platform.create_tenant_schema(text) is
  'Instantiates the complete FELIX business schema into t_<slug> and locks it to felix_<slug>. Idempotent; asserts its own structure and privileges before returning. Does not touch the registry and does not reload PostgREST — provision_tenant() orchestrates those.';

-- 0004 §8 already knew Postgres grants EXECUTE on a new function to
-- PUBLIC, and revoked it from provision_tenant(). The same line matters
-- more here: this function creates roles and schemas as a superuser.
--
-- It is granted to nobody. Its intended callers are platform.provision_
-- tenant() (0010), which is SECURITY DEFINER and so reaches it as its
-- owner, and a migration runner applying 0012 as a superuser. Granting it
-- to service_role would widen a leaked service key from "can read and
-- write every showroom's data" — already total — to "can also create
-- schemas and roles", for no capability anyone needs today.
revoke all on function platform.create_tenant_schema(text) from public;


-- ============================================================
-- 3. SELF-CHECK
--
-- 0005 exists in this repository because "the functions compile" and "the
-- functions do the new thing" are different claims, and 0003's header
-- records a live database where a whole migration silently failed to
-- apply. The per-tenant assertions above only run when a showroom is
-- provisioned, which may be weeks after this file lands. These four run
-- now, at migration time, on the template itself.
-- ============================================================
do $selfcheck$
declare
  v_probe text;
  v_at    int;
begin
  v_probe := platform.tenant_ddl_template();

  -- A truncated template is the failure mode of assembling one file out
  -- of seven. Anything under 60 kB is not this template.
  if length(v_probe) < 60000 then
    raise exception 'Tenant DDL template is % bytes — it looks truncated', length(v_probe);
  end if;

  if position('{{SCHEMA}}' in v_probe) = 0 then
    raise exception 'Tenant DDL template contains no {{SCHEMA}} placeholder — every function would be pinned to a literal';
  end if;

  if position('{{ROLE}}' in v_probe) = 0 then
    raise exception 'Tenant DDL template contains no {{ROLE}} placeholder — the grants would name nobody';
  end if;

  -- The one text check worth making on the template itself. Anchored on
  -- `set search_path`, so the prose in §2 describing Supabase's
  -- pgrst.db_extra_search_path does not trip it.
  if v_probe ~* 'set[[:space:]]+search_path[[:space:]]*=[[:space:]]*public' then
    raise exception 'Tenant DDL template pins a search_path to public somewhere — that is a privilege-escalation bug, not a style issue';
  end if;

  -- The same unrecognised-placeholder check create_tenant_schema() makes,
  -- run here against a probe so the answer arrives at migration time
  -- rather than at the first provisioning.
  v_probe := replace(replace(v_probe, '{{SCHEMA}}', 't_probe'), '{{ROLE}}', 'felix_probe');
  v_at := position('{{' in v_probe);
  if v_at > 0 then
    raise exception 'Tenant DDL template carries an unrecognised placeholder at character %: ...%...',
      v_at, substr(v_probe, greatest(v_at - 40, 1), 120);
  end if;
end
$selfcheck$;

commit;

-- No provisioning happens in this migration, so there is no schema for
-- PostgREST to learn about and nothing to sync. The first call to
-- platform.create_tenant_schema() is 0011's, for the flagship.
