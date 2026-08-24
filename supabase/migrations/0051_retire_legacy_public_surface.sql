-- ============================================================
-- 0051 — RETIRE THE LEGACY public.* FINANCIAL SURFACE
--
-- 0011 moved the flagship's books into t_felix and deliberately left
-- every public table in place as a rollback story: "revert the app and
-- the old schema is still there, untouched and authoritative." That was
-- the right call for the APP — but nobody ever told the DATABASE the
-- cutover happened, so the legacy copy has stayed fully live for
-- anyone who is not the app:
--
--   * Supabase grants ALL on new public tables to anon and
--     authenticated by default (0009 §6a documents this). The ~21
--     FELIX tables still hold those grants.
--   * The SECURITY DEFINER sale RPCs are still explicitly granted to
--     authenticated (0001/0003), and no later file revoked them. Any
--     pre-cutover account (which still has a public.profiles row, so
--     current_tenant_id() still resolves) can call
--     public.execute_vehicle_sale() against the STALE flagship copy —
--     minting ledger entries, flipping vehicle status and writing
--     contracts into books the app no longer reads. A tamperable
--     shadow ledger, invisible to every report.
--   * TRUNCATE is the worst single privilege in that pile: RLS does
--     not apply to it and row-level triggers do not fire on it, so
--     the append-only guarantee on audit_log ("even the CEO", 0003)
--     never applied to a TRUNCATE by any authenticated session.
--
-- WHAT THIS FILE DOES ABOUT IT
-- ----------------------------
-- Revokes, from PUBLIC / anon / authenticated only:
--   §1  EXECUTE on every function FELIX created in public
--       (catalog-driven over pg_proc, so overloads and functions
--       dropped by 0010 need no special casing).
--   §2  ALL privileges on the FELIX-owned legacy tables, and the
--       write privileges on the shared registry public.tenants,
--       which stays READABLE because A-Star and Calendar read it
--       cross-product (0013).
--
-- WHAT DELIBERATELY SURVIVES
-- --------------------------
--   * service_role keeps everything. The rollback story is intact:
--     reverting the app still works, because the app talks through
--     service_role (and tenant roles that never touched public).
--     Only END USERS lose the ability to reach the stale copy.
--   * Sibling products keep their objects: brands / module_requests /
--     agents (Agent Portal), product_leads / demo_bookings /
--     notification_log (508.world router) are NOT FELIX's and are not
--     touched. public.tenants keeps SELECT.
--   * Nothing is dropped. A later migration, after a soak period,
--     may empty or drop the legacy tables; this file only switches
--     the door locked. Reversible with plain GRANTs.
--
-- Idempotent: REVOKE is idempotent, the loops skip missing objects,
-- and the verification block passes unchanged on re-run.
-- ============================================================

begin;

set local search_path = pg_catalog;

