-- ============================================================
-- 0039 — FELIX MAIL (felixmail.508.world)
--
-- Every profile gets a real address the moment it exists:
-- firstname.lastname.<tenant>@felixmail.508.world, generated once by
-- handle_new_user() and never again — guard_profile_privilege_columns()
-- gains a fourth arm that refuses ANY change to it, CEO included, so a
-- thread already addressed to someone keeps working even after a name
-- change or a role change.
--
-- WHY INTERNAL MAIL IS NOT SMTP
-- ------------------------------
-- Sender and recipient of an internal message are both rows in THIS
-- tenant's own `profiles`. Round-tripping that through Resend and
-- Cloudflare Email Routing would add latency, cost, and a dependency on
-- two external services for a message that never needs to leave the
-- database. mail_messages.direction = 'internal' is written directly by
-- the sender's own RLS-scoped session — no admin client, no network
-- call. Only 'outbound' (this tenant → an address that is not one of
-- its own profiles) and 'inbound' (the outside world → a felixmail
-- address) touch the 508.world Worker, and 'inbound' rows are written
-- exclusively by the service-role client behind /api/mail/inbound —
-- nothing here grants a tenant role any path to insert one.
--
-- WHY THE DIRECTORY LIVES IN `platform`, NOT PER-TENANT
-- -------------------------------------------------------
-- Inbound mail arrives at the Worker before FELIX knows which tenant it
-- belongs to — that is exactly the question platform.mail_addresses
-- answers. It is the same shape as platform.tenants itself: a global
-- lookup a request resolves against before anything schema-scoped
-- becomes possible. No tenant role is granted anything on it; RLS is
-- enabled with zero policies, the same fence device_verifications
-- (0038) uses, and the only writer is handle_new_user() (SECURITY
-- DEFINER, already cross-schema) or a service-role backfill.
--
-- WHY MAIL IS NOT AUDITED
-- ------------------------
-- record_audit() copies the whole row into audit_log, which the
-- accountant and CEO can read regardless of a table's own RLS —
-- correct for a vehicle sale, wrong for somebody's inbox. Attaching it
-- to mail_messages would defeat the privacy model two paragraphs up:
-- a message visible only to its sender and recipients would still have
-- a full copy sitting in a table two other roles can already see. So,
-- like device_verifications before it, none of the three new tables
-- carry the audit trigger.
--
-- ATTACHMENT SECURITY
-- --------------------
-- This migration only shapes where a file's metadata is stored
-- (mail_attachments.r2_key, .mime_type as CLAIMED). The actual
-- verification — magic-byte sniffing against an allowlist, independent
-- of what the uploader claims — happens in application code
-- (src/lib/file-sniff.ts) before a row here is ever written, on both
-- the compose path and the inbound path. The database cannot sniff a
-- byte stream; it only refuses to let a row exist without the app
-- having already done so (size_bytes > 0, r2_key not null).
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- -----------------------------------------
--   * No new SECURITY DEFINER function. Assertion (f)'s count (21,
--     since 0037) is untouched — generate_mail_address() is a plain
--     function, callable only from inside handle_new_user()'s own
--     definer context or this migration's backfill, and is revoked
--     from public/anon/authenticated same as any internal helper.
--   * Nothing added to c_tables inside create_tenant_schema() — 0016,
--     0030 and 0038 all decline this for the same reason: it is a
--     hand-maintained allowlist, not an exhaustive one, and §5 below
--     verifies the three tables directly.
--   * No UI, no Worker changes, no DNS. This is schema only.
--
-- LINE ENDINGS: the anchors below are authored LF; the stored template
-- is CRLF. §2 normalises every anchor to the template's own convention
-- before touching it, exactly as 0038 §2 does.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception '0039 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if position('create table if not exists attendance_events' in platform.tenant_ddl_template()) = 0 then
    raise exception '0039 PRECONDITION FAILED: the template has no attendance_events. Apply 0038 first.';
  end if;

  if to_regprocedure('platform.handle_new_user()') is null then
    raise exception '0039 PRECONDITION FAILED: platform.handle_new_user() does not exist. Apply 0010 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  -- 2a. profiles: mail_address, beside work_mode.
  c_pr_from text := $a1$  work_mode           text        not null default 'on_site'
                                  check (work_mode in ('on_site','remote')),
  created_at          timestamptz default now(),$a1$;
  c_pr_to   text := $a2$  work_mode           text        not null default 'on_site'
                                  check (work_mode in ('on_site','remote')),
  -- FELIX MAIL (0039). Assigned once by handle_new_user(), of the shape
  -- firstname.lastname.<tenant>@felixmail.508.world. Immutable after
  -- that — see guard_profile_privilege_columns() below — so a thread
  -- someone already has this address for keeps working through a later
  -- name or role change. Nullable: a profile predating this migration
  -- gets one from the backfill in §4, not from a NOT NULL default,
  -- because no single default could be unique.
  mail_address        text        unique,
  created_at          timestamptz default now(),$a2$;

  -- 2b. the three tables, spliced after trusted_devices' own audit
  --     trigger and its "not audited" note — the tail of 0038's
  --     addition, before the "note for the grants section" comment.
  c_tbl_from text := $b1$drop trigger if exists trg_audit_trusted_devices on trusted_devices;
