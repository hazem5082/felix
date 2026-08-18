-- ============================================================
-- 0011 — MOVE THE FLAGSHIP INTO ITS OWN SCHEMA
--
-- 0008-0010 built the machinery beside the running system without
-- touching it. This is the migration that moves live data: every row the
-- flagship showroom owns leaves public.* and lands in t_felix.*, with
-- tenant_id dropped on arrival because the schema now carries that fact.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
-- It does not drop, rename or empty a single public table. After it
-- runs, both copies exist and public.* is still exactly as it was. That
-- is the whole rollback story: if anything is wrong, revert the app and
-- the old schema is still there, untouched and authoritative. Dropping
-- public belongs in a later migration, after a soak period and after the
-- app has actually been serving from t_felix.
--
-- The cost of that choice is a window where writes could land in the old
-- copy and be lost. It is the app cutover (task 5), not this migration,
-- that closes it — and the ordering that makes it safe is: apply 0011,
-- deploy the app pointing at t_felix, verify, then drop public later.
-- Running 0011 and leaving the app on public is safe; the reverse is not.
--
-- THE COLUMN LIST IS COMPUTED, NOT WRITTEN OUT
-- --------------------------------------------
-- 19 hand-written column lists would be 19 chances to silently drop a
-- column — and a column that exists in public but not in the template is
-- exactly the kind of drift 0009's completeness review never got to
-- check. So each table's list is derived by intersecting the two
-- catalogs, and §4 FAILS THE MIGRATION if public holds any column the
-- tenant schema lacks. Silent data loss is the one outcome worth
-- aborting for.
-- ============================================================

begin;

-- ============================================================
-- 1. THE FLAGSHIP REGISTRY ROW
--
-- Moved here from 0008 §2. A registry row must never exist without its
-- schema: sync_postgrest_schemas() builds PostgREST's exposed list from
-- this table, and every function that interpolates schema_name into
-- dynamic SQL (0010) would otherwise hit a raw "schema does not exist".
-- So the row and the schema are created together, a few lines apart,
-- and 0010 §7(e) asserts the invariant.
--
-- The UUID is the one 0004 §1 used, because the backfill in §3 finds the
-- flagship's rows by exactly this value.
-- ============================================================
insert into platform.tenants (id, slug, name, licensed_via, schema_name, role_name)
values ('00000000-0000-0000-0000-0000000f31e0', 'felix', 'FELIX Flagship Showroom',
        '508.world', 't_felix', 'felix_felix')
on conflict (id) do nothing;

select platform.create_tenant_schema('felix');

-- ============================================================
-- 2. CLEAR THE BASELINE SEED
--
-- create_tenant_schema() seeds what a NEW showroom cannot function
-- without: a first branch, its overhead_config row, and the 10-tier
-- commission ladder (0009 §7). The flagship already has all three, with
-- real values — its own branches, its own configured overhead, and a
-- ladder its CEO may have reshaped from the Accountant Hub.
--
-- Left in place, the seed would collide: commission_tiers is keyed on
-- tier_index so the copy would conflict outright, and the branch would
-- survive as a phantom "Main Showroom" alongside the real ones,
-- selectable in every branch dropdown in the product.
--
-- TRUNCATE rather than DELETE: the schema is seconds old and holds
-- nothing but seed, CASCADE handles overhead_config's FK to branches,
-- and it resets any sequence the copy would otherwise continue from.
-- ============================================================
truncate table
  t_felix.branches, t_felix.overhead_config, t_felix.commission_tiers
  cascade;

-- ============================================================
-- 3. THE COPY
--
-- Order is FK order: nothing is inserted before what it references.
--
-- Triggers are suspended for the same reasons 0004 §2 suspended them,
-- and they all still apply: audit_log's immutability trigger rejects
-- writes it did not make, the sold-vehicle locks reject any edit to an
-- already-sold car, the deal-ticket status guard calls is_manager_or_above()
-- which is false for a migration's own session, and record_audit() would
-- otherwise write one audit row per copied row — burying the real audit
-- history under the migration's own noise.
--
-- Sequences are not reset afterwards because every table in this schema
-- keys on uuid; the only serial-shaped thing is the contract serial,
-- which generate_contract_serial() derives from existing rows rather
-- than from a sequence.
-- ============================================================
do $$
declare
  c_flagship constant uuid := '00000000-0000-0000-0000-0000000f31e0';
  c_schema   constant text := 't_felix';

  -- FK order. Reversing two of these is the difference between a clean
  -- run and a foreign-key violation halfway through a data migration.
  c_order constant text[] := array[
    'branches', 'profiles', 'investors', 'vehicles', 'vehicle_equity_splits',
    'vehicle_expenses', 'overhead_config', 'financing_partners', 'leads',
    'lead_comments', 'deal_tickets', 'deal_ticket_events',
    'financing_requests', 'contracts', 'commission_tiers', 'ledger_entries',
    'audit_log', 'meetings', 'meeting_invitees'];

  t        text;
  v_cols   text;
  v_missing text;
  v_src    bigint;
  v_dst    bigint;
