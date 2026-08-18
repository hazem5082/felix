-- ============================================================
-- 0008 — SCHEMA-PER-TENANT, FOUNDATION
--
-- Replaces the row-level tenancy of 0004 with physical separation:
-- every showroom gets its own Postgres schema (t_<slug>) and its own
-- Postgres role (felix_<slug>). Isolation stops being a policy
-- predicate on a shared table and becomes an object privilege on
-- separate tables.
--
-- WHY THE CHANGE
-- --------------
-- 0004's `tenant_id` + RESTRICTIVE policy design is sound, but its
-- boundary is a predicate: every showroom's rows sit in one table, and
-- exactly one WHERE clause stands between them. A single missing policy,
-- a SECURITY DEFINER function that forgets its tenant check, or a future
-- table added without the isolation policy leaks everything. 0004 knew
-- this — that is why it ends with a catalogue assertion that every table
-- carries its policy. This migration removes the class of bug instead of
-- asserting its absence: tenant B's role has no privilege on tenant A's
-- schema, so there is no query tenant B can write that reads it.
--
-- THE CONSTRAINT THIS DESIGN IS BUILT AROUND
-- ------------------------------------------
-- PostgREST authenticates as `authenticator`, then SET ROLE to the JWT's
-- `role` claim. Supabase issues `role: authenticated` for every signed-in
-- user of every tenant. Table GRANTs are per-role. So splitting the
-- tables while leaving everyone as `authenticated` would be WORSE than
-- 0004 — separate tables, all granted to one shared role, and no RLS
-- backstop. Physical separation only becomes isolation if the role is
-- per-tenant too. That is what section 4 exists for, and it is the load-
-- bearing part of this migration: if the access-token hook (0010) ever
-- stops setting the role claim, users fall back to `authenticated`,
-- which section 6 strips of every privilege on every tenant schema.
-- The failure mode is "sees nothing", never "sees everyone".
--
-- WHY NOT A PROJECT PER CLIENT
-- ----------------------------
-- A separate database per showroom is stronger still, and was the first
-- choice. It is ruled out by the roadmap: FELIX is moving to an
-- on-premises Supabase deployment, and self-hosted Supabase is a single
-- project. Schema-per-tenant is the strongest isolation available inside
-- one database.
--
-- SCALE, HONESTLY
-- ---------------
-- Each tenant costs ~20 tables + ~37 indexes + ~43 functions ≈ 100
-- relations. PostgREST introspects every exposed schema on reload, and
-- provisioning triggers one. At 150 tenants that is ~15k relations and a
-- reload measured in seconds; the pathological reports upstream are at
-- 67k relations and 100k schemas. So this design is comfortable into the
-- high hundreds of tenants and degrades past that. If FELIX ever
-- approaches four figures, the answer is sharding across several
-- on-prem Postgres instances, not another schema.
--
-- APPLYING THIS REQUIRES SUPERUSER (or CREATEROLE + the ability to
-- ALTER ROLE authenticator). Section 4 creates roles and section 5
-- rewrites PostgREST's in-database config. On managed Supabase run it
-- as `postgres`; on the on-prem deployment, as the bootstrap superuser.
--
-- THE ONE UNPROVEN ASSUMPTION
-- ---------------------------
-- Supabase's access-token hook documents `role` as modifiable and shows
-- it being reassigned, but its published claims schema still describes
-- role as one of `anon` | `authenticated`. Emitting `felix_<slug>` is
-- therefore supported-but-off-the-happy-path, and a GoTrue release could
-- tighten that validation. Before this design carries production
-- traffic, 0013 must prove end to end that a real login yields a JWT
-- with role = felix_<slug> AND that PostgREST switches into it. If a
-- future GoTrue rejects the custom role, the fallback is to keep
-- role = authenticated and have PostgREST's db-pre-request hook do the
-- SET ROLE from a tenant claim instead — same isolation, one more
-- moving part. Do not let that discovery happen in production.
-- ============================================================

begin;

