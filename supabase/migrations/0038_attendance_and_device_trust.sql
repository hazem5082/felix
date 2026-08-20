-- ============================================================
-- 0038 — ATTENDANCE: GEOFENCE, DEVICE TRUST AND WORK MODE
--
-- A showroom group knows to the pound what every car cost and has no
-- idea who was standing on the floor when it sold. Attendance today is
-- a paper book by the door, a WhatsApp message, or nothing.
--
-- WHAT THIS ADDS
-- --------------
--   branches.latitude / .longitude / .geofence_radius_m
--                          where the showroom physically is, and how
--                          far from that pin still counts as "here".
--   profiles.work_mode     'on_site' | 'remote'. A remote profile owes
--                          no attendance; an on-site one owes a day.
--   trusted_devices        the phones a person may punch from. One row
--                          per (profile, device), soft-revoked.
--   device_verifications   the short-lived email codes that let a NEW
--                          phone become a trusted one. Deliberately
--                          unreadable by every tenant session — see
--                          "THE CODE TABLE IS NOT READABLE" below.
--   attendance_events      one row per punch: arrival, break out, break
--                          back, departure. Carries the coordinates it
--                          was taken at, the distance from the branch
--                          pin, and the verdict.
--
-- WHY THE DISTANCE IS COMPUTED IN THE DATABASE
-- --------------------------------------------
-- The phone reports coordinates. It must not report the ANSWER. A
-- browser's geolocation API is scriptable — navigator.geolocation can
-- be monkey-patched from a console in ten seconds — so coordinates are
-- already a claim rather than a fact, and this product's honest
-- position is that it records where the phone SAYS it is. But letting
-- the same client also send distance_m and within_geofence would mean
-- the row asserts its own correctness, and the report would show a
-- green tick that nothing ever checked.
--
-- stamp_attendance_geofence() in section 4 therefore NULLs both fields
-- on the way in and recomputes them from branches' own pin, on every
-- insert, for every caller including service_role. Whatever the client
-- sent is discarded before it is ever stored. The GPS accuracy the
-- phone reports is honoured as a tolerance but CLAMPED at 100 m, so a
-- client claiming accuracy_m = 999999 buys itself 100 metres and not a
-- kilometre.
--
-- Not SECURITY DEFINER, deliberately: assertion (f) inside
-- platform.create_tenant_schema() pins the number of those per schema
-- (twenty-one, since 0037 added has_branch_grant), and this function
-- needs none of the privilege — it reads branches, which
-- branches_select already shows to every member of the showroom.
--
-- THE CODE TABLE IS NOT READABLE
-- ------------------------------
-- device_verifications holds a hash of the six-digit code emailed to
-- someone enrolling a new phone. If a tenant session could SELECT that
-- table the second factor would be worth nothing: a salesperson could
-- read their own pending row and — the code being six digits over a
-- known input space — recover it offline without ever opening mail.
--
-- So this table has NO POLICIES AT ALL. With RLS enabled and no
-- permissive policy, Postgres denies every row to every non-owner
-- without BYPASSRLS — the absence IS the fence, and §4 asserts the
-- policy count is zero for exactly that reason.
--
-- The tenant role does hold SELECT on it, and that is not a
-- contradiction: guard (5) inside the template's own §6j requires the
-- role to hold SELECT on EVERY table in the schema, because a missing
-- grant is otherwise a table that is silently invisible to the whole
-- showroom with no error anywhere. Withholding it here would abort
-- provisioning for every future showroom in a file that reads as if it
-- only added attendance. So the verb is granted and the rows are
-- denied, which is the same arrangement every other table in this
-- schema uses — the difference is only that here the policy set is
-- empty rather than narrow. INSERT, UPDATE and DELETE are withheld
-- outright, so even a policy added by mistake could not produce a
-- write. Every read and write of it happens inside a Server Action
-- through the admin client, which already knows who the caller is from
-- their own session before it looks anything up.
--
-- The same reasoning is why trusted_devices has no INSERT grant for the
-- tenant role. A policy cannot express "and the emailed code was
-- correct", so a session-level INSERT would let anyone enrol a phone by
-- POSTing at PostgREST and skip the code entirely. Enrolment is
-- service-role only. REVOCATION is not: it rides the caller's own
-- session through a column-limited grant, precisely so record_audit()
-- stamps the real actor on "who cut this phone off".
--
-- WORK MODE IS A PRIVILEGE COLUMN
-- -------------------------------
-- guard_profile_privilege_columns() gains a third arm. work_mode
-- decides whether a person owes attendance at all, so a self-service
-- work_mode would make the whole report opt-out: `update profiles set
-- work_mode='remote' where id = auth.uid()` and the absence disappears.
-- It joins role and branch_id as CEO-only, which also keeps it beside
-- every other employment term on the CEO-only employees page — a branch
-- manager cannot change a subordinate's wage, branch or role today
-- either, and work mode is a contract term, not a day's circumstance.
--
-- A manager who needs to fix one DAY rather than one CONTRACT has the
-- adjustment path instead: source='adjustment' with a mandatory reason,
-- which the report renders as an adjustment and never as a GPS punch.
--
-- NOTHING IS DELETED, AS EVER
-- ---------------------------
-- §6f grants DELETE on nothing and assertion (j) proves it, so a
-- mistaken punch is VOIDED (voided_at / voided_by / void_reason) rather
-- than removed, a lost phone is revoked rather than deleted, and the
-- attendance report filters voided rows out while the trail keeps them.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * It adds no role. On-site vs remote is a column, not a rank —
--     0030's argument about area managers, restated.
--   * It adds no SECURITY DEFINER function, so assertion (f)'s count
--     (twenty-one, after 0037) is untouched. The one function this file
--     does add, stamp_attendance_geofence(), is a plain trigger.
--   * It adds nothing to c_tables inside create_tenant_schema(), for
--     the reason 0016 and 0030 both give; §4 below verifies the three
--     tables across every live schema directly.
--   * It does not compute a working day, a late arrival or an overtime
--     hour. Those are a pure function over the event stream and live in
--     src/lib/attendance.ts, where they can be unit-tested — the same
--     decision 0036 made for stock ageing.
--   * It widens no existing policy. branches gains a SECOND update
--     policy (managers, geofence only) rather than a loosened
--     branches_write, and the column-limited grant beside it is what
--     actually holds the line.
--
-- LINE ENDINGS
-- ------------
-- The anchors below are authored with LF; the stored template is CRLF.
-- §2 normalises every anchor and every replacement to the template's
-- own convention before touching it, exactly as 0030 §2 does, or every
-- multi-line anchor silently misses and the guard raises a drift error
-- that is a lie.
--
-- STRUCTURE MIRRORS 0030/0036 — template + live loop, anchored and
-- verified substitutions, per-tenant search_path in §3 because policy
-- expressions, FK targets and the trigger's function are resolved and
-- frozen at CREATE time. Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0038 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  -- §2 splices the three tables onto the tail of what 0035 added, so
  -- 0035 is the batch-ordering gate. A database that skipped it fails
  -- here rather than four anchors deep with a misleading drift message.
  if position('create table if not exists stock_transfers' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0038 PRECONDITION FAILED: the template has no stock_transfers. Apply 0035 first.';
  end if;

  -- 0019's branch licensing block is the anchor for the geofence
  -- columns; 0018's statutory block is the anchor for work_mode.
  if position('is_under_residential_building boolean' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0038 PRECONDITION FAILED: the template has no branch licensing columns. Apply 0019 first.';
  end if;

  if position('  employment_type     text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0038 PRECONDITION FAILED: the template has no employment_type. Apply 0018 first.';
  end if;

  -- 0037 IS A HARD GATE, not an ordering preference.
  --
  -- Every attendance policy below calls can_act_on_branch() or
  -- can_read_branch(). Before 0037 those two inlined `auth.uid()` into
  -- the caller's own name resolution, and the tenant role holds no
  -- USAGE on schema auth — so every one of them raised "permission
  -- denied for schema auth" for every session, the CEO included.
  -- Shipping attendance onto that would produce a showroom where
  -- nobody can punch, and the failure would read as a bug in THIS file
  -- rather than the one it actually is.
  --
  -- 0037 fixes it by moving the branch_grants lookup into
  -- has_branch_grant(), a SECURITY DEFINER function that resolves
  -- auth.uid() as its owner — and raises assertion (f)'s count from 20
  -- to 21 in the same migration, which is what that assertion's own
  -- comment asks of anyone who legitimately changes the number.
  if position('has_branch_grant' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0038 PRECONDITION FAILED: the branch predicates still resolve auth.uid() as the tenant role. Apply 0037 first, or every punch will fail with "permission denied for schema auth".';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Nine anchored substitutions. Every anchor is a within-section span:
-- 0036's header records what happened when an anchor crossed a section
-- boundary and a migration authored in parallel landed between its two
-- ends.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  -- None of these is `constant`: every one is rewritten into the
  -- template's own line-ending convention before it is used. See the
  -- header, and the normalisation block at the top of the body.

  -- 2a. branches: the geofence, at the tail of 0019's licensing block.
  c_br_from text := $a1$  is_under_residential_building boolean,
  created_at  timestamptz default now()
);$a1$;
  c_br_to   text := $a2$  is_under_residential_building boolean,
  -- GEOFENCE (0038) — where this showroom physically is, and how far
  -- from the pin still counts as "at work".
  --
  -- Null latitude/longitude means nobody has placed this branch on the
  -- map yet. Every punch against such a branch stores within_geofence
  -- NULL — "not assessed" — rather than false: a branch nobody has
  -- pinned must not read as a branch everybody is absent from.
  --
  -- numeric(9,6) is ~11 cm of resolution, which is three orders of
  -- magnitude finer than any phone GPS and costs nothing to store.
  -- The radius floor of 25 m is a fence a phone can actually sit
  -- inside; the 5 km ceiling is what stops "the whole governorate"
  -- being entered as a showroom.
  latitude                      numeric(9,6) check (latitude between -90 and 90),
  longitude                     numeric(9,6) check (longitude between -180 and 180),
  geofence_radius_m             int not null default 150
                                check (geofence_radius_m between 25 and 5000),
  created_at  timestamptz default now()
);$a2$;

  -- 2b. profiles: work_mode, beside the other employment terms 0018
  --     added rather than among the contact preferences — which is
  --     also the line guard_profile_privilege_columns() draws.
  c_pr_from text := $b1$  employment_type     text,
  created_at          timestamptz default now(),$b1$;
  c_pr_to   text := $b2$  employment_type     text,
  -- WORK MODE (0038). NOT NULL with a default, so every profile that
  -- already exists becomes 'on_site' — which is the truthful answer for
  -- a showroom floor and makes the column additive to every tenant
  -- already trading. A CEO marks the exceptions.
  --
  -- This is a PRIVILEGE column: guard_profile_privilege_columns()
  -- refuses to let anyone but the CEO change it. See the file header.
  work_mode           text        not null default 'on_site'
                                  check (work_mode in ('on_site','remote')),
  created_at          timestamptz default now(),$b2$;

  -- 2c. the three tables, after stock_transfers' partial unique index —
  --     the tail of what 0035 spliced in. They belong AFTER profiles
  --     and branches (both are FK targets) and after nothing else.
  c_tbl_from text := $c1$create unique index if not exists uniq_stock_transfer_open_per_vehicle
  on stock_transfers(vehicle_id) where status = 'requested';$c1$;
  c_tbl_to   text := $c2$create unique index if not exists uniq_stock_transfer_open_per_vehicle
  on stock_transfers(vehicle_id) where status = 'requested';

-- ------------------------------------------------------------
-- 12-bis. TRUSTED DEVICES  (0038)
--
-- The phones a person may punch attendance from. A browser cannot read
-- a hardware identifier — there is no IMEI, no serial, nothing a web
-- page is allowed to see — so device_hash is a SHA-256 of a random
-- secret the app plants on the phone the first time it enrols, never
-- of anything the browser volunteers. That makes it a bearer token
-- rather than an identity: copy the secret and you have copied the
-- device. What it buys is that the copy must be deliberate. The user
-- agent is stored ALONGSIDE it as a label ("iPhone, iOS 17") so a
-- person can recognise their own phone in a list, and is never part of
-- the hash, because a browser update would otherwise silently unenrol
-- every phone in the company on the same afternoon.
--
-- No INSERT grant for the tenant role — enrolment requires the emailed
-- code, which no policy can express. See the file header.
-- ------------------------------------------------------------
create table if not exists trusted_devices (
  id            uuid        primary key default gen_random_uuid(),
  profile_id    uuid        not null references profiles(id) on delete cascade,
  device_hash   text        not null,
  -- What the person sees in their device list. Free text from the
  -- user agent, so treat it as untrusted when rendering.
  label         text,
  platform      text,
  status        text        not null default 'active'
                            check (status in ('active','revoked')),
  enrolled_at   timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid        references profiles(id),
  constraint trusted_devices_revocation_consistent check (
    (status = 'active'  and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

-- One row per (person, phone), forever. status is what changes, so a
-- re-enrolled phone reuses its row and its history rather than opening
-- a second answer to "may this phone punch?" — 0030's unique index on
-- branch_grants, for the same reason.
create unique index if not exists uniq_trusted_device_profile_hash
  on trusted_devices(profile_id, device_hash);
create index if not exists idx_trusted_devices_profile
  on trusted_devices(profile_id);

-- ------------------------------------------------------------
-- 12-ter. DEVICE VERIFICATIONS  (0038)
--
-- One row per emailed six-digit code. NO POLICIES AND NO TENANT GRANT,
-- deliberately and load-bearingly — see the file header. If a future
-- migration adds either, the second factor stops being one.
--
-- The code is stored as a SHA-256 hex digest and never in clear.
-- attempts is what makes a six-digit code defensible at all: the
-- Server Action refuses a row past a small number of wrong guesses,
-- and the row expires within minutes regardless.
-- ------------------------------------------------------------
create table if not exists device_verifications (
  id           uuid        primary key default gen_random_uuid(),
  profile_id   uuid        not null references profiles(id) on delete cascade,
  device_hash  text        not null,
  code_hash    text        not null,
  label        text,
  platform     text,
  attempts     int         not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_device_verifications_pending
  on device_verifications(profile_id, created_at desc);

-- ------------------------------------------------------------
-- 12-quater. ATTENDANCE EVENTS  (0038)
--
-- One row per punch. The stream IS the record: there is no "today"
-- row that gets updated four times, because a day that is a row has
-- to decide in advance how many breaks a person may take, and because
-- an append-only stream is the only shape in which "when did he
-- actually leave" survives someone changing their mind.
--
-- branch_id is the branch being attended, not a copy of the profile's
-- home branch: a manager covering Heliopolis under a 0030 grant punches
-- in at Heliopolis, and the geofence checked is Heliopolis'. It is
-- denormalised onto the row (0033's receivables-book pattern) so the
-- SELECT policy is a scalar can_read_branch(branch_id) rather than a
-- subquery into profiles.
--
-- distance_m and within_geofence are NOT the app's to set — the
-- trigger in section 4 overwrites both. See the file header.
--
-- source distinguishes a punch the person took on their phone from one
-- a manager entered on their behalf, and the CHECK makes the reason
-- mandatory for the second. The attendance report renders them
-- differently and must always be able to tell them apart: an adjusted
-- day that looks like a GPS day is a worse record than no record.
-- ------------------------------------------------------------
create table if not exists attendance_events (
  id               uuid        primary key default gen_random_uuid(),
  profile_id       uuid        not null references profiles(id) on delete cascade,
  branch_id        uuid        not null references branches(id),
  kind             text        not null
                               check (kind in ('in','break_start','break_end','out')),
  occurred_at      timestamptz not null default now(),
  latitude         numeric(9,6) check (latitude between -90 and 90),
  longitude        numeric(9,6) check (longitude between -180 and 180),
  -- What the phone claimed about its own precision, in metres. Used as
  -- a tolerance by the trigger and clamped there; stored raw so the
  -- report can show a punch that was only accurate to half a kilometre
  -- for what it is.
  accuracy_m       numeric     check (accuracy_m >= 0),
  distance_m       numeric,
  within_geofence  boolean,
  device_id        uuid        references trusted_devices(id),
  source           text        not null default 'device'
                               check (source in ('device','adjustment')),
  -- Who caused this row to exist: the person themselves for a punch,
  -- the manager for an adjustment. Pinned to auth.uid() by the policy.
  recorded_by      uuid        references profiles(id),
  reason           text,
  voided_at        timestamptz,
  voided_by        uuid        references profiles(id),
  void_reason      text,
  created_at       timestamptz not null default now(),
  constraint attendance_adjustment_needs_reason check (
    source <> 'adjustment' or (reason is not null and length(btrim(reason)) > 0)
  ),
  constraint attendance_void_needs_reason check (
    voided_at is null
    or (void_reason is not null and length(btrim(void_reason)) > 0)
  )
);

-- "This person's day", which is every read the punch screen and the
-- per-employee report make.
create index if not exists idx_attendance_events_profile_time
  on attendance_events(profile_id, occurred_at desc);
-- "This branch's day", which is the manager's board and the report's
-- window scan.
create index if not exists idx_attendance_events_branch_time
  on attendance_events(branch_id, occurred_at desc);$c2$;

  -- 2d. guard_profile_privilege_columns() gains the work_mode arm, and
  --     stamp_attendance_geofence() lands immediately after it.
  --
  --     One substitution rather than two because the second's anchor
  --     would otherwise be text the first had just rewritten, and the
  --     order-dependence between them is exactly the kind of thing that
  --     survives review and fails in production six months later.
  c_fn_from text := $d1$  if old.role = 'ceo' and new.role is distinct from 'ceo'
     and (select count(*) from profiles where role = 'ceo') <= 1 then
    raise exception 'Cannot remove the last CEO account (LAST_CEO)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$d1$;
  c_fn_to   text := $d2$  if old.role = 'ceo' and new.role is distinct from 'ceo'
     and (select count(*) from profiles where role = 'ceo') <= 1 then
    raise exception 'Cannot remove the last CEO account (LAST_CEO)';
  end if;

  -- 0038. work_mode decides whether this person owes attendance at
  -- all, so self-service would make the attendance report opt-out:
  -- `update profiles set work_mode='remote' where id = auth.uid()`
  -- passes both USING and WITH CHECK of profiles_update_self, and the
  -- absence simply stops being an absence. It is an employment term,
  -- and it sits with the other employment terms: CEO only.
  if new.work_mode is distinct from old.work_mode and not is_ceo() then
    raise exception 'Only the CEO can change a work mode (PRIVILEGE_LOCKED)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0038. The geofence verdict, computed HERE and never accepted from a
-- client. See the file header for why this is the whole point of the
-- feature rather than a detail of it.
--
-- NOT SECURITY DEFINER: assertion (f)'s per-schema count is untouched
-- by this file, and this needs no privilege — branches_select already
-- shows every member of the showroom the row it reads.
--
-- Haversine on a spherical earth. The error against a proper geodesic
-- is a few metres in a thousand kilometres, which is irrelevant at a
-- fence measured in tens of metres, and it needs no extension —
-- PostGIS is not installed and adding it to reach a schoolbook formula
-- would be a strange trade.
create or replace function stamp_attendance_geofence() returns trigger as $trg$
declare
  v_lat numeric;
  v_lng numeric;
  v_rad int;
  v_tol numeric;
begin
  -- Whatever the client sent for these two is discarded, always,
  -- before anything else happens. This is the line that makes the
  -- verdict the database's rather than the phone's.
  new.distance_m      := null;
  new.within_geofence := null;

  select latitude, longitude, geofence_radius_m
    into v_lat, v_lng, v_rad
    from branches
   where id = new.branch_id;

  -- An unpinned branch, or a manager's adjustment typed at a desk with
  -- no coordinates at all: both leave the verdict NULL, which the
  -- report renders as "not assessed" and never as "outside".
  if v_lat is null or v_lng is null
     or new.latitude is null or new.longitude is null then
    return new;
  end if;

  new.distance_m := round((
    6371000 * 2 * asin(sqrt(
        power(sin(radians((new.latitude - v_lat)::float8) / 2), 2)
      + cos(radians(v_lat::float8)) * cos(radians(new.latitude::float8))
        * power(sin(radians((new.longitude - v_lng)::float8) / 2), 2)
    ))
  )::numeric);

  -- The phone's own accuracy claim is honoured as slack, and clamped:
  -- a client reporting accuracy_m = 999999 buys 100 metres, not a
  -- kilometre. Null accuracy means no slack rather than infinite.
  v_tol := least(coalesce(new.accuracy_m, 0), 100);
  new.within_geofence := new.distance_m <= coalesce(v_rad, 150) + v_tol;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;$d2$;

  -- 2e. RLS enablement, at the tail of the list 0033 last extended.
  c_rls_from text := $e1$alter table receipts               enable row level security;$e1$;
  c_rls_to   text := $e2$alter table receipts               enable row level security;
alter table trusted_devices        enable row level security;
alter table device_verifications   enable row level security;
alter table attendance_events      enable row level security;$e2$;

  -- 2f. the policies, after stock_transfers' three.
  c_pol_from text := $f1$drop policy if exists "stock_transfers_update" on stock_transfers;
create policy "stock_transfers_update" on stock_transfers for update
  using (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id))
  with check (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id));$f1$;
  c_pol_to   text := $f2$drop policy if exists "stock_transfers_update" on stock_transfers;
create policy "stock_transfers_update" on stock_transfers for update
  using (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id))
  with check (can_act_on_branch(from_branch_id) or can_act_on_branch(to_branch_id));

-- ------------------------------------------------------------
-- 5b-bis. BRANCHES, GEOFENCE ONLY — 0038
--
-- branches_write is `for all using (is_ceo())` and stays exactly as it
-- is. This is a SECOND, permissive UPDATE policy so that a branch
-- manager can place their own showroom on the map without gaining the
-- power to rename it, re-license it, or open a new one.
--
-- The policy is only half the fence and the smaller half. §6 grants the
-- tenant role `update (latitude, longitude, geofence_radius_m)` on
-- branches and nothing else — a column-limited grant, in the shape 0024
-- used for the eta_* fields and 0028 for the two prices. Whatever any
-- policy says, no session can write any other column of branches,
-- because the privilege to do so does not exist.
-- ------------------------------------------------------------
drop policy if exists "branches_geofence_update" on branches;
create policy "branches_geofence_update" on branches for update
  using (is_manager_or_above() and can_act_on_branch(id))
  with check (is_manager_or_above() and can_act_on_branch(id));

-- ------------------------------------------------------------
-- 5q-bis. TRUSTED DEVICES — 0038
--
-- READ is own-rows, plus the CEO, plus a manager over their own branch
-- — the shape employee_targets_select uses. The subquery into profiles
-- is safe here in a way 0030 explains it would NOT have been on
-- branch_grants: nothing expands trusted_devices inside another
-- policy, so there is no path back into profiles_select and no cycle
-- to open.
--
-- There is no INSERT policy and (see §6) no INSERT grant. Enrolling a
-- phone requires the emailed code to have been checked, which no
-- predicate can express, so enrolment belongs to the service role and
-- to the one Server Action that holds it.
--
-- UPDATE exists for exactly one purpose — revoking a phone — and the
-- column-limited grant beside it is what confines it to that. It is
-- deliberately NOT service-role-only: revocation through the caller's
-- own session is what lets record_audit() stamp who did it, and "who
-- cut this phone off, and when" is the question this table exists to
-- answer after the fact.
-- ------------------------------------------------------------
drop policy if exists "trusted_devices_select" on trusted_devices;
create policy "trusted_devices_select" on trusted_devices for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = trusted_devices.profile_id
         and p.branch_id = current_branch_id())));

drop policy if exists "trusted_devices_update" on trusted_devices;
create policy "trusted_devices_update" on trusted_devices for update
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = trusted_devices.profile_id
         and p.branch_id = current_branch_id())))
  with check (
    (profile_id = auth.uid()
     or is_ceo()
     or (is_manager_or_above() and exists (
       select 1 from profiles p
        where p.id = trusted_devices.profile_id
          and p.branch_id = current_branch_id())))
    and status = 'revoked'
    and revoked_by = auth.uid());