begin
  -- Abort before copying anything if the tenant schema is missing a
  -- column the live data uses. Reported for ALL tables at once, because
  -- finding these one migration-run at a time is miserable.
  select string_agg(format('%s.%s', c.table_name, c.column_name), ', ' order by c.table_name, c.column_name)
    into v_missing
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = any(c_order)
     and c.column_name <> 'tenant_id'
     and not exists (
       select 1 from information_schema.columns d
        where d.table_schema = c_schema
          and d.table_name = c.table_name
          and d.column_name = c.column_name);

  if v_missing is not null then
    raise exception
      'The tenant schema template is missing column(s) that live data uses: %. Copying would silently drop them', v_missing;
  end if;

  foreach t in array c_order loop
    execute format('alter table %I.%I disable trigger user', c_schema, t);

    -- Intersect the catalogs rather than hand-writing 19 column lists.
    -- Ordered by the SOURCE's ordinal position and used for both sides,
    -- so a column-order difference between the two schemas cannot
    -- transpose values into the wrong columns.
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into v_cols
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = t
       and c.column_name <> 'tenant_id'
       and exists (
         select 1 from information_schema.columns d
          where d.table_schema = c_schema
            and d.table_name = c.table_name
            and d.column_name = c.column_name);

    if v_cols is null then
      raise exception 'No copyable columns found for public.% — catalog lookup is wrong', t;
    end if;

    execute format(
      'insert into %I.%I (%s) select %s from public.%I where tenant_id = %L on conflict do nothing',
      c_schema, t, v_cols, v_cols, t, c_flagship);

    execute format('alter table %I.%I enable trigger user', c_schema, t);

    -- Per-table verification, inside the same transaction that did the
    -- copy, so a mismatch rolls the whole thing back rather than leaving
    -- a half-migrated showroom to be discovered later.
    execute format('select count(*) from public.%I where tenant_id = %L', t, c_flagship) into v_src;
    execute format('select count(*) from %I.%I', c_schema, t) into v_dst;

    if v_src <> v_dst then
      raise exception
        'Row count mismatch on %: public has %, % has %', t, v_src, c_schema, v_dst;
    end if;

    raise notice 'copied % rows into %.%', v_dst, c_schema, t;
  end loop;
end $$;

-- ============================================================
-- 4. THE CONTROL-PLANE TABLES
--
-- These do not go to t_felix; they go to `platform`, because they are
-- the things that cannot be tenant-scoped (0008 §3).
-- ============================================================

-- Invitations. Normalised on the way in to satisfy the constraint 0010
-- §1 added, and given an expiry, since rows written before 0010 have
-- none and the column is NOT NULL with a default that only applies to
-- new rows. Pending invitations older than the window are already
-- effectively dead; giving them a fresh 7 days is the kinder reading and
-- matches what a CEO would expect after an upgrade.
insert into platform.staff_invitations
  (tenant_id, email, full_name, role, branch_id, invited_by, accepted_at, created_at, expires_at)
select
  '00000000-0000-0000-0000-0000000f31e0',
  lower(btrim(si.email)),
  si.full_name,
  si.role,
  si.branch_id,
  si.invited_by,
  si.accepted_at,
  si.created_at,
  case when si.accepted_at is null then now() + interval '7 days' else si.created_at end
from public.staff_invitations si
where si.tenant_id = '00000000-0000-0000-0000-0000000f31e0'
   or si.tenant_id is null
on conflict (tenant_id, email) do nothing;

-- The membership map the access token hook reads. Derived from the
-- profiles that were just copied: every existing flagship user must get
-- a row here or their next token carries no tenant role and they open
-- the app to a blank screen.
insert into platform.tenant_users (user_id, tenant_id)
select p.id, '00000000-0000-0000-0000-0000000f31e0'
  from t_felix.profiles p
 where exists (select 1 from auth.users u where u.id = p.id)
on conflict (user_id) do nothing;

-- Abuse-control buckets are deployment-wide, not tenant data (0008 §3).
insert into platform.rate_limit_buckets (bucket_key, window_start, hits)
select bucket_key, window_start, hits from public.rate_limit_buckets
on conflict (bucket_key) do nothing;

-- THE FUNCTION MOVES WITH ITS TABLE.
--
-- 0008 moved rate_limit_buckets into `platform` and 0009 explicitly
-- excluded consume_rate_limit from the tenant template — but nothing
-- created the platform copy, so the only definition still lived in
-- `public` and still read `public.rate_limit_buckets`. Copying the rows
-- without the function left the platform table as dead weight.
--
-- That gap is quiet in the worst way: rate limiting keeps working today
-- against the old table, and breaks the moment `public` is dropped. And
-- consume() in src/lib/rate-limit.ts FAILS OPEN by design — a limiter
-- that takes the login page down with it is a worse outage than the
-- abuse it prevents — so the breakage would surface as login throttling
-- silently not happening, with only a log line to say so.
--
-- Body carried over from 0003 unchanged except for schema qualification.
create or replace function platform.consume_rate_limit(
  p_key text, p_limit int, p_window_seconds int
) returns jsonb as $$
declare
  b platform.rate_limit_buckets%rowtype;
  now_ts timestamptz := now();