-- ============================================================
-- 1. THE platform SCHEMA
--
-- Everything that is genuinely cross-tenant, and nothing else. Kept
-- deliberately tiny: each table here is a table that CANNOT live in a
-- tenant schema, with the reason stated. Anything that could live in a
-- tenant schema does, because every row here is a row the isolation
-- boundary does not cover.
-- ============================================================
create schema if not exists platform;

comment on schema platform is
  'Cross-tenant control plane: the tenant registry, the auth-user -> tenant map, pre-signup invitations, and migration bookkeeping. No showroom business data ever lands here.';

-- ============================================================
-- 2. THE REGISTRY
-- ============================================================

-- Moved from public.tenants (0004 §1). Same shape, same flagship UUID,
-- so the backfill in 0011 can match rows on it.
create table if not exists platform.tenants (
  id            uuid        primary key default gen_random_uuid(),
  slug          text        not null unique
                            check (slug ~ '^[a-z0-9]+$' and length(slug) between 2 and 40),
  name          text        not null,
  status        text        not null default 'active'
                            check (status in ('active','suspended')),
  licensed_via  text,
  -- Denormalised so the schema and role names have exactly one
  -- definition. Every other site derives them from here rather than
  -- re-deriving 't_' || slug and risking a mismatch after a rename.
  schema_name   text        not null unique
                            check (schema_name ~ '^t_[a-z0-9]+$'),
  role_name     text        not null unique
                            check (role_name ~ '^felix_[a-z0-9]+$'),
  created_at    timestamptz not null default now()
);

comment on table platform.tenants is
  'One licensed FELIX showroom. Provisioned by partners.508.world on licence approval; never self-registered.';

-- THE FLAGSHIP ROW IS DELIBERATELY NOT INSERTED HERE.
--
-- An earlier draft inserted it at this point, with the fixed UUID
-- carried over from 0004 so 0011's data migration could find its rows.
-- That created a registry row whose schema does not exist until 0011,
-- and two things go wrong in that window:
--
--   * sync_postgrest_schemas() (§5) builds the exposed-schema list FROM
--     this table, so it would announce t_felix to a running PostgREST
--     before anything created it.
--   * every function that interpolates schema_name into dynamic SQL —
--     handle_new_user, invite_staff, revoke_invitation in 0010 — would
--     hit a raw "schema does not exist" for the flagship.
--
-- The invariant worth holding is simply: a registry row and its schema
-- are created together, never apart. 0011 inserts this row immediately
-- before creating t_felix, and 0010 §7(e) asserts the invariant so a
-- future migration cannot quietly reintroduce the split.
--
-- The fixed UUID 00000000-0000-0000-0000-0000000f31e0 moves with it;
-- 0011 needs it to match the rows 0004 backfilled.

-- ============================================================
-- 3. WHAT CANNOT LIVE IN A TENANT SCHEMA
-- ============================================================

