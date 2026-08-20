-- ============================================================
-- 0029 — THE MARKETING ROLE, AND CHANNEL LISTINGS
--
-- A sixth staff role: 'marketing'. They advertise the showroom's stock
-- — the Dubizzle/Facebook/Instagram postings, the emails, the socials —
-- so what they need from the database is narrow and specific:
--
--   * READ every vehicle, org-wide. A marketing person lists the whole
--     showroom's stock, not one branch's, so vehicles_select gains a
--     marketing arm alongside the accountant's (who reads org-wide for
--     the cost base; marketing reads org-wide for the shop window).
--     They see asking_price/min_price like everyone else with SELECT —
--     the app is what keeps purchase_price off their screens, exactly
--     as it does for the sales floor (0028's header).
--   * WRITE vehicle_listings — the new table below: one row per
--     (vehicle, channel) recording where a car is posted, at what URL,
--     and in what state. This is the marketing workspace's whole
--     surface; they touch nothing financial.
--
-- Everything else stays closed to them by construction: leads, deals,
-- ledger, contracts and the rest all gate on is_ceo()/is_staff()/
-- branch predicates that a 'marketing' profile does not satisfy.
-- is_staff() is deliberately NOT widened — it means "the selling
-- operation" everywhere it is used, and marketing is not that.
--
-- FOUR PLACES KNOW THE ROLE LIST; ALL FOUR ARE WIDENED HERE:
--   1. t_<slug>.profiles role CHECK        (template + every live schema)
--   2. platform.staff_invitations CHECK    (one table, platform-wide)
--   3. platform.invite_staff() p_role gate (one function)
--   4. vehicles_select                     (template + every live schema)
--
-- vehicle_listings — WHY A TABLE
-- ------------------------------
-- "Is the BMW on Dubizzle yet?" must have one answer. A row per
-- (vehicle, channel) with a unique index makes posting state an upsert,
-- the same shape 0027 gave targets. status covers the lifecycle the
-- marketing desk actually manages: draft → posted → needs_update (price
-- changed, photos changed) → removed (sold, or pulled). posted_by is
-- pinned to auth.uid() by the write policies, 0027-style.
--
-- STRUCTURE MIRRORS 0027/0016 — template + live loop, anchored and
-- verified substitutions, per-tenant search_path so policies bind to
-- each schema's own helpers. Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0029 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('create table if not exists employee_targets' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0029 PRECONDITION FAILED: the template has no employee_targets. Apply 0027 first.';
  end if;

  -- Batch-ordering gate: the marketing workspace prices its listings
  -- from asking_price, so 0028 must already be in.
  if position('  asking_price    numeric' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0029 PRECONDITION FAILED: the template has no vehicles.asking_price. Apply 0028 first.';
  end if;

  if to_regclass('platform.staff_invitations') is null
     or to_regprocedure('platform.invite_staff(text, text, text, uuid)') is null then
    raise exception
      '0029 PRECONDITION FAILED: platform.staff_invitations / invite_staff() missing. Apply 0010 first.';
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

  -- 2a. the profiles role CHECK gains 'marketing'.
  c_role_from constant text := $m1$  role                text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor')),$m1$;
  c_role_to   constant text := $m2$  role                text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor','marketing')),$m2$;

  -- 2b. vehicles_select gains the marketing arm.
  c_sel_from constant text := $m3$create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
  );$m3$;
  c_sel_to   constant text := $m4$create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    -- 0029: marketing lists the whole showroom's stock across channels,
    -- so their read is org-wide like the accountant's.
    or current_role_name() = 'marketing'
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
  );$m4$;

  -- 2c. the table, after employee_targets' unique index — the tail of
  --     what 0027 spliced in.
  c_tbl_from constant text := $m5$create unique index if not exists uniq_employee_target_metric_month
  on employee_targets(profile_id, metric, period_month);$m5$;
  c_tbl_to   constant text := $m6$create unique index if not exists uniq_employee_target_metric_month
  on employee_targets(profile_id, metric, period_month);