-- ------------------------------------------------------------
-- 5q-ter. DEVICE VERIFICATIONS — 0038
--
-- NO POLICIES. Not an omission: RLS is enabled on this table and the
-- absence of a permissive policy is what makes it deny. §6 withholds
-- every verb from the tenant role as well, so the two say the same
-- thing twice.
--
-- The reason is in the file header and is worth repeating where a
-- future migration would come to add one: a six-digit code over a
-- known input space is recoverable from its hash by anyone who can
-- read the hash. A SELECT policy here, however narrow, ends the second
-- factor.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5q-quater. ATTENDANCE EVENTS — 0038
--
-- READ: your own attendance, always. Otherwise a manager over the
-- branch, or an accountant/CEO org-wide — can_read_branch() is already
-- both of those. A sales exec deliberately cannot read a colleague's
-- attendance: it is HR data, the branch predicate alone would have
-- shown the whole floor to the whole floor, and nothing in the product
-- asks a salesperson who else was in.
--
-- INSERT: one policy covering both paths, because they differ only in
-- who the row is about.
--   a punch      — you, about you, at a branch you may act on
--   an adjustment — a manager, about somebody else, at a branch they
--                   may act on, with a reason the CHECK constraint
--                   makes mandatory
-- recorded_by = auth.uid() in both arms, so the row always names who
-- caused it and nobody can file a punch under a colleague's name.
--
-- UPDATE: voiding, and only voiding. The column-limited grant in §6 is
-- the real fence — occurred_at, the coordinates and the verdict are
-- outside it and therefore unreachable, whatever this policy says.
-- Nobody edits when somebody arrived; a wrong row is struck with a
-- reason and a correcting row is added beside it.
-- ------------------------------------------------------------
drop policy if exists "attendance_events_select" on attendance_events;
create policy "attendance_events_select" on attendance_events for select
  using (
    profile_id = auth.uid()
    or is_accountant_or_above()
    or (is_manager_or_above() and can_read_branch(branch_id)));

