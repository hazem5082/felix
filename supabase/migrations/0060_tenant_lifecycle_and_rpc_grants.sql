-- ============================================================
-- 0060 — SERVICE-ROLE PROVISIONING GRANTS + TENANT LIFECYCLE
--
-- Three things, one file, because the second and third are unusable
-- without the first:
--
--  1. GRANT EXECUTE on platform.provision_tenant() and
--     platform.sync_postgrest_schemas() to service_role.
--
--     THE BUG THIS FIXES: partners.508.world -> Worker ->
--     POST /api/provision -> admin.rpc("provision_tenant") has been
--     answering "permission denied for function provision_tenant"
--     (SQLSTATE 42501). No migration ever granted EXECUTE on either
--     function to anyone: 0008 §6 revokes EXECUTE on all platform
--     functions from public/anon/authenticated AND alters the default
--     privileges so later functions are born owner-only, 0010 created
--     provision_tenant under that regime, and 0013/0052's CREATE OR
--     REPLACE preserved the owner-only ACL faithfully. Confirmed live
--     2026-08-24: proacl = {postgres=X/postgres}, and
--     has_function_privilege('service_role', ..., 'execute') = false
--     for both functions. Every migration's own probe runs as postgres,
--     which is why five migrations' worth of "provisions cleanly"
--     notices never noticed.
--
--  2. Move the public.tenants mirror out of provision_tenant() and
--     into a trigger on platform.tenants. 0013 taught provision_tenant
--     to mirror slug/name/status into the cross-product registry
--     public.tenants (A-Star and Calendar read it for hostname
--     resolution and slug-collision protection); 0052's rewrite of the
--     function was based on 0010's body and silently shed the mirror.
--     Discovered while writing THIS migration: the live database still
--     runs the 0010-era body (neither 0013's nor 0052's rewrite was
--     ever applied live), so the mirror has depended on which version
--     of one function happens to be installed. A row-level trigger ends
--     that class of bug: whoever writes platform.tenants — any past or
--     future provision_tenant, the lifecycle functions below, a manual
--     UPDATE — the mirror follows, and no future function rewrite can
--     lose it again.
--
--  3. The lifecycle FELIX never had: suspend_tenant / resume_tenant /
--     delete_tenant. 0008's comment on sync_postgrest_schemas() claims
--     it is "called at the end of every provision, suspend, and
--     resume" — this migration makes that sentence true eight weeks
--     later. The app side already enforces status='suspended' on every
--     authenticated surface (login action, (app) layout, auth.ts
--     gates), so suspension needs no app deploy to bite.
--
-- Callers: src/app/api/provision/route.ts (existing) and the new
-- src/app/api/tenants/lifecycle/route.ts, both service-role via
-- PostgREST, both webhook-secret-authed on the HTTP side.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRECONDITIONS
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('platform.provision_tenant(text,text,text,text,text,text)') is null then
    raise exception '0060 PRECONDITION FAILED: platform.provision_tenant(...) missing — apply 0052 first.';
  end if;
  if to_regprocedure('platform.sync_postgrest_schemas()') is null then
    raise exception '0060 PRECONDITION FAILED: platform.sync_postgrest_schemas() missing — apply 0012 first.';
  end if;
  if to_regclass('public.tenants') is null then
    raise exception '0060 PRECONDITION FAILED: public.tenants missing — the cross-product mirror has nowhere to go.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. THE MIRROR, AS A TRIGGER
--
-- provision_tenant() itself is deliberately NOT touched: the live
-- database runs the 0010-era body while the repo carries 0052's, and a
-- CREATE OR REPLACE here would have to pick a side. The mirror stops
-- being a function's job at all — a row in platform.tenants IS the
-- fact, and the trigger keeps public.tenants agreeing with it.
--
-- SECURITY DEFINER (owner postgres) because the writers of
-- platform.tenants — service_role via PostgREST, the SECDEF lifecycle
-- functions — do not themselves hold write on public.tenants (0051
-- made the shared registry read-only for end-user roles on purpose).
-- Schema-qualified writes rather than `public` in the search_path: a
-- SECURITY DEFINER function naming `public` in its path is the hijack
-- surface 0009 exists to close.
-- ------------------------------------------------------------
create or replace function platform.mirror_tenant_registry() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    -- id AND slug, so a public.tenants row that belongs to another
    -- product (same slug claimed there first) can never be deleted by
    -- a FELIX registry change.
    delete from public.tenants where id = old.id and slug = old.slug;
    return old;
  end if;

  -- A slug already registered under a DIFFERENT id belongs to another
  -- 508.world product (measured live: 'demo2' is a Calendar tenant with
  -- real bookings). That must not abort the FELIX write — the house's
  -- own demo showrooms deliberately share their slug across products —
  -- so the row is skipped with a warning instead. Keeping paying
  -- customers off other products' slugs is /api/provision's job, which
  -- refuses the collision BEFORE provisioning starts.
  begin
    insert into public.tenants (id, slug, name, licensed_via, status)
    values (new.id, new.slug, new.name, new.licensed_via, new.status)
    on conflict (id) do update
       set slug         = excluded.slug,
           name         = excluded.name,
           licensed_via = excluded.licensed_via,
           status       = excluded.status;
  exception when unique_violation then
    raise warning 'public.tenants slug % is held by another product''s tenant — FELIX tenant % left unmirrored',
      new.slug, new.id;
  end;
  return new;
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

