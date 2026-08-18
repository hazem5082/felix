-- ============================================================
-- 0010 — IDENTITY: THE ROLE CLAIM, SIGNUP, PROVISIONING, AND THE
--        INVITATION GATE
--
-- 0008 built the control plane and the per-tenant roles; 0009 built the
-- schemas. Neither is reachable yet, because nothing puts a user INTO a
-- tenant role. This migration is the join between an authenticated
-- identity and the Postgres role its queries run as, and it is where the
-- whole design either holds or quietly stops holding.
--
-- FOUR THINGS, ALL LOAD-BEARING
-- -----------------------------
--  1. custom_access_token_hook() — GoTrue calls it on every token issue
--     and rewrites `role` from `authenticated` to felix_<slug>.
--     PostgREST SET ROLEs into that, and 0009 §6's GRANTs become the
--     boundary. A missing claim leaves `authenticated`, which holds
--     nothing anywhere: "sees nothing", never "sees another showroom".
--  2. platform.handle_new_user() — rewritten because it now writes
--     ACROSS schemas: the tenant map in `platform`, the profile in
--     t_<slug>.
--  3. platform.provision_tenant() — 0009's header delegates the rewrite
--     here. Without it /api/provision still writes to public.* and a new
--     showroom's CEO cannot sign up at all.
--  4. invite_staff() / revoke_invitation() — successor to 0003's
--     `staff_invitations_ceo`, which 0009 §5 recorded as owed.
--
-- WHY 4 IS NOT OPTIONAL
-- --------------------
-- 0003 put a CEO-only RLS policy on staff_invitations, and
-- employees/actions.ts:57 deliberately inserts through the CEO's OWN
-- session so it applies — the service role plays no part in deciding
-- what a new account becomes. handle_new_user() reads the invitation to
-- assign role, branch and tenant, so whoever writes one can mint a CEO.
-- The table now lives in `platform`, which no tenant role may read or
-- write, so left alone the invite path would run as service_role and the
-- only surviving CEO check would be authorize(["ceo"]) in TypeScript.
-- The control is restored here as SECURITY DEFINER RPCs that re-derive
-- the caller's tenant from auth.uid() and re-check is_ceo() inside that
-- tenant's own schema.
--
-- TWO THINGS THIS MIGRATION DOES NOT FIX, DELIBERATELY
-- ----------------------------------------------------
--  * An invitation is still a BEARER CREDENTIAL whose only secret is the
--    employee's email address: handle_new_user() honours it for any
--    auth.users insert, including a public /auth/v1/signup. Expiry (§1)
--    bounds the window, but the real fix is either a one-time token in
--    user_metadata or disabling public signup in GoTrue. Tracked, not
--    done here, because it changes the app's create-employee flow.
--  * The `role`-claim rewrite is unverified against real GoTrue. See
--    0008's header for the db-pre-request fallback.
-- ============================================================

begin;

-- ============================================================
-- 1. INVITATION SHAPE
-- ============================================================

-- 0003 defined invited_by and employees/actions.ts:62 still writes it;
-- it was lost when the table moved to `platform`. profiles is per-tenant
-- now so a FK to it is impossible, and auth.users is the better referent
-- anyway — the subject is a person, not a showroom membership.
alter table platform.staff_invitations
  add column if not exists invited_by uuid references auth.users(id) on delete set null;

-- The FK above nulls on delete, which erases the audit fact at exactly
-- the moment it matters: working out how an account got privileges it
-- should not have, after the person who granted them is gone. Keep the
-- FK for referential sanity and snapshot the fact independently.
alter table platform.staff_invitations
  add column if not exists invited_by_email text;

-- Bounds the bearer-credential window described in the header. Not a
-- fix, a limit: an invitation that leaks is useful for 7 days rather
-- than forever.
alter table platform.staff_invitations
  add column if not exists expires_at timestamptz not null default now() + interval '7 days';