-- ============================================================
-- 1. FUNCTIONS — EXECUTE away from end users
--
-- Every name below was created against public by migrations 0001-0006
-- (0010 already dropped handle_new_user and provision_tenant from
-- public; the loop simply finds nothing for them). Trigger-returning
-- functions cannot be invoked directly anyway, but revoking them too
-- costs nothing and closes the list against future confusion.
--
-- Why the whole list and not just the four money RPCs: SECURITY
-- DEFINER helpers like record_audit() and consume_rate_limit() bypass
-- table privileges when invoked, so leaving them executable would let
-- a session keep writing rows into tables whose INSERT we revoke in
-- §2 — the lock would have a keyhole-sized hole in exactly its most
-- important panel.
--
-- Catalog-driven rather than regprocedure-per-signature: five hand-
-- written signatures would be five chances to miss an overload, and
-- the whole reason this file exists is that drift between "what we
-- think is live" and what IS live.
-- ============================================================
do $$
declare
  c_felix_functions constant text[] := array[
    -- 0001
    'handle_new_user', 'current_role_name', 'current_branch_id',
    'is_ceo', 'is_manager_or_above', 'is_accountant_or_above',
    'is_staff', 'check_equity_splits_sum', 'prevent_split_edit_after_sale',
    'lock_ceo_override_expense', 'enforce_financing_partner_upload_gate',
    'enforce_financing_partner_active', 'log_deal_ticket_status_change',
    'generate_contract_serial', 'handle_deal_ticket_approval',
    'create_vehicle_with_equity_splits', 'preview_vehicle_sale_waterfall',
    'execute_vehicle_sale',
    -- 0003
    'set_updated_at', 'is_investor', 'can_act_on_branch',
    'can_read_branch', 'holds_equity_in_vehicle', 'vehicle_branch',
    'guard_profile_privilege_columns', 'sync_investor_row',
    'guard_deal_ticket_status', 'enforce_ticket_matches_vehicle',
    'compute_sale_waterfall', 'commission_for_sale', 'record_audit',
    'reject_audit_mutation', 'consume_rate_limit',
    'prune_rate_limit_buckets',
    -- 0004
    '_tenant_scoped_tables', 'current_tenant_id', 'provision_tenant',
    -- 0006
    'guard_meeting_columns', 'guard_meeting_invitee_columns',
    'create_meeting', 'calendar_meetings', 'calendar_invitable_people'
  ];

  r record;
  v_revoked int := 0;
begin
  for r in
    select p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) as identity_args
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = any(c_felix_functions)
  loop
    execute format(
      'revoke all on function %I.%I(%s) from public, anon, authenticated',
      'public', r.proname, r.identity_args);
    v_revoked := v_revoked + 1;
  end loop;

  raise notice 'revoked EXECUTE on % legacy public function(s)', v_revoked;
end $$;

-- ============================================================
-- 2. TABLES — all privileges away from end users
--
-- The 19 tables 0011 copied (its §3 order array is the authority on
-- what belongs to FELIX) plus the two support tables 0011 superseded:
-- staff_invitations (moved to platform in 0010) and
-- rate_limit_buckets (moved to platform in 0011).
--
-- public.tenants is different ON PURPOSE. It is the cross-product
-- registry A-Star and Calendar slug-lookup against (0013 header);
-- FELIX only stopped writing business data into it. End users keep
-- SELECT and lose every write path — platform.provision_tenant(),
-- which mirrors rows into it (0013 §2), runs as service_role and is
-- untouched by these revokes.
-- ============================================================
do $$
declare
  c_felix_tables constant text[] := array[
    'branches', 'profiles', 'investors', 'vehicles',
    'vehicle_equity_splits', 'vehicle_expenses', 'overhead_config',
    'financing_partners', 'leads', 'lead_comments', 'deal_tickets',
    'deal_ticket_events', 'financing_requests', 'contracts',
    'commission_tiers', 'ledger_entries', 'audit_log',
    'meetings', 'meeting_invitees',
    'staff_invitations', 'rate_limit_buckets'
  ];

  t text;
begin
  foreach t in array c_felix_tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;  -- already dropped by an operator; nothing to revoke
    end if;
    execute format(
      'revoke all on public.%I from anon, authenticated', t);
  end loop;

  -- Shared registry: readable, not writable, not erasable.
  revoke insert, update, delete, truncate on public.tenants
    from anon, authenticated;

  raise notice 'revoked privileges on % legacy tables + public.tenants writes',
    array_length(c_felix_tables, 1);
end $$;

-- ============================================================
-- 3. VERIFICATION
--
-- Same discipline as 0009's guard block: assert the state this file
-- promises, raise otherwise, so a partially-applied run cannot look
-- like success. Checks are written as "privilege must NOT exist" so
-- re-running after sibling products add unrelated grants stays valid.
-- ============================================================
do $$
declare
  c_felix_tables constant text[] := array[
    'branches', 'profiles', 'investors', 'vehicles',
    'vehicle_equity_splits', 'vehicle_expenses', 'overhead_config',
    'financing_partners', 'leads', 'lead_comments', 'deal_tickets',
    'deal_ticket_events', 'financing_requests', 'contracts',
    'commission_tiers', 'ledger_entries', 'audit_log',
    'meetings', 'meeting_invitees',
    'staff_invitations', 'rate_limit_buckets'
  ];
  c_roles constant text[] := array['anon', 'authenticated'];

  c_money_rpcs constant text[] := array[
    'execute_vehicle_sale(uuid)',
    'compute_sale_waterfall(uuid,numeric,numeric,timestamptz)',
    'preview_vehicle_sale_waterfall(uuid,numeric,numeric)',
    'create_vehicle_with_equity_splits(uuid,text,int,text,text,text,numeric,text[],jsonb)',
    'consume_rate_limit(text,int,int)'
  ];

  t   text;
  rol text;
  f   text;