create trigger trg_audit_trusted_devices
  after insert or update or delete on trusted_devices
  for each row execute function record_audit();

-- device_verifications is deliberately NOT audited. record_audit()
-- copies the whole row into audit_log, which accountants and the CEO
-- can read — so auditing it would take the one column this schema
-- works hardest to keep unreadable and file a copy somewhere readable.
-- Nothing is lost: trusted_devices' own trail records the enrolment
-- that a successful code produced.$b1$;
  c_tbl_to   text := $b2$drop trigger if exists trg_audit_trusted_devices on trusted_devices;
create trigger trg_audit_trusted_devices
  after insert or update or delete on trusted_devices
  for each row execute function record_audit();

-- device_verifications is deliberately NOT audited. record_audit()
-- copies the whole row into audit_log, which accountants and the CEO
-- can read — so auditing it would take the one column this schema
-- works hardest to keep unreadable and file a copy somewhere readable.
-- Nothing is lost: trusted_devices' own trail records the enrolment
-- that a successful code produced.

-- ------------------------------------------------------------
-- 12-quinquies. MAIL  (0039)
--
-- One row per message. direction distinguishes the three delivery
-- paths in the file header; sender_profile_id is null for exactly the
-- 'inbound' case, since a stranger's mail has no local sender. to/cc
-- addresses are the full display list (internal and external, mixed);
-- mail_recipients below is the FAN-OUT to internal profiles only, and
-- exists for RLS visibility and per-person read state, not display.
-- ------------------------------------------------------------
create table if not exists mail_messages (
  id                uuid        primary key default gen_random_uuid(),
  sender_profile_id uuid        references profiles(id) on delete set null,
  direction         text        not null check (direction in ('internal','outbound','inbound')),
  from_address      text        not null,
  from_name         text,
  to_addresses      text[]      not null default '{}',
  cc_addresses      text[]      not null default '{}',
  subject           text,
  body_text         text,
  body_html         text,
  snippet           text,
  thread_key        text,
  message_id        text,
  in_reply_to       text,
  send_status       text        check (send_status in ('sent','skipped','failed')),
  send_error        text,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint mail_messages_sender_matches_direction check (
    (direction = 'inbound' and sender_profile_id is null)
    or (direction in ('internal','outbound') and sender_profile_id is not null)
  )
);

create index if not exists idx_mail_messages_sender on mail_messages(sender_profile_id, occurred_at desc);
create index if not exists idx_mail_messages_thread  on mail_messages(thread_key);