-- RE-KEYING, and why the old key was wrong.
--
-- 0008 kept 0003's `primary key (email)` on the reasoning that
-- auth.users.email is globally unique, so one address cannot be invited
-- into two showrooms. True, but it makes an ACCEPTED invitation occupy
-- that address forever: there is no code path that deletes one, so an
-- employee who leaves and is re-hired can never be invited again, and
-- one showroom permanently blocks every other from onboarding that
-- address.
--
-- The property actually needed is narrower: an address may be PENDING in
-- at most one showroom. A partial unique index says exactly that and
-- frees accepted rows.
--
-- The index is on lower(btrim(email)) because that is how the row is
-- looked up. With the key on raw `email`, 'Bob@x.com' and 'bob@x.com'
-- could both exist while handle_new_user() matched on lower() — two
-- rows, arbitrary winner, and a user silently placed in the wrong
-- showroom. Lookup key and uniqueness key must be the same expression.
update platform.staff_invitations set email = lower(btrim(email))
 where email <> lower(btrim(email));

alter table platform.staff_invitations drop constraint if exists staff_invitations_pkey;
alter table platform.staff_invitations
  add constraint staff_invitations_pkey primary key (tenant_id, email);

create unique index if not exists uq_staff_invitations_pending_email
  on platform.staff_invitations (lower(btrim(email)))
  where accepted_at is null;

alter table platform.staff_invitations
  drop constraint if exists staff_invitations_email_normalised;
alter table platform.staff_invitations
  add constraint staff_invitations_email_normalised
  check (email = lower(btrim(email)));

-- ============================================================
-- 2. THE ACCESS TOKEN HOOK
--
-- Input : {"user_id": uuid, "claims": {...}, "authentication_method":...}
-- Output: {"claims": {...}}
--
-- FAIL-CLOSED BY OMISSION. Every path that cannot confidently name a
-- tenant returns the caller's claims UNCHANGED, leaving role =
-- `authenticated`, which holds nothing on any tenant schema. There is no
-- `raise` anywhere in this function: an exception fails the token issue,
-- which would lock every user of every showroom out of the product.
-- Degrading one session to no-access beats an outage.
--
-- A SUSPENDED TENANT takes the same path, which is how a licence lapse
-- is enforced — the next token carries no tenant role and the showroom
-- goes dark without deleting anything.
-- ============================================================
create or replace function platform.custom_access_token_hook(event jsonb)
returns jsonb as $$
declare
  v_claims jsonb := event->'claims';
  v_out    jsonb;
  v_uid    uuid;
  t        platform.tenants%rowtype;
begin
  -- NEVER SYNTHESISE A CLAIMS OBJECT. GoTrue REPLACES the token's claims
  -- with whatever this returns — it does not merge. An earlier draft
  -- opened with `coalesce(event->'claims','{}')`, which produced two
  -- opposite failures on inputs that are not exactly what GoTrue sends
  -- today, both reproduced against Postgres 16:
  --
  --   claims key ABSENT  -> returned {"role":...,"felix_tenant":...} and
  --     nothing else. A fabricated token: no sub, no exp, no aud. Either
  --     GoTrue rejects it against its minimum-viable-token schema and
  --     every login everywhere fails, or a build that relaxes that check
  --     mints a never-expiring token holding a tenant role whose
  --     auth.uid() is NULL — inverting the entire fail-closed premise.
  --   claims = JSON null -> `cannot set path in scalar`, an uncaught
  --     exception: the deployment-wide outage this section promises not
  --     to cause. coalesce cannot catch it — JSON null is not SQL NULL.
  --
  -- GoTrue marshals Claims from a pointer, so `"claims": null` is a shape
  -- a nil pointer genuinely produces. Hence a type check, not a coalesce.
  if jsonb_typeof(v_claims) is distinct from 'object' then
    return jsonb_build_object('claims', coalesce(v_claims, '{}'::jsonb));
  end if;

  -- Captured BEFORE any rewriting so the handler below cannot return a
  -- half-modified claims object.
  v_out := jsonb_build_object('claims', v_claims);

  -- A claims object with no subject is not a token worth upgrading.
  -- Granting a tenant role to a session whose auth.uid() will be NULL is
  -- the worst available combination: every owner check inside t_<slug>
  -- compares against NULL while the GRANTs say "come in".
  if coalesce(v_claims->>'sub', '') = '' then
    return v_out;
  end if;

  -- The handler spans the platform.* reads, not just the uuid cast. The
  -- paragraph above promises no exception escapes; an ALTER TABLE on the
  -- control plane, a permission change, or a missing schema during a
  -- migration window would otherwise take down every login in every
  -- showroom — the precise scenario the promise exists for.
  begin
    v_uid := (event->>'user_id')::uuid;
    if v_uid is null then
      return v_out;
    end if;

    select tn.* into t
      from platform.tenant_users tu
      join platform.tenants tn on tn.id = tu.tenant_id
     where tu.user_id = v_uid
       and tn.status = 'active';

    if not found then
      return v_out;
    end if;

    v_claims := jsonb_set(v_claims, '{role}', to_jsonb(t.role_name));

    -- Carried so the app can choose the schema for PostgREST's
    -- Accept-Profile without a second round trip, and so it can tell "no
    -- tenant" from "tenant, but empty". Authoritative in a way the
    -- hostname is not: this comes from the user's own membership row,
    -- whereas the subdomain is attacker-supplied routing (see
    -- src/lib/tenant.ts). Where the two disagree, this one is right.
    v_claims := jsonb_set(v_claims, '{felix_tenant}', jsonb_build_object(
      'slug', t.slug, 'schema', t.schema_name));

    return jsonb_build_object('claims', v_claims);
  exception when others then
    return v_out;
  end;