-- ------------------------------------------------------------
-- 8d. CHANNEL LISTINGS  (0029)
--
-- Where each car is advertised. One row per (vehicle, channel); the
-- unique index makes posting state an upsert, so "is it on Dubizzle?"
-- always has exactly one answer.
--
-- url        the live posting, once there is one.
-- posted_by  who last touched the listing — pinned to auth.uid() by
--            the write policies, exactly like employee_targets.set_by.
-- posted_at  when it went live; the app stamps it on status='posted'.
-- ------------------------------------------------------------
create table if not exists vehicle_listings (
  id          uuid        primary key default gen_random_uuid(),
  vehicle_id  uuid        not null references vehicles(id) on delete cascade,
  channel     text        not null check (channel in ('dubizzle','facebook','instagram','tiktok','website','other')),
  status      text        not null default 'draft' check (status in ('draft','posted','needs_update','removed')),
  url         text,
  note        text,
  posted_by   uuid        references profiles(id),
  posted_at   timestamptz,
  created_at  timestamptz default now()
);

create index if not exists idx_vehicle_listings_vehicle on vehicle_listings(vehicle_id);

create unique index if not exists uniq_vehicle_listing_channel
  on vehicle_listings(vehicle_id, channel);$m6$;

  -- 2d. RLS
  c_rls_from constant text := $m7$alter table employee_targets       enable row level security;$m7$;
  c_rls_to   constant text := $m8$alter table employee_targets       enable row level security;
alter table vehicle_listings       enable row level security;$m8$;

  -- 2e. the policies, after employee_targets' four
  c_pol_from constant text := $m9$drop policy if exists "employee_targets_delete" on employee_targets;
create policy "employee_targets_delete" on employee_targets for delete
  using (is_manager_or_above());$m9$;
  c_pol_to   constant text := $n1$drop policy if exists "employee_targets_delete" on employee_targets;
create policy "employee_targets_delete" on employee_targets for delete
  using (is_manager_or_above());

-- ------------------------------------------------------------
-- 5j-quater. CHANNEL LISTINGS — 0029
--
-- Marketing and management write; the selling staff read (a salesman
-- answering "where did you see it?" needs the answer). Investors have
-- no business here. posted_by = auth.uid() in every WITH CHECK: a
-- listing always names whoever last touched it.
-- ------------------------------------------------------------
drop policy if exists "vehicle_listings_select" on vehicle_listings;
create policy "vehicle_listings_select" on vehicle_listings for select
  using (is_staff() or current_role_name() = 'marketing');

drop policy if exists "vehicle_listings_insert" on vehicle_listings;
create policy "vehicle_listings_insert" on vehicle_listings for insert
  with check (
    posted_by = auth.uid()
    and (is_manager_or_above() or current_role_name() = 'marketing'));

drop policy if exists "vehicle_listings_update" on vehicle_listings;
create policy "vehicle_listings_update" on vehicle_listings for update
  using (is_manager_or_above() or current_role_name() = 'marketing')
  with check (
    posted_by = auth.uid()
    and (is_manager_or_above() or current_role_name() = 'marketing'));

-- Manager+, and §6d withholds the DELETE grant regardless: a listing
-- that came down is status='removed' with its history in audit_log,
-- not a vanished row.
drop policy if exists "vehicle_listings_delete" on vehicle_listings;
create policy "vehicle_listings_delete" on vehicle_listings for delete
  using (is_manager_or_above());$n1$;

  -- 2f. the audit trigger, after employee_targets'
  c_trg_from constant text := $n2$drop trigger if exists trg_audit_employee_targets on employee_targets;
create trigger trg_audit_employee_targets
  after insert or update or delete on employee_targets
  for each row execute function record_audit();$n2$;
  c_trg_to   constant text := $n3$drop trigger if exists trg_audit_employee_targets on employee_targets;
create trigger trg_audit_employee_targets
  after insert or update or delete on employee_targets
  for each row execute function record_audit();

-- Audited like everything else that is revised in place: "who pulled
-- the Instagram post and when" is a question with an answer.
drop trigger if exists trg_audit_vehicle_listings on vehicle_listings;
create trigger trg_audit_vehicle_listings
  after insert or update or delete on vehicle_listings
  for each row execute function record_audit();$n3$;

  -- 2g. the grants
  c_gnt_from constant text := $n4$grant select, insert, update, delete on employee_targets to service_role;$n4$;
  c_gnt_to   constant text := $n5$grant select, insert, update, delete on employee_targets to service_role;