-- Fan-out to internal recipients only — an external To/Cc address has
-- no profile row to point at, and is still fully represented in
-- to_addresses/cc_addresses above for display. is_read is per-person by
-- construction, which a shared mailbox (like the 508.world Agent
-- Portal's) has no need for and this does.
create table if not exists mail_recipients (
  id         uuid        primary key default gen_random_uuid(),
  message_id uuid        not null references mail_messages(id) on delete cascade,
  profile_id uuid        not null references profiles(id) on delete cascade,
  kind       text        not null check (kind in ('to','cc')),
  is_read    boolean     not null default false,
  created_at timestamptz not null default now(),
  constraint uniq_mail_recipient unique (message_id, profile_id)
);

create index if not exists idx_mail_recipients_profile on mail_recipients(profile_id, is_read);

-- mime_type and size_bytes are what the UPLOADER claimed; nothing here
-- verifies them; see "ATTACHMENT SECURITY" in the file header.
create table if not exists mail_attachments (
  id         uuid        primary key default gen_random_uuid(),
  message_id uuid        not null references mail_messages(id) on delete cascade,
  filename   text        not null,
  mime_type  text,
  size_bytes integer     not null check (size_bytes > 0),
  r2_key     text        not null,
  is_inline  boolean     not null default false,
  content_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_mail_attachments_message on mail_attachments(message_id);$b2$;

  -- 2c. RLS enable-list — grouped with every other table's, at the top
  --     of section 5, regardless of when each table was introduced.
  c_rls_from text := $c1$alter table trusted_devices        enable row level security;
alter table device_verifications   enable row level security;
alter table attendance_events      enable row level security;$c1$;
  c_rls_to   text := $c2$alter table trusted_devices        enable row level security;
alter table device_verifications   enable row level security;
alter table attendance_events      enable row level security;
alter table mail_messages          enable row level security;
alter table mail_recipients        enable row level security;
alter table mail_attachments       enable row level security;$c2$;

  -- 2d. RLS policies, spliced where 0038's attendance_events policies
  --     end and the pre-existing commission_tiers section begins.
  c_pol_from text := $d1$    and voided_by = auth.uid());

-- ------------------------------------------------------------
-- 5p. COMMISSION TIERS — select from 0001 §17, write from 0003 §10$d1$;
  c_pol_to   text := $d2$    and voided_by = auth.uid());

-- ------------------------------------------------------------
-- 5o-bis. MAIL  (0039)
--
-- A message is visible to its sender and to whoever it names as an
-- internal recipient — nobody else, hierarchy included. This is
-- correspondence, not a business record a manager oversees; see the
-- file header. Immutable after insert: no update or delete policy on
-- mail_messages at all, matching "no DELETE anywhere" and the plain
-- fact that a sent email is not a thing anyone gets to revise.
-- ------------------------------------------------------------
drop policy if exists "mail_messages_select" on mail_messages;
create policy "mail_messages_select" on mail_messages for select
  using (
    sender_profile_id = auth.uid()
    or exists (
      select 1 from mail_recipients r
       where r.message_id = mail_messages.id and r.profile_id = auth.uid())
  );

drop policy if exists "mail_messages_insert" on mail_messages;
create policy "mail_messages_insert" on mail_messages for insert
  with check (sender_profile_id = auth.uid() and direction in ('internal','outbound'));

-- An inbound row (no sender_profile_id) matches neither USING nor WITH
-- CHECK above for any authenticated session — those rows exist only
-- through the service-role client behind /api/mail/inbound, which
-- bypasses RLS entirely. Nothing here grants that path to a tenant role.

drop policy if exists "mail_recipients_select" on mail_recipients;
create policy "mail_recipients_select" on mail_recipients for select
  using (profile_id = auth.uid());

drop policy if exists "mail_recipients_insert" on mail_recipients;
create policy "mail_recipients_insert" on mail_recipients for insert
  with check (
    exists (
      select 1 from mail_messages m
       where m.id = mail_recipients.message_id and m.sender_profile_id = auth.uid())
  );

-- Column-limited to is_read by the grant below, not by this policy —
-- the same "grant is the real fence" shape as branches_geofence_update
-- (0038): a recipient may only ever mark their own copy read or unread.
drop policy if exists "mail_recipients_update" on mail_recipients;
create policy "mail_recipients_update" on mail_recipients for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

drop policy if exists "mail_attachments_select" on mail_attachments;
create policy "mail_attachments_select" on mail_attachments for select
  using (
    exists (
      select 1 from mail_messages m
       where m.id = mail_attachments.message_id
         and (m.sender_profile_id = auth.uid()
              or exists (
                select 1 from mail_recipients r
                 where r.message_id = m.id and r.profile_id = auth.uid()))
    )
  );