end;
$$ language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp;

revoke all on function platform.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function platform.custom_access_token_hook(jsonb) to supabase_auth_admin;

comment on function platform.custom_access_token_hook(jsonb) is
  'Rewrites the JWT role claim to the caller''s tenant role. Register at Authentication > Hooks. Fails closed by returning claims unchanged, leaving role=authenticated, which holds no privilege on any tenant schema.';

-- ============================================================
-- 3. SIGNUP
--
-- Same rail as 0003/0004: role, branch and tenant come ONLY from an
-- invitation row, never from user metadata. What changes is that the
-- profile lands in a different SCHEMA depending on which invitation
-- matched, so the insert is dynamic.
--
-- Created in `platform`, not `public`. It runs as its definer, writes
-- platform.tenant_users, and issues dynamic INSERTs into arbitrary
-- t_*.profiles — leaving it in the one schema where `authenticated`
-- holds broad default privileges would contradict 0009's entire thesis.
-- ============================================================
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

create or replace function platform.handle_new_user()
returns trigger as $$
declare
  inv    platform.staff_invitations%rowtype;
  t      platform.tenants%rowtype;
  v_name text;
  v_ok   boolean;
begin
  -- Matches the partial unique index from §1, so at most one row can
  -- qualify; the ORDER BY makes a multi-match deterministic anyway if a
  -- future migration ever relaxes that index.
  select * into inv
    from platform.staff_invitations
   where lower(btrim(email)) = lower(btrim(new.email))
     and accepted_at is null
   order by created_at
   limit 1;

  if not found then
    raise exception
      'No invitation exists for % — FELIX accounts are created by invitation only (NO_INVITATION)', new.email;
  end if;

  if inv.expires_at <= now() then
    raise exception
      'The invitation for % expired on % (INVITATION_EXPIRED)', new.email, inv.expires_at;
  end if;

  select * into t from platform.tenants where id = inv.tenant_id;
  if not found then
    raise exception 'Invitation for % names tenant % which does not exist', new.email, inv.tenant_id;
  end if;

  -- invite_staff() and revoke_invitation() both refuse on a suspended
  -- showroom; without this, the third door into the same control plane
  -- would stay open and an unlicensed showroom could still take on staff.
  if t.status <> 'active' then
    raise exception
      'The showroom this invitation belongs to is not active (TENANT_SUSPENDED)';
  end if;

  -- The schema is about to be interpolated into dynamic SQL. It comes
  -- from the registry, whose CHECK constrains it, but this function runs
  -- as its definer on a path reachable by anyone who can create an auth
  -- user, so it does not take the registry's word for it.
  if t.schema_name !~ '^t_[a-z0-9]+$' then
    raise exception 'Registry holds a malformed schema name for tenant %', t.slug;
  end if;

  if to_regnamespace(t.schema_name) is null then
    raise exception
      'Tenant % names schema % which does not exist (TENANT_SCHEMA_MISSING)', t.slug, t.schema_name;
  end if;

  -- The branch was validated when the invitation was written; it can
  -- have been deleted since. Without this the failure surfaces as a raw
  -- foreign-key violation from inside a trigger on auth.users.
  if inv.branch_id is not null then
    execute format('select exists (select 1 from %I.branches where id = $1)', t.schema_name)
      into v_ok using inv.branch_id;
    if not v_ok then
      raise exception
        'The branch this invitation was issued for no longer exists (BRANCH_GONE)';
    end if;
  end if;

  v_name := coalesce(nullif(inv.full_name, ''), new.raw_user_meta_data->>'full_name', new.email);

  -- The membership row FIRST: it is what the access token hook reads, and
  -- a profile without it produces a user who authenticates and never
  -- receives a tenant role.
  insert into platform.tenant_users (user_id, tenant_id)
  values (new.id, t.id)
  on conflict (user_id) do nothing;

  execute format(
    'insert into %I.profiles (id, full_name, role, branch_id) values ($1,$2,$3,$4) on conflict (id) do nothing',
    t.schema_name)
    using new.id, v_name, inv.role, inv.branch_id;

  if inv.role = 'investor' then
    execute format('insert into %I.investors (id) values ($1) on conflict (id) do nothing',
      t.schema_name) using new.id;
  end if;

  update platform.staff_invitations
     set accepted_at = now()
   where tenant_id = inv.tenant_id and email = inv.email;

  return new;
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