begin
  -- (a) No end-user table privilege survives on the legacy copy —
  -- checked per-principle-of-action rather than one blanket probe,
  -- because has_table_privilege('ALL') reports the conjunction and a
  -- leftover UPDATE behind a revoked SELECT would pass it.
  foreach t in array c_felix_tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    foreach rol in array c_roles loop
      if has_table_privilege(rol, format('public.%I', t), 'SELECT')
         or has_table_privilege(rol, format('public.%I', t), 'INSERT')
         or has_table_privilege(rol, format('public.%I', t), 'UPDATE')
         or has_table_privilege(rol, format('public.%I', t), 'DELETE')
         or has_table_privilege(rol, format('public.%I', t), 'TRUNCATE') then
        raise exception
          'Legacy surface still reachable: % retains privileges on public.% — the shadow books are still open', rol, t;
      end if;
    end loop;
  end loop;

  -- (b) The shared registry is readable but frozen.
  foreach rol in array c_roles loop
    if not has_table_privilege(rol, 'public.tenants', 'SELECT') then
      raise exception
        '% lost SELECT on public.tenants — A-Star and Calendar slug lookups would break', rol;
    end if;
    if has_table_privilege(rol, 'public.tenants', 'INSERT')
       or has_table_privilege(rol, 'public.tenants', 'UPDATE')
       or has_table_privilege(rol, 'public.tenants', 'DELETE')
       or has_table_privilege(rol, 'public.tenants', 'TRUNCATE') then
      raise exception
        '% can still write public.tenants — the shared registry must stay read-only for end users', rol;
    end if;
  end loop;

  -- (c) The money RPCs are gone for end users. These five were the
  -- explicit grants in 0001/0003; checking by full identity catches
  -- the case where §1's loop matched zero rows (e.g. someone renamed
  -- the list) while the grants sat untouched.
  foreach f in array c_money_rpcs loop
    if to_regprocedure(format('public.%s', f)) is not null then
      foreach rol in array c_roles loop
        if has_function_privilege(rol, format('public.%s', f), 'EXECUTE') then
          raise exception
            'SECURITY DEFINER RPC still callable: % retains EXECUTE on public.% — the stale sale path is still armed', rol, f;
        end if;
      end loop;
    else
      raise exception
        'Expected legacy RPC public.% is missing entirely — confirm who dropped it before trusting this migration''s other checks', f;
    end if;
  end loop;

  -- (d) Sibling products untouched: the Agent Portal's registry tables
  -- must still be readable, or this file just took down another team.
  if to_regclass('public.brands') is not null
     and not has_table_privilege('authenticated', 'public.brands', 'SELECT') then
    raise exception
      'public.brands lost authenticated SELECT — wrong table got caught in the revoke net';
  end if;

  -- (e) Rollback story intact: service_role keeps the legacy copy
  -- reachable. If this ever fails, reverting the app silently loses
  -- its database, which is the exact scenario 0011 preserved it for.
  if not has_table_privilege('service_role', 'public.vehicles', 'SELECT')
     or not has_function_privilege(
          'service_role', 'public.execute_vehicle_sale(uuid)', 'EXECUTE') then
    raise notice
      'WARNING: service_role no longer reaches the legacy public copy — the 0011 rollback story is closed, not just retired';
  end if;

  raise notice '0051 applied: legacy public financial surface retired for end users';
end $$;

commit;