drop policy if exists "mail_attachments_insert" on mail_attachments;
create policy "mail_attachments_insert" on mail_attachments for insert
  with check (
    exists (
      select 1 from mail_messages m
       where m.id = mail_attachments.message_id and m.sender_profile_id = auth.uid())
  );

-- ------------------------------------------------------------
-- 5p. COMMISSION TIERS — select from 0001 §17, write from 0003 §10$d2$;

  -- 2e. guard_profile_privilege_columns(): mail_address is immutable,
  --     full stop — not even the CEO escape work_mode gets. See the
  --     file header for why a stable address matters more than the
  --     ability to correct one.
  c_grd_from text := $e1$  if new.work_mode is distinct from old.work_mode and not is_ceo() then
    raise exception 'Only the CEO can change a work mode (PRIVILEGE_LOCKED)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$e1$;
  c_grd_to   text := $e2$  if new.work_mode is distinct from old.work_mode and not is_ceo() then
    raise exception 'Only the CEO can change a work mode (PRIVILEGE_LOCKED)';
  end if;

  -- 0039. Assigned once by handle_new_user() (or this migration's own
  -- backfill, which is also a plain UPDATE and fires this same
  -- trigger) — so the guard must allow null -> value exactly once and
  -- refuse every value -> different-value after that. profiles is
  -- granted table-wide UPDATE (§6), so this trigger is the only thing
  -- standing between "immutable" and "immutable until somebody
  -- PATCHes it"; no column-limited grant could do this job instead,
  -- since the grant cannot itself distinguish the two cases.
  if old.mail_address is not null and new.mail_address is distinct from old.mail_address then
    raise exception 'mail_address cannot be changed (MAIL_ADDRESS_IMMUTABLE)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;$e2$;

  -- 2f. grants, appended after attendance_events'.
  c_gnt_from text := $f1$grant select, insert on attendance_events to {{ROLE}};
grant update (voided_at, voided_by, void_reason) on attendance_events to {{ROLE}};
grant select, insert, update, delete on attendance_events to service_role;$f1$;
  c_gnt_to   text := $f2$grant select, insert on attendance_events to {{ROLE}};
grant update (voided_at, voided_by, void_reason) on attendance_events to {{ROLE}};
grant select, insert, update, delete on attendance_events to service_role;

-- ── mail (0039) ──────────────────────────────────────────────
-- mail_messages: read and send, never update or delete — see the RLS
-- section for why there is no update/delete policy to grant against
-- even if the verb were offered.
grant select, insert on mail_messages to {{ROLE}};
grant select, insert, update, delete on mail_messages to service_role;

-- mail_recipients: read own fan-out rows, insert alongside a message
-- the caller is sending, and the ONE column a recipient may touch
-- afterwards — is_read is deliberately the whole grant, not the table.
grant select, insert on mail_recipients to {{ROLE}};
grant update (is_read) on mail_recipients to {{ROLE}};
grant select, insert, update, delete on mail_recipients to service_role;