revoke all on function platform.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function platform.handle_new_user();

-- ============================================================
-- 4. PROVISIONING
--
-- 0009's header delegates the rewrite of 0004 §8's provision_tenant()
-- here. src/app/api/provision/route.ts:109 still calls it by name, so
-- without this the licence-approval path writes to public.* and a new
-- showroom's CEO can never sign up.
--
-- Ordering is the contract 0009 §2 asserts: registry row FIRST, then the
-- schema (create_tenant_schema refuses without it, because
-- sync_postgrest_schemas builds the exposed list from the registry and a
-- schema with no row would be created correctly and never served).
--
-- sync_postgrest_schemas() is deliberately NOT called here — 0008 keeps
-- it outside the transaction so a rolled-back provision never announces
-- a schema that does not exist. The caller runs it after COMMIT.
-- ============================================================
drop function if exists public.provision_tenant(text, text, text, text, text, text);

create or replace function platform.provision_tenant(
  p_slug              text,
  p_name              text,
  p_ceo_email         text,
  p_ceo_full_name     text,
  p_first_branch_name text default 'Main Showroom',
  p_licensed_via      text default '508.world'
) returns jsonb as $$
declare
  t          platform.tenants%rowtype;
  v_created  boolean := false;
  v_branch   uuid;
  v_schema   text;
begin
  if p_slug !~ '^[a-z0-9]+$' or length(p_slug) not between 2 and 40 then
    raise exception 'Illegal tenant slug %', coalesce(quote_literal(p_slug), 'NULL');
  end if;

  select * into t from platform.tenants where slug = p_slug;

  if not found then
    insert into platform.tenants (slug, name, licensed_via, schema_name, role_name)
    values (p_slug, p_name, p_licensed_via, 't_' || p_slug, 'felix_' || p_slug)
    returning * into t;
    v_created := true;
  end if;

  -- Idempotent (0009 §2), so a retried approval after a network timeout
  -- converges instead of erroring or making a second showroom.
  v_schema := platform.create_tenant_schema(p_slug);

  execute format('select id from %I.branches order by created_at limit 1', v_schema)
    into v_branch;

  -- create_tenant_schema seeds the first branch, so this should always
  -- find one; renaming it is the only thing left to do.
  if v_branch is not null and p_first_branch_name is not null then
    execute format('update %I.branches set name = $1 where id = $2 and name = $3', v_schema)
      using p_first_branch_name, v_branch, 'Main Showroom';
  end if;

  -- The invitation is what makes the about-to-be-created auth user a CEO
  -- of this tenant. Written directly rather than through invite_staff()
  -- because there is no CEO yet to authorise it — this is the one
  -- legitimate service-role write to the table, and it is why
  -- provision_tenant is service-role only.
  insert into platform.staff_invitations
    (tenant_id, email, full_name, role, branch_id, expires_at)
  values
    (t.id, lower(btrim(p_ceo_email)), p_ceo_full_name, 'ceo', v_branch,
     now() + interval '7 days')
  on conflict (tenant_id, email) do update
     set full_name   = excluded.full_name,
         role        = excluded.role,
         branch_id   = excluded.branch_id,
         expires_at  = excluded.expires_at,
         accepted_at = null
   where platform.staff_invitations.accepted_at is null;

  return jsonb_build_object(
    'tenant_created', v_created,
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status),
    'schema_name', v_schema,
    'branch_id', v_branch,
    'ceo_email', lower(btrim(p_ceo_email))
  );
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

