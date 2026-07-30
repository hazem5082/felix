-- ============================================================
-- 0005 — Triggers must inherit tenant_id from the row, not the session
-- ============================================================
--
-- 0004 gave every tenant-scoped table `tenant_id uuid not null default
-- current_tenant_id()`, and fixed execute_vehicle_sale() to pass tenant_id
-- explicitly. Three trigger functions were missed and still let the column
-- fall through to that default:
--
--   log_deal_ticket_status_change()  -> deal_ticket_events
--   handle_deal_ticket_approval()    -> contracts
--   record_audit()                   -> audit_log
--
-- current_tenant_id() reads the *caller's* profile via auth.uid(). Two
-- consequences:
--
--  1. It is NULL whenever there is no authenticated user — the service-role
--     key, provisioning, seeding, any server-side job. Creating a deal
--     ticket that way fails with a NOT NULL violation on deal_ticket_events,
--     which is how this was found.
--  2. It is conceptually wrong even when it works. A row's tenant is a
--     property of the row, not of whoever happened to trigger the write.
--     Deriving it from the session means the audit trail's own tenancy
--     depends on session state rather than on the fact being recorded.
--
-- The fix is to read tenant_id from the row that caused the trigger. Every
-- table these fire on is tenant-scoped and NOT NULL, so the value is always
-- available. current_tenant_id() is kept only as a last-resort fallback in
-- record_audit(), which is generic over tables.
--
-- Behaviour is otherwise unchanged: same rows written, same conditions.

begin;

-- ── deal_ticket_events ──────────────────────────────────────────────────
create or replace function log_deal_ticket_status_change() returns trigger as $$
begin
  if (tg_op = 'INSERT') or (old.status is distinct from new.status) then
    insert into deal_ticket_events (
      tenant_id, deal_ticket_id, actor_id, from_status, to_status, note
    )
    values (
      new.tenant_id, new.id, auth.uid(),
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      case when new.status = 'rejected' then new.rejection_reason else null end
    );
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- ── contracts ───────────────────────────────────────────────────────────
create or replace function handle_deal_ticket_approval() returns trigger as $$
declare
  v_vin text;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if not (new.financial_check_passed and new.discount_validated and new.rate_revalidated) then
      raise exception 'Cannot approve: financial check, discount validation, and rate revalidation must all pass first';
    end if;
    select vin into v_vin from vehicles where id = new.vehicle_id;
    insert into contracts (tenant_id, deal_ticket_id, serial, unlocked_at)
    values (new.tenant_id, new.id, generate_contract_serial(new.id, v_vin), now())
    on conflict (deal_ticket_id) do nothing;
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- ── audit_log ───────────────────────────────────────────────────────────
-- Generic over every audited table, so tenant_id is pulled out of the row's
-- jsonb rather than named directly.
create or replace function record_audit() returns trigger as $$
declare
  v_entity uuid;
  v_row    jsonb;
  v_tenant uuid;
begin
  v_row := to_jsonb(coalesce(new, old));
  v_entity := (v_row->>'id')::uuid;
  v_tenant := coalesce((v_row->>'tenant_id')::uuid, current_tenant_id());

  insert into audit_log (
    tenant_id, actor_id, action, entity_type, entity_id, detail, before_data, after_data
  )
  values (
    v_tenant,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity,
    jsonb_build_object('table', tg_table_name, 'op', tg_op),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$ language plpgsql security definer set search_path = public, extensions;

-- ── verification ────────────────────────────────────────────────────────
-- Proves the functions no longer depend on the session default, rather than
-- just that they compile.
do $$
declare
  src text;
begin
  select prosrc into src from pg_proc where proname = 'log_deal_ticket_status_change';
  if src not like '%new.tenant_id%' then
    raise exception '0005: log_deal_ticket_status_change did not take';
  end if;

  select prosrc into src from pg_proc where proname = 'handle_deal_ticket_approval';
  if src not like '%new.tenant_id%' then
    raise exception '0005: handle_deal_ticket_approval did not take';
  end if;

  select prosrc into src from pg_proc where proname = 'record_audit';
  if src not like '%v_tenant%' then
    raise exception '0005: record_audit did not take';
  end if;
end $$;

commit;
