-- ═══════════════════════════════════════════════════════════════
-- FELIX + 508.world — EVERYTHING PENDING, ONE PASTE.
-- Both halves target the SAME Supabase project. Idempotent —
-- safe to re-run. Order matters and is already correct:
--   A) FELIX production (auth repair + calendar + notification columns)
--   B) 508.world notifications (leads, demo bookings, send log)
-- ═══════════════════════════════════════════════════════════════

-- ============================================================
-- FELIX — PRODUCTION READINESS: run this ONCE in the Supabase
-- SQL Editor (paste the whole file, press Run).
--
-- It contains, in order:
--   PART 1 — repair of the corrupt auth.users row that makes the
--            admin listUsers API return HTTP 500 (a legacy account
--            bootstrapped via raw SQL with NULLs in token columns
--            GoTrue expects to be non-null strings).
--   PART 2 — migration 0006: the shared calendar (meetings +
--            invitations + the create_meeting permission gate).
--            Without this, "New Meeting" fails on every showroom.
--
-- Both parts are idempotent — running the file twice is safe.
-- Expected output: "Success" plus NOTICE lines, ending with
-- "Calendar ready: ...".
-- ============================================================

-- ═══════════════════ PART 1 — auth.users repair ═══════════════════

update auth.users set
  confirmation_token         = coalesce(confirmation_token, ''),
  recovery_token             = coalesce(recovery_token, ''),
  email_change               = coalesce(email_change, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
where confirmation_token is null
   or recovery_token is null
   or email_change is null
   or email_change_token_new is null
   or email_change_token_current is null
   or phone_change is null
   or phone_change_token is null
   or reauthentication_token is null;

-- ═══════════════════ PART 2 — migration 0006 ═══════════════════
-- (verbatim copy of supabase/migrations/0006_calendar.sql)

-- ============================================================
-- 0006 — SHARED CALENDAR
--
-- A meetings tab every role can see, but which only some roles may
-- write to:
--
--   sales_exec / accountant / investor  read only
--   branch_manager                      may schedule, but may only
--                                       invite sales staff of their
--                                       own branch
--   ceo                                 may schedule for anyone in
--                                       the showroom
--
-- WHERE THE RULE LIVES
--
-- Not in the form. `create_meeting()` below is the only way a row
-- reaches these tables from an authenticated session — there is
-- deliberately no INSERT policy on either table — so hiding the
-- button is presentation, and the check that actually holds is the
-- one a hand-crafted POST cannot route around. A branch manager who
-- calls the RPC directly with the CEO's id in p_invitees gets an
-- exception, not a meeting.
--
-- WHY THE READS GO THROUGH AN RPC TOO
--
-- `profiles_select` (0003 §10) lets a sales_exec read exactly one
-- profile: their own. So a salesperson cannot join to find out who
-- organised the meeting they were invited to, or who else is
-- attending — a plain PostgREST select would render a calendar full
-- of blank names. Widening profiles_select to fix that would hand
-- every salesperson the whole staff directory, phone numbers
-- included, to solve a display problem. `calendar_meetings()`
-- instead returns just the names and roles of people who share a
-- meeting with the caller, and nothing else.
--
-- TENANCY
--
-- Both tables carry tenant_id with the same default + RESTRICTIVE
-- isolation policy 0004 applies everywhere else. They are
-- deliberately NOT added to `_tenant_scoped_tables()`: that function
-- drives 0004's one-time backfill, which stamps every row it finds
-- with the flagship tenant. Adding calendar tables to it would mean
-- that re-running 0004 after this migration silently moved every
-- showroom's meetings into the flagship.
--
-- The three SECURITY DEFINER functions here bypass RLS by
-- definition, so each one re-derives current_tenant_id() itself and
-- filters on it explicitly — see 0004 §7 for why that is not
-- optional.
-- ============================================================

-- ============================================================
-- 1. TABLES
-- ============================================================
create table if not exists meetings (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id),
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
  -- from a deliberate multi-day block, and would smear one row
  -- across every cell of the month grid.
  constraint meetings_duration_sane  check (ends_at <= starts_at + interval '12 hours')
);

create table if not exists meeting_invitees (
  meeting_id    uuid        not null references meetings(id) on delete cascade,
  profile_id    uuid        not null references profiles(id) on delete cascade,
  tenant_id     uuid        not null references tenants(id),
  response      text        not null default 'pending'
                            check (response in ('pending','accepted','declined')),
  responded_at  timestamptz,
  created_at    timestamptz not null default now(),
  primary key (meeting_id, profile_id)
);

alter table meetings          alter column tenant_id set default current_tenant_id();
alter table meeting_invitees  alter column tenant_id set default current_tenant_id();