-- Licensing action, never self-service.
revoke all on function platform.provision_tenant(text,text,text,text,text,text)
  from public, anon, authenticated;

-- ============================================================
-- 5. THE INVITATION GATE — successor to 0003's staff_invitations_ceo
--
-- The caller's tenant is derived from platform.tenant_users using
-- auth.uid(), never from a parameter, so a CEO of showroom A cannot
-- invite into showroom B by passing a different id — there is no id to
-- pass. The CEO check executes INSIDE the caller's own tenant schema.
-- ============================================================
create or replace function platform.invite_staff(
  p_email     text,
  p_full_name text,
  p_role      text,
  p_branch_id uuid default null
) returns void as $$
declare
  v_uid    uuid := auth.uid();
  t        platform.tenants%rowtype;
  v_is_ceo boolean;
  v_ok     boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select tn.* into t
    from platform.tenant_users tu
    join platform.tenants tn on tn.id = tu.tenant_id
   where tu.user_id = v_uid;

  if not found then
    raise exception 'This account does not belong to a showroom';
  end if;

  if t.status <> 'active' then
    raise exception 'This showroom is suspended';
  end if;

  execute format(
    'select exists (select 1 from %I.profiles where id = $1 and role = ''ceo'')', t.schema_name)
    into v_is_ceo using v_uid;

  if not v_is_ceo then
    raise exception 'Only the CEO can invite staff';
  end if;

  if p_role not in ('ceo','accountant','branch_manager','sales_exec','investor') then
    raise exception 'Unknown role %', p_role;
  end if;

  -- A branch id arrives from the client. Without this it could name
  -- another showroom's branch, which handle_new_user() would then read
  -- back as this tenant's.
  if p_branch_id is not null then
    execute format('select exists (select 1 from %I.branches where id = $1)', t.schema_name)
      into v_ok using p_branch_id;
    if not v_ok then
      raise exception 'Unknown branch';
    end if;
  end if;

  insert into platform.staff_invitations
    (email, tenant_id, full_name, role, branch_id, invited_by, invited_by_email,
     expires_at)
  values
    (lower(btrim(p_email)), t.id, p_full_name, p_role, p_branch_id, v_uid,
     (select u.email from auth.users u where u.id = v_uid),
     now() + interval '7 days');

exception
  -- The pending-email index is GLOBAL, so a raw unique violation would
  -- tell showroom A that showroom B has a pending invitation for an
  -- address — a cross-tenant existence oracle reachable by any CEO. Same
  -- message whichever tenant holds the row.
  when unique_violation then
    raise exception 'That email address is unavailable'
      using hint = 'It may already be invited or registered.';
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