-- The marketing workspace upserts listings (insert + update under the
-- unique index); staff read. No DELETE, matching 6d throughout — a
-- pulled listing is an UPDATE to status='removed'.
grant select, insert, update on vehicle_listings to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on vehicle_listings to service_role;$n5$;
begin
  if position('create table if not exists vehicle_listings' in v_tpl) > 0 then
    raise notice '0029: template already carries vehicle_listings — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_role_from, c_role_to);
    if position(c_role_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2a (profiles role check) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_sel_from, c_sel_to);
    if position(c_sel_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2b (vehicles_select) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2c (table) did not match. Template drifted from 0027.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2d (rls) did not match. Template drifted from 0027.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2e (policies) did not match. Template drifted from 0027.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2f (audit trigger) did not match. Template drifted from 0027.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0029: template anchor 2g (grants) did not match. Template drifted from 0027.';
    end if;
    v_done := v_done + 1;

    -- Prefix-of-replacement safety, as 0027: exactly one of each.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists vehicle_listings', ''))) <> 43 then
      raise exception '0029: the template carries more than one vehicle_listings table.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0029$ select %L::text $felix_0029$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0029: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. THE PLATFORM CONTROL PLANE — invitation table and gate
--
-- These exist once, not per tenant. Both learn 'marketing'.
-- ============================================================
do $$
declare
  r record;
begin
  -- 3a. staff_invitations.role CHECK. The constraint was created inline
  -- so its name is whatever Postgres minted; discover it by definition
  -- rather than guessing, then re-add under a stable name.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'platform.staff_invitations'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%marketing%'
  ) then
    raise notice '0029: staff_invitations already accepts marketing — skipping.';
  else
    for r in
      select conname from pg_constraint
       where conrelid = 'platform.staff_invitations'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%sales_exec%'
    loop
      execute format('alter table platform.staff_invitations drop constraint %I', r.conname);
    end loop;

    alter table platform.staff_invitations
      add constraint staff_invitations_role_check
      check (role in ('ceo','accountant','branch_manager','sales_exec','investor','marketing'));
    raise notice '0029: staff_invitations role check widened.';
  end if;
end
$$;

-- 3b. invite_staff() — 0010's function verbatim, with 'marketing' added
-- to the p_role gate. Grants survive create-or-replace.
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

  if p_role not in ('ceo','accountant','branch_manager','sales_exec','investor','marketing') then
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

