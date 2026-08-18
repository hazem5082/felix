-- ============================================================
-- 0013 — MIRROR NEW SHOWROOMS INTO public.tenants
--
-- 0008 moved FELIX's registry to platform.tenants and 0010 pointed
-- provisioning at platform.provision_tenant(). Neither one writes to
-- public.tenants anymore, but that table is not FELIX's alone: it is the
-- cross-product registry A-Star and Calendar both still read and write
-- (`select id, status from public.tenants where slug = $1` — A-Star
-- tenancy_and_provisioning.md §1, §3; Calendar RUNBOOK.md §8 item 5) for
-- hostname resolution and to enforce that a slug means one client
-- everywhere on 508.world, not just within one product.
--
-- Confirmed live 2026-08-13: platform.tenants has exactly one row
-- (felix, carried over correctly by 0011) and public.tenants has 9,
-- the 8 extra being other products' test fixtures plus one abandoned
-- FELIX test tenant (henryautomotive, cleaned up separately). So no FELIX
-- showroom has silently gone missing from public.tenants YET — but every
-- showroom provisioned through platform.provision_tenant() since 0008
-- shipped would have, the first time it happened. This closes that gap
-- before it does.
--
-- WHY A MIRROR, NOT A JOIN OR A MOVE
-- -----------------------------------
-- platform.tenants carries schema_name and role_name, which are FELIX
-- implementation detail no other product should see or depend on;
-- public.tenants carries exactly the shape A-Star and Calendar already
-- expect (slug, name, status, licensed_via). Replacing one with the other
-- either leaks FELIX internals platform-wide or breaks two other
-- products' queries. A mirror keeps both contracts intact. The row shares
-- platform.tenants.id as its public.tenants.id, matching 0008's own note
-- that the flagship kept "the same flagship UUID" across both — id
-- continuity is the established convention here, not a new one.
--
-- WHAT THIS DOES NOT DO
-- ----------------------
-- It does not touch status transitions (suspend/resume) beyond what
-- provision_tenant already governs, and it does not attempt to reconcile
-- the 8 non-FELIX rows already in public.tenants — those belong to their
-- own products' migrations, not this one.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('platform.provision_tenant(text,text,text,text,text,text)') is null then
    raise exception '0013 PRECONDITION FAILED: platform.provision_tenant(...) does not exist. Apply 0010 first.';
  end if;
  if to_regclass('public.tenants') is null then
    raise exception '0013 PRECONDITION FAILED: public.tenants does not exist — nothing to mirror into. If it was intentionally dropped, this migration is obsolete; do not run it blind.';
  end if;
end $$;

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

  -- NEW IN 0013: mirror into the shared cross-product registry, same id,
  -- so A-Star and Calendar's own slug lookups see this showroom from the
  -- moment it exists rather than never. ON CONFLICT (id) covers the
  -- retried-approval case the way the rest of this function already does;
  -- ON CONFLICT (slug) would silently adopt another product's row of the
  -- same slug, which is exactly the collision this migration exists to
  -- prevent, so it is deliberately not handled here — RESERVED_SLUGS in
  -- /api/provision/route.ts and platform.tenants.slug's own uniqueness
  -- constraint are what stop a colliding slug from reaching this point.
  insert into public.tenants (id, slug, name, licensed_via, status)
  values (t.id, t.slug, t.name, p_licensed_via, t.status)
  on conflict (id) do update
     set name         = excluded.name,
         licensed_via  = excluded.licensed_via,
         status        = excluded.status
   where public.tenants.slug = excluded.slug;

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
$$ language plpgsql security definer set search_path = pg_catalog, platform, public, pg_temp;

comment on function platform.provision_tenant(text,text,text,text,text,text) is
  'Provisions a licensed FELIX showroom: registry row, schema, role, baseline data, and the CEO''s invitation. Also mirrors slug/name/status/licensed_via into public.tenants (same id) so A-Star and Calendar''s cross-product slug lookups see it. Service-role only. Idempotent on slug.';

revoke all on function platform.provision_tenant(text,text,text,text,text,text)
  from public, anon, authenticated;

-- Backfill: the flagship is already mirrored correctly (0011 verified
-- live), so this affects nothing today and exists only so a future
-- showroom created before this migration somehow slipped through is
-- caught rather than silently left out.
insert into public.tenants (id, slug, name, licensed_via, status)
select pt.id, pt.slug, pt.name, pt.licensed_via, pt.status
  from platform.tenants pt
 where not exists (select 1 from public.tenants t where t.id = pt.id)
on conflict (id) do nothing;

-- ============================================================
-- SELF-VERIFICATION
-- ============================================================
do $$
declare
  v_fail text[] := '{}';
  v_missing text;
begin
  select string_agg(pt.slug, ', ') into v_missing
    from platform.tenants pt
   where not exists (select 1 from public.tenants t where t.id = pt.id);

  if v_missing is not null then
    v_fail := v_fail || format('platform.tenants row(s) still missing from public.tenants after backfill: %s', v_missing);
  end if;

  if array_length(v_fail, 1) > 0 then
    raise exception '0013 FAILED verification: %', array_to_string(v_fail, '; ');
  end if;

  raise notice '0013 applied: platform.provision_tenant() now mirrors into public.tenants; existing rows reconciled.';
end $$;

commit;