-- The rollback half. employees/actions.ts:87 deletes the invitation when
-- auth user creation fails, so that path needs its own gate — otherwise
-- the compensating action becomes a way to delete any showroom's pending
-- invitation by knowing an email address.
create or replace function platform.revoke_invitation(p_email text)
returns void as $$
declare
  v_uid    uuid := auth.uid();
  t        platform.tenants%rowtype;
  v_is_ceo boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select tn.* into t
    from platform.tenant_users tu
    join platform.tenants tn on tn.id = tu.tenant_id
   where tu.user_id = v_uid;

  if not found then
    raise exception 'This account does not belong to a showroom';
  end if;

  -- Suspended showrooms are refused here too. The two halves of one gate
  -- disagreeing about whether a suspended tenant may mutate the control
  -- plane is the kind of asymmetry that becomes a bug report years later.
  if t.status <> 'active' then
    raise exception 'This showroom is suspended';
  end if;

  execute format(
    'select exists (select 1 from %I.profiles where id = $1 and role = ''ceo'')', t.schema_name)
    into v_is_ceo using v_uid;

  if not v_is_ceo then
    raise exception 'Only the CEO can revoke an invitation';
  end if;

  -- Scoped to the caller's own tenant AND to invitations not yet taken
  -- up: once accepted, the row records how an existing account got its
  -- privileges, and deleting it would erase that.
  delete from platform.staff_invitations
   where lower(btrim(email)) = lower(btrim(p_email))
     and tenant_id = t.id
     and accepted_at is null;
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

-- ============================================================
-- 6. REACHING THE GATE
--
-- A tenant session runs as felix_<slug>, which 0008 §4 strips of
-- everything on `platform`. So the two RPCs above are, as written,
-- uncallable by the only role that should call them.
--
-- The opening is as narrow as it can be: USAGE on the schema, EXECUTE on
-- exactly two functions, and no table privilege of any kind — a tenant
-- role still cannot read platform.tenants or platform.tenant_users,
-- which is what would let one showroom enumerate the others.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. 0008 §6 set an
-- ALTER DEFAULT PRIVILEGES entry that revokes it, but that entry is
-- scoped to the role that created it, and `revoke ... from <tenant role>`
-- cannot strip a grant held by PUBLIC. Until 0010 that was inert,
-- because no tenant role had USAGE on the schema; granting USAGE makes
-- it live. Hence the explicit PUBLIC revokes below rather than trust in
-- the default-privilege entry.
-- ============================================================
revoke all on function platform.invite_staff(text,text,text,uuid)
  from public, anon, authenticated;
revoke all on function platform.revoke_invitation(text)
  from public, anon, authenticated;
revoke all on function platform.handle_new_user() from public, anon, authenticated;

create or replace function platform.create_tenant_role(p_slug text)
returns text as $$
declare
  v_role text := 'felix_' || p_slug;
  n      int;
begin
  if p_slug !~ '^[a-z0-9]+$' then
    raise exception 'Illegal tenant slug %', p_slug
      using hint = 'Slugs are lowercase alphanumeric; they become identifiers.';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
    execute format('create role %I nologin noinherit', v_role);
  end if;

  execute format('grant %I to authenticator', v_role);

  -- Reset first, so this stays the single definition of what a tenant
  -- role may reach in the control plane rather than accumulating grants
  -- across migrations. PUBLIC is stripped from the two RPCs above rather
  -- than here, because a per-role revoke cannot touch a PUBLIC grant.
  execute format('revoke all on schema platform from %I', v_role);
  execute format('revoke all on all tables in schema platform from %I', v_role);
  execute format('revoke all on all functions in schema platform from %I', v_role);

  execute format('grant usage on schema platform to %I', v_role);
  execute format('grant execute on function platform.invite_staff(text,text,text,uuid) to %I', v_role);
  execute format('grant execute on function platform.revoke_invitation(text) to %I', v_role);

  -- The reset above revokes by name; a future migration that adds a
  -- grant without adding it here would have it silently destroyed on the
  -- next re-provision, surfacing as one showroom whose CEO cannot invite
  -- anyone. Assert the outcome rather than trusting the sequence.
  select count(*) into n
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform'
     and has_function_privilege(v_role, p.oid, 'execute');

  if n <> 2 then
    raise exception
      'Tenant role % ends with EXECUTE on % platform function(s), expected exactly 2 (invite_staff, revoke_invitation)', v_role, n;
  end if;

  return v_role;
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

-- Existing tenant roles predate the grants above.
do $$
declare r record;
begin
  for r in select slug from platform.tenants loop
    perform platform.create_tenant_role(r.slug);
  end loop;
end $$;

-- ============================================================
-- 7. GUARD
-- ============================================================
do $$
declare
  n         int;
  r         record;
  v_missing text;