comment on function platform.mirror_tenant_registry() is
  'Row trigger on platform.tenants: keeps the cross-product registry public.tenants (read by A-Star and Calendar for hostname resolution and slug-collision protection) in step with FELIX''s own registry. Introduced by 0060 after two separate provision_tenant rewrites each silently shed the 0013 in-function mirror.';

drop trigger if exists trg_mirror_tenant_registry on platform.tenants;
create trigger trg_mirror_tenant_registry
  after insert or update or delete on platform.tenants
  for each row execute function platform.mirror_tenant_registry();

-- Backfill whatever the years of function-body roulette left out.
-- Expected to touch zero rows today (the flagship is mirrored), but a
-- gap here breaks other products' slug-collision checks silently.
insert into public.tenants (id, slug, name, licensed_via, status)
select pt.id, pt.slug, pt.name, pt.licensed_via, pt.status
  from platform.tenants pt
 where not exists (select 1 from public.tenants t where t.id = pt.id)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2. SUSPEND / RESUME
--
-- Suspension is reversible and enforcement already exists app-side:
-- login refuses, every (app) page view redirects, print/API surfaces
-- refuse, and sync_postgrest_schemas() below drops the schema from the
-- exposed list so even hand-rolled PostgREST calls stop resolving.
-- ------------------------------------------------------------
create or replace function platform.suspend_tenant(p_slug text) returns jsonb as $$
declare
  t platform.tenants%rowtype;
begin
  if p_slug = 'felix' then
    -- The flagship demo is the product's shop window; taking it down is
    -- what public.demo_status (the partners portal's Demo Status tab)
    -- exists for, and that path is reversible without touching the
    -- registry. Refusing here keeps a mis-click on the new Tenants tab
    -- from bricking the demo.
    raise exception 'FLAGSHIP_PROTECTED: the flagship demo cannot be suspended from the lifecycle API — use the demo kill switch.';
  end if;

  select * into t from platform.tenants where slug = p_slug for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND: no tenant with slug %', quote_literal(p_slug);
  end if;

  -- The public.tenants mirror follows via trg_mirror_tenant_registry.
  update platform.tenants set status = 'suspended' where id = t.id;

  -- Removes the schema from pgrst.db_schemas. Sessions already open die
  -- on their next page view via the layout gate; this closes the API.
  perform platform.sync_postgrest_schemas();

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', 'suspended')
  );
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

comment on function platform.suspend_tenant(text) is
  'Deactivates a showroom: status=suspended in platform.tenants and the public.tenants mirror, then re-syncs PostgREST''s exposed schemas. Reversible via resume_tenant(). Service-role only; refuses the flagship.';

create or replace function platform.resume_tenant(p_slug text) returns jsonb as $$
declare
  t platform.tenants%rowtype;
begin
  select * into t from platform.tenants where slug = p_slug for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND: no tenant with slug %', quote_literal(p_slug);
  end if;

  -- The public.tenants mirror follows via trg_mirror_tenant_registry.
  update platform.tenants set status = 'active' where id = t.id;

  perform platform.sync_postgrest_schemas();

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', 'active')
  );
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

comment on function platform.resume_tenant(text) is
  'Reactivates a suspended showroom and re-syncs PostgREST''s exposed schemas. Service-role only.';

-- ------------------------------------------------------------
-- 3. DELETE
--
-- Hard, irreversible, and deliberately two-step: a tenant must already
-- be SUSPENDED before it can be deleted, so the destructive click on
-- the partners page is always the second of two clicks, with a working
-- undo (resume) between them.
--
-- What it does NOT do: touch auth.users. GoTrue's tables belong to
-- supabase_auth_admin and the auth accounts are shared with A-Star and
-- Calendar, so account deletion is the HTTP caller's job (it can ask
-- GoTrue properly, and it can check the user has no other tenant
-- membership first). tenant_users rows are deleted here because their
-- FK to tenants is ON DELETE RESTRICT — left behind, they would block
-- the registry delete; left orphaned, they would lie.
-- ------------------------------------------------------------
create or replace function platform.delete_tenant(p_slug text) returns jsonb as $$
declare
  t             platform.tenants%rowtype;
  v_users       int;
  v_invites     int;
  v_mail        int;
  v_user_ids    uuid[];
  v_role_exists boolean;