drop policy if exists "attendance_events_insert" on attendance_events;
create policy "attendance_events_insert" on attendance_events for insert
  with check (
    recorded_by = auth.uid()
    and can_act_on_branch(branch_id)
    and (
      (source = 'device' and profile_id = auth.uid())
      or (source = 'adjustment' and is_manager_or_above())
    ));

drop policy if exists "attendance_events_update" on attendance_events;
create policy "attendance_events_update" on attendance_events for update
  using (is_manager_or_above() and can_act_on_branch(branch_id))
  with check (
    is_manager_or_above()
    and can_act_on_branch(branch_id)
    and voided_at is not null
    and voided_by = auth.uid());$f2$;

  -- 2g. the triggers, after branch_grants' audit trigger — the tail of
  --     the audit-trigger list.
  c_trg_from text := $g1$drop trigger if exists trg_audit_branch_grants on branch_grants;
create trigger trg_audit_branch_grants
  after insert or update or delete on branch_grants
  for each row execute function record_audit();$g1$;
  c_trg_to   text := $g2$drop trigger if exists trg_audit_branch_grants on branch_grants;
create trigger trg_audit_branch_grants
  after insert or update or delete on branch_grants
  for each row execute function record_audit();

-- 0038. BEFORE INSERT, so the verdict is stamped onto the row being
-- written rather than corrected afterwards. This is the trigger that
-- makes the geofence real; without it attendance_events records
-- whatever the phone claimed about its own compliance.
drop trigger if exists trg_stamp_attendance_geofence on attendance_events;
create trigger trg_stamp_attendance_geofence
  before insert on attendance_events
  for each row execute function stamp_attendance_geofence();