-- auth.users is global — there is one GoTrue for the whole deployment —
-- so the map from an auth user to their showroom has to be global too.
-- The access-token hook (0010) reads exactly this table on every token
-- issue, so it is kept to one indexed lookup and nothing else.
--
-- This is the only table that, if wrong, puts a user in the wrong
-- showroom. It is therefore service-role-only to read and write, and
-- 0010's hook is the only thing that reads it at runtime.
create table if not exists platform.tenant_users (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  tenant_id  uuid        not null references platform.tenants(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_users_tenant on platform.tenant_users(tenant_id);

comment on table platform.tenant_users is
  'auth user -> showroom. Read by the custom access token hook to decide which Postgres role a session runs as. The single most security-sensitive table in the deployment.';

-- Invitations are written BEFORE the auth user exists, so there is no
-- session to derive a tenant from and nothing to scope the row to.
-- auth.users.email is globally unique, so an invitation genuinely cannot
-- be tenant-scoped without allowing the same address into two showrooms.
create table if not exists platform.staff_invitations (
  email       text        primary key,
  tenant_id   uuid        not null references platform.tenants(id) on delete cascade,
  full_name   text        not null,
  role        text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor')),
  branch_id   uuid,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

comment on table platform.staff_invitations is
  'Pre-signup role/branch/tenant assignment. branch_id is intentionally NOT a foreign key: branches live in the tenant schema, which this table cannot reference.';

-- Abuse control is a property of the deployment, not of a showroom: a
-- caller hammering the referral endpoint must be throttled whether or
-- not they have picked a tenant, and a per-tenant bucket would let an
-- attacker reset their limit by switching subdomains.
create table if not exists platform.rate_limit_buckets (
  bucket_key   text        primary key,
  window_start timestamptz not null default now(),
  hits         int         not null default 0
);

create index if not exists idx_platform_rate_limit_window
  on platform.rate_limit_buckets(window_start);

-- Per-schema migration bookkeeping. With N schemas the question that
-- matters is no longer "has this migration run" but "which schemas is it
-- missing from" — a tenant provisioned mid-rollout is the normal way
-- drift appears. 0012's runner writes here; its drift report reads here.
create table if not exists platform.schema_migrations (
  schema_name text        not null,
  version     text        not null,
  applied_at  timestamptz not null default now(),
  primary key (schema_name, version)
);

-- ============================================================
-- 4. THE TENANT ROLE
--
-- The mechanism the whole design rests on. One NOLOGIN role per
-- showroom, granted to `authenticator` so PostgREST may SET ROLE into
-- it when a JWT names it.
--
-- NOINHERIT is deliberate and load-bearing. Without it a tenant role
-- would inherit whatever `authenticator` can reach; with it, the role
-- holds exactly the privileges granted to it by name in
-- create_tenant_schema() and nothing else.
-- ============================================================
create or replace function platform.create_tenant_role(p_slug text)
returns text as $$
declare
  v_role text := 'felix_' || p_slug;
begin
  if p_slug !~ '^[a-z0-9]+$' then
    raise exception 'Illegal tenant slug %', p_slug
      using hint = 'Slugs are lowercase alphanumeric; they become identifiers.';
  end if;

  -- CREATE ROLE has no IF NOT EXISTS, and provisioning must be
  -- idempotent because an approval on partners.508.world can be retried
  -- after a network timeout.
  if not exists (select 1 from pg_roles where rolname = v_role) then
    execute format('create role %I nologin noinherit', v_role);
  end if;

  -- What lets PostgREST become this role. Without it a JWT naming the
  -- role produces a 500 rather than a session.
  execute format('grant %I to authenticator', v_role);

  -- Belt and braces: a tenant role must never reach the control plane.
  -- Section 6 revokes this globally, but a role created later would
  -- otherwise pick up any default privileges granted in between.
  execute format('revoke all on schema platform from %I', v_role);

  return v_role;
end;
-- search_path deliberately does NOT name `public`. This is the most
-- privileged function in the provisioning chain — it runs CREATE ROLE and
-- GRANT ... TO authenticator as its definer — and 0009's whole thesis is
-- that a SECURITY DEFINER function naming `public` is a hijack surface.
-- Nothing in this body needs public, and 0009's assertion (d) cannot see
-- this function (it scopes itself to the tenant schema), so the rule has
-- to be applied here by hand rather than caught.
$$ language plpgsql security definer set search_path = pg_catalog, platform;

comment on function platform.create_tenant_role(text) is
  'Creates the NOLOGIN role a showroom''s sessions run as. Idempotent. The role gets its privileges from create_tenant_schema(), never from inheritance.';

-- ============================================================
-- 5. POSTGREST EXPOSURE
--
-- PostgREST only serves schemas named in `db-schemas`. On managed
-- Supabase that is a dashboard field; here it is in-database config on
-- the authenticator role, which is reloadable — so provisioning a
-- showroom exposes its schema from SQL, with no restart and no config
-- management outside the database.
--
-- Recomputed from platform.tenants in full rather than appended to, so
-- the exposed list cannot drift from the registry: a suspended or
-- deleted tenant disappears from the API on the next call.
--
-- `platform` is exposed but not reachable: section 6 leaves anon and
-- authenticated with no privilege on it, and no tenant role is granted
-- anything there. Only service_role can address it, which is what the
-- provisioning route and getTenant() need.
-- ============================================================
create or replace function platform.sync_postgrest_schemas()
returns text as $$
declare
  v_schemas text;
begin
  select string_agg(schema_name, ', ' order by schema_name)
    into v_schemas
    from platform.tenants
   where status = 'active';

  v_schemas := 'platform' || coalesce(', ' || v_schemas, '');

  execute format(
    'alter role authenticator set pgrst.db_schemas = %L', v_schemas);

  -- Transactional: delivered on COMMIT, so a rolled-back provisioning
  -- never tells PostgREST about a schema that does not exist.
  notify pgrst, 'reload config';
  notify pgrst, 'reload schema';

  return v_schemas;
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform;

comment on function platform.sync_postgrest_schemas() is
  'Recomputes PostgREST''s exposed-schema list from the tenant registry and reloads it in place. Called at the end of every provision, suspend, and resume.';

-- ============================================================
-- 6. LOCKDOWN
--
-- The assertion the design depends on: `authenticated` and `anon` hold
-- nothing anywhere that matters. Every privilege a session has comes
-- from its tenant role.
--
-- Supabase grants `authenticated` broad default privileges on `public`,
-- which is exactly why business data is leaving `public` entirely rather
-- than staying there behind new GRANTs.
-- ============================================================
revoke all on schema platform from public, anon, authenticated;
revoke all on all tables in schema platform from public, anon, authenticated;
revoke all on all functions in schema platform from public, anon, authenticated;
revoke all on all sequences in schema platform from public, anon, authenticated;

-- Future objects in `platform` inherit the same default.
alter default privileges in schema platform
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema platform
  revoke all on functions from public, anon, authenticated;

-- service_role is the control plane's only client: the provisioning
-- route, getTenant(), and the migration runner.
grant usage on schema platform to service_role;
grant all on all tables in schema platform to service_role;
grant all on all sequences in schema platform to service_role;
alter default privileges in schema platform grant all on tables to service_role;
alter default privileges in schema platform grant all on sequences to service_role;

-- supabase_auth_admin runs the access-token hook (0010) and the
-- on_auth_user_created trigger, both of which read this schema. Granted
-- narrowly rather than via service_role.
grant usage on schema platform to supabase_auth_admin;
grant select on platform.tenants, platform.tenant_users to supabase_auth_admin;
grant select, insert, update on platform.staff_invitations to supabase_auth_admin;
grant insert on platform.tenant_users to supabase_auth_admin;

-- Nobody creates objects in `platform` except a migration running as
-- superuser. This is what stops a future migration from absent-mindedly
-- adding a business table to the control plane.
revoke create on schema platform from public;

-- ============================================================
-- 7. GUARD — the property this migration exists to establish
--
-- Fails the transaction if `authenticated` can reach the control plane.
-- Cheap to assert now, and 0013 re-asserts it against every tenant
-- schema once they exist.
-- ============================================================
do $$
declare
  n int;
begin
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'platform'
     and grantee in ('authenticated', 'anon', 'PUBLIC');

  if n > 0 then
    raise exception
      'Lockdown failed: % privilege(s) on platform.* still held by anon/authenticated', n;
  end if;

  if has_schema_privilege('authenticated', 'platform', 'usage') then
    raise exception 'Lockdown failed: authenticated retains USAGE on schema platform';
  end if;
end $$;

commit;

-- Deliberately outside the transaction. This is the one step that
-- reaches out of the database and changes the behaviour of a running
-- PostgREST; keeping it separate means a failed or slow reload is an
-- operational problem to retry, not a reason the schema above rolls
-- back. Re-runnable at any time — it recomputes from the registry.
select platform.sync_postgrest_schemas();
