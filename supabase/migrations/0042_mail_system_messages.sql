-- ============================================================
-- 0042 — SYSTEM MESSAGES IN THE INTERNAL MAIL INBOX
--
-- FraudRadar (built alongside migration 0040/0041) sends its VIN-
-- mismatch alert by calling sendExternalMail() directly — a Resend
-- round-trip with no footprint in this app's own `mail_messages` table,
-- so the alert never appeared in the CEO's own FELIX Mail inbox. This
-- migration gives it somewhere to land: a message with no human sender,
-- rendered with its own colour and icon in mail-client.tsx so it reads
-- as "the system flagged something", not an email from a colleague.
--
-- WHAT THIS ADDS
-- --------------
--   mail_messages.is_system   boolean, not null, default false.
--
-- WHY NOT REUSE `direction` OR `sender_profile_id IS NULL`
-- ----------------------------------------------------------
-- `direction` already means something (internal/outbound/inbound), and
-- 0039's own mail_messages_sender_matches_direction CHECK pins it to
-- sender_profile_id's nullability: 'inbound' requires a null sender,
-- 'internal'/'outbound' require a real one. FraudRadar has no profile
-- row to be that sender — there is no "FraudRadar" staff member — so it
-- needs a THIRD way to be null-sendered that has nothing to do with
-- being an inbound stranger's email. `is_system` is that third way; the
-- CHECK below adds it as its own disjunct rather than touching the other
-- two, so every existing row and every existing code path is unaffected.
--
-- THE SECURITY BOUNDARY IS THE GRANT, NOT THE APP
-- -------------------------------------------------
-- 0039 gave the tenant role a blanket `grant insert on mail_messages` —
-- no column list, so PostgREST will happily insert ANY column a request
-- body names, including one added after the fact. Without narrowing
-- that grant, an ordinary signed-in user could POST a compose request
-- with `is_system: true` in the payload and have it accepted: RLS's
-- `mail_messages_insert` policy only checks `sender_profile_id =
-- auth.uid()` and `direction in ('internal','outbound')`, and this
-- migration's relaxed CHECK is a pure OR — it does not forbid `is_system
-- = true` from also being set on an otherwise-ordinary row with a real
-- sender. A fake "FraudRadar" alert sitting in a colleague's inbox would
-- defeat the entire point of this feature being trustworthy.
--
-- The fix is at the privilege layer, not the application layer: §2/§3
-- REVOKE the table-wide insert and replace it with `grant insert (<every
-- column except is_system>) on mail_messages to {{ROLE}}`. Postgres only
-- requires column privilege for a column an INSERT statement actually
-- *names* — sendMail() (mail/actions.ts) never names is_system, so its
-- ordinary compose flow is completely unaffected and silently gets the
-- FALSE default. A request that explicitly names is_system is the one
-- and only case this blocks, which is exactly the attack it exists to
-- stop. service_role is untouched (it already holds unrestricted
-- select/insert/update/delete from 0039) and is the only way a row with
-- is_system = true can ever be created — by lib/vin-fraud-alert.ts and
-- the operator's one-off backfill sweep, both of which authenticate as
-- service_role via createAdminClient(), never as a signed-in user.
--
-- NO RLS CHANGE. mail_messages_insert (0039) already cannot be satisfied
-- by a null-sender row under any signed-in session — service_role
-- bypasses RLS entirely regardless, which is how /api/mail/inbound's
-- inbound rows and this migration's system rows both get written.
--
-- mail_recipients IS UNCHANGED. FraudRadar's fan-out row (message_id,
-- profile_id = the CEO, kind = 'to') is written by the same service-role
-- client that writes the mail_messages row, so 0039's existing
-- mail_recipients grants and RLS are already sufficient — nothing here
-- needed widening for the CEO to actually see the message in their inbox
-- list, only for the message row itself to exist with the right shape.
--
-- TWO TARGETS, BOTH REQUIRED (0039/0040/0041 — read those headers):
--   1. platform.tenant_ddl_template() — showrooms not yet provisioned.
--   2. Every existing t_<slug> schema, discovered from platform.tenants.
--
-- LINE ENDINGS. Multi-line anchors are rewritten into the template's own
-- CRLF/LF convention before use — see 0036's header for why. The grant
-- anchor is single-line and CRLF/LF-agnostic.
--
-- GATE. On 0039 — the migration that created mail_messages.
--
-- Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0042 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0042 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  if position('constraint mail_messages_sender_matches_direction check (' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0042 PRECONDITION FAILED: the template has no mail_messages table. Apply 0039 first.';
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

  c_col_from text := $a1$  created_at        timestamptz not null default now(),
  constraint mail_messages_sender_matches_direction check (
    (direction = 'inbound' and sender_profile_id is null)
    or (direction in ('internal','outbound') and sender_profile_id is not null)
  )
);$a1$;
  c_col_to   text := $a2$  created_at        timestamptz not null default now(),
  -- FraudRadar / system messages (0042) — a message with no human
  -- sender, styled distinctly in the recipient's inbox. Independent of
  -- `direction`; see the relaxed CHECK immediately below and the file
  -- header for why this could not reuse direction='inbound' instead.
  is_system         boolean     not null default false,
  constraint mail_messages_sender_matches_direction check (
    (direction = 'inbound' and sender_profile_id is null)
    or (direction in ('internal','outbound') and sender_profile_id is not null)
    or (is_system and sender_profile_id is null)
  )
);$a2$;

  c_gnt_from text := $b1$grant select, insert on mail_messages to {{ROLE}};$b1$;
  c_gnt_to   text := $b2$grant select on mail_messages to {{ROLE}};
-- is_system EXCLUDED from the writable column list (0042) — see the file
-- header. Postgres only enforces column privilege on a column an INSERT
-- actually names, so mail/actions.ts's sendMail() (which never names
-- is_system) is unaffected and silently gets the FALSE default; a
-- request that explicitly names is_system is refused.
grant insert (sender_profile_id, direction, from_address, from_name, to_addresses, cc_addresses, subject, body_text, body_html, snippet, thread_key, message_id, in_reply_to, send_status, send_error, occurred_at) on mail_messages to {{ROLE}};$b2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;
  c_col_from := replace(replace(c_col_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_col_to   := replace(replace(c_col_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('is_system         boolean' in v_tpl) > 0 then
    raise notice '0042: template already carries mail_messages.is_system — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_col_from, c_col_to);
    if position(c_col_to in v_tpl) = 0 then
      raise exception '0042: template anchor 2a (mail_messages column/check) did not match. Template drifted from 0039.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0042: template anchor 2b (grant) did not match. Template drifted from 0039.';
    end if;
    if position(c_gnt_from in v_tpl) > 0 then
      raise exception '0042: the blanket mail_messages insert grant survived the amendment.';
    end if;
    v_done := v_done + 1;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0042$ select %L::text $felix_0042$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0042: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.mail_messages', r.schema_name)) is null then
      raise notice '0042: %.mail_messages missing — skipping (tenant not fully provisioned, or predates 0039).', r.schema_name;
      continue;
    end if;

    execute format('alter table %I.mail_messages add column if not exists is_system boolean not null default false', r.schema_name);

    execute format('alter table %I.mail_messages drop constraint if exists mail_messages_sender_matches_direction', r.schema_name);
    execute format($ddl$
      alter table %I.mail_messages add constraint mail_messages_sender_matches_direction check (
        (direction = 'inbound' and sender_profile_id is null)
        or (direction in ('internal','outbound') and sender_profile_id is not null)
        or (is_system and sender_profile_id is null)
      )
    $ddl$, r.schema_name);

    -- The blanket grant must be REVOKED before the column-limited one is
    -- granted — Postgres privileges are additive, so granting a narrower
    -- set on top of an existing table-wide one would not narrow anything.
    execute format('revoke insert on %I.mail_messages from %I', r.schema_name, r.role_name);
    execute format(
      'grant insert (sender_profile_id, direction, from_address, from_name, to_addresses, cc_addresses, subject, body_text, body_html, snippet, thread_key, message_id, in_reply_to, send_status, send_error, occurred_at) on %I.mail_messages to %I',
      r.schema_name, r.role_name
    );

    v_count := v_count + 1;
    raise notice '0042: % amended.', r.schema_name;
  end loop;

  raise notice '0042: % tenant schema(s) can carry system messages in mail_messages.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY
-- ============================================================
do $$
declare
  r     record;
  v_bad text[] := '{}';
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.mail_messages', r.schema_name)) is null then
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = r.schema_name and table_name = 'mail_messages' and column_name = 'is_system'
    ) then
      v_bad := v_bad || (r.schema_name || ' (is_system column)');
    end if;

    if not exists (
      select 1 from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = r.schema_name and t.relname = 'mail_messages'
        and c.conname = 'mail_messages_sender_matches_direction'
        and pg_get_constraintdef(c.oid) like '%is_system%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (check not relaxed for is_system)');
    end if;

    -- The security boundary this migration exists for: the tenant role
    -- must NOT be able to name is_system in an INSERT.
    if has_column_privilege(r.role_name, format('%I.mail_messages', r.schema_name)::regclass, 'is_system', 'insert') then
      v_bad := v_bad || (r.schema_name || ' (role can insert is_system — spoofable!)');
    end if;

    -- The ordinary compose flow must still work: spot-check a handful of
    -- columns sendMail() actually names.
    if not (
      has_column_privilege(r.role_name, format('%I.mail_messages', r.schema_name)::regclass, 'subject', 'insert')
      and has_column_privilege(r.role_name, format('%I.mail_messages', r.schema_name)::regclass, 'body_html', 'insert')
      and has_column_privilege(r.role_name, format('%I.mail_messages', r.schema_name)::regclass, 'sender_profile_id', 'insert')
    ) then
      v_bad := v_bad || (r.schema_name || ' (ordinary compose columns not insertable — sendMail() broken)');
    end if;

    if not has_table_privilege(
         'service_role', format('%I.mail_messages', r.schema_name), 'insert') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot insert mail_messages)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0042 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('is_system         boolean' in platform.tenant_ddl_template()) = 0
     or position('grant insert (sender_profile_id' in platform.tenant_ddl_template()) = 0 then
    raise exception '0042 VERIFY FAILED: the template does not carry system-message support.';
  end if;

  raise notice '0042: verified — mail_messages can carry a system message, and only service_role can ever set is_system.';
end
$$;

notify pgrst, 'reload schema';

commit;