-- Both new tables are authority records of a kind: one says who was at
-- work, the other says which phone is allowed to say so. Who revoked a
-- device and who voided a punch must survive the row being revised in
-- place — 0030's argument for auditing branch_grants, restated.
drop trigger if exists trg_audit_attendance_events on attendance_events;
create trigger trg_audit_attendance_events
  after insert or update or delete on attendance_events
  for each row execute function record_audit();

drop trigger if exists trg_audit_trusted_devices on trusted_devices;
create trigger trg_audit_trusted_devices
  after insert or update or delete on trusted_devices
  for each row execute function record_audit();

-- device_verifications is deliberately NOT audited. record_audit()
-- copies the whole row into audit_log, which accountants and the CEO
-- can read — so auditing it would take the one column this schema
-- works hardest to keep unreadable and file a copy somewhere readable.
-- Nothing is lost: trusted_devices' own trail records the enrolment
-- that a successful code produced.$g2$;

  -- 2h. the column-limited grant on branches, beside the SELECT it
  --     has carried since 0001.
  c_bgnt_from text := $h1$grant select on branches to {{ROLE}};$h1$;
  c_bgnt_to   text := $h2$grant select on branches to {{ROLE}};

-- 0038. The geofence, and NOTHING else on this table. branches has
-- never been writable from a tenant session — there is no branch
-- editor in the product, and renaming or re-licensing a showroom is
-- not something this migration is opening. Three columns, in the shape
-- 0024 used to open the eta_* fields on contracts and 0028 the two
-- prices on vehicles: the policy above says who, this says what, and
-- the second is the one that cannot be widened by accident.
grant update (latitude, longitude, geofence_radius_m) on branches to {{ROLE}};$h2$;

  -- 2i. the grants for the three new tables, after stock_transfers'.
  c_gnt_from text := $i1$grant select, insert, update on stock_transfers to {{ROLE}};