begin
  if p_slug = 'felix' then
    raise exception 'FLAGSHIP_PROTECTED: the flagship demo cannot be deleted.';
  end if;

  select * into t from platform.tenants where slug = p_slug for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND: no tenant with slug %', quote_literal(p_slug);
  end if;

  if t.status <> 'suspended' then
    raise exception 'TENANT_NOT_SUSPENDED: deactivate % first — deletion is only offered to suspended tenants.', quote_literal(p_slug);
  end if;

  -- Memberships: FK is ON DELETE RESTRICT, so these must go explicitly.
  -- The ids ride back to the caller so it can decide which auth accounts
  -- are now orphaned (member of no other tenant) and remove them via
  -- GoTrue's admin API rather than behind its back.
  select coalesce(array_agg(user_id), '{}') into v_user_ids
    from platform.tenant_users where tenant_id = t.id;
  delete from platform.tenant_users where tenant_id = t.id;
  get diagnostics v_users = row_count;

  -- Invitations cascade with the tenants row, but deleting them here
  -- makes the count reportable and the intent explicit.
  delete from platform.staff_invitations where tenant_id = t.id;
  get diagnostics v_invites = row_count;

  -- felixmail addresses are keyed by schema, not tenant id (0039).
  delete from platform.mail_addresses where tenant_schema = t.schema_name;
  get diagnostics v_mail = row_count;

  -- The business data. CASCADE takes every table, function, policy and
  -- trigger in one statement; there is nothing selective about this.
  execute format('drop schema if exists %I cascade', t.schema_name);

  -- The tenant's Postgres role. DROP OWNED requires membership of the
  -- role being cleaned (postgres created it via create_tenant_role but
  -- membership is not implied on every PG major), so grant it first —
  -- inside its own sub-block because on some versions/states the grant
  -- is redundant and must not abort the delete.
  select exists (select 1 from pg_roles where rolname = t.role_name) into v_role_exists;
  if v_role_exists then
    begin
      execute format('grant %I to postgres', t.role_name);
    exception when others then
      null; -- already a member, or the grant is unnecessary on this version
    end;
    -- Revokes every privilege the role holds (USAGE on its dropped
    -- schema's neighbours, the authenticator membership survives as a
    -- membership not a privilege) and drops anything it still owns.
    execute format('drop owned by %I', t.role_name);
    execute format('drop role %I', t.role_name);
  end if;

  -- Registry row last, so a failure above leaves the tenant visible
  -- (suspended) rather than half-vanished. The public.tenants mirror
  -- row goes with it via trg_mirror_tenant_registry's DELETE branch.
  delete from platform.tenants where id = t.id;

  perform platform.sync_postgrest_schemas();

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name),
    'schema_dropped', t.schema_name,
    'role_dropped', case when v_role_exists then t.role_name else null end,
    'memberships_deleted', v_users,
    'invitations_deleted', v_invites,
    'mail_addresses_deleted', v_mail,
    'detached_user_ids', to_jsonb(v_user_ids)
  );
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

comment on function platform.delete_tenant(text) is
  'Irreversibly deletes a SUSPENDED showroom: schema (cascade), role, memberships, invitations, mail addresses, registry row and public.tenants mirror, then re-syncs PostgREST. Returns the detached auth user ids for the caller to clean up via GoTrue. Refuses the flagship and any active tenant.';