create index if not exists idx_meetings_tenant          on meetings(tenant_id);
create index if not exists idx_meetings_starts          on meetings(starts_at);
create index if not exists idx_meetings_branch          on meetings(branch_id);
create index if not exists idx_meetings_organizer       on meetings(organizer_id);
create index if not exists idx_meeting_invitees_tenant  on meeting_invitees(tenant_id);
create index if not exists idx_meeting_invitees_profile on meeting_invitees(profile_id);

-- ============================================================
-- 2. IMMUTABLE COLUMNS
--
-- The UPDATE policies below are broad on purpose (an organizer may
-- reschedule; an invitee may answer). These triggers pin down the
-- columns that decide *who the row belongs to*, so a legitimate
-- UPDATE cannot be turned into a privilege change — the same
-- reasoning as guard_profile_privilege_columns() in 0003 §2b.
-- ============================================================
create or replace function guard_meeting_columns() returns trigger as $$
begin
  if new.tenant_id    is distinct from old.tenant_id
  or new.organizer_id is distinct from old.organizer_id
  or new.branch_id    is distinct from old.branch_id then
    raise exception 'A meeting''s showroom, branch and organizer cannot be changed';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_guard_meeting_columns on meetings;
create trigger trg_guard_meeting_columns
  before update on meetings
  for each row execute function guard_meeting_columns();

create or replace function guard_meeting_invitee_columns() returns trigger as $$
begin
  -- Without this an invitee could repoint their own row at a meeting
  -- they were never invited to: the UPDATE policy only checks
  -- profile_id, which they are not changing.
  if new.meeting_id is distinct from old.meeting_id
  or new.profile_id is distinct from old.profile_id
  or new.tenant_id  is distinct from old.tenant_id then
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
$$ language plpgsql;

drop trigger if exists trg_guard_meeting_invitee_columns on meeting_invitees;
create trigger trg_guard_meeting_invitee_columns
  before update on meeting_invitees
  for each row execute function guard_meeting_invitee_columns();

-- ============================================================
-- 3. RLS
--
-- Note what is absent: neither table has an INSERT policy, so the
-- only authenticated write path is create_meeting(). And neither has
-- a DELETE policy — a meeting is cancelled, never erased, so the
-- people who rearranged their day around it can still see what
-- happened to it.
-- ============================================================
alter table meetings         enable row level security;
alter table meeting_invitees enable row level security;

-- The isolation conjunct, matching 0004 §4.
drop policy if exists "meetings_tenant_isolation" on meetings;
create policy "meetings_tenant_isolation" on meetings
  as restrictive for all to authenticated
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

drop policy if exists "meeting_invitees_tenant_isolation" on meeting_invitees;
create policy "meeting_invitees_tenant_isolation" on meeting_invitees
  as restrictive for all to authenticated
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- You see a meeting if you called it, were asked to it, or manage
-- the people in it. An accountant and an investor are org-wide for
-- money, not for diaries, so they fall through to "only my own
-- invitations" — deliberately narrower than can_read_branch().
drop policy if exists "meetings_select" on meetings;
create policy "meetings_select" on meetings for select to authenticated
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
create policy "meetings_update" on meetings for update to authenticated
  using (organizer_id = auth.uid() or is_ceo())
  with check (organizer_id = auth.uid() or is_ceo());

-- Attendee lists are visible to whoever can see the meeting itself.
drop policy if exists "meeting_invitees_select" on meeting_invitees;
create policy "meeting_invitees_select" on meeting_invitees for select to authenticated
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

-- Answering an invitation is the one write a salesperson gets.
drop policy if exists "meeting_invitees_respond" on meeting_invitees;
create policy "meeting_invitees_respond" on meeting_invitees for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Belt and braces. The missing INSERT policy already denies these —
-- RLS refuses anything no permissive policy allows — but Supabase
-- grants table privileges to `authenticated` by default, and revoking
-- them says out loud that the omission above was deliberate.
grant  select, update            on meetings          to authenticated;
grant  select, update            on meeting_invitees  to authenticated;
revoke insert, delete, truncate  on meetings          from authenticated;
revoke insert, delete, truncate  on meeting_invitees  from authenticated;

-- ============================================================
-- 4. create_meeting() — the authority gate
-- ============================================================
create or replace function create_meeting(
  p_title      text,
  p_agenda     text,
  p_location   text,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz,
  p_branch_id  uuid,
  p_invitees   uuid[]
) returns uuid as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid := current_tenant_id();
  v_role    text := current_role_name();
  v_branch  uuid := current_branch_id();
  v_ids     uuid[];
  v_n       int;
  v_ok      int;
  v_meeting uuid;