grant select, insert, update, delete on stock_transfers to service_role;$i1$;
  c_gnt_to   text := $i2$grant select, insert, update on stock_transfers to {{ROLE}};
grant select, insert, update, delete on stock_transfers to service_role;

-- ── attendance (0038) ───────────────────────────────────────
--
-- trusted_devices: read and revoke, never enrol. INSERT is withheld
-- because a policy cannot check that the emailed code was right, so
-- enrolment is the service role's alone. The UPDATE is column-limited
-- to the three revocation fields — with those three the policy's
-- `status = 'revoked'` is enforceable, and without the limit a session
-- could rewrite device_hash and adopt somebody else's phone.
grant select on trusted_devices to {{ROLE}};
grant update (status, revoked_at, revoked_by) on trusted_devices to {{ROLE}};
grant select, insert, update, delete on trusted_devices to service_role;

-- device_verifications: SELECT and nothing else, and the SELECT is a
-- formality. §6j's guard (5) refuses to provision a schema in which the
-- tenant role lacks SELECT on any table — it is the detector for a
-- typo'd grant, and it cannot tell a deliberate omission from one. So
-- the verb is granted and RLS does the refusing: this table carries no
-- policies, and with RLS on that means every row is denied. §4 asserts
-- the policy count is zero, which is the property that actually holds
-- the second factor up. No write verb, so even a policy added later by
-- mistake could not turn into a forged enrolment.
grant select on device_verifications to {{ROLE}};
grant select, insert, update, delete on device_verifications to service_role;

-- attendance_events: punch (insert) and void (a column-limited
-- update). No DELETE — assertion (j) forbids it outright and a struck
-- punch is voided, never removed. occurred_at, the coordinates,
-- distance_m and within_geofence are all outside the update grant, so
-- no session can retouch when or where somebody was.
grant select, insert on attendance_events to {{ROLE}};
grant update (voided_at, voided_by, void_reason) on attendance_events to {{ROLE}};
grant select, insert, update, delete on attendance_events to service_role;$i2$;
begin
  -- The template's own line-ending convention decides the anchors'.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next. Each string is flattened to
  -- LF first, in case an editor saved THIS file with CRLF, and then
  -- rewritten in the template's convention.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_br_from   := replace(replace(c_br_from,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_br_to     := replace(replace(c_br_to,     chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pr_from   := replace(replace(c_pr_from,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pr_to     := replace(replace(c_pr_to,     chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_from  := replace(replace(c_tbl_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to    := replace(replace(c_tbl_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fn_from   := replace(replace(c_fn_from,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_fn_to     := replace(replace(c_fn_to,     chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from  := replace(replace(c_rls_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to    := replace(replace(c_rls_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_from  := replace(replace(c_pol_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_to    := replace(replace(c_pol_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_from  := replace(replace(c_trg_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_to    := replace(replace(c_trg_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_bgnt_from := replace(replace(c_bgnt_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_bgnt_to   := replace(replace(c_bgnt_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from  := replace(replace(c_gnt_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to    := replace(replace(c_gnt_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists attendance_events' in v_tpl) > 0 then
    raise notice '0038: template already carries attendance_events — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_br_from, c_br_to);
    if position(c_br_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2a (branches geofence) did not match. Template drifted from 0019.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pr_from, c_pr_to);
    if position(c_pr_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2b (profiles work_mode) did not match. Template drifted from 0018.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2c (tables) did not match. Template drifted from 0035.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2d (privilege guard + geofence fn) did not match. Template drifted from 0003.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2e (rls) did not match. Template drifted from 0033.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2f (policies) did not match. Template drifted from 0035.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2g (triggers) did not match. Template drifted from 0030.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_bgnt_from, c_bgnt_to);
    if position(c_bgnt_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2h (branches grant) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0038: template anchor 2i (grants) did not match. Template drifted from 0035.';
    end if;
    v_done := v_done + 1;

    -- 0027's prefix-of-replacement safety, restated. EVERY anchor above
    -- is a prefix of its replacement, so `replace` would fire twice on
    -- any anchor the template happened to carry twice. These four
    -- counts are what would catch it.
    --
    -- The lengths are COMPUTED, never hand-written: 0035 shipped a
    -- guard with a hand-counted 40 where the string was 42 characters
    -- long, and the guard that exists to catch drift became the thing
    -- that aborted a correct migration.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists attendance_events', '')))
       <> length('create table if not exists attendance_events') then
      raise exception '0038: the template carries more than one attendance_events table.';
    end if;

    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists trusted_devices', '')))
       <> length('create table if not exists trusted_devices') then
      raise exception '0038: the template carries more than one trusted_devices table.';
    end if;

    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists device_verifications', '')))
       <> length('create table if not exists device_verifications') then
      raise exception '0038: the template carries more than one device_verifications table.';
    end if;

    -- 2d is a whole-span replacement rather than a splice, so the
    -- counts above say nothing about it. This one does: exactly one
    -- work_mode guard, and exactly one geofence function.
    if (length(v_tpl) - length(replace(v_tpl, 'PRIVILEGE_LOCKED', '')))
       <> 2 * length('PRIVILEGE_LOCKED') then
      raise exception '0038: expected exactly two PRIVILEGE_LOCKED guards in the template.';
    end if;

    -- The DEFINITION, not the name: "function stamp_attendance_geofence()"
    -- also occurs inside `execute function ...` on the trigger, so the
    -- bare name legitimately appears twice and counting it would be a
    -- guard that fires on correct input.
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function stamp_attendance_geofence()', '')))
       <> length('create or replace function stamp_attendance_geofence()') then
      raise exception '0038: the template does not carry exactly one stamp_attendance_geofence() definition.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0038$ select %L::text $felix_0038$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0038: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Ordering rules, both learned the hard way elsewhere in this series:
--
--   * trusted_devices must exist before attendance_events, which
--     carries a foreign key to it.
--   * stamp_attendance_geofence() must exist before its trigger, and
--     its body is plpgsql so it parses lazily — but the TRIGGER's
--     reference to it does not, and a missing function there fails at
--     CREATE TRIGGER with a message that reads like a typo.
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0030 §3
-- and 0036 §3: FK targets, policy expressions and the trigger's
-- function are resolved and frozen HERE, and each showroom's must bind
-- to its own.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_cols constant text := $cols$
alter table branches add column if not exists latitude numeric(9,6);
alter table branches add column if not exists longitude numeric(9,6);
alter table branches add column if not exists geofence_radius_m int not null default 150;

do $inner$
begin
  if not exists (select 1 from pg_constraint where conname = 'branches_latitude_check'
                   and conrelid = 'branches'::regclass) then
    alter table branches add constraint branches_latitude_check
      check (latitude between -90 and 90);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'branches_longitude_check'
                   and conrelid = 'branches'::regclass) then
    alter table branches add constraint branches_longitude_check
      check (longitude between -180 and 180);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'branches_geofence_radius_m_check'
                   and conrelid = 'branches'::regclass) then
    alter table branches add constraint branches_geofence_radius_m_check
      check (geofence_radius_m between 25 and 5000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_work_mode_check'
                   and conrelid = 'profiles'::regclass) then
    alter table profiles add constraint profiles_work_mode_check
      check (work_mode in ('on_site','remote'));
  end if;