-- ------------------------------------------------------------
-- 4. GRANTS — the reason this file exists
--
-- Explicit per-function grants, not a default-privileges change: the
-- platform schema holds functions service_role must never call
-- (create_tenant_schema, create_tenant_role, the auth hook), so the
-- born-owner-only default from 0008 stays exactly as it is and each
-- RPC the API layer calls is named here. NOTE FOR FUTURE REWRITES:
-- CREATE OR REPLACE preserves these; DROP + CREATE (or any signature
-- change) silently sheds them, and the symptom is /api/provision
-- answering 42501 again. The verify block below is what catches that.
-- ------------------------------------------------------------
revoke all on function platform.provision_tenant(text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function platform.suspend_tenant(text)  from public, anon, authenticated;
revoke all on function platform.resume_tenant(text)   from public, anon, authenticated;
revoke all on function platform.delete_tenant(text)   from public, anon, authenticated;

grant execute on function platform.provision_tenant(text,text,text,text,text,text) to service_role;
grant execute on function platform.sync_postgrest_schemas()                        to service_role;
grant execute on function platform.suspend_tenant(text)                            to service_role;
grant execute on function platform.resume_tenant(text)                             to service_role;
grant execute on function platform.delete_tenant(text)                             to service_role;

-- ============================================================
-- VERIFICATION
-- ============================================================

-- (a) The grants that fix the live 42501, asserted as the role that
-- was denied — not as postgres, which is how five earlier probes
-- missed this.
do $$
declare
  fn text;
  fns constant text[] := array[
    'platform.provision_tenant(text,text,text,text,text,text)',
    'platform.sync_postgrest_schemas()',
    'platform.suspend_tenant(text)',
    'platform.resume_tenant(text)',
    'platform.delete_tenant(text)'
  ];
begin
  foreach fn in array fns loop
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception '0060 VERIFY FAILED: service_role cannot execute %', fn;
    end if;
    if has_function_privilege('anon', fn, 'execute')
       or has_function_privilege('authenticated', fn, 'execute') then
      raise exception '0060 VERIFY FAILED: % is reachable by anon/authenticated — provisioning must stay service-role only', fn;
    end if;
  end loop;
  raise notice '0060 (a): all five RPCs execute as service_role and refuse anon/authenticated.';
end $$;

-- (b) The full lifecycle, END TO END, as data: provision a throwaway
-- tenant, suspend it, resume it, suspend it again, delete it, and
-- assert every artefact is gone. This is the probe discipline the
-- provisioning outage taught (see 0056–0059): text assertions passed
-- for weeks while the template could not provision, and only an actual
-- provision tells the truth. Net effect on the database: zero rows.
do $$
declare
  c_slug constant text := 'zz0060probe';
  v jsonb;
begin
  -- A previous failed run must not make this one un-runnable.
  if exists (select 1 from platform.tenants where slug = c_slug) then
    raise exception '0060 VERIFY BLOCKED: leftover probe tenant % exists — clean it up before re-running.', c_slug;
  end if;

  v := platform.provision_tenant(c_slug, 'Probe 0060', 'probe0060@probe.invalid', 'Probe CEO', 'Probe Branch', '0060-verify');
  if to_regnamespace('t_' || c_slug) is null then
    raise exception '0060 VERIFY FAILED: provision returned but schema t_% does not exist', c_slug;
  end if;
  if not exists (select 1 from public.tenants where slug = c_slug) then
    raise exception '0060 VERIFY FAILED: the public.tenants mirror row was not written — the 0013 restore did not take';
  end if;

  v := platform.suspend_tenant(c_slug);
  if (select status from platform.tenants where slug = c_slug) <> 'suspended'
     or (select status from public.tenants where slug = c_slug) <> 'suspended' then
    raise exception '0060 VERIFY FAILED: suspend_tenant did not set both registries to suspended';
  end if;

  v := platform.resume_tenant(c_slug);
  if (select status from platform.tenants where slug = c_slug) <> 'active' then
    raise exception '0060 VERIFY FAILED: resume_tenant did not restore active';
  end if;

  -- Delete must refuse an active tenant…
  begin
    v := platform.delete_tenant(c_slug);
    raise exception '0060 VERIFY FAILED: delete_tenant deleted an ACTIVE tenant — the suspend-first guard is not working';
  exception when others then
    if sqlerrm not like 'TENANT_NOT_SUSPENDED%' then raise; end if;
  end;

  -- …and the flagship, in any state.
  begin
    v := platform.delete_tenant('felix');
    raise exception '0060 VERIFY FAILED: delete_tenant accepted the flagship';
  exception when others then
    if sqlerrm not like 'FLAGSHIP_PROTECTED%' then raise; end if;
  end;

  v := platform.suspend_tenant(c_slug);
  v := platform.delete_tenant(c_slug);

  if to_regnamespace('t_' || c_slug) is not null then
    raise exception '0060 VERIFY FAILED: schema t_% survived delete_tenant', c_slug;
  end if;
  if exists (select 1 from pg_roles where rolname = 'felix_' || c_slug) then
    raise exception '0060 VERIFY FAILED: role felix_% survived delete_tenant', c_slug;
  end if;
  if exists (select 1 from platform.tenants where slug = c_slug)
     or exists (select 1 from public.tenants where slug = c_slug)
     or exists (select 1 from platform.staff_invitations si
                  join platform.tenants t on t.id = si.tenant_id and t.slug = c_slug) then
    raise exception '0060 VERIFY FAILED: registry rows for % survived delete_tenant', c_slug;
  end if;

  raise notice '0060 (b): provision -> suspend -> resume -> (guards) -> suspend -> delete round-trips cleanly; nothing left behind.';
end $$;

commit;
