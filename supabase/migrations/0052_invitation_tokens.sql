-- ============================================================
-- 0052 — INVITATIONS BEAR A ONE-TIME SECRET
--
-- Closes the hole 0010 §"TWO THINGS THIS MIGRATION DOES NOT FIX"
-- tracked and left open: an invitation was a bearer credential whose
-- ONLY secret was the employee's email address. platform.handle_new_user()
-- honoured any pending invitation on a plain POST /auth/v1/signup — no
-- token, no proof, just an address anyone could learn from a business
-- card or a CC line. First-come-wins: whoever registered before the real
-- hire inherited the role, including ceo and accountant, inside a
-- showroom that moves money.
--
-- THE MECHANISM
-- -------------
-- An invitation row now carries SHA-256(invite_token), never the token
-- itself — the same shape trusted_devices already uses for its codes
-- (0038). The plaintext token exists in exactly two places:
--   * the RETURN VALUE of platform.invite_staff() /
--     platform.provision_tenant(), consumed server-side by the app;
--   * signup user_metadata.invite_token, attached by this application
--     in the same request that creates the auth user.
-- A public signup without a matching token now FAILS. The email match
-- alone buys nothing.
--
-- WHY THE APP FLOW DOES NOT CHANGE VISIBLY
-- ----------------------------------------
-- createEmployee() and /api/provision create the auth user themselves
-- (admin.createUser) seconds after writing the invitation, so they pass
-- the token from the RPC result straight into user_metadata over a
-- service-role channel. The CEO still types only name/email/role; the
-- token never appears in a UI, a log, or an email.
--
-- LEGACY PENDING INVITATIONS ARE DELIBERATELY BROKEN
-- ---------------------------------------------------
-- Rows written before this file have no digest. handle_new_user()
-- refuses them loudly (INVITATION_LEGACY_NO_TOKEN) rather than waving
-- them through — grandfathering would preserve exactly the door this
-- closes, and an unaccepted invitation is at most seven days old by
-- expiry. Re-inviting takes one click and mints a fresh token.
--
-- COMPARISON IS NOT CONSTANT-TIME
-- --------------------------------
-- The digest compare inside Postgres uses `=`. Timing attacks across
-- GoTrue + network jitter against a sha256 preimage are not a credible
-- path, and the secret being protected is the preimage, not the digest.
-- Documented so nobody "fixes" it into something slower and equally
-- unprovable.
--
-- SIGNATURES ARE UNCHANGED
-- ------------------------
-- invite_staff keeps (text,text,text,uuid) — return type void→text does
-- not alter identity arguments, so every EXECUTE grant created by
-- create_tenant_role() (0010 §6) stays valid untouched.
-- ============================================================

begin;

-- ============================================================
-- 1. THE DIGEST COLUMN
-- ============================================================
alter table platform.staff_invitations
  add column if not exists invite_token_digest text;

comment on column platform.staff_invitations.invite_token_digest is
  'SHA-256 hex of the one-time signup token. The plaintext is returned once by invite_staff()/provision_tenant() and passed to GoTrue as signup user_metadata; it is never stored.';

-- ============================================================
-- 2. INVITE_STAFF RETURNS A TOKEN
--
-- Body unchanged except for generation + return; every guard (tenant
-- derivation, suspension, is_ceo, role whitelist, branch validation,
-- the collapsed unique violation) is carried over verbatim from 0010.
-- ============================================================
create or replace function platform.invite_staff(
  p_email     text,
  p_full_name text,
  p_role      text,
  p_branch_id uuid default null
) returns text as $$
declare
  v_uid    uuid := auth.uid();
  t        platform.tenants%rowtype;
  v_is_ceo boolean;
  v_ok     boolean;
  v_token  text;
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

  -- 192 bits of CSPRNG. Longer than any brute-forceable horizon and
  -- short enough to survive being read out over a phone call.
  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into platform.staff_invitations
    (email, tenant_id, full_name, role, branch_id, invited_by, invited_by_email,
     expires_at, invite_token_digest)
  values
    (lower(btrim(p_email)), t.id, p_full_name, p_role, p_branch_id, v_uid,
     (select u.email from auth.users u where u.id = v_uid),
     now() + interval '7 days',
     encode(extensions.digest(v_token, 'sha256'), 'hex'));

  return v_token;

exception
  -- The pending-email index is GLOBAL, so a raw unique violation would
  -- tell showroom A that showroom B has a pending invitation for an
  -- address — a cross-tenant existence oracle reachable by any CEO. Same
  -- message whichever tenant holds the row.
  when unique_violation then
    raise exception 'That email address is unavailable'
      using hint = 'It may already be invited or registered.';
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, extensions, pg_temp;