begin
  -- (a) Exactly ONE hook definition. GoTrue invokes it with an untyped
  --     argument, so any overload makes the call ambiguous and breaks
  --     100% of logins — and a signature-specific check cannot see one.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'custom_access_token_hook';
  if n <> 1 then
    raise exception
      'platform.custom_access_token_hook has % definitions — GoTrue calls it untyped, so any overload makes that call ambiguous', n;
  end if;

  -- (b) The hook is callable by GoTrue and nobody else.
  if not has_function_privilege('supabase_auth_admin',
        'platform.custom_access_token_hook(jsonb)', 'execute') then
    raise exception 'supabase_auth_admin cannot execute the access token hook — GoTrue would fail every login';
  end if;

  for r in select unnest(array['anon','authenticated','public']) as who loop
    if has_function_privilege(r.who, 'platform.custom_access_token_hook(jsonb)', 'execute') then
      raise exception
        'Role % can execute the access token hook — it would reveal which showroom any user_id belongs to', r.who;
    end if;
  end loop;

  -- (c) Tenant roles reach EXACTLY the two RPCs and nothing else.
  --     Asserted as a complement — count every platform function the role
  --     can execute — rather than by naming the functions it must not
  --     reach. A deny-list only catches what it happens to name, and this
  --     is the property §6's whole design rests on.
  -- Iterates the REGISTRY, not `pg_roles like 'felix\_%'`. Roles are
  -- cluster-wide while tenants are per-database, so a name-pattern scan
  -- picks up roles belonging to other databases in the same cluster —
  -- which this migration has neither the right nor the ability to
  -- configure. Found by applying to a cluster that still held roles from
  -- an earlier test database. platform.tenants is the authoritative list
  -- of the roles THIS database owns.
  for r in select role_name as rolname from platform.tenants loop
    if not has_function_privilege(r.rolname, 'platform.invite_staff(text,text,text,uuid)', 'execute')
       or not has_function_privilege(r.rolname, 'platform.revoke_invitation(text)', 'execute') then
      raise exception 'Tenant role % cannot call both invitation RPCs — its CEO could not add or roll back staff', r.rolname;
    end if;

    select count(*) into n
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'platform'
       and has_function_privilege(r.rolname, p.oid, 'execute');

    if n <> 2 then
      raise exception
        'Tenant role % can execute % platform functions, expected exactly 2 — provisioning and hook functions must be unreachable', r.rolname, n;
    end if;

    select count(*) into n
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'platform'
       and c.relkind in ('r','p')
       and has_table_privilege(r.rolname, c.oid,
             'select, insert, update, delete, references, trigger, truncate');

    if n > 0 then
      raise exception
        'Tenant role % holds privileges on % platform table(s) — it must reach the control plane only through SECURITY DEFINER functions', r.rolname, n;
    end if;
  end loop;

  -- (d) The signup trigger is attached AND points at the right function.
  --     0003 §12 was written after a probe found functions present and
  --     their triggers absent; a function that compiles and a function
  --     that runs are different claims. Checking tgfoid too, because a
  --     stale public.handle_new_user() would satisfy a name-only check.
  if not exists (
    select 1 from pg_trigger tg
     where tg.tgname = 'on_auth_user_created'
       and not tg.tgisinternal
       and tg.tgfoid = 'platform.handle_new_user()'::regprocedure
  ) then
    raise exception 'on_auth_user_created is missing or does not point at platform.handle_new_user()';
  end if;

  -- (e) Every registered tenant has a schema. handle_new_user,
  --     invite_staff and revoke_invitation all interpolate schema_name
  --     into dynamic SQL; a registry row without a schema surfaces as a
  --     raw "schema does not exist" from inside a trigger on auth.users.
  --     0008 inserts the flagship row and 0011 creates its schema, so
  --     applying this migration before 0011 is precisely the window.
  select string_agg(slug || ' -> ' || schema_name, ', ') into v_missing
    from platform.tenants where to_regnamespace(schema_name) is null;
  if v_missing is not null then
    raise exception
      'Registered tenant(s) with no schema: %. A registry row must never exist without its schema — provision through platform.provision_tenant()', v_missing;
  end if;
end $$;

commit;
