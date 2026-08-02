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