begin
  insert into platform.rate_limit_buckets (bucket_key, window_start, hits)
  values (p_key, now_ts, 0)
  on conflict (bucket_key) do nothing;

  select * into b from platform.rate_limit_buckets where bucket_key = p_key for update;

  if b.window_start < now_ts - make_interval(secs => p_window_seconds) then
    update platform.rate_limit_buckets
       set window_start = now_ts, hits = 1
     where bucket_key = p_key;
    return jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'retry_after', 0);
  end if;

  if b.hits >= p_limit then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after', ceil(extract(epoch from (b.window_start + make_interval(secs => p_window_seconds) - now_ts)))
    );
  end if;

  update platform.rate_limit_buckets set hits = hits + 1 where bucket_key = p_key;
  return jsonb_build_object('allowed', true, 'remaining', p_limit - b.hits - 1, 'retry_after', 0);
end;
$$ language plpgsql security definer set search_path = pg_catalog, platform, pg_temp;

create or replace function platform.prune_rate_limit_buckets(p_older_than interval default '1 day')
returns void as $$
  delete from platform.rate_limit_buckets where window_start < now() - p_older_than;
$$ language sql security definer set search_path = pg_catalog, platform, pg_temp;

-- Called by the service-role client only (src/lib/rate-limit.ts). Never
-- granted to a tenant role: a caller who can invoke it can also reset
-- their own bucket.
revoke all on function platform.consume_rate_limit(text,int,int) from public, anon, authenticated;
revoke all on function platform.prune_rate_limit_buckets(interval) from public, anon, authenticated;
grant execute on function platform.consume_rate_limit(text,int,int) to service_role;
grant execute on function platform.prune_rate_limit_buckets(interval) to service_role;

-- ============================================================
-- 5. VERIFICATION
--
-- §3 already checked every table's row count as it went. What is left is
-- the cross-schema arithmetic that only makes sense once everything has
-- landed, plus the invariants 0010 depends on.
-- ============================================================
do $$
declare
  c_flagship constant uuid := '00000000-0000-0000-0000-0000000f31e0';
  n bigint;
  m bigint;
begin
  -- Every flagship profile is mapped. A profile without a tenant_users
  -- row is a user who can authenticate, receives no tenant role from the
  -- hook, and sees an empty app with no error — the exact failure 0010
  -- §3 orders its inserts to avoid.
  select count(*) into n from t_felix.profiles p
   where exists (select 1 from auth.users u where u.id = p.id)
     and not exists (select 1 from platform.tenant_users tu where tu.user_id = p.id);
  if n > 0 then
    raise exception '% migrated profile(s) have no platform.tenant_users row — they would log in to a blank app', n;
  end if;

  -- Nothing was left behind. Compares the flagship's slice of public
  -- against the whole tenant schema, table by table, one last time
  -- against a fully-populated destination.
  select count(*) into n from public.vehicles where tenant_id = c_flagship;
  select count(*) into m from t_felix.vehicles;
  if n <> m then
    raise exception 'vehicles: % in public, % in t_felix', n, m;
  end if;

  select count(*) into n from public.ledger_entries where tenant_id = c_flagship;
  select count(*) into m from t_felix.ledger_entries;
  if n <> m then
    raise exception 'ledger_entries: % in public, % in t_felix', n, m;
  end if;

  -- The ledger is the one table where a partial copy is silently
  -- expensive rather than obviously broken: it is what investors are
  -- paid from, so a missing row is money.
  select coalesce(sum(amount), 0) into n from public.ledger_entries where tenant_id = c_flagship;
  select coalesce(sum(amount), 0) into m from t_felix.ledger_entries;
  if n <> m then
    raise exception 'Ledger totals differ: public %, t_felix % — do not proceed', n, m;
  end if;

  -- The baseline seed is gone rather than mixed in with real data.
  select count(*) into n from t_felix.branches where name = 'Main Showroom'
    and not exists (select 1 from public.branches b
                     where b.tenant_id = c_flagship and b.name = 'Main Showroom');
  if n > 0 then
    raise exception 'A seeded "Main Showroom" branch survived into t_felix alongside the real branches';
  end if;

  raise notice 'flagship migrated: % profiles, % vehicles, % ledger entries',
    (select count(*) from t_felix.profiles),
    (select count(*) from t_felix.vehicles),
    (select count(*) from t_felix.ledger_entries);
end $$;

commit;

-- Outside the transaction, for the reason 0008 §5 gives: this reaches
-- out of the database and changes a running PostgREST. t_felix now
-- exists, so announcing it is finally correct.
select platform.sync_postgrest_schemas();