begin
  if v_uid is null or v_tenant is null then
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
      select 1 from branches b where b.id = p_branch_id and b.tenant_id = v_tenant
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
     and p.tenant_id = v_tenant
     and (
       v_role = 'ceo'
       or (p.role = 'sales_exec' and p.branch_id = v_branch)
     );

  if v_ok <> v_n then
    if v_role = 'branch_manager' then
      raise exception 'A branch manager may only invite sales staff from their own branch';
    else
      raise exception 'One or more invitees do not work at this showroom';
    end if;
  end if;

  insert into meetings (
    tenant_id, branch_id, organizer_id, title, agenda, location, starts_at, ends_at
  ) values (
    v_tenant,
    p_branch_id,
    v_uid,
    btrim(p_title),
    nullif(btrim(coalesce(p_agenda, '')), ''),
    nullif(btrim(coalesce(p_location, '')), ''),
    p_starts_at,
    p_ends_at
  )
  returning id into v_meeting;

  insert into meeting_invitees (tenant_id, meeting_id, profile_id)
  select v_tenant, v_meeting, x from unnest(v_ids) as x;

  return v_meeting;
end;
$$ language plpgsql security definer set search_path = public, extensions;

grant execute on function create_meeting(text, text, text, timestamptz, timestamptz, uuid, uuid[]) to authenticated;

-- ============================================================
-- 5. calendar_meetings() — the read side
--
-- Returns the caller's visible meetings for a window, with the
-- organizer's and attendees' names resolved. Same visibility rule as
-- meetings_select, restated here because SECURITY DEFINER means the
-- policy does not apply to this query.
-- ============================================================
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
) as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := current_tenant_id();
  v_role   text := current_role_name();
  v_branch uuid := current_branch_id();
begin
  if v_uid is null or v_tenant is null then
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
  where m.tenant_id = v_tenant
    and m.starts_at < p_to
    and m.ends_at   > p_from
    and (
      m.organizer_id = v_uid
      or mine.profile_id is not null
      or v_role = 'ceo'
      or (v_role = 'branch_manager' and m.branch_id = v_branch)
    )
  order by m.starts_at;
end;
$$ language plpgsql stable security definer set search_path = public, extensions;

grant execute on function calendar_meetings(timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 6. calendar_invitable_people() — the picker
--
-- Exactly the set create_meeting() will accept from this caller, so
-- the form cannot offer a choice the RPC would then reject. Returns
-- nothing at all for roles that may not schedule, which is what
-- makes it safe to expose to every signed-in user.
-- ============================================================
create or replace function calendar_invitable_people()
returns table (id uuid, full_name text, role text, branch_id uuid) as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := current_tenant_id();
  v_role   text := current_role_name();
  v_branch uuid := current_branch_id();
begin
  if v_uid is null or v_tenant is null then return; end if;
  if v_role not in ('ceo', 'branch_manager') then return; end if;

  return query
  select p.id, p.full_name, p.role, p.branch_id
    from profiles p
   where p.tenant_id = v_tenant
     and p.id <> v_uid
     and (
       v_role = 'ceo'
       or (p.role = 'sales_exec' and p.branch_id = v_branch)
     )
   order by p.full_name;
end;
$$ language plpgsql stable security definer set search_path = public, extensions;

grant execute on function calendar_invitable_people() to authenticated;

-- ============================================================
-- 7. SELF-VERIFICATION
--
-- Fails the migration loudly rather than leaving a calendar that
-- looks fine until the wrong person schedules something.
-- ============================================================
do $$
declare
  v_missing text := '';
begin
  if to_regclass('public.meetings') is null then
    v_missing := v_missing || ' meetings';
  end if;
  if to_regclass('public.meeting_invitees') is null then
    v_missing := v_missing || ' meeting_invitees';
  end if;

  -- The absence of an INSERT policy is load-bearing, not an
  -- oversight: it is what forces every write through create_meeting().
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('meetings', 'meeting_invitees')
       and cmd = 'INSERT'
  ) then
    raise exception 'An INSERT policy exists on a calendar table — direct inserts would bypass create_meeting()';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'meetings'
       and policyname = 'meetings_tenant_isolation' and permissive = 'RESTRICTIVE'
  ) then
    v_missing := v_missing || ' meetings_tenant_isolation';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'meeting_invitees'
       and policyname = 'meeting_invitees_tenant_isolation' and permissive = 'RESTRICTIVE'
  ) then
    v_missing := v_missing || ' meeting_invitees_tenant_isolation';
  end if;

  if v_missing <> '' then
    raise exception 'Calendar migration incomplete, missing:%', v_missing;
  end if;

  raise notice 'Calendar ready: meetings + meeting_invitees, writes gated by create_meeting()';