-- ============================================================
-- 3. PROVISION_TENANT MINTS THE FOUNDING TOKEN
--
-- The direct insert (there is no CEO yet to authorise invite_staff)
-- gains a generated digest, the conflict-refresh regenerates it — a
-- re-provision must not leave the OLD token valid after accepted_at was
-- reset — and the plaintext rides back to the caller in the result
-- jsonb, next to the temporary password it already carries.
-- ============================================================
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
  v_token    text;
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

  -- Fresh token EVERY run, including retries: the row this upsert
  -- refreshes may be carrying a digest whose plaintext sat in a previous
  -- response body. Resetting accepted_at while keeping that old token
  -- live would reopen the door this file exists to close.
  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  -- The invitation is what makes the about-to-be-created auth user a CEO
  -- of this tenant. Written directly rather than through invite_staff()
  -- because there is no CEO yet to authorise it — this is the one
  -- legitimate service-role write to the table, and it is why
  -- provision_tenant is service-role only.
  insert into platform.staff_invitations
    (tenant_id, email, full_name, role, branch_id, expires_at, invite_token_digest)
  values
    (t.id, lower(btrim(p_ceo_email)), p_ceo_full_name, 'ceo', v_branch,
     now() + interval '7 days',
     encode(extensions.digest(v_token, 'sha256'), 'hex'))
  on conflict (tenant_id, email) do update
     set full_name            = excluded.full_name,
         role                 = excluded.role,
         branch_id            = excluded.branch_id,
         expires_at           = excluded.expires_at,
         accepted_at          = null,
         invite_token_digest  = excluded.invite_token_digest
   where platform.staff_invitations.accepted_at is null;

  return jsonb_build_object(
    'tenant_created', v_created,
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status),
    'schema_name', v_schema,
    'branch_id', v_branch,
    'ceo_email', lower(btrim(p_ceo_email)),
    'invite_token', v_token
  );
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, extensions, pg_temp;

-- ============================================================
-- 4. HANDLE_NEW_USER DEMANDS THE TOKEN
--
-- Carried verbatim from 0010 except the new §4a. Error strings keep the
-- ALL_CAPS_CODE convention so db-error.ts-style mapping stays possible.
-- ============================================================
create or replace function platform.handle_new_user()
returns trigger as $$
declare
  inv      platform.staff_invitations%rowtype;
  t        platform.tenants%rowtype;
  v_name   text;
  v_ok     boolean;
  v_signed text;
begin
  -- Matches the partial unique index from 0010 §1, so at most one row can
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

  -- ── 4a. THE TOKEN GATE ──────────────────────────────────────────
  -- The email named the invitation; only the token proves the speaker.
  -- Read from raw_user_meta_data, the same bag the app writes full_name
  -- into via admin.createUser options — and the same bag a public
  -- /auth/v1/signup fills from its own `data` argument, which is why a
  -- missing token here fails the whole insert rather than degrading.
  v_signed := coalesce(new.raw_user_meta_data->>'invite_token', '');

  if inv.invite_token_digest is null then
    raise exception
      'The invitation for % predates one-time tokens. Ask the CEO to revoke it and send a fresh one (INVITATION_LEGACY_NO_TOKEN)', new.email;
  end if;

  if v_signed = '' then
    raise exception
      'Sign-up requires the one-time invitation token issued with this invitation (INVITATION_TOKEN_REQUIRED)';
  end if;

  if encode(extensions.digest(v_signed, 'sha256'), 'hex') <> inv.invite_token_digest then
    raise exception
      'That invitation token does not match the pending invitation for % (INVITATION_TOKEN_INVALID)', new.email;
  end if;
  -- ── end 4a ───────────────────────────────────────────────────────

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
$$ language plpgsql security definer set search_path = pg_catalog, platform, extensions, pg_temp;

revoke all on function platform.handle_new_user() from public, anon, authenticated;

-- ============================================================
-- 5. VERIFICATION
-- ============================================================
do $$
declare
  n int;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'platform'
       and table_name   = 'staff_invitations'
       and column_name  = 'invite_token_digest'
  ) then
    raise exception '0052 VERIFICATION FAILED: platform.staff_invitations.invite_token_digest missing';
  end if;

  -- invite_staff returns text now. pg_proc.prorettype checked by name —
  -- 'text' resolves inside this block regardless of search_path pinning.
  select count(*) into n
    from pg_proc p
   where p.pronamespace = 'platform'::regnamespace
     and p.proname = 'invite_staff'
     and pg_get_function_identity_arguments(p.oid) = 'p_email text, p_full_name text, p_role text, p_branch_id uuid'
     and p.prorettype = 'text'::regtype;
  if n <> 1 then
    raise exception
      '0052 VERIFICATION FAILED: platform.invite_staff(text,text,text,uuid) does not return text (% matching definition(s))', n;
  end if;

  -- provision_tenant must hand the token back.
  if position('invite_token' in coalesce(
       (select p.prosrc from pg_proc p
         where p.pronamespace = 'platform'::regnamespace
           and p.proname = 'provision_tenant'
         limit 1), '')) = 0 then
    raise exception
      '0052 VERIFICATION FAILED: provision_tenant body does not mention invite_token';
  end if;

  -- The gate must be present in the live trigger function.
  select count(*) into n
    from pg_proc p
   where p.pronamespace = 'platform'::regnamespace
     and p.proname = 'handle_new_user'
     and p.prosrc like '%INVITATION_TOKEN_REQUIRED%'
     and p.prosrc like '%INVITATION_TOKEN_INVALID%';
  if n <> 1 then
    raise exception
      '0052 VERIFICATION FAILED: handle_new_user does not carry the token gate (% matches)', n;
  end if;

  -- Grants survived the signature-preserving rewrite: every tenant role
  -- keeps EXECUTE on invite_staff, or creating staff breaks silently on
  -- the next provisioned showroom.
  select count(*) into n
    from pg_roles r
   where r.rolname like 'felix_%' and r.rolcanlogin = false
     and not has_function_privilege(r.rolname, 'platform.invite_staff(text,text,text,uuid)', 'execute');
  if n > 0 then
    raise exception
      '% tenant role(s) lost EXECUTE on platform.invite_staff during the rewrite', n;
  end if;

  raise notice '0052 applied: invitations now require a one-time token';
end $$;

commit;
