-- ============================================================
-- 0047 — THE HR ROLE
--
-- A seventh staff role: 'hr'. The person who owns the employment
-- relationship rather than the sales operation — the payroll register,
-- the attendance record, the statutory filing data, and (0049) the
-- salespeople's bonus ladder.
--
-- WHAT AN HR PROFILE MAY DO
-- --------------------------
--   * READ every profile in the showroom, org-wide. A payroll register
--     that stops at a branch boundary is not a payroll register. This
--     is the same shape 0029 gave marketing over vehicles: an explicit
--     arm on the named policy, not a widening of a shared predicate.
--   * WRITE the payroll columns on someone else's profile —
--     monthly_wage, hire_date, employment_type, national_id,
--     social_insurance_number.
--   * READ and CORRECT attendance, org-wide, including voiding a bad
--     punch and entering an adjustment.
--   * READ trusted devices, so a lost-phone report can be acted on.
--
-- WHAT AN HR PROFILE MAY NOT DO — and the fences are in the database,
-- not in the navigation:
--   * Nothing in the sales operation. is_hr() is deliberately NOT added
--     to is_staff(): that predicate means "takes part in the sales
--     operation" everywhere it is used (0029's header says so in those
--     words), and HR is not that. Vehicles, costs, leads, deal tickets,
--     the ledger and the cap table stay invisible.
--   * Change anyone's ROLE or BRANCH. That is guard_profile_privilege_
--     columns()'s first arm and it still says is_ceo(). An HR officer
--     who could set role='ceo' would be a total compromise wearing a
--     job title.
--   * Touch a CEO's profile row at all — new arm below. Without it,
--     `profiles_update_self` gaining `or is_hr()` would let HR rewrite
--     the CEO's notification_email, which is the address FraudRadar
--     (0042) and every other alert answers to.
--   * Set their OWN pay. The payroll arm requires `is_ceo() or (is_hr()
--     and new.id <> auth.uid())`. Separation of duties is the entire
--     reason a payroll clerk is not simply a CEO with fewer tabs; the
--     CEO sets HR's wage, HR sets everybody else's.
--
-- A HOLE THIS CLOSES ON THE WAY PAST
-- -----------------------------------
-- monthly_wage, hire_date, employment_type, national_id and
-- social_insurance_number have been self-editable by EVERY employee
-- since 0018. profiles is granted table-wide UPDATE (0009 §6),
-- profiles_update_self admits `id = auth.uid()`, and the guard trigger
-- named only role, branch_id, work_mode and mail_address — so
-- `PATCH /profiles?id=eq.<self> {"monthly_wage": 99999}` has always
-- succeeded against the API, with the NOSI filing reading whatever the
-- employee last wrote. No UI ever offered it, which is why it was
-- never noticed; the UI is not the fence. The payroll arm below closes
-- it for everyone, HR included.
--
-- WHAT THIS DOES NOT TOUCH
-- -------------------------
-- Mail (0039) and the calendar (0006) are identity-scoped, not
-- role-scoped: mail_messages_select keys off sender/recipient and
-- meetings_select off organizer/invitee, so an HR profile gets its own
-- felixmail address and its own diary with no change here. HR cannot
-- ORGANISE a meeting — create_meeting() admits 'ceo' and
-- 'branch_manager' only — which is out of scope for this migration and
-- recorded here so the next person does not read the omission as an
-- oversight.
--
-- is_hr() IS AN UNPINNED PREDICATE, so §4 adds it to c_unpinned inside
-- create_tenant_schema(). Assertion (e) demands that every function
-- without a pinned search_path be on that list; a new showroom
-- provisioned without this step would fail to create at all. Assertion
-- (f)'s SECURITY DEFINER count is UNCHANGED — is_hr() is a plain
-- `language sql stable` predicate like its six siblings.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor into the template's own convention first
-- (0036's header explains why).
--
-- GATE. On 0029 (the marketing role, whose CHECK line this extends) and
-- 0039 (the mail_address guard arm, which is the newest stable landmark
-- inside the trigger this amends).
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
    raise exception '0047 PRECONDITION FAILED: platform.tenant_ddl_template() missing. Apply 0009 first.';
  end if;
  -- Matches the MIDDLE of the role list rather than its closing
  -- parenthesis, so it still matches after §2 has appended 'hr' to the
  -- same line. Anchoring on the full tuple made this file fail its own
  -- precondition on a second run, which is the opposite of idempotent.
  if position($p$'sales_exec','investor','marketing'$p$
              in platform.tenant_ddl_template()) = 0 then
    raise exception '0047 PRECONDITION FAILED: the template has no marketing role. Apply 0029 first.';
  end if;
  if position('MAIL_ADDRESS_IMMUTABLE' in platform.tenant_ddl_template()) = 0 then
    raise exception '0047 PRECONDITION FAILED: the template has no mail_address guard. Apply 0039 first.';
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
  v_done int := 0;

  -- 2a. the profiles role CHECK gains 'hr'.
  c_role_from text := $a1$  role                text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor','marketing')),$a1$;
  c_role_to   text := $a2$  role                text        not null check (role in ('ceo','accountant','branch_manager','sales_exec','investor','marketing','hr')),$a2$;

  -- 2b. is_hr(), prepended to is_investor(). Unpinned and `language sql
  --     stable` like the other six inlinable predicates — see §4.
  c_fn_from text := $b1$create or replace function is_investor() returns boolean as $fn$$b1$;
  c_fn_to   text := $b2$-- 0047. The employment relationship, not the sales operation.
-- DELIBERATELY ABSENT FROM is_staff(): that predicate gates vehicles,
-- leads, deal tickets and the ledger, and an HR officer has no business
-- in any of them. Every arm HR needs is named explicitly, one policy at
-- a time, so widening this role later is a visible edit rather than a
-- side effect.
create or replace function is_hr() returns boolean as $fn$
  select {{SCHEMA}}.current_role_name() = 'hr';
$fn$ language sql stable;

create or replace function is_investor() returns boolean as $fn$$b2$;

  -- 2c. profiles_select — HR reads every profile, org-wide.
  c_psel_from text := $c1$create policy "profiles_select" on profiles for select
  using (
    id = auth.uid()
    or is_ceo()
    or is_accountant_or_above()
    or (is_manager_or_above() and (branch_id = current_branch_id() or branch_id is null))
  );$c1$;
  c_psel_to   text := $c2$create policy "profiles_select" on profiles for select
  using (
    id = auth.uid()
    or is_ceo()
    or is_accountant_or_above()
    -- 0047. A payroll register that stops at a branch boundary is not a
    -- payroll register, so HR is org-wide like the accountant rather
    -- than branch-confined like the manager.
    or is_hr()
    or (is_manager_or_above() and (branch_id = current_branch_id() or branch_id is null))
  );$c2$;

  -- 2d. profiles_update_self — HR writes payroll columns on other
  --     people's rows. WHICH columns is the guard trigger's job (2e);
  --     a policy cannot express "this row but not those columns".
  c_pupd_from text := $d1$  using (id = auth.uid() or is_ceo()) with check (id = auth.uid() or is_ceo());$d1$;
  c_pupd_to   text := $d2$  using (id = auth.uid() or is_ceo() or is_hr())
  with check (id = auth.uid() or is_ceo() or is_hr());$d2$;

  -- 2e. guard_profile_privilege_columns() gains two arms.
  c_grd_from text := $e1$  if old.mail_address is not null and new.mail_address is distinct from old.mail_address then
    raise exception 'mail_address cannot be changed (MAIL_ADDRESS_IMMUTABLE)';
  end if;
  return new;$e1$;
  c_grd_to   text := $e2$  if old.mail_address is not null and new.mail_address is distinct from old.mail_address then
    raise exception 'mail_address cannot be changed (MAIL_ADDRESS_IMMUTABLE)';
  end if;

  -- 0047. HR may not touch a CEO's row at all.
  --
  -- profiles_update_self now admits is_hr() so that HR can maintain
  -- everybody's payroll record. Without this arm that same admission
  -- would let a payroll clerk rewrite the CEO's notification_email —
  -- the address FraudRadar alerts and every other notification answer
  -- to — and then read the replies. The CEO's own row is administered
  -- by a CEO, full stop.
  if is_hr() and not is_ceo() and old.role = 'ceo' then
    raise exception 'HR cannot modify a CEO account (PRIVILEGE_LOCKED)';
  end if;

  -- 0047. THE PAYROLL COLUMNS.
  --
  -- Two separate things at once, and both matter.
  --
  -- The hole: these five have been self-editable by every employee
  -- since 0018. profiles carries a table-wide UPDATE grant,
  -- profiles_update_self admits `id = auth.uid()`, and this trigger
  -- named only role, branch_id, work_mode and mail_address — so
  -- `PATCH /profiles?id=eq.<self> {"monthly_wage": 99999}` has always
  -- succeeded and the NOSI filing has always read whatever the employee
  -- last wrote. No screen ever offered it; a screen is not a fence.
  --
  -- The rule: `new.id <> auth.uid()` on the HR arm is separation of
  -- duties, not caution. A payroll clerk who can set their own pay is a
  -- CEO with fewer tabs. The CEO sets HR's wage; HR sets everybody
  -- else's.
  if (new.monthly_wage            is distinct from old.monthly_wage
   or new.hire_date               is distinct from old.hire_date
   or new.employment_type         is distinct from old.employment_type
   or new.national_id             is distinct from old.national_id
   or new.social_insurance_number is distinct from old.social_insurance_number)
     and not (is_ceo() or (is_hr() and new.id <> auth.uid())) then
    raise exception 'Only the CEO or HR can change payroll details (PRIVILEGE_LOCKED)';
  end if;
  return new;$e2$;

  -- 2f. trusted_devices_select — a lost-phone report reaches HR.
  c_dev_from text := $f1$create policy "trusted_devices_select" on trusted_devices for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and exists ($f1$;
  c_dev_to   text := $f2$create policy "trusted_devices_select" on trusted_devices for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or is_hr()
    or (is_manager_or_above() and exists ($f2$;

  -- 2g/2h/2i. attendance. HR owns the attendance record org-wide: they
  -- read it, they void a bad punch, and they enter the adjustment that
  -- replaces it. `can_act_on_branch(branch_id) or is_hr()` rather than a
  -- widening of can_act_on_branch() itself — 0044's header records why
  -- that predicate is not the extension point it looks like: 0033, 0034
  -- and 0038 all hang unrelated authority off it.
  c_asel_from text := $g1$    or (is_manager_or_above() and can_read_branch(branch_id)));$g1$;
  c_asel_to   text := $g2$    or is_hr()
    or (is_manager_or_above() and can_read_branch(branch_id)));$g2$;

  c_ains_from text := $h1$    recorded_by = auth.uid()
    and can_act_on_branch(branch_id)
    and (
      (source = 'device' and profile_id = auth.uid())
      or (source = 'adjustment' and is_manager_or_above())
    ));$h1$;
  c_ains_to   text := $h2$    recorded_by = auth.uid()
    and (can_act_on_branch(branch_id) or is_hr())
    and (
      (source = 'device' and profile_id = auth.uid())
      or (source = 'adjustment' and (is_manager_or_above() or is_hr()))
    ));$h2$;

  c_aupd_from text := $i1$  using (is_manager_or_above() and can_act_on_branch(branch_id))
  with check (
    is_manager_or_above()
    and can_act_on_branch(branch_id)
    and voided_at is not null
    and voided_by = auth.uid());$i1$;
  c_aupd_to   text := $i2$  using ((is_manager_or_above() or is_hr()) and (can_act_on_branch(branch_id) or is_hr()))
  with check (
    (is_manager_or_above() or is_hr())
    and (can_act_on_branch(branch_id) or is_hr())
    and voided_at is not null
    and voided_by = auth.uid());$i2$;