end $$;
-- ============================================================
-- 0007 — NOTIFICATION CONTACTS
--
-- Two columns on `profiles` so a person can opt in to being reached
-- outside the app: `notification_email` for meeting invites / the
-- 1-hour reminder cron / FELIX product updates, and `whatsapp_number`
-- for the same over WhatsApp. Both live on 508.world's router Worker,
-- which reads them directly from this table with the service role —
-- there is no FELIX-side sending code, only the columns it reads.
--
-- WHY SELF-EDITABLE
--
-- These are contact *preferences*, not identity or privilege. The
-- guard trigger from 0003 §2b (`guard_profile_privilege_columns`)
-- already pins role/branch_id/tenant_id against exactly this kind of
-- self-service update, and deliberately does not mention these two
-- columns — so a profile owner writing their own notification_email
-- is the intended path, not a gap. `profiles_update_self` (0003 §10)
-- already scopes the write to `id = auth.uid()` (plus the CEO), so no
-- RLS change is needed here at all.
--
-- WHY CHECK CONSTRAINTS INSTEAD OF A DOMAIN TYPE
--
-- Both fields come from a plain text input with no client-side format
-- library — this app serves Arabic- and English-speaking markets, so
-- no country-specific phone format is assumed (mirrors the `phone`
-- schema already used for CRM leads and staff in validation.ts). The
-- checks only guarantee "looks vaguely like an email" / "looks vaguely
-- dialable", which is exactly what the Worker needs to attempt a send
-- — never a validation strong enough to reject a real address.
-- ============================================================

alter table profiles add column if not exists notification_email text;
alter table profiles add column if not exists whatsapp_number    text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_notification_email_check'
  ) then
    alter table profiles add constraint profiles_notification_email_check
      check (
        notification_email is null
        or (
          position('@' in notification_email) > 1
          and length(notification_email) <= 254
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_whatsapp_number_check'
  ) then
    alter table profiles add constraint profiles_whatsapp_number_check
      check (
        whatsapp_number is null
        or whatsapp_number ~ '^[+0-9() -]{6,32}$'
      );
  end if;
end $$;

comment on column profiles.notification_email is
  'Self-editable contact address for meeting invites, the 1-hour reminder cron, and FELIX product updates — sent by the 508.world router Worker, not by FELIX. Deliberately outside guard_profile_privilege_columns() (0003 §2b): this is a contact preference, not a privilege column, and profiles_update_self already scopes the write to the owner (plus CEO).';

comment on column profiles.whatsapp_number is
  'Self-editable WhatsApp contact number for the same notifications as notification_email. Same self-service rationale — see the comment on that column.';

-- ============================================================
-- SELF-VERIFICATION
--
-- Fails the migration loudly rather than leaving a notifications
-- feature that silently has nowhere to write.
-- ============================================================
do $$
declare
  v_missing text := '';
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name = 'notification_email'
  ) then
    v_missing := v_missing || ' notification_email';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name = 'whatsapp_number'
  ) then
    v_missing := v_missing || ' whatsapp_number';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_notification_email_check'
  ) then
    v_missing := v_missing || ' profiles_notification_email_check';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_whatsapp_number_check'
  ) then
    v_missing := v_missing || ' profiles_whatsapp_number_check';
  end if;

  if v_missing <> '' then
    raise exception 'Notification-contacts migration incomplete, missing:%', v_missing;
  end if;

  raise notice 'Notification contacts ready: profiles.notification_email + profiles.whatsapp_number, self-editable';
end $$;

-- ═══════════════ B — 508.world notifications ═══════════════

-- ============================================================
-- RUN_ME_notifications.sql
--
-- Paste into the Supabase SQL editor (Dashboard → SQL Editor →
-- New query) of the shared 508.world / FELIX project and run it
-- once. Idempotent — safe to re-run.
--
-- Creates the three tables behind the router Worker's marketing
-- endpoints and its notification cron:
--
--   product_leads     "I want FELIX" inquiries from 508.world
--   demo_bookings     booked 20-minute demo slots (UNIQUE slot_start
--                     is the race arbiter for double bookings)
--   notification_log  one row per (kind, person, meeting) so the
--                     reminder cron never messages anyone twice
--
-- WRITE PATH: only the router Worker writes these tables, with the
-- service-role key — so there are deliberately NO INSERT or DELETE
-- policies. The Agent Portal reads leads/bookings and updates their
-- status, and only when the signed-in user has an agents row with
-- role='admin'. notification_log gets no policies at all: with RLS
-- enabled and no permissive policy, anon/authenticated get nothing,
-- which is exactly the intent — it is service-role-only plumbing.
-- ============================================================