-- mail_attachments: metadata only, written alongside the message that
-- owns it. No update or delete — an attachment is never revised, and
-- the bytes it names in R2 outlive whatever the row's own lifecycle
-- might otherwise imply.
grant select, insert on mail_attachments to {{ROLE}};
grant select, insert, update, delete on mail_attachments to service_role;$f2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_pr_from  := replace(replace(c_pr_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pr_to    := replace(replace(c_pr_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_from := replace(replace(c_tbl_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_grd_from := replace(replace(c_grd_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_grd_to   := replace(replace(c_grd_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('mail_address' in v_tpl) > 0 then
    raise notice '0039: template already carries mail_address — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_pr_from, c_pr_to);
    if position(c_pr_to in v_tpl) = 0 then
      raise exception '0039: template anchor 2a (profiles mail_address) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0039: template anchor 2b (mail tables) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0039: template anchor 2c (RLS enable-list) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0039: template anchor 2d (RLS policies) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_grd_from, c_grd_to);
    if position(c_grd_to in v_tpl) = 0 then
      raise exception '0039: template anchor 2e (privilege guard) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0039: template anchor 2f (grants) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    -- Duplicate-anchor guards, definitions rather than bare names for
    -- the same reason 0038's does: a table's name legitimately recurs
    -- in its own indexes and foreign keys.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists mail_messages', '')))
       <> length('create table if not exists mail_messages') then
      raise exception '0039: the template carries more than one mail_messages table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists mail_recipients', '')))
       <> length('create table if not exists mail_recipients') then
      raise exception '0039: the template carries more than one mail_recipients table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists mail_attachments', '')))
       <> length('create table if not exists mail_attachments') then
      raise exception '0039: the template carries more than one mail_attachments table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'MAIL_ADDRESS_IMMUTABLE', '')))
       <> length('MAIL_ADDRESS_IMMUTABLE') then
      raise exception '0039: expected exactly one MAIL_ADDRESS_IMMUTABLE guard in the template.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0039$ select %L::text $felix_0039$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0039: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Same fragments as §2, applied directly rather than through the
-- template — a showroom already provisioned does not re-run
-- create_tenant_schema(). Unqualified DDL under a per-tenant
-- search_path, as 0030/0036/0038 §3 all do.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_cols constant text := $cols$
alter table profiles add column if not exists mail_address text;

do $inner$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_mail_address_key'
                   and conrelid = 'profiles'::regclass) then
    alter table profiles add constraint profiles_mail_address_key unique (mail_address);
  end if;
end
$inner$;
$cols$;

  c_ddl constant text := $ddl$
create table if not exists mail_messages (
  id                uuid        primary key default gen_random_uuid(),
  sender_profile_id uuid        references profiles(id) on delete set null,
  direction         text        not null check (direction in ('internal','outbound','inbound')),
  from_address      text        not null,
  from_name         text,
  to_addresses      text[]      not null default '{}',
  cc_addresses      text[]      not null default '{}',
  subject           text,
  body_text         text,
  body_html         text,
  snippet           text,
  thread_key        text,
  message_id        text,
  in_reply_to       text,
  send_status       text        check (send_status in ('sent','skipped','failed')),
  send_error        text,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint mail_messages_sender_matches_direction check (
    (direction = 'inbound' and sender_profile_id is null)
    or (direction in ('internal','outbound') and sender_profile_id is not null)
  )
);

create index if not exists idx_mail_messages_sender on mail_messages(sender_profile_id, occurred_at desc);
create index if not exists idx_mail_messages_thread  on mail_messages(thread_key);

create table if not exists mail_recipients (
  id         uuid        primary key default gen_random_uuid(),
  message_id uuid        not null references mail_messages(id) on delete cascade,
  profile_id uuid        not null references profiles(id) on delete cascade,
  kind       text        not null check (kind in ('to','cc')),
  is_read    boolean     not null default false,
  created_at timestamptz not null default now(),
  constraint uniq_mail_recipient unique (message_id, profile_id)
);

create index if not exists idx_mail_recipients_profile on mail_recipients(profile_id, is_read);

create table if not exists mail_attachments (
  id         uuid        primary key default gen_random_uuid(),
  message_id uuid        not null references mail_messages(id) on delete cascade,
  filename   text        not null,
  mime_type  text,
  size_bytes integer     not null check (size_bytes > 0),
  r2_key     text        not null,
  is_inline  boolean     not null default false,
  content_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_mail_attachments_message on mail_attachments(message_id);
$ddl$;

  c_rls constant text := $rls$
alter table mail_messages    enable row level security;
alter table mail_recipients  enable row level security;
alter table mail_attachments enable row level security;

drop policy if exists "mail_messages_select" on mail_messages;
create policy "mail_messages_select" on mail_messages for select
  using (
    sender_profile_id = auth.uid()
    or exists (
      select 1 from mail_recipients r
       where r.message_id = mail_messages.id and r.profile_id = auth.uid())
  );

drop policy if exists "mail_messages_insert" on mail_messages;
create policy "mail_messages_insert" on mail_messages for insert
  with check (sender_profile_id = auth.uid() and direction in ('internal','outbound'));

drop policy if exists "mail_recipients_select" on mail_recipients;
create policy "mail_recipients_select" on mail_recipients for select
  using (profile_id = auth.uid());

drop policy if exists "mail_recipients_insert" on mail_recipients;
create policy "mail_recipients_insert" on mail_recipients for insert
  with check (
    exists (
      select 1 from mail_messages m
       where m.id = mail_recipients.message_id and m.sender_profile_id = auth.uid())
  );

drop policy if exists "mail_recipients_update" on mail_recipients;
create policy "mail_recipients_update" on mail_recipients for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

drop policy if exists "mail_attachments_select" on mail_attachments;
create policy "mail_attachments_select" on mail_attachments for select
  using (
    exists (
      select 1 from mail_messages m
       where m.id = mail_attachments.message_id
         and (m.sender_profile_id = auth.uid()
              or exists (
                select 1 from mail_recipients r
                 where r.message_id = m.id and r.profile_id = auth.uid()))
    )
  );

drop policy if exists "mail_attachments_insert" on mail_attachments;
create policy "mail_attachments_insert" on mail_attachments for insert
  with check (
    exists (
      select 1 from mail_messages m
       where m.id = mail_attachments.message_id and m.sender_profile_id = auth.uid())
  );
$rls$;

  c_grd constant text := $grd$
create or replace function guard_profile_privilege_columns() returns trigger as $trg$
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

  if old.mail_address is not null and new.mail_address is distinct from old.mail_address then
    raise exception 'mail_address cannot be changed (MAIL_ADDRESS_IMMUTABLE)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{THIS_SCHEMA}}, extensions;
$grd$;

  c_gnt constant text := $gnt$
grant select, insert on mail_messages to {{THIS_ROLE}};
grant select, insert, update, delete on mail_messages to service_role;

grant select, insert on mail_recipients to {{THIS_ROLE}};
grant update (is_read) on mail_recipients to {{THIS_ROLE}};
grant select, insert, update, delete on mail_recipients to service_role;

grant select, insert on mail_attachments to {{THIS_ROLE}};
grant select, insert, update, delete on mail_attachments to service_role;
$gnt$;

begin
  for r in select slug, schema_name, role_name from platform.tenants loop
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);

    execute c_cols;
    execute c_ddl;
    execute c_rls;
    execute replace(c_grd, '{{THIS_SCHEMA}}', r.schema_name);
    execute replace(c_gnt, '{{THIS_ROLE}}', r.role_name);

    -- Audit triggers deliberately absent here too — see the file header.

    v_count := v_count + 1;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0039: % tenant schema(s) carry mail.', v_count;
end
$mig$;

-- ============================================================
-- 4. THE DIRECTORY, THE GENERATOR, AND handle_new_user()
-- ============================================================

-- platform.mail_addresses: the global map from a felixmail address to
-- the tenant schema and profile it belongs to. RLS on, zero policies —
-- the same "absence is the fence" shape as device_verifications (0038).
-- No tenant role holds USAGE on `platform` at all (see tenant.ts's own
-- comment on that), so this is defence in depth, not the only lock.
create table if not exists platform.mail_addresses (
  address       text primary key,
  tenant_schema text not null,
  profile_id    uuid not null,
  created_at    timestamptz not null default now()
);

alter table platform.mail_addresses enable row level security;

revoke all on platform.mail_addresses from public, anon, authenticated;
grant select on platform.mail_addresses to service_role;

-- The local-part generator. Deliberately not SECURITY DEFINER — it
-- takes no auth.uid() and needs none; it runs inside handle_new_user()'s
-- own definer context (a nested call inherits the caller's effective
-- role for a non-definer function) or this migration's own backfill
-- below, both of which already hold platform access. Not reachable any
-- other way: revoked from every PostgREST-facing role.
create or replace function platform.generate_mail_address(
  p_full_name   text,
  p_tenant_slug text,
  p_profile_id  uuid
) returns text as $$
declare
  v_base   text;
  v_local  text;
  v_addr   text;
  v_suffix int := 1;
begin
  -- ASCII-slugified name. A fully non-Latin name (Arabic, for instance
  -- — FELIX serves both markets) collapses to nothing here, and the
  -- fallback below gives it a stable, collision-resistant local-part
  -- instead of looping the suffix counter for every such profile in a
  -- showroom.
  v_base := regexp_replace(lower(trim(p_full_name)), '[^a-z0-9]+', '.', 'g');
  v_base := trim(both '.' from v_base);
  if v_base = '' then
    v_base := 'member' || substr(replace(p_profile_id::text, '-', ''), 1, 8);
  end if;

  v_local := v_base || '.' || p_tenant_slug;
  v_addr  := v_local || '@felixmail.508.world';

  -- Two Alex Carters in the same showroom: the second becomes
  -- alex.carter2.<tenant>, never a silent overwrite of the first's row
  -- in the directory (address is the primary key there).
  while exists (select 1 from platform.mail_addresses where address = v_addr) loop
    v_suffix := v_suffix + 1;
    v_addr := v_local || v_suffix::text || '@felixmail.508.world';
  end loop;

  return v_addr;
end;
$$ language plpgsql set search_path = pg_catalog, platform, extensions;

revoke all on function platform.generate_mail_address(text, text, uuid) from public, anon, authenticated;

-- handle_new_user(), restated in full with one addition: after the
-- profile row lands, generate and store its felixmail address and
-- register it in the directory. Everything above the marked block is
-- byte-for-byte 0010's version — see that file for the rest of the
-- reasoning (invitation lookup, tenant/branch validation, the
-- tenant_users membership row).
create or replace function platform.handle_new_user()
returns trigger as $$
declare
  inv    platform.staff_invitations%rowtype;
  t      platform.tenants%rowtype;
  v_name text;
  v_ok   boolean;
  v_mail_addr text;
begin
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

  if t.status <> 'active' then
    raise exception
      'The showroom this invitation belongs to is not active (TENANT_SUSPENDED)';
  end if;

  if t.schema_name !~ '^t_[a-z0-9]+$' then
    raise exception 'Registry holds a malformed schema name for tenant %', t.slug;
  end if;

  if to_regnamespace(t.schema_name) is null then
    raise exception
      'Tenant % names schema % which does not exist (TENANT_SCHEMA_MISSING)', t.slug, t.schema_name;
  end if;

  if inv.branch_id is not null then
    execute format('select exists (select 1 from %I.branches where id = $1)', t.schema_name)
      into v_ok using inv.branch_id;
    if not v_ok then
      raise exception
        'The branch this invitation was issued for no longer exists (BRANCH_GONE)';
    end if;
  end if;

  v_name := coalesce(nullif(inv.full_name, ''), new.raw_user_meta_data->>'full_name', new.email);

  insert into platform.tenant_users (user_id, tenant_id)
  values (new.id, t.id)
  on conflict (user_id) do nothing;

  execute format(
    'insert into %I.profiles (id, full_name, role, branch_id) values ($1,$2,$3,$4) on conflict (id) do nothing',
    t.schema_name)
    using new.id, v_name, inv.role, inv.branch_id;

  -- ── 0039: felixmail address ──────────────────────────────────
  -- `on conflict do nothing` above means this can re-run against an
  -- already-provisioned profile (a retried trigger, a re-accepted
  -- invitation) without generating a second address for the same
  -- person — checked directly rather than assumed.
  execute format('select mail_address from %I.profiles where id = $1', t.schema_name)
    into v_mail_addr using new.id;

  if v_mail_addr is null then
    v_mail_addr := platform.generate_mail_address(v_name, t.slug, new.id);

    execute format('update %I.profiles set mail_address = $1 where id = $2', t.schema_name)
      using v_mail_addr, new.id;

    insert into platform.mail_addresses (address, tenant_schema, profile_id)
    values (v_mail_addr, t.schema_name, new.id)
    on conflict (address) do nothing;
  end if;

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

-- ============================================================
-- 5. BACKFILL — every profile that predates this migration
-- ============================================================
do $backfill$
declare
  r record;
  p record;
  v_addr text;
  v_count int := 0;
begin
  for r in select slug, schema_name from platform.tenants loop
    for p in execute format(
      'select id, full_name from %I.profiles where mail_address is null', r.schema_name)
    loop
      v_addr := platform.generate_mail_address(p.full_name, r.slug, p.id);

      execute format('update %I.profiles set mail_address = $1 where id = $2', r.schema_name)
        using v_addr, p.id;

      insert into platform.mail_addresses (address, tenant_schema, profile_id)
      values (v_addr, r.schema_name, p.id)
      on conflict (address) do nothing;

      v_count := v_count + 1;
    end loop;
  end loop;

  raise notice '0039: backfilled % existing profile(s) with a felixmail address.', v_count;
end
$backfill$;

-- ============================================================
-- 6. SELF-VERIFY
-- ============================================================
do $verify$
declare
  n int;
  r record;
begin
  -- (1) The template carries every anchor exactly once.
  if position('mail_address        text        unique,' in platform.tenant_ddl_template()) = 0 then
    raise exception '0039 SELF-VERIFY FAILED: template missing profiles.mail_address.';
  end if;
  if position('create table if not exists mail_messages' in platform.tenant_ddl_template()) = 0 then
    raise exception '0039 SELF-VERIFY FAILED: template missing mail_messages.';
  end if;
  if position('MAIL_ADDRESS_IMMUTABLE' in platform.tenant_ddl_template()) = 0 then
    raise exception '0039 SELF-VERIFY FAILED: template missing the immutability guard.';
  end if;

  -- (2) Every live tenant schema actually has the three tables, the
  --     column, and RLS enabled on all three — not just t_felix.
  for r in select slug, schema_name, role_name from platform.tenants loop
    if to_regclass(quote_ident(r.schema_name) || '.mail_messages') is null
       or to_regclass(quote_ident(r.schema_name) || '.mail_recipients') is null
       or to_regclass(quote_ident(r.schema_name) || '.mail_attachments') is null then
      raise exception '0039 SELF-VERIFY FAILED: % is missing a mail table.', r.schema_name;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'profiles' and column_name = 'mail_address'
    ) then
      raise exception '0039 SELF-VERIFY FAILED: %.profiles has no mail_address column.', r.schema_name;
    end if;

    select count(*) into n
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name
       and c.relname in ('mail_messages','mail_recipients','mail_attachments')
       and not c.relrowsecurity;
    if n > 0 then
      raise exception '0039 SELF-VERIFY FAILED: % mail table(s) in % have RLS disabled.', n, r.schema_name;
    end if;

    -- (3) The tenant role can read all three (guard (5) would already
    --     have refused provisioning on this, but an already-provisioned
    --     schema went through §3 above instead, which has no such guard).
    if not (
      has_table_privilege(r.role_name, quote_ident(r.schema_name) || '.mail_messages', 'select')
      and has_table_privilege(r.role_name, quote_ident(r.schema_name) || '.mail_recipients', 'select')
      and has_table_privilege(r.role_name, quote_ident(r.schema_name) || '.mail_attachments', 'select')
    ) then
      raise exception '0039 SELF-VERIFY FAILED: % lacks SELECT on a mail table in %.', r.role_name, r.schema_name;
    end if;

    -- (4) No profile left without an address after the backfill.
    execute format('select count(*) from %I.profiles where mail_address is null', r.schema_name) into n;
    if n > 0 then
      raise exception '0039 SELF-VERIFY FAILED: % profile(s) in % still have no mail_address.', n, r.schema_name;
    end if;

    -- (5) No new SECURITY DEFINER function — count stays 21 (0037/0038).
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> 21 then
      raise exception '0039 SELF-VERIFY FAILED: % has % SECURITY DEFINER function(s), expected 21.', r.schema_name, n;
    end if;
  end loop;

  -- (6) The directory and every profile agree on cardinality — one
  --     address, one row, no orphans either direction.
  select count(*) into n from platform.mail_addresses;
  if n = 0 then
    raise exception '0039 SELF-VERIFY FAILED: platform.mail_addresses is empty after backfill.';
  end if;

  raise notice '0039 SELF-VERIFY PASSED.';
end
$verify$;

commit;