begin
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_role_from := replace(replace(c_role_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_role_to   := replace(replace(c_role_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_from   := replace(replace(c_fn_from,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_to     := replace(replace(c_fn_to,     chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_psel_from := replace(replace(c_psel_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_psel_to   := replace(replace(c_psel_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pupd_from := replace(replace(c_pupd_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pupd_to   := replace(replace(c_pupd_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_grd_from  := replace(replace(c_grd_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_grd_to    := replace(replace(c_grd_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_dev_from  := replace(replace(c_dev_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_dev_to    := replace(replace(c_dev_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_asel_from := replace(replace(c_asel_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_asel_to   := replace(replace(c_asel_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_ains_from := replace(replace(c_ains_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_ains_to   := replace(replace(c_ains_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_aupd_from := replace(replace(c_aupd_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_aupd_to   := replace(replace(c_aupd_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('create or replace function is_hr()' in v_tpl) > 0 then
    raise notice '0047: template already carries the hr role — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_role_from, c_role_to);
    if position(c_role_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2a (role check) did not match. Template drifted from 0029.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2b (is_hr) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_psel_from, c_psel_to);
    if position(c_psel_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2c (profiles_select) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pupd_from, c_pupd_to);
    if position(c_pupd_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2d (profiles_update_self) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_grd_from, c_grd_to);
    if position(c_grd_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2e (privilege guard) did not match. Template drifted from 0039.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_dev_from, c_dev_to);
    if position(c_dev_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2f (trusted_devices_select) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_asel_from, c_asel_to);
    if position(c_asel_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2g (attendance select) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_ains_from, c_ains_to);
    if position(c_ains_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2h (attendance insert) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_aupd_from, c_aupd_to);
    if position(c_aupd_to in v_tpl) = 0 then
      raise exception '0047: template anchor 2i (attendance update) did not match. Template drifted from 0038.';
    end if;
    v_done := v_done + 1;

    -- Uniqueness: exactly one is_hr() definition, and exactly one
    -- payroll guard. A double substitution would compile and then
    -- shadow itself in ways nothing else here would notice.
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function is_hr()', ''))) <>
       length('create or replace function is_hr()') then
      raise exception '0047: the template does not carry exactly one is_hr().';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'Only the CEO or HR can change payroll details', ''))) <>
       length('Only the CEO or HR can change payroll details') then
      raise exception '0047: the template does not carry exactly one payroll guard.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0047$ select %L::text $felix_0047$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0047: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. THE PLATFORM CONTROL PLANE — invitation table and gate
--
-- These exist once, not per tenant. Both learn 'hr'. 0029 §3 verbatim
-- with the role changed.
-- ============================================================
do $$
declare
  r record;
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'platform.staff_invitations'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%''hr''%'
  ) then
    raise notice '0047: staff_invitations already accepts hr — skipping.';
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
      check (role in ('ceo','accountant','branch_manager','sales_exec','investor','marketing','hr'));
    raise notice '0047: staff_invitations role check widened.';
  end if;
end
$$;

-- 3b. invite_staff()'s p_role gate. Patched from its OWN live source
-- rather than a hand-retyped copy — 0037's and 0045's technique, and
-- the only safe one now that 0029 has already rewritten this body once.
do $mig$
declare
  v_src text;
  v_n   int;
  c_from constant text := $z1$p_role not in ('ceo','accountant','branch_manager','sales_exec','investor','marketing')$z1$;
  c_to   constant text := $z2$p_role not in ('ceo','accountant','branch_manager','sales_exec','investor','marketing','hr')$z2$;
begin
  select p.prosrc into v_src
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'invite_staff';

  if v_src is null then
    raise exception '0047: platform.invite_staff() not found. Apply 0010 first.';
  end if;

  if position(c_to in v_src) > 0 then
    raise notice '0047: invite_staff() already accepts hr — skipping.';
  else
    v_n := length(v_src) - length(replace(v_src, c_from, ''));
    if v_n <> length(c_from) then
      raise exception '0047: expected exactly one role gate in invite_staff(). Function drifted from 0029.';
    end if;
    v_src := replace(v_src, c_from, c_to);

    execute format(
      'create or replace function platform.invite_staff('
      '  p_email text, p_full_name text, p_role text, p_branch_id uuid default null) '
      'returns void language plpgsql security definer set search_path = pg_catalog, platform as %L',
      v_src
    );
    raise notice '0047: invite_staff() now accepts hr.';
  end if;
end
$mig$;

-- ============================================================
-- 4. c_unpinned INSIDE create_tenant_schema()
--
-- Assertion (e) demands that every function in a tenant schema WITHOUT
-- a pinned search_path be one of the named inlinable predicates.
-- is_hr() is the eighth. Without this step the template above is
-- correct and the next showroom provisioned from it fails outright —
-- which is the good failure mode, but only if it never happens.
--
-- Assertion (f) is untouched: is_hr() is not SECURITY DEFINER.
-- ============================================================
do $mig$
declare
  v_src text;
  v_n   int;
  c_from constant text := $z1$'is_investor', 'can_act_on_branch', 'can_read_branch'];$z1$;
  c_to   constant text := $z2$'is_investor', 'is_hr', 'can_act_on_branch', 'can_read_branch'];$z2$;
begin
  select p.prosrc into v_src
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_src is null then
    raise exception '0047: platform.create_tenant_schema() not found.';
  end if;

  if position($z3$'is_hr'$z3$ in v_src) > 0 then
    raise notice '0047: create_tenant_schema() already lists is_hr — skipping.';
  else
    v_n := length(v_src) - length(replace(v_src, c_from, ''));
    if v_n <> length(c_from) then
      raise exception '0047: expected exactly one c_unpinned tail in create_tenant_schema(). Function drifted.';
    end if;
    v_src := replace(v_src, c_from, c_to);
    -- The prose count in the comment above the array, kept honest.
    v_src := replace(v_src, 'The seven functions that deliberately carry',
                            'The eight functions that deliberately carry');
    v_src := replace(v_src, 'the only functions WITHOUT a pinned search_path are the seven',
                            'the only functions WITHOUT a pinned search_path are the eight');
    v_src := replace(v_src, 'are not one of the seven inlinable predicates',
                            'are not one of the eight inlinable predicates');

    execute format(
      'create or replace function platform.create_tenant_schema(p_slug text) returns text '
      'language plpgsql security definer set search_path = pg_catalog, platform as %L',
      v_src
    );
    raise notice '0047: create_tenant_schema() now permits is_hr() to be unpinned.';
  end if;
end
$mig$;

-- ============================================================
-- 5. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  c       record;
  v_count int := 0;
  c_ddl constant text := $ddl$
-- 0047. See the migration header. Unpinned and `language sql stable`
-- like the other inlinable predicates; deliberately absent from
-- is_staff().
create or replace function is_hr() returns boolean as $fn$
  select current_role_name() = 'hr';
$fn$ language sql stable;

drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using (
    id = auth.uid()
    or is_ceo()
    or is_accountant_or_above()
    or is_hr()
    or (is_manager_or_above() and (branch_id = current_branch_id() or branch_id is null))
  );

drop policy if exists "profiles_update_self" on profiles;
create policy "profiles_update_self" on profiles for update
  using (id = auth.uid() or is_ceo() or is_hr())
  with check (id = auth.uid() or is_ceo() or is_hr());

drop policy if exists "trusted_devices_select" on trusted_devices;
create policy "trusted_devices_select" on trusted_devices for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or is_hr()
    or (is_manager_or_above() and exists (
      select 1 from profiles p
       where p.id = trusted_devices.profile_id
         and p.branch_id = current_branch_id())));

drop policy if exists "attendance_events_select" on attendance_events;
create policy "attendance_events_select" on attendance_events for select
  using (
    profile_id = auth.uid()
    or is_accountant_or_above()
    or is_hr()
    or (is_manager_or_above() and can_read_branch(branch_id)));

drop policy if exists "attendance_events_insert" on attendance_events;
create policy "attendance_events_insert" on attendance_events for insert
  with check (
    recorded_by = auth.uid()
    and (can_act_on_branch(branch_id) or is_hr())
    and (
      (source = 'device' and profile_id = auth.uid())
      or (source = 'adjustment' and (is_manager_or_above() or is_hr()))
    ));

drop policy if exists "attendance_events_update" on attendance_events;
create policy "attendance_events_update" on attendance_events for update
  using ((is_manager_or_above() or is_hr()) and (can_act_on_branch(branch_id) or is_hr()))
  with check (
    (is_manager_or_above() or is_hr())
    and (can_act_on_branch(branch_id) or is_hr())
    and voided_at is not null
    and voided_by = auth.uid());

-- The privilege guard, re-created whole with the two 0047 arms. Written
-- out rather than patched because a trigger function that fails to land
-- fails OPEN — assertion (i) checks the trigger exists, nothing checks
-- what is inside it.
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

  -- 0047. HR may not touch a CEO's row at all — see the migration
  -- header for the notification_email takeover this closes.
  if is_hr() and not is_ceo() and old.role = 'ceo' then
    raise exception 'HR cannot modify a CEO account (PRIVILEGE_LOCKED)';
  end if;

  -- 0047. The payroll columns: CEO always, HR on somebody else's row,
  -- and nobody on their own. Also closes the self-service wage hole
  -- open since 0018 — see the migration header.
  if (new.monthly_wage            is distinct from old.monthly_wage
   or new.hire_date               is distinct from old.hire_date
   or new.employment_type         is distinct from old.employment_type
   or new.national_id             is distinct from old.national_id
   or new.social_insurance_number is distinct from old.social_insurance_number)
     and not (is_ceo() or (is_hr() and new.id <> auth.uid())) then
    raise exception 'Only the CEO or HR can change payroll details (PRIVILEGE_LOCKED)';
  end if;
  return new;
end;
$trg$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;
$ddl$;
  v_ddl text;
begin
  for r in select schema_name, role_name from platform.tenants order by slug loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0047: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- 5a. the profiles role CHECK. Inline-created, so discover by
    -- definition; skip if a widened one is already in place.
    if not exists (
      select 1 from pg_constraint pc
       where pc.conrelid = format('%I.profiles', r.schema_name)::regclass
         and pc.contype = 'c'
         and pg_get_constraintdef(pc.oid) like '%''hr''%'
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
        'check (role in (''ceo'',''accountant'',''branch_manager'',''sales_exec'',''investor'',''marketing'',''hr''))',
        r.schema_name
      );
    end if;

    -- 5b. under the tenant's own search_path, so the recreated policies
    -- and the trigger function bind to THIS schema's helpers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    v_ddl := replace(c_ddl, '{{SCHEMA}}', quote_ident(r.schema_name));
    execute v_ddl;

    -- is_hr() is a predicate every session evaluates through RLS; the
    -- tenant role must be able to call it. (Default EXECUTE for PUBLIC
    -- would already cover this; stated explicitly because §6 of the
    -- template revokes broadly and this must not depend on that
    -- ordering.)
    execute format('grant execute on function %I.is_hr() to %I', r.schema_name, r.role_name);

    v_count := v_count + 1;
    raise notice '0047: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0047: % tenant schema(s) carry the hr role.', v_count;
end
$mig$;

-- ============================================================
-- 6. BACKFILL
--
-- None. A role is not data: no profile becomes HR because this ran.
-- The CEO creates or re-roles one from the staff screen.
-- ============================================================

-- ============================================================
-- 7. SELF-VERIFY
-- ============================================================
do $$
declare
  r     record;
  v_bad text[] := '{}';
  v_src text;
  n     int;
begin
  for r in select schema_name from platform.tenants loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    -- (a) the role CHECK accepts hr
    if not exists (
      select 1 from pg_constraint pc
       where pc.conrelid = format('%I.profiles', r.schema_name)::regclass
         and pc.contype = 'c'
         and pg_get_constraintdef(pc.oid) like '%''hr''%'
    ) then
      v_bad := v_bad || (r.schema_name || ' (role check does not accept hr)');
    end if;

    -- (b) is_hr() exists, and is NOT security definer
    if to_regprocedure(format('%I.is_hr()', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (is_hr missing)');
    else
      select count(*) into n
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'is_hr' and p.prosecdef;
      if n > 0 then
        v_bad := v_bad || (r.schema_name || ' (is_hr is SECURITY DEFINER — assertion (f) would drift)');
      end if;
    end if;

    -- (c) is_hr() did NOT leak into is_staff(). The single most likely
    --     way this migration goes wrong later is somebody "tidying" the
    --     role into the shared predicate, which would hand HR the
    --     vehicles, the ledger and the cap table in one edit.
    if position('''hr''' in pg_get_functiondef(
         to_regprocedure(format('%I.is_staff()', r.schema_name)))) > 0 then
      v_bad := v_bad || (r.schema_name || ' (is_staff() now names hr — HR must not be sales staff)');
    end if;

    -- (d) the four policies carry the hr arm
    foreach v_src in array array[
      'profiles_select', 'profiles_update_self',
      'trusted_devices_select', 'attendance_events_select',
      'attendance_events_insert', 'attendance_events_update'
    ] loop
      select count(*) into n
        from pg_policies
       where schemaname = r.schema_name
         and policyname = v_src
         and (coalesce(qual, '') like '%is_hr%' or coalesce(with_check, '') like '%is_hr%');
      if n <> 1 then
        v_bad := v_bad || (r.schema_name || ' (' || v_src || ' has no is_hr arm)');
      end if;
    end loop;

    -- (e) the payroll guard landed, and the CEO-row guard with it
    v_src := pg_get_functiondef(
      to_regprocedure(format('%I.guard_profile_privilege_columns()', r.schema_name)));
    if position('Only the CEO or HR can change payroll details' in v_src) = 0 then
      v_bad := v_bad || (r.schema_name || ' (privilege guard has no payroll arm)');
    end if;
    if position('HR cannot modify a CEO account' in v_src) = 0 then
      v_bad := v_bad || (r.schema_name || ' (privilege guard has no CEO-row arm)');
    end if;

    -- (f) and it is still attached. A guard trigger fails OPEN.
    if not exists (
      select 1 from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name
         and tg.tgname = 'trg_guard_profile_privileges'
         and not tg.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (trg_guard_profile_privileges missing)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0047 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  -- (g) the template, the invitation gate and the provisioner
  if position('create or replace function is_hr()' in platform.tenant_ddl_template()) = 0 then
    raise exception '0047 VERIFY FAILED: template does not carry is_hr().';
  end if;
  if position('Only the CEO or HR can change payroll details' in platform.tenant_ddl_template()) = 0 then
    raise exception '0047 VERIFY FAILED: template does not carry the payroll guard.';
  end if;
  if position($v$'marketing','hr'$v$ in platform.tenant_ddl_template()) = 0 then
    raise exception '0047 VERIFY FAILED: template role CHECK does not accept hr.';
  end if;
  if position($v$'is_hr'$v$ in (
       select p.prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'platform' and p.proname = 'create_tenant_schema')) = 0 then
    raise exception '0047 VERIFY FAILED: create_tenant_schema() does not permit is_hr() to be unpinned — the next provision would fail assertion (e).';
  end if;
  if position($v$'marketing','hr'$v$ in (
       select p.prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'platform' and p.proname = 'invite_staff')) = 0 then
    raise exception '0047 VERIFY FAILED: invite_staff() does not accept hr.';
  end if;

  raise notice '0047: verified — the showroom can employ an HR officer, and nobody can set their own wage any more.';
end
$$;

commit;

notify pgrst, 'reload schema';