end
$inner$;
$cols$;

  c_ddl constant text := $ddl$
create table if not exists trusted_devices (
  id            uuid        primary key default gen_random_uuid(),
  profile_id    uuid        not null references profiles(id) on delete cascade,
  device_hash   text        not null,
  label         text,
  platform      text,
  status        text        not null default 'active'
                            check (status in ('active','revoked')),
  enrolled_at   timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid        references profiles(id),
  constraint trusted_devices_revocation_consistent check (
    (status = 'active'  and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index if not exists uniq_trusted_device_profile_hash
  on trusted_devices(profile_id, device_hash);
create index if not exists idx_trusted_devices_profile
  on trusted_devices(profile_id);

create table if not exists device_verifications (
  id           uuid        primary key default gen_random_uuid(),
  profile_id   uuid        not null references profiles(id) on delete cascade,
  device_hash  text        not null,
  code_hash    text        not null,
  label        text,
  platform     text,
  attempts     int         not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_device_verifications_pending
  on device_verifications(profile_id, created_at desc);

create table if not exists attendance_events (
  id               uuid        primary key default gen_random_uuid(),
  profile_id       uuid        not null references profiles(id) on delete cascade,
  branch_id        uuid        not null references branches(id),
  kind             text        not null
                               check (kind in ('in','break_start','break_end','out')),
  occurred_at      timestamptz not null default now(),
  latitude         numeric(9,6) check (latitude between -90 and 90),
  longitude        numeric(9,6) check (longitude between -180 and 180),
  accuracy_m       numeric     check (accuracy_m >= 0),
  distance_m       numeric,
  within_geofence  boolean,
  device_id        uuid        references trusted_devices(id),
  source           text        not null default 'device'
                               check (source in ('device','adjustment')),
  recorded_by      uuid        references profiles(id),
  reason           text,
  voided_at        timestamptz,
  voided_by        uuid        references profiles(id),
  void_reason      text,
  created_at       timestamptz not null default now(),
  constraint attendance_adjustment_needs_reason check (
    source <> 'adjustment' or (reason is not null and length(btrim(reason)) > 0)
  ),
  constraint attendance_void_needs_reason check (
    voided_at is null
    or (void_reason is not null and length(btrim(void_reason)) > 0)
  )
);

create index if not exists idx_attendance_events_profile_time
  on attendance_events(profile_id, occurred_at desc);
create index if not exists idx_attendance_events_branch_time
  on attendance_events(branch_id, occurred_at desc);

alter table trusted_devices      enable row level security;
alter table device_verifications enable row level security;
alter table attendance_events    enable row level security;

drop policy if exists "branches_geofence_update" on branches;
create policy "branches_geofence_update" on branches for update
  using (is_manager_or_above() and can_act_on_branch(id))
  with check (is_manager_or_above() and can_act_on_branch(id));

drop policy if exists "trusted_devices_select" on trusted_devices;
create policy "trusted_devices_select" on trusted_devices for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = trusted_devices.profile_id
         and p.branch_id = current_branch_id())));

drop policy if exists "trusted_devices_update" on trusted_devices;
create policy "trusted_devices_update" on trusted_devices for update
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = trusted_devices.profile_id
         and p.branch_id = current_branch_id())))
  with check (
    (profile_id = auth.uid()
     or is_ceo()
     or (is_manager_or_above() and exists (
       select 1 from profiles p
        where p.id = trusted_devices.profile_id
          and p.branch_id = current_branch_id())))
    and status = 'revoked'
    and revoked_by = auth.uid());

drop policy if exists "attendance_events_select" on attendance_events;
create policy "attendance_events_select" on attendance_events for select
  using (
    profile_id = auth.uid()
    or is_accountant_or_above()
    or (is_manager_or_above() and can_read_branch(branch_id)));

drop policy if exists "attendance_events_insert" on attendance_events;
create policy "attendance_events_insert" on attendance_events for insert
  with check (
    recorded_by = auth.uid()
    and can_act_on_branch(branch_id)
    and (
      (source = 'device' and profile_id = auth.uid())
      or (source = 'adjustment' and is_manager_or_above())
    ));

drop policy if exists "attendance_events_update" on attendance_events;
create policy "attendance_events_update" on attendance_events for update
  using (is_manager_or_above() and can_act_on_branch(branch_id))
  with check (
    is_manager_or_above()
    and can_act_on_branch(branch_id)
    and voided_at is not null
    and voided_by = auth.uid());

drop trigger if exists trg_stamp_attendance_geofence on attendance_events;
create trigger trg_stamp_attendance_geofence
  before insert on attendance_events
  for each row execute function stamp_attendance_geofence();

drop trigger if exists trg_audit_attendance_events on attendance_events;
create trigger trg_audit_attendance_events
  after insert or update or delete on attendance_events
  for each row execute function record_audit();

drop trigger if exists trg_audit_trusted_devices on trusted_devices;
create trigger trg_audit_trusted_devices
  after insert or update or delete on trusted_devices
  for each row execute function record_audit();
$ddl$;

  -- The two functions, schema-qualified rather than path-resolved, for
  -- the reason 0030 §3 gives: guard_profile_privilege_columns() is
  -- SECURITY DEFINER with a pinned search_path and must be recreated
  -- with THIS schema's pin, and the geofence function reads THIS
  -- schema's branches.
  c_fns constant text := $fns$
create or replace function {{SCHEMA}}.guard_profile_privilege_columns() returns trigger as $trg$
begin
  if (new.role is distinct from old.role or new.branch_id is distinct from old.branch_id)
     and not is_ceo() then
    raise exception 'Only the CEO can change a role or branch assignment (PRIVILEGE_LOCKED)';
  end if;

  if old.role = 'ceo' and new.role is distinct from 'ceo'
     and (select count(*) from profiles where role = 'ceo') <= 1 then
    raise exception 'Cannot remove the last CEO account (LAST_CEO)';
  end if;

  if new.work_mode is distinct from old.work_mode and not is_ceo() then
    raise exception 'Only the CEO can change a work mode (PRIVILEGE_LOCKED)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