-- ============================================================
-- 1. TABLES
-- ============================================================
create table if not exists product_leads (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  email       text        not null,
  phone       text        not null,
  message     text,
  module_key  text        not null default 'felix',
  status      text        not null default 'new'
                          check (status in ('new','contacted','closed')),
  created_at  timestamptz not null default now()
);

create table if not exists demo_bookings (
  id          uuid        primary key default gen_random_uuid(),
  slot_start  timestamptz not null unique,
  name        text        not null,
  email       text        not null,
  phone       text        not null,
  status      text        not null default 'booked'
                          check (status in ('booked','done','cancelled')),
  created_at  timestamptz not null default now()
);

create table if not exists notification_log (
  id          uuid        primary key default gen_random_uuid(),
  kind        text        not null,
  target      text        not null,
  meeting_id  uuid,
  sent_at     timestamptz not null default now(),
  unique (kind, target, meeting_id)
);

-- ============================================================
-- 2. RLS
-- ============================================================
alter table product_leads    enable row level security;
alter table demo_bookings    enable row level security;
alter table notification_log enable row level security;

-- Only Agent Portal admins (an agents row with role='admin') may see or
-- work leads and bookings. Re-checked per statement rather than granted to
-- a broader role because agents and FELIX profiles share this database —
-- a signed-in showroom CEO is `authenticated` too, and must see nothing.
drop policy if exists "product_leads_admin_select" on product_leads;
create policy "product_leads_admin_select" on product_leads
  for select to authenticated
  using (
    exists (
      select 1 from agents
      where agents.id = auth.uid() and agents.role = 'admin'
    )
  );

drop policy if exists "product_leads_admin_update" on product_leads;
create policy "product_leads_admin_update" on product_leads
  for update to authenticated
  using (
    exists (
      select 1 from agents
      where agents.id = auth.uid() and agents.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from agents
      where agents.id = auth.uid() and agents.role = 'admin'
    )
  );

drop policy if exists "demo_bookings_admin_select" on demo_bookings;
create policy "demo_bookings_admin_select" on demo_bookings
  for select to authenticated
  using (
    exists (
      select 1 from agents
      where agents.id = auth.uid() and agents.role = 'admin'
    )
  );

drop policy if exists "demo_bookings_admin_update" on demo_bookings;
create policy "demo_bookings_admin_update" on demo_bookings
  for update to authenticated
  using (
    exists (
      select 1 from agents
      where agents.id = auth.uid() and agents.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from agents
      where agents.id = auth.uid() and agents.role = 'admin'
    )
  );

-- notification_log: no policies, on purpose. See header.

-- ============================================================
-- 3. TABLE PRIVILEGES
--
-- Belt and braces, same reasoning as the calendar migration: the missing
-- policies already deny these, but Supabase grants table privileges to
-- `authenticated` by default, and revoking them says out loud that the
-- omission was deliberate.
-- ============================================================
grant  select, update            on product_leads    to authenticated;
revoke insert, delete, truncate  on product_leads    from authenticated;
revoke all                       on product_leads    from anon;

grant  select, update            on demo_bookings    to authenticated;
revoke insert, delete, truncate  on demo_bookings    from authenticated;
revoke all                       on demo_bookings    from anon;

revoke all on notification_log from authenticated;
revoke all on notification_log from anon;

-- ============================================================
-- 4. SELF-VERIFICATION
-- ============================================================
do $$
declare
  v_missing text := '';
begin
  if to_regclass('public.product_leads')    is null then v_missing := v_missing || ' product_leads';    end if;
  if to_regclass('public.demo_bookings')    is null then v_missing := v_missing || ' demo_bookings';    end if;
  if to_regclass('public.notification_log') is null then v_missing := v_missing || ' notification_log'; end if;

  -- The write path is the Worker's service-role key; an INSERT policy on
  -- any of these tables would mean someone re-opened a browser write path.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('product_leads', 'demo_bookings', 'notification_log')
       and cmd in ('INSERT', 'DELETE')
  ) then
    raise exception 'An INSERT/DELETE policy exists on a notifications table — writes must stay service-role-only';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notification_log'
  ) then
    raise exception 'notification_log has a policy — it must remain service-role-only';
  end if;

  if v_missing <> '' then
    raise exception 'Notifications setup incomplete, missing:%', v_missing;
  end if;

  raise notice 'Notifications ready: product_leads + demo_bookings (admin-read under RLS), notification_log (service-role only)';
end $$;
