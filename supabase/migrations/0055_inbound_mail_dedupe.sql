-- ============================================================
-- 0055 — INBOUND MAIL DEDUPE
--
-- The 508.world router retries a delivery on ANY non-2xx from the
-- inbound bridge (src/app/api/mail/inbound/route.ts), including the
-- "thrown on DB hiccup" path that fires AFTER the message row landed.
-- A timeout-then-retry there stored the same email twice: two rows, two
-- recipient fan-outs, one confused reader. Nothing in 0039 constrained
-- message_id — it is optional (not every SMTP message carries one) and
-- outbound rows reuse the column for their own header value.
--
-- THE CONSTRAINT THAT DESCRIBES REALITY
-- --------------------------------------
-- Unique per tenant schema on message_id, but ONLY for inbound rows and
-- ONLY when a Message-ID exists at all:
--
--   partial    -> direction = 'inbound' and message_id is not null
--   per-schema -> mail lives in t_<slug>, so the index goes into BOTH
--                 the DDL template and every live tenant schema.
--
-- The route already knows what to do with the resulting 23505: it looks
-- the existing row up and answers ok/duplicate, which turns Cloudflare's
-- retry storm into an idempotent no-op instead of a second copy.
--
-- Template amendment follows 0042's mechanism exactly: read
-- platform.tenant_ddl_template(), splice at a literal anchor that FAILS
-- LOUDLY if the template drifted, re-emit the function, re-revoke from
-- public. Idempotent throughout.
-- ============================================================

begin;

-- ============================================================
-- 1. AMEND THE TEMPLATE
--
-- Anchor: the attachments index line from 0039's mail section — the
-- dedupe index belongs beside it, after the tables exist and inside the
-- same forward pass.
-- ============================================================
do $mig$
declare
  v_tpl      text;
  v_anchor   constant text := 'create index if not exists idx_mail_attachments_message';
  v_addition constant text :=
    'create unique index if not exists uniq_inbound_message_id on mail_messages (message_id)' || chr(10) ||
    '  where direction = ''inbound'' and message_id is not null;';
begin
  v_tpl := platform.tenant_ddl_template();

  if position('uniq_inbound_message_id' in v_tpl) > 0 then
    raise notice '0055: template already carries uniq_inbound_message_id — skipping amendment.';
    return;
  end if;

  if position(v_anchor in v_tpl) = 0 then
    raise exception
      '0055: template anchor (mail attachments index) did not match. The template drifted from 0039 — splice the dedupe index into the new shape by hand rather than trusting this file.';
  end if;

  v_tpl := replace(v_tpl, v_anchor, v_addition || chr(10) || v_anchor);
  if position(v_addition in v_tpl) = 0 then
    raise exception '0055: template amendment produced no change.';
  end if;

  execute format(
    'create or replace function platform.tenant_ddl_template() returns text '
    'language sql immutable set search_path = pg_catalog '
    'as $felix_0055$ select %L::text $felix_0055$',
    v_tpl
  );
  revoke all on function platform.tenant_ddl_template() from public;

  raise notice '0055: template amended with uniq_inbound_message_id.';
end
$mig$;

-- ============================================================
-- 2. EVERY LIVE TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
begin
  for r in select schema_name from platform.tenants order by slug loop
    if to_regclass(format('%I.mail_messages', r.schema_name)) is null then
      raise notice '0055: %.mail_messages missing — skipping (tenant predates 0039).', r.schema_name;
      continue;
    end if;

    execute format(
      'create unique index if not exists uniq_inbound_message_id on %I.mail_messages (message_id)
        where direction = ''inbound'' and message_id is not null',
      r.schema_name);
    v_count := v_count + 1;
  end loop;

  raise notice '0055: live schemas ensured (% processed).', v_count;
end
$mig$;

-- ============================================================
-- 3. VERIFICATION
-- ============================================================
do $mig$
declare
  r record;
  n int := 0;
begin
  -- (a) Every live schema with mail carries exactly one such index.
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.mail_messages', r.schema_name)) is null then
      continue;
    end if;

    select count(*) into n
      from pg_indexes
     where schemaname = r.schema_name
       and indexname = 'uniq_inbound_message_id';

    if n <> 1 then
      raise exception '0055 VERIFICATION FAILED: %.mail_messages lacks uniq_inbound_message_id', r.schema_name;
    end if;
  end loop;

  -- (b) The template produces it, so future showrooms inherit the rule.
  if position('uniq_inbound_message_id' in platform.tenant_ddl_template()) = 0 then
    raise exception '0055 VERIFICATION FAILED: tenant_ddl_template does not produce the dedupe index';
  end if;

  -- (c) The template function kept its guardrails after the rewrite:
  -- PUBLIC EXECUTE is how a tenant role could read every future
  -- showroom's baseline DDL.
  if has_function_privilege(
       'authenticated', 'platform.tenant_ddl_template()', 'EXECUTE') then
    raise exception '0055 VERIFICATION FAILED: tenant_ddl_template is executable by authenticated again';
  end if;

  raise notice '0055 verified across all live tenants and the template';
end
$mig$;

commit;