create or replace function {{SCHEMA}}.stamp_attendance_geofence() returns trigger as $trg$
declare
  v_lat numeric;
  v_lng numeric;
  v_rad int;
  v_tol numeric;
begin
  new.distance_m      := null;
  new.within_geofence := null;

  select latitude, longitude, geofence_radius_m
    into v_lat, v_lng, v_rad
    from branches
   where id = new.branch_id;

  if v_lat is null or v_lng is null
     or new.latitude is null or new.longitude is null then
    return new;
  end if;

  new.distance_m := round((
    6371000 * 2 * asin(sqrt(
        power(sin(radians((new.latitude - v_lat)::float8) / 2), 2)
      + cos(radians(v_lat::float8)) * cos(radians(new.latitude::float8))
        * power(sin(radians((new.longitude - v_lng)::float8) / 2), 2)
    ))
  )::numeric);

  v_tol := least(coalesce(new.accuracy_m, 0), 100);
  new.within_geofence := new.distance_m <= coalesce(v_rad, 150) + v_tol;

  return new;
end;
$trg$ language plpgsql set search_path = {{SCHEMA}}, extensions;
$fns$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0038: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    -- work_mode first and on its own: it is NOT NULL with a default,
    -- so adding it rewrites nothing (Postgres 11+ stores the default in
    -- the catalogue) but the guard function replaced further down names
    -- it, and a function body that names a missing column fails at
    -- first execution rather than at CREATE.
    execute 'alter table profiles add column if not exists work_mode text not null default ''on_site''';
    execute c_cols;

    -- FUNCTIONS BEFORE TABLES, and specifically before c_ddl's
    -- `create trigger ... execute function stamp_attendance_geofence()`.
    -- CREATE TRIGGER resolves its function eagerly, so the reverse
    -- order fails with "function stamp_attendance_geofence() does not
    -- exist" — an error that reads like a typo and is really a missing
    -- statement. Neither function body needs the new tables: plpgsql
    -- is parsed lazily, and the only relation either one names is
    -- branches (already there) and profiles.work_mode (added above).
    execute replace(c_fns, '{{SCHEMA}}', quote_ident(r.schema_name));
    execute c_ddl;

    -- §6b's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards. No DELETE for the tenant
    -- role anywhere below: assertion (j) forbids it outright.
    execute format(
      'grant update (latitude, longitude, geofence_radius_m) on %I.branches to %I',
      r.schema_name, r.role_name
    );

    execute format('grant select on %I.trusted_devices to %I', r.schema_name, r.role_name);
    execute format(
      'grant update (status, revoked_at, revoked_by) on %I.trusted_devices to %I',
      r.schema_name, r.role_name
    );
    execute format('grant select, insert on %I.attendance_events to %I', r.schema_name, r.role_name);
    execute format(
      'grant update (voided_at, voided_by, void_reason) on %I.attendance_events to %I',
      r.schema_name, r.role_name
    );

    -- device_verifications: SELECT only, and RLS-with-no-policies is
    -- what actually denies the rows. The revoke first, then the single
    -- grant, so a re-run cannot accumulate a write verb; see 5q-ter and
    -- the file header for why the SELECT is here at all.
    execute format(
      'revoke all on table %I.device_verifications from %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select on %I.device_verifications to %I',
      r.schema_name, r.role_name
    );

    execute format(
      'grant select, insert, update, delete on %I.trusted_devices, %I.device_verifications, %I.attendance_events to service_role',
      r.schema_name, r.schema_name, r.schema_name
    );
    execute format(
      'revoke all on table %I.trusted_devices, %I.device_verifications, %I.attendance_events from public, anon, authenticated',
      r.schema_name, r.schema_name, r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0038: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0038: % tenant schema(s) carry attendance.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
--
-- Structure, lockdown, that every policy bound to THIS schema's
-- predicates, that the geofence trigger is actually attached (a
-- verdict-stamping trigger that is missing fails OPEN — the rows keep
-- being written and the column is simply null forever), and that the
-- code table is unreachable from the tenant role.
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

    -- (a) the three tables and the two columns exist
    if to_regclass(format('%I.trusted_devices', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (trusted_devices missing)');
      continue;
    end if;
    if to_regclass(format('%I.device_verifications', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (device_verifications missing)');
      continue;
    end if;
    if to_regclass(format('%I.attendance_events', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (attendance_events missing)');
      continue;
    end if;

    select count(*) into n
      from information_schema.columns
     where table_schema = r.schema_name and table_name = 'branches'
       and column_name in ('latitude','longitude','geofence_radius_m');
    if n <> 3 then
      v_bad := v_bad || format('%s (%s/3 geofence columns)', r.schema_name, n);
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'profiles'
         and column_name = 'work_mode'
    ) then
      v_bad := v_bad || (r.schema_name || ' (profiles.work_mode missing)');
    end if;

    -- (b) RLS is on for all three
    select count(*) into n
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name
       and c.relname in ('trusted_devices','device_verifications','attendance_events')
       and c.relrowsecurity;
    if n <> 3 then
      v_bad := v_bad || format('%s (rls on %s/3 attendance tables)', r.schema_name, n);
    end if;

    -- (c) device_verifications carries NO policy. With RLS on, that is
    --     what makes it deny — and it is the property a well-meaning
    --     future migration is most likely to "fix".
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'device_verifications';
    if n <> 0 then
      v_bad := v_bad || format('%s (device_verifications has %s policy/policies — it must have none)', r.schema_name, n);
    end if;

    -- (d) two policies on trusted_devices, three on attendance_events,
    --     and branches gained exactly one (branches_select,
    --     branches_write, branches_geofence_update = 3).
    select count(*) into n
      from pg_policy p join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'trusted_devices';
    if n <> 2 then
      v_bad := v_bad || format('%s (%s trusted_devices policies, expected 2)', r.schema_name, n);
    end if;

    select count(*) into n
      from pg_policy p join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'attendance_events';
    if n <> 3 then
      v_bad := v_bad || format('%s (%s attendance_events policies, expected 3)', r.schema_name, n);
    end if;

    if not exists (
      select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'branches'
         and p.polname = 'branches_geofence_update'
    ) then
      v_bad := v_bad || (r.schema_name || ' (branches_geofence_update missing)');
    end if;

    -- (e) the silent disaster: a policy bound to another schema's
    --     helpers. Every policy on these two tables names at least one
    --     is_*()/can_*() predicate, so every one must carry this
    --     schema's qualification.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name
       and c.relname in ('trusted_devices','attendance_events')
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s attendance policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    -- (f) the geofence trigger is attached AND is this schema's
    --     function. A missing one fails open: rows keep being written
    --     and within_geofence is simply null forever, which reads as
    --     "not assessed" on every report and never as an error.
    if not exists (
      select 1
        from pg_trigger tg
        join pg_class c       on c.oid = tg.tgrelid
        join pg_namespace ns  on ns.oid = c.relnamespace
        join pg_proc pr       on pr.oid = tg.tgfoid
        join pg_namespace pns on pns.oid = pr.pronamespace
       where ns.nspname = r.schema_name
         and c.relname  = 'attendance_events'
         and tg.tgname  = 'trg_stamp_attendance_geofence'
         and not tg.tgisinternal
         and pns.nspname = r.schema_name
    ) then
      v_bad := v_bad || (r.schema_name || ' (geofence trigger missing or bound to another schema)');
    end if;

    -- (g) the privilege guard learned about work_mode
    if not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name
         and p.proname = 'guard_profile_privilege_columns'
         and p.prosrc like '%work_mode%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (privilege guard does not mention work_mode)');
    end if;

    -- (h) the tenant role's ceiling, restated per table.
    --
    --     device_verifications is the odd one: SELECT is REQUIRED
    --     (§6j guard (5) refuses to provision without it) and the
    --     denial comes from (c) above — zero policies with RLS on.
    --     What must not exist is any write verb, because a write verb
    --     plus a policy someone adds later is a forged enrolment.
    if not has_table_privilege(r.role_name, format('%I.device_verifications', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (tenant role lacks SELECT on device_verifications — §6j guard (5) will refuse to provision)');
    end if;
    if has_table_privilege(r.role_name, format('%I.device_verifications', r.schema_name), 'insert')
       or has_table_privilege(r.role_name, format('%I.device_verifications', r.schema_name), 'update')
       or has_table_privilege(r.role_name, format('%I.device_verifications', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (tenant role can WRITE device_verifications — the second factor is forgeable)');
    end if;

    if has_table_privilege(r.role_name, format('%I.trusted_devices', r.schema_name), 'insert') then
      v_bad := v_bad || (r.schema_name || ' (tenant role can enrol a device without a code)');
    end if;

    if has_table_privilege(r.role_name, format('%I.attendance_events', r.schema_name), 'delete')
       or has_table_privilege(r.role_name, format('%I.trusted_devices', r.schema_name), 'delete')
       or has_table_privilege(r.role_name, format('%I.branches', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (tenant role holds delete — assertion (j) would refuse to provision this)');
    end if;

    if not has_table_privilege(
         r.role_name, format('%I.attendance_events', r.schema_name), 'select, insert') then
      v_bad := v_bad || (r.schema_name || ' (role cannot punch)');
    end if;

    -- (i) the column-limited grants are actually column-limited. A
    --     whole-table UPDATE on either would mean the policy is the
    --     only fence left, and 0035's lesson is that the grant is the
    --     real one.
    if has_table_privilege(r.role_name, format('%I.branches', r.schema_name), 'update') then
      v_bad := v_bad || (r.schema_name || ' (tenant role holds table-wide UPDATE on branches)');
    end if;
    if not has_column_privilege(
         r.role_name, format('%I.branches', r.schema_name), 'latitude', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot place the geofence)');
    end if;
    if has_column_privilege(
         r.role_name, format('%I.branches', r.schema_name), 'name', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can rename a branch — the geofence grant is too wide)');
    end if;

    if has_table_privilege(r.role_name, format('%I.attendance_events', r.schema_name), 'update') then
      v_bad := v_bad || (r.schema_name || ' (tenant role holds table-wide UPDATE on attendance_events)');
    end if;
    if has_column_privilege(
         r.role_name, format('%I.attendance_events', r.schema_name), 'occurred_at', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can rewrite when somebody arrived)');
    end if;
    if has_column_privilege(
         r.role_name, format('%I.attendance_events', r.schema_name), 'within_geofence', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can overturn the geofence verdict)');
    end if;
    if not has_column_privilege(
         r.role_name, format('%I.attendance_events', r.schema_name), 'voided_at', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot void a mistaken punch)');
    end if;

    if has_column_privilege(
         r.role_name, format('%I.trusted_devices', r.schema_name), 'device_hash', 'update') then
      v_bad := v_bad || (r.schema_name || ' (role can adopt another phone by rewriting device_hash)');
    end if;

    -- (j) nothing reachable by the anonymous roles
    if has_table_privilege('anon', format('%I.attendance_events', r.schema_name), 'select')
       or has_table_privilege('authenticated', format('%I.attendance_events', r.schema_name), 'select')
       or has_table_privilege('anon', format('%I.device_verifications', r.schema_name), 'select')
       or has_table_privilege('authenticated', format('%I.device_verifications', r.schema_name), 'select') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated can read attendance)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0038 SELF-VERIFY FAILED: %', array_to_string(v_bad, '; ');
  end if;

  raise notice '0038: self-verify passed.';
end
$$;

-- ============================================================
-- 5. THE TEMPLATE STILL PROVISIONS
--
-- 0035 shipped an amendment that was correct in §3 and broken in §2,
-- and nothing caught it until a new showroom failed to provision. The
-- cheapest possible detector for that class of mistake is to read the
-- amended template back and check that the text this file spliced in is
-- there, in one piece, exactly once.
-- ============================================================
do $$
declare
  v_tpl text := platform.tenant_ddl_template();
  v_bad text[] := '{}';
  t     text;
begin
  foreach t in array array[
    'create table if not exists trusted_devices',
    'create table if not exists device_verifications',
    'create table if not exists attendance_events',
    -- Definitions rather than names throughout: every one of these
    -- identifiers is legitimately mentioned more than once (a function
    -- by its trigger, a trigger by its own `drop ... if exists`, a
    -- policy by the same), and a count over the bare name would be a
    -- check that fails on correct input.
    'create or replace function stamp_attendance_geofence()',
    'create trigger trg_stamp_attendance_geofence',
    'create policy "branches_geofence_update"',
    'grant update (latitude, longitude, geofence_radius_m) on branches to {{ROLE}}',
    'grant update (voided_at, voided_by, void_reason) on attendance_events to {{ROLE}}',
    'grant update (status, revoked_at, revoked_by) on trusted_devices to {{ROLE}}',
    'grant select on device_verifications to {{ROLE}}',
    'work_mode           text        not null default ''on_site''',
    'geofence_radius_m             int not null default 150'
  ] loop
    if (length(v_tpl) - length(replace(v_tpl, t, ''))) <> length(t) then
      v_bad := v_bad || format('%L appears %s time(s), expected 1', t,
        (length(v_tpl) - length(replace(v_tpl, t, ''))) / greatest(length(t), 1));
    end if;
  end loop;

  -- The things that must NOT be there. A WRITE verb on the code table
  -- for the interpolated tenant role would be spliced into every future
  -- showroom at once; so would a policy on it, which is what actually
  -- unlocks the rows. (SELECT is expected and checked above — §6j guard
  -- (5) requires it.)
  if position('insert on device_verifications to {{ROLE}}' in v_tpl) > 0
     or position('update on device_verifications to {{ROLE}}' in v_tpl) > 0
     or position('insert, update on device_verifications to {{ROLE}}' in v_tpl) > 0 then
    v_bad := v_bad || 'the template gives the tenant role a write verb on device_verifications';
  end if;

  if position('on device_verifications for select' in v_tpl) > 0
     or position('on device_verifications for all' in v_tpl) > 0 then
    v_bad := v_bad || 'the template carries a policy on device_verifications — RLS with no policy is what denies the codes';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '0038 TEMPLATE CHECK FAILED: %', array_to_string(v_bad, '; ');
  end if;

  raise notice '0038: template check passed.';
end
$$;

commit;