-- ============================================================
-- 4. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  c       record;
  v_count int := 0;

  -- Dynamic SQL throughout (0027's rule): plpgsql caches the plans of
  -- static statements, and a cached CREATE POLICY would bind every
  -- tenant's policy to the FIRST schema on the loop's path.
  c_ddl constant text := $ddl$
drop policy if exists "vehicles_select" on vehicles;
create policy "vehicles_select" on vehicles for select
  using (
    is_ceo()
    or is_accountant_or_above()
    or current_role_name() = 'marketing'
    or branch_id = current_branch_id()
    or holds_equity_in_vehicle(vehicles.id)
  );

create table if not exists vehicle_listings (
  id          uuid        primary key default gen_random_uuid(),
  vehicle_id  uuid        not null references vehicles(id) on delete cascade,
  channel     text        not null check (channel in ('dubizzle','facebook','instagram','tiktok','website','other')),
  status      text        not null default 'draft' check (status in ('draft','posted','needs_update','removed')),
  url         text,
  note        text,
  posted_by   uuid        references profiles(id),
  posted_at   timestamptz,
  created_at  timestamptz default now()
);

create index if not exists idx_vehicle_listings_vehicle on vehicle_listings(vehicle_id);

create unique index if not exists uniq_vehicle_listing_channel
  on vehicle_listings(vehicle_id, channel);

alter table vehicle_listings enable row level security;

drop policy if exists "vehicle_listings_select" on vehicle_listings;
create policy "vehicle_listings_select" on vehicle_listings for select
  using (is_staff() or current_role_name() = 'marketing');

drop policy if exists "vehicle_listings_insert" on vehicle_listings;
create policy "vehicle_listings_insert" on vehicle_listings for insert
  with check (
    posted_by = auth.uid()
    and (is_manager_or_above() or current_role_name() = 'marketing'));

drop policy if exists "vehicle_listings_update" on vehicle_listings;
create policy "vehicle_listings_update" on vehicle_listings for update
  using (is_manager_or_above() or current_role_name() = 'marketing')
  with check (
    posted_by = auth.uid()
    and (is_manager_or_above() or current_role_name() = 'marketing'));

drop policy if exists "vehicle_listings_delete" on vehicle_listings;
create policy "vehicle_listings_delete" on vehicle_listings for delete
  using (is_manager_or_above());

drop trigger if exists trg_audit_vehicle_listings on vehicle_listings;
create trigger trg_audit_vehicle_listings
  after insert or update or delete on vehicle_listings
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0029: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- 4a. the profiles role CHECK. Inline-created, so discover by
    -- definition; skip if a widened one is already in place.
    if not exists (
      select 1 from pg_constraint pc
       where pc.conrelid = format('%I.profiles', r.schema_name)::regclass
         and pc.contype = 'c'
         and pg_get_constraintdef(pc.oid) like '%marketing%'
    ) then
      for c in
        select conname from pg_constraint pc
         where pc.conrelid = format('%I.profiles', r.schema_name)::regclass
           and pc.contype = 'c'
           and pg_get_constraintdef(pc.oid) like '%sales_exec%'
      loop
        execute format('alter table %I.profiles drop constraint %I', r.schema_name, c.conname);
      end loop;
      execute format(
        'alter table %I.profiles add constraint profiles_role_check '
        'check (role in (''ceo'',''accountant'',''branch_manager'',''sales_exec'',''investor'',''marketing''))',
        r.schema_name
      );
    end if;

    -- 4b + 4c under the tenant's own search_path, so the recreated
    -- policy and the new table's policies bind to THIS schema's helpers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    execute format(
      'grant select, insert, update on %I.vehicle_listings to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.vehicle_listings to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.vehicle_listings from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0029: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0029: % tenant schema(s) carry the marketing role and listings.', v_count;
end
$mig$;

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
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    -- the role is admissible
    if not exists (
      select 1 from pg_constraint pc
       where pc.conrelid = format('%I.profiles', r.schema_name)::regclass
         and pc.contype = 'c'
         and pg_get_constraintdef(pc.oid) like '%marketing%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (profiles check)');
    end if;

    -- marketing can read vehicles, and the policy bound to this schema
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicles'
       and p.polname = 'vehicles_select'
       and pg_get_expr(p.polqual, p.polrelid) like '%marketing%'
       and pg_get_expr(p.polqual, p.polrelid) ~ ('\m' || r.schema_name || '\M');
    if n <> 1 then
      v_bad := v_bad || (r.schema_name || ' (vehicles_select)');
    end if;

    if to_regclass(format('%I.vehicle_listings', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicle_listings'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicle_listings';
    if n <> 4 then
      v_bad := v_bad || format('%s (%s policies, expected 4)', r.schema_name, n);
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'vehicle_listings'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    if not has_table_privilege(
         r.role_name, format('%I.vehicle_listings', r.schema_name), 'select, insert, update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot write listings)');
    end if;

    if has_table_privilege(r.role_name, format('%I.vehicle_listings', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (role holds delete!)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.vehicle_listings', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.vehicle_listings', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege)');
    end if;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'vehicle_listings'
         and t.tgname = 'trg_audit_vehicle_listings' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (no audit trigger)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0029 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  -- the control plane
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'platform.staff_invitations'::regclass
       and contype = 'c' and pg_get_constraintdef(oid) like '%marketing%'
  ) then
    raise exception '0029 VERIFY FAILED: staff_invitations does not accept marketing.';
  end if;

  if position('''marketing''' in pg_get_functiondef(
       'platform.invite_staff(text, text, text, uuid)'::regprocedure)) = 0 then
    raise exception '0029 VERIFY FAILED: invite_staff() does not accept marketing.';
  end if;

  -- the template
  if position('create table if not exists vehicle_listings' in platform.tenant_ddl_template()) = 0
     or position('''sales_exec'',''investor'',''marketing''' in platform.tenant_ddl_template()) = 0
     or position('or current_role_name() = ''marketing''' in platform.tenant_ddl_template()) = 0 then
    raise exception '0029 VERIFY FAILED: the template does not carry the marketing role.';
  end if;

  raise notice '0029: verified — marketing exists everywhere it must.';
end
$$;

notify pgrst, 'reload schema';

commit;
