-- ============================================================
-- 0053 — TASKS, THE RECURRING KIND, AND THE END-OF-DAY REPORT
--
-- FELIX has always recorded what a salesperson ACHIEVED — a lead, a
-- ticket, a punch — and never once recorded what they were ASKED to do.
-- "Ring every pending enquiry", "check the forecourt stock sheet",
-- "reconcile the month" are the actual shape of a showroom day, and
-- until now they lived in WhatsApp.
--
-- WHAT THIS ADDS
-- ---------------
--   task_templates    the recurring instruction: daily / weekly /
--                     monthly, aimed at a role or at one person, in one
--                     branch or across the whole company.
--   tasks             the concrete instance: one row per person per due
--                     day. What actually gets ticked.
--   day_reports       what END DAY produced: the counts, and the mail
--                     that carried them.
--
--   materialise_tasks(day)      turns due templates into task rows.
--   set_task_status(id, …)      the ONLY way a status changes.
--   day_report_recipients()     who the end-of-day mail goes to.
--   task_template_due(…)        the recurrence rule, as one expression.
--
-- WHY A TEMPLATE AND AN INSTANCE ARE DIFFERENT TABLES
-- ---------------------------------------------------
-- Because "did Karim ring his leads on the 14th" is a question about
-- the 14th, and a recurring rule cannot answer it. If the tick lived on
-- the template there would be exactly one tick and it would be
-- overwritten every morning; the end-of-day report would have nothing
-- to report and the history would be a single boolean. So a template
-- is policy, a task is a fact about a day, and materialise_tasks() is
-- the one place the first becomes the second.
--
-- MATERIALISATION IS PULL, NOT CRON
-- ----------------------------------
-- Nothing in this deployment runs on a schedule inside Postgres, and
-- the one scheduler FELIX has (the 508.world Worker) is a different
-- trust domain with a different credential. So the tasks page calls
-- materialise_tasks(today) on load, and the unique indexes make that
-- idempotent — the tenth page load of the morning inserts nothing.
--
-- It is SECURITY DEFINER for a reason that is not "convenience": a
-- salesperson cannot read a template aimed at their colleague, cannot
-- insert a row whose created_by is their manager, and must still end up
-- with today's tasks in front of them. The function gates itself by
-- role exactly as monthly_sales_units() (0049) does — you materialise
-- for yourself, a manager materialises for the branches
-- can_read_branch() admits, the CEO for the company. An investor gets
-- nothing: they are outside capital, not staff, and nobody assigns them
-- a task.
--
-- WHY set_task_status() EXISTS AND tasks_update DOES NOT ADMIT THE ASSIGNEE
-- -------------------------------------------------------------------------
-- The assignee must be able to tick their own task and must NOT be able
-- to rewrite it. A policy cannot express "this row but not those
-- columns" — 0047 hit the same wall with payroll and answered it with a
-- guard trigger. This answers it with a narrow RPC instead, which is
-- strictly better here: there is exactly one legitimate edit a
-- salesperson makes to a task, so there is exactly one entry point, and
-- tasks_update stays manager-only rather than being opened and then
-- fenced. A task whose title changed after the fact would make the
-- end-of-day report a document about nothing.
--
-- 'cancelled' IS THE MANAGER'S WITHDRAWAL, NOT THE WORKER'S EXCUSE.
-- 'skipped' is the worker saying "not today, and here is why" — it is
-- REPORTED, it does not hide. Assertion (j) refuses a DELETE grant to
-- the tenant role regardless, so nothing here is ever erased.
--
-- WHAT day_report_recipients() IS FOR
-- ------------------------------------
-- profiles_select shows a sales exec exactly one row: their own. So a
-- salesperson pressing END DAY cannot name their own manager, let alone
-- the CEO, and the mail would go nowhere. This is the same shape as
-- calendar_invitable_people(): a definer that returns four columns —
-- id, name, mail address, role — for the CEOs of the company and the
-- managers of the caller's OWN branch, and nothing else. It reveals no
-- wage, no branch roster, no other salesperson.
--
-- WHAT IS DELIBERATELY NOT HERE
-- ------------------------------
--   * No due TIME. A task is due on a day; the showroom day ends when
--     the person presses END DAY, and inventing a 17:00 would make the
--     report wrong for every branch that closes at 21:00.
--   * No priorities, labels, subtasks or dependencies. "Simple first."
--   * No reassignment of a task between people. Cancel it and assign a
--     new one, so the record says what happened.
--   * No bulk delete of a template's past instances. Retiring a
--     template is active = false and yesterday keeps its evidence.
--
-- THREE NEW SECURITY DEFINER FUNCTIONS, so assertion (f) in
-- create_tenant_schema() rises by three. §5 READS the live number and
-- adds to it rather than hard-coding a constant — 0050's technique, for
-- 0050's reason: this database has moved past what the migration
-- history reads as, and a constant here would abort a correct migration
-- over a number that is not this file's business.
--
-- task_template_due() is SECURITY INVOKER and names nothing in schema
-- auth, so it does not count and cannot trip the inlining trap that
-- 0037 and 0045 exist to explain.
--
-- LINE ENDINGS: the live template is CRLF and this file is LF; §2
-- rewrites every anchor and replacement into the template's own
-- convention first.
--
-- GATE. On 0049 — every anchor below is one 0049 introduced, which also
-- guarantees this lands after it — and on 0039, since day_reports
-- points at mail_messages.
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
    raise exception '0053 PRECONDITION FAILED: platform.tenant_ddl_template() missing. Apply 0009 first.';
  end if;
  if position('create table if not exists bonus_rules' in platform.tenant_ddl_template()) = 0 then
    raise exception '0053 PRECONDITION FAILED: the template has no bonus_rules. Apply 0049 first.';
  end if;
  if position('create table if not exists mail_messages' in platform.tenant_ddl_template()) = 0 then
    raise exception '0053 PRECONDITION FAILED: the template has no mail_messages. Apply 0039 first.';
  end if;
end
$$;

-- ============================================================
-- 2. THE DDL, WRITTEN ONCE
--
-- §3 (existing showrooms) and §4 (the template every future showroom is
-- built from) need the same text, differing only in whether {{SCHEMA}}
-- and {{ROLE}} stay literal. 0050's arrangement: hold the fragments in
-- one temp table, and let each section decide what to do with the
-- placeholders. Duplicating them would be how the two drift.
-- ============================================================
-- `on commit drop` clears this at the end of the transaction, which is the
-- whole story for a normal apply. The explicit drop is for the abnormal
-- one: running the file twice inside a SINGLE transaction — which is
-- exactly what a rollback-protected dry run does when it tests
-- idempotence — otherwise fails on "relation already exists" before
-- reaching any of the logic that is actually being tested.
drop table if exists felix_0053_ddl;
create temp table felix_0053_ddl (name text primary key, body text) on commit drop;

insert into felix_0053_ddl (name, body) values ('tables', $ddl$
-- ------------------------------------------------------------
-- 1-quinquies. TASKS (0053)
--
-- A TEMPLATE is policy — "every sales exec rings their pending
-- enquiries, daily". A TASK is a fact about one person on one day. They
-- are separate tables because "did Karim do it on the 14th" is a
-- question about the 14th, and a recurring rule has nowhere to put that
-- answer. See the migration header.
-- ------------------------------------------------------------
create table if not exists task_templates (
  id            uuid        primary key default gen_random_uuid(),
  title         text        not null,
  description   text,
  recurrence    text        not null check (recurrence in ('daily','weekly','monthly')),
  -- 0 = Sunday, matching extract(dow). Required for 'weekly'.
  weekday       int         check (weekday between 0 and 6),
  -- 1..28 only, and that is a CHECK rather than a convention: a monthly
  -- task due on the 31st would silently never fall due in February, and
  -- a recurring instruction that quietly skips a month is worse than
  -- one the form refused to accept.
  day_of_month  int         check (day_of_month between 1 and 28),
  -- null = every branch in the company. Only the CEO may write that;
  -- task_templates_insert is where that is enforced.
  branch_id     uuid        references branches(id),
  -- Exactly one of the two. A template aims either at a ROLE (everyone
  -- who is a sales exec in this branch) or at one NAMED person — never
  -- both, never neither.
  assignee_role text        check (assignee_role in ('ceo','accountant','branch_manager','sales_exec','marketing','hr')),
  assignee_id   uuid        references profiles(id),
  active        boolean     not null default true,
  created_by    uuid        references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid        references profiles(id),
  constraint task_templates_target_check check (
    (assignee_role is not null and assignee_id is null)
    or (assignee_role is null and assignee_id is not null)),
  constraint task_templates_weekly_check check (
    recurrence <> 'weekly' or weekday is not null),
  constraint task_templates_monthly_check check (
    recurrence <> 'monthly' or day_of_month is not null)
);

create index if not exists idx_task_templates_active on task_templates(active, recurrence);

-- One row per person per due day.
--
-- 'skipped' is the worker declining WITH A REASON and it is reported as
-- such; 'cancelled' is the manager withdrawing the instruction and is
-- excluded from the day's report entirely. Nothing is ever deleted —
-- assertion (j) refuses a DELETE grant to the tenant role regardless.
create table if not exists tasks (
  id              uuid        primary key default gen_random_uuid(),
  branch_id       uuid        references branches(id),
  assignee_id     uuid        not null references profiles(id) on delete cascade,
  title           text        not null,
  description     text,
  -- A day, not an instant. The showroom day ends when the person
  -- presses END DAY, and a hard-coded 17:00 would be wrong for every
  -- branch that closes at 21:00.
  due_on          date        not null,
  origin          text        not null default 'manual' check (origin in ('manual','recurring','lead')),
  template_id     uuid        references task_templates(id) on delete set null,
  lead_id         uuid        references leads(id) on delete cascade,
  status          text        not null default 'open' check (status in ('open','done','skipped','cancelled')),
  completed_at    timestamptz,
  completed_by    uuid        references profiles(id),
  completion_note text,
  created_by      uuid        references profiles(id),
  created_at      timestamptz not null default now()
);

create index if not exists idx_tasks_assignee_day on tasks(assignee_id, due_on);
create index if not exists idx_tasks_branch_day   on tasks(branch_id, due_on);

-- What makes materialise_tasks() idempotent: the tenth page load of the
-- morning inserts nothing.
--
-- NOT partial indexes, though template_id and lead_id are both nullable
-- and a partial one reads as the more precise statement. Two reasons,
-- and the second is the load-bearing one:
--   * Postgres treats NULLs as distinct in a unique index, so a manual
--     task (both columns null) is unconstrained either way — the WHERE
--     clause would buy nothing.
--   * ON CONFLICT can only INFER a partial index when the statement
--     repeats its predicate, which PostgREST cannot express. So a
--     partial index here would work for materialise_tasks() (plpgsql,
--     no target) and silently fail for the lead split, which goes
--     through supabase-js.
create unique index if not exists uniq_task_from_template
  on tasks(template_id, assignee_id, due_on);
-- One follow-up per enquiry per day, whoever it landed on. Without this
-- a manager pressing "split the leads" twice would double every
-- salesperson's list.
create unique index if not exists uniq_task_from_lead
  on tasks(lead_id, due_on);

-- What END DAY produced. One row per person per day, updatable by that
-- person alone: finishing a late task and pressing END DAY again must
-- correct the record rather than fail on a unique violation.
create table if not exists day_reports (
  id              uuid        primary key default gen_random_uuid(),
  profile_id      uuid        not null references profiles(id) on delete cascade,
  branch_id       uuid        references branches(id),
  day             date        not null,
  done_count      int         not null default 0,
  skipped_count   int         not null default 0,
  open_count      int         not null default 0,
  total_count     int         not null default 0,
  note            text,
  -- The mail that carried it, when there was one. Null is a real state:
  -- a showroom with nobody to report to still gets the record.
  mail_message_id uuid        references mail_messages(id) on delete set null,
  mail_status     text        check (mail_status in ('sent','skipped','failed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uniq_day_report unique (profile_id, day)
);

create index if not exists idx_day_reports_branch_day on day_reports(branch_id, day);
$ddl$);

insert into felix_0053_ddl (name, body) values ('functions', $ddl$
-- 0053. The recurrence rule, as one expression rather than as three
-- copies in the materialiser, the UI and whatever reads it next.
--
-- SECURITY INVOKER and naming nothing in schema auth, so it is exempt
-- from the inlining trap 0037 and 0045 exist to explain, and it does
-- not count toward assertion (f).
create or replace function task_template_due(
  p_recurrence text, p_weekday int, p_day_of_month int, p_day date
) returns boolean as $fn$
  select case p_recurrence
           when 'daily'   then true
           when 'weekly'  then p_weekday is not null
                               and extract(dow  from p_day)::int = p_weekday
           when 'monthly' then p_day_of_month is not null
                               and extract(day  from p_day)::int = p_day_of_month
           else false
         end;
$fn$ language sql immutable;

-- 0053. Turn every template that falls due on p_day into task rows.
--
-- SECURITY DEFINER because a salesperson cannot read a template aimed
-- at their colleague and cannot insert a row whose created_by is their
-- manager — and must still find today's work waiting for them. The gate
-- is inside the function, exactly as monthly_sales_units() (0049) does
-- it: you materialise for YOURSELF, a branch manager for the branches
-- can_read_branch() admits, the CEO for the company. An investor gets
-- nothing.
--
-- Idempotent by uniq_task_from_template, which is what lets the page
-- call it on every load instead of depending on a scheduler that does
-- not exist in this deployment.
--
-- The +/-7 day window is not a performance guard. It stops a client
-- from asking the database to invent a year of history nobody was ever
-- asked to do, and then reporting on it.
create or replace function materialise_tasks(p_day date)
returns int as $fn$
declare
  v_uid  uuid := auth.uid();
  v_role text := {{SCHEMA}}.current_role_name();
  v_n    int  := 0;
begin
  if v_uid is null or v_role is null or v_role = 'investor' then return 0; end if;

  if p_day < current_date - 7 or p_day > current_date + 7 then
    raise exception 'materialise_tasks: % is outside the seven-day window', p_day;
  end if;

  insert into {{SCHEMA}}.tasks
    (branch_id, assignee_id, title, description, due_on, origin, template_id, created_by)
  select p.branch_id, p.id, t.title, t.description, p_day, 'recurring', t.id, t.created_by
    from {{SCHEMA}}.task_templates t
    join {{SCHEMA}}.profiles p
      on (t.assignee_id is not null and p.id = t.assignee_id)
      -- A role template reaches everyone holding that role, confined to
      -- its branch when it names one. branch_id null is company-wide,
      -- and only a CEO can have written that.
      or (t.assignee_role is not null
          and p.role = t.assignee_role
          and (t.branch_id is null or p.branch_id = t.branch_id))
   where t.active
     and {{SCHEMA}}.task_template_due(t.recurrence, t.weekday, t.day_of_month, p_day)
     and p.role <> 'investor'
     and (
       p.id = v_uid
       or {{SCHEMA}}.is_ceo()
       or ({{SCHEMA}}.is_manager_or_above() and {{SCHEMA}}.can_read_branch(p.branch_id))
     )
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0053. The ONLY way a task's status changes.
--
-- tasks_update deliberately does not admit the assignee: they must be
-- able to tick their own task and must not be able to rewrite its
-- title, and a policy cannot express "this row but not those columns".
-- 0047 answered that with a guard trigger over an opened policy; this
-- answers it with a narrow RPC over a closed one, which is the better
-- shape here because there is exactly ONE legitimate edit a salesperson
-- makes to a task. A task whose wording changed after the fact would
-- make the end-of-day report a document about nothing.
--
-- 'cancelled' is the manager withdrawing an instruction, never the
-- worker's way out — that is 'skipped', which is reported rather than
-- hidden. A cancelled task does not come back: reopening it would let a
-- withdrawn instruction reappear in somebody's evening report.
create or replace function set_task_status(p_task_id uuid, p_status text, p_note text)
returns void as $fn$
declare
  v_uid  uuid := auth.uid();
  v_task record;
begin
  if v_uid is null then
    raise exception 'set_task_status: no session';
  end if;
  if p_status not in ('open','done','skipped','cancelled') then
    raise exception 'set_task_status: unknown status %', p_status;
  end if;

  select * into v_task from {{SCHEMA}}.tasks where id = p_task_id;
  if not found then
    raise exception 'set_task_status: no such task';
  end if;
  if v_task.status = 'cancelled' then
    raise exception 'set_task_status: a cancelled task cannot be reopened';
  end if;

  if p_status = 'cancelled' then
    if not ({{SCHEMA}}.is_ceo()
            or ({{SCHEMA}}.is_manager_or_above()
                and {{SCHEMA}}.can_act_on_branch(v_task.branch_id))) then
      raise exception 'set_task_status: only a manager may withdraw a task';
    end if;
  elsif not (
    v_task.assignee_id = v_uid
    or {{SCHEMA}}.is_ceo()
    or ({{SCHEMA}}.is_manager_or_above() and {{SCHEMA}}.can_act_on_branch(v_task.branch_id))
  ) then
    raise exception 'set_task_status: that task belongs to somebody else';
  end if;

  update {{SCHEMA}}.tasks
     set status          = p_status,
         completed_at    = case when p_status in ('done','skipped') then now() end,
         completed_by    = case when p_status = 'open' then null else v_uid end,
         completion_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_task_id;
end;
$fn$ language plpgsql security definer set search_path = {{SCHEMA}}, extensions;

-- 0053. Who the end-of-day report is addressed to.
--
-- profiles_select shows a sales exec exactly one row — their own — so
-- somebody pressing END DAY cannot name their own manager, let alone
-- the CEO, and the mail would have nowhere to go. Same construction as
-- calendar_invitable_people(): a definer returning four columns and
-- nothing else, for the company's CEOs and the managers of the CALLER'S
-- OWN branch. No wage, no roster, no colleague.
--
-- A manager pressing END DAY gets the CEOs and their fellow managers;
-- a CEO gets the other CEOs, or nobody, and the app files the report
-- without a mail rather than refusing to close the day.
create or replace function day_report_recipients()
returns table (id uuid, full_name text, mail_address text, role text) as $fn$
declare
  v_uid    uuid := auth.uid();
  v_role   text := {{SCHEMA}}.current_role_name();
  v_branch uuid := {{SCHEMA}}.current_branch_id();
begin
  if v_uid is null or v_role is null or v_role = 'investor' then return; end if;

  return query
  select p.id, p.full_name, p.mail_address, p.role
    from {{SCHEMA}}.profiles p
   where p.id <> v_uid
     and (
       p.role = 'ceo'
       or (p.role = 'branch_manager' and v_branch is not null and p.branch_id = v_branch)
     )
   order by p.role, p.full_name;
end;
$fn$ language plpgsql stable security definer set search_path = {{SCHEMA}}, extensions;
$ddl$);

insert into felix_0053_ddl (name, body) values ('rls', $ddl$alter table task_templates         enable row level security;
alter table tasks                  enable row level security;
alter table day_reports            enable row level security;$ddl$);

insert into felix_0053_ddl (name, body) values ('policies', $ddl$-- ------------------------------------------------------------
-- 5w. TASKS — 0053
--
-- TEMPLATES. Read by anyone a template can reach, which includes the
-- salesperson it aims at: a recurring duty nobody can look up is not an
-- instruction, it is a surprise in the evening report. Written by
-- is_ceo() or a branch manager over their own branch — and a
-- COMPANY-WIDE template (branch_id null) is the CEO's alone, since a
-- manager writing one would be reaching into branches they cannot
-- otherwise touch.
--
-- TASKS. A person sees their own, a manager their branch's, the CEO
-- everything — the same shape leads_select has had since 0001.
-- tasks_update deliberately does NOT admit the assignee: ticking goes
-- through set_task_status(), so that "done" is the only thing a
-- salesperson can change about the instruction they were given. The one
-- INSERT arm that is not a manager's is the personal to-do: your own
-- id, your own hand, in your own branch, and origin 'manual' so it can
-- never impersonate a recurring duty.
--
-- DAY REPORTS. Yours, your branch's if you manage it, everyone's if you
-- are the CEO. Written by you about you and nobody else — the row is
-- evidence, and evidence somebody else can author is not evidence.
-- UPDATE is admitted for exactly one reason: finishing a late task and
-- pressing END DAY again must correct the record rather than fail.
--
-- NO DELETE ANYWHERE, and §"grants" issues none. Assertion (j) would
-- refuse it regardless.
-- ------------------------------------------------------------
drop policy if exists "task_templates_select" on task_templates;
create policy "task_templates_select" on task_templates for select
  using (
    is_ceo()
    or (is_manager_or_above() and (branch_id is null or can_read_branch(branch_id)))
    or assignee_id = auth.uid()
    or (assignee_role is not null
        and assignee_role = current_role_name()
        and (branch_id is null or branch_id = current_branch_id()))
  );

drop policy if exists "task_templates_insert" on task_templates;
create policy "task_templates_insert" on task_templates for insert
  with check (
    is_ceo()
    or (is_manager_or_above() and branch_id is not null and can_act_on_branch(branch_id))
  );

drop policy if exists "task_templates_update" on task_templates;
create policy "task_templates_update" on task_templates for update
  using (
    is_ceo()
    or (is_manager_or_above() and branch_id is not null and can_act_on_branch(branch_id))
  )
  with check (
    is_ceo()
    or (is_manager_or_above() and branch_id is not null and can_act_on_branch(branch_id))
  );

drop policy if exists "tasks_select" on tasks;
create policy "tasks_select" on tasks for select
  using (
    is_ceo()
    or assignee_id = auth.uid()
    or (is_manager_or_above() and can_read_branch(branch_id))
  );

drop policy if exists "tasks_insert" on tasks;
create policy "tasks_insert" on tasks for insert
  with check (
    (is_manager_or_above() and can_act_on_branch(branch_id))
    or (assignee_id = auth.uid()
        and created_by = auth.uid()
        and origin = 'manual'
        and branch_id is not distinct from current_branch_id())
  );

drop policy if exists "tasks_update" on tasks;
create policy "tasks_update" on tasks for update
  using (is_ceo() or (is_manager_or_above() and can_act_on_branch(branch_id)))
  with check (is_ceo() or (is_manager_or_above() and can_act_on_branch(branch_id)));

drop policy if exists "day_reports_select" on day_reports;
create policy "day_reports_select" on day_reports for select
  using (
    profile_id = auth.uid()
    or is_ceo()
    or (is_manager_or_above() and can_read_branch(branch_id))
  );

drop policy if exists "day_reports_insert" on day_reports;
create policy "day_reports_insert" on day_reports for insert
  with check (profile_id = auth.uid());

drop policy if exists "day_reports_update" on day_reports;
create policy "day_reports_update" on day_reports for update
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
$ddl$);

insert into felix_0053_ddl (name, body) values ('triggers', $ddl$-- Who changed the standing instructions, and when. A recurring duty
-- quietly retired the week somebody stopped doing it is exactly the
-- kind of edit this table exists to catch.
--
-- tasks itself is NOT audited, deliberately: it would write a row for
-- every tick of every checkbox in the showroom, every day, and the task
-- row already carries completed_at and completed_by. day_reports is not
-- audited for the same reason it exists — it IS the record.
drop trigger if exists trg_audit_task_templates on task_templates;
create trigger trg_audit_task_templates
  after insert or update or delete on task_templates
  for each row execute function record_audit();
$ddl$);

-- ============================================================
-- 3. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Every anchor below is one migration 0049 introduced. That is not
-- laziness: anchoring on 0049 makes "this file lands after 0049" a
-- property the anchors themselves enforce, and 0050/0051/0052 touch
-- none of them.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int := 0;

  c_tbl_from text := $a1$  constraint uniq_bonus_rule_units       unique (min_units)
);$a1$;
  c_tbl_to   text;

  c_fn_from  text := $b1$-- 0049. How many cars each salesperson EXECUTED in a window.$b1$;
  c_fn_to    text;

  c_rls_from text := $c1$alter table bonus_rules            enable row level security;$c1$;
  c_rls_to   text;

  c_pol_from text := $d1$drop policy if exists "bonus_rules_select" on bonus_rules;$d1$;
  c_pol_to   text;

  c_trg_from text := $e1$drop trigger if exists trg_audit_bonus_rules on bonus_rules;$e1$;
  c_trg_to   text;

  c_gnt_from text := $f1$grant execute on function monthly_sales_units(timestamptz, timestamptz) to {{ROLE}};$f1$;
  c_gnt_to   text := $f2$grant execute on function monthly_sales_units(timestamptz, timestamptz) to {{ROLE}};

-- 0053. The task board: read and written under policy, never deleted.
grant select, insert, update on task_templates to {{ROLE}};
grant select, insert, update on tasks          to {{ROLE}};
grant select, insert, update on day_reports    to {{ROLE}};
grant select, insert, update, delete on task_templates to service_role;
grant select, insert, update, delete on tasks          to service_role;
grant select, insert, update, delete on day_reports    to service_role;
-- The four behind it. Each gates itself by role; these grants only say
-- a tenant session may ask.
grant execute on function task_template_due(text, int, int, date)  to {{ROLE}};
grant execute on function materialise_tasks(date)                  to {{ROLE}};
grant execute on function set_task_status(uuid, text, text)        to {{ROLE}};
grant execute on function day_report_recipients()                  to {{ROLE}};$f2$;
begin
  select c_tbl_from || E'\n' || body into c_tbl_to from felix_0053_ddl where name = 'tables';
  select body || E'\n' || c_fn_from  into c_fn_to  from felix_0053_ddl where name = 'functions';
  select c_rls_from || E'\n' || body into c_rls_to from felix_0053_ddl where name = 'rls';
  select body || E'\n' || c_pol_from into c_pol_to from felix_0053_ddl where name = 'policies';
  select body || E'\n' || c_trg_from into c_trg_to from felix_0053_ddl where name = 'triggers';

  -- The template's own line-ending convention decides every string's.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0 then chr(13) || chr(10) else chr(10) end;
  c_tbl_from := replace(replace(c_tbl_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_from  := replace(replace(c_fn_from,  chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_fn_to    := replace(replace(c_fn_to,    chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_from := replace(replace(c_trg_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_trg_to   := replace(replace(c_trg_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13)||chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13)||chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists tasks (' in v_tpl) > 0 then
    raise notice '0053: template already carries tasks — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0053: template anchor 3a (tables) did not match. Template drifted from 0049.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_fn_from, c_fn_to);
    if position(c_fn_to in v_tpl) = 0 then
      raise exception '0053: template anchor 3b (functions) did not match. Template drifted from 0049.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0053: template anchor 3c (rls) did not match. Template drifted from 0049.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0053: template anchor 3d (policies) did not match. Template drifted from 0049.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0053: template anchor 3e (audit trigger) did not match. Template drifted from 0049.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0053: template anchor 3f (grants) did not match. Template drifted from 0049.';
    end if;
    v_done := v_done + 1;

    -- Exactly one of each. A doubled anchor would have produced a
    -- template that fails at provision time, which is the worst place
    -- to discover it.
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists tasks (', ''))) <>
       length('create table if not exists tasks (') then
      raise exception '0053: the template does not carry exactly one tasks table.';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function materialise_tasks', ''))) <>
       length('create or replace function materialise_tasks') then
      raise exception '0053: the template does not carry exactly one materialise_tasks().';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function set_task_status', ''))) <>
       length('create or replace function set_task_status') then
      raise exception '0053: the template does not carry exactly one set_task_status().';
    end if;
    if (length(v_tpl) - length(replace(v_tpl, 'create or replace function day_report_recipients', ''))) <>
       length('create or replace function day_report_recipients') then
      raise exception '0053: the template does not carry exactly one day_report_recipients().';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0053$ select %L::text $felix_0053$', v_tpl);
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0053: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 4. AMEND EVERY EXISTING TENANT SCHEMA
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;
  v_ddl   text;
begin
  -- ORDER MATTERS, SO IT IS STATED. Tables before the policies and
  -- triggers that name them: string_agg without an ORDER BY is free to
  -- return the policies first, and CREATE POLICY on a relation that does
  -- not exist yet fails. Assembled once, outside the loop, because it is
  -- the same text for every showroom.
  select string_agg(body, E'\n' order by ord)
    into v_ddl
    from (
      select body, case name
                     when 'tables'    then 1
                     when 'functions' then 2
                     when 'rls'       then 3
                     when 'policies'  then 4
                     when 'triggers'  then 5
                   end as ord
        from felix_0053_ddl
       where name in ('tables','functions','rls','policies','triggers')
    ) s
   where s.ord is not null;

  if v_ddl is null then
    raise exception '0053: the DDL fragments are missing — section 2 did not run.';
  end if;

  for r in select schema_name, role_name from platform.tenants order by slug loop
    -- tasks points at leads and day_reports at mail_messages; a schema
    -- missing either is not fully provisioned and is skipped rather
    -- than half-built.
    if to_regclass(format('%I.leads', r.schema_name)) is null
       or to_regclass(format('%I.mail_messages', r.schema_name)) is null then
      raise notice '0053: %.leads or %.mail_messages missing — skipping (tenant not fully provisioned).',
        r.schema_name, r.schema_name;
      continue;
    end if;

    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute replace(v_ddl, '{{SCHEMA}}', quote_ident(r.schema_name));

    execute format('grant select, insert, update on %I.task_templates to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update on %I.tasks          to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update on %I.day_reports    to %I', r.schema_name, r.role_name);
    execute format('grant select, insert, update, delete on %I.task_templates to service_role', r.schema_name);
    execute format('grant select, insert, update, delete on %I.tasks          to service_role', r.schema_name);
    execute format('grant select, insert, update, delete on %I.day_reports    to service_role', r.schema_name);
    execute format('revoke all on table %I.task_templates from public, anon, authenticated', r.schema_name);
    execute format('revoke all on table %I.tasks          from public, anon, authenticated', r.schema_name);
    execute format('revoke all on table %I.day_reports    from public, anon, authenticated', r.schema_name);

    execute format('grant execute on function %I.task_template_due(text, int, int, date) to %I',
                   r.schema_name, r.role_name);
    execute format('grant execute on function %I.materialise_tasks(date) to %I',
                   r.schema_name, r.role_name);
    execute format('grant execute on function %I.set_task_status(uuid, text, text) to %I',
                   r.schema_name, r.role_name);
    execute format('grant execute on function %I.day_report_recipients() to %I',
                   r.schema_name, r.role_name);

    v_count := v_count + 1;
    raise notice '0053: % amended.', r.schema_name;
  end loop;

  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0053: % tenant schema(s) carry a task board.', v_count;
end
$mig$;

-- ============================================================
-- 5. RAISE ASSERTION (f) IN create_tenant_schema()
--
-- This migration adds THREE SECURITY DEFINER functions
-- (materialise_tasks, set_task_status, day_report_recipients).
-- task_template_due() is SECURITY INVOKER and does not count.
--
-- The number is MEASURED, not arithmetic. 0050's header explains why a
-- constant is wrong here — this database has moved past what the
-- migration history reads as, and 0048's hard-coded "expected 22" was
-- already stale when it ran. Measuring also makes this section
-- idempotent for free: a second run of the whole file measures the same
-- schemas and writes the same number, where "read the old value and add
-- three" would climb by three every time.
-- ============================================================
do $mig$
declare
  v_src  text;
  v_old  int;
  v_new  int;
  v_vals int[];
begin
  select p.prosrc into v_src
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'platform' and p.proname = 'create_tenant_schema';

  if v_src is null then
    raise exception '0053: platform.create_tenant_schema() not found.';
  end if;

  v_old := (regexp_match(v_src, 'expected (\d+) SECURITY DEFINER functions'))[1]::int;
  if v_old is null then
    raise exception '0053: create_tenant_schema() carries no "expected N SECURITY DEFINER functions" assertion.';
  end if;

  -- Every amended schema, and they must all agree. A tenant that
  -- disagrees is drift this file must not paper over.
  select array_agg(distinct n) into v_vals from (
    select (select count(*)::int
              from pg_proc p2
              join pg_namespace ns2 on ns2.oid = p2.pronamespace
             where ns2.nspname = t.schema_name and p2.prosecdef) as n
      from platform.tenants t
     where to_regprocedure(format('%I.materialise_tasks(date)', t.schema_name)) is not null
  ) s;

  if v_vals is null then
    -- No provisioned tenant to measure — a bare platform install. Fall
    -- back to arithmetic, which is the only thing left, and note it.
    v_new := v_old + 3;
    raise notice '0053: no provisioned tenant to measure; asserting % by arithmetic.', v_new;
  elsif array_length(v_vals, 1) <> 1 then
    raise exception
      '0053: tenant schemas disagree on their SECURITY DEFINER count (%). Resolve the drift before asserting one number.',
      array_to_string(v_vals, ', ');
  else
    v_new := v_vals[1];
  end if;

  if v_new = v_old then
    raise notice '0053: create_tenant_schema() already asserts % — skipping.', v_new;
  else
    -- MEASURING ALONE IS NOT ENOUGH, and this cross-check is why.
    --
    -- A measured count says what the schema carries; it does not say
    -- that the difference is THIS file's doing. Three sessions have
    -- written migrations against this database in one day (the count
    -- went 22 -> 31 in that window), so if somebody else's functions
    -- land between §4 and here, a pure measure would quietly bless
    -- their number as ours and the next drift would have no baseline
    -- left to detect it from. This migration adds exactly three
    -- definers — materialise_tasks, set_task_status and
    -- day_report_recipients — and if the schema disagrees, something
    -- other than 0053 moved and a human should look before the
    -- provisioner is rewritten.
    --
    -- Placed AFTER the equality skip on purpose: a second run measures
    -- old = new and returns above without ever reaching this.
    if v_vals is not null and v_new <> v_old + 3 then
      raise exception
        '0053: expected % SECURITY DEFINER functions after this migration (% + 3) but the schemas carry %. Something other than 0053 changed the function set — check before rewriting create_tenant_schema().',
        v_old + 3, v_old, v_new;
    end if;

    v_src := regexp_replace(v_src, 'expected \d+ SECURITY DEFINER functions',
                            format('expected %s SECURITY DEFINER functions', v_new), 'g');
    v_src := regexp_replace(v_src, 'if n <> \d+ then',
                            format('if n <> %s then', v_new), 'g');

    execute format(
      'create or replace function platform.create_tenant_schema(p_slug text) returns text '
      'language plpgsql security definer set search_path = pg_catalog, platform as %L',
      v_src
    );
    raise notice '0053: platform.create_tenant_schema() now asserts % SECURITY DEFINER functions (was %).',
      v_new, v_old;
  end if;
end
$mig$;

-- ============================================================
-- 6. BACKFILL
--
-- None, and deliberately. A task nobody at the showroom agreed to would
-- appear in somebody's evening report as work they ignored. The board
-- starts empty and the page says so.
-- ============================================================

-- ============================================================
-- 7. SELF-VERIFY
-- ============================================================
do $$
declare
  r        record;
  v_bad    text[] := '{}';
  v_assert int;
  n        int;
begin
  v_assert := (regexp_match(
    (select p.prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'platform' and p.proname = 'create_tenant_schema'),
    'expected (\d+) SECURITY DEFINER functions'))[1]::int;

  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.leads', r.schema_name)) is null
       or to_regclass(format('%I.mail_messages', r.schema_name)) is null then
      continue;
    end if;


    -- (a) the three tables exist and every one of them has RLS on.
    if to_regclass(format('%I.task_templates', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (task_templates missing)');
      continue;
    end if;
    if to_regclass(format('%I.tasks', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (tasks missing)');
      continue;
    end if;
    if to_regclass(format('%I.day_reports', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (day_reports missing)');
      continue;
    end if;

    select count(*) into n
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name
       and c.relname in ('task_templates','tasks','day_reports')
       and c.relrowsecurity;
    if n <> 3 then
      v_bad := v_bad || format('%s (%s of 3 task tables have RLS enabled)', r.schema_name, n);
    end if;

    -- (b) the idempotence indexes. Without these, materialise_tasks()
    --     duplicates every task on every page load, which is the single
    --     worst failure this feature has.
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'uniq_task_from_template'
    ) then
      v_bad := v_bad || (r.schema_name || ' (uniq_task_from_template missing)');
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'uniq_task_from_lead'
    ) then
      v_bad := v_bad || (r.schema_name || ' (uniq_task_from_lead missing)');
    end if;

    -- (c) the three definers exist, are definers, and pin search_path.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name
       and p.proname in ('materialise_tasks','set_task_status','day_report_recipients')
       and p.prosecdef
       and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                    where cfg like 'search_path=%');
    if n <> 3 then
      v_bad := v_bad || format('%s (%s of 3 task RPCs are pinned SECURITY DEFINER)', r.schema_name, n);
    end if;

    -- (d) 0037/0045's trap, checked for the one invoker this file adds.
    if exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = r.schema_name and p.proname = 'task_template_due'
         and not p.prosecdef and p.prosrc ~ '\mauth\s*\.'
    ) then
      v_bad := v_bad || (r.schema_name || ' (task_template_due is INVOKER and names schema auth)');
    end if;

    -- (e) the tenant role may ask, and may not erase.
    if not has_function_privilege(r.role_name,
         format('%I.materialise_tasks(date)', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (tenant role cannot execute materialise_tasks)');
    end if;
    if not has_function_privilege(r.role_name,
         format('%I.set_task_status(uuid, text, text)', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (tenant role cannot execute set_task_status)');
    end if;
    if not has_function_privilege(r.role_name,
         format('%I.day_report_recipients()', r.schema_name), 'execute') then
      v_bad := v_bad || (r.schema_name || ' (tenant role cannot execute day_report_recipients)');
    end if;
    if has_table_privilege(r.role_name, format('%I.tasks', r.schema_name), 'delete')
       or has_table_privilege(r.role_name, format('%I.task_templates', r.schema_name), 'delete')
       or has_table_privilege(r.role_name, format('%I.day_reports', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (tenant role holds DELETE on a task table)');
    end if;

    -- (f) and the count create_tenant_schema() will assert on the next
    --     provision matches what this schema actually carries.
    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.schema_name and p.prosecdef;
    if n <> v_assert then
      v_bad := v_bad || format('%s (%s SECURITY DEFINER functions, create_tenant_schema asserts %s)',
                               r.schema_name, n, v_assert);
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0053 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists tasks (' in platform.tenant_ddl_template()) = 0 then
    raise exception '0053 VERIFY FAILED: template does not carry the tasks table.';
  end if;
  if position('create or replace function materialise_tasks' in platform.tenant_ddl_template()) = 0 then
    raise exception '0053 VERIFY FAILED: template does not carry materialise_tasks().';
  end if;
  if position('grant execute on function day_report_recipients()' in platform.tenant_ddl_template()) = 0 then
    raise exception '0053 VERIFY FAILED: template does not grant day_report_recipients().';
  end if;

  raise notice '0053: verified — every showroom has a task board, and nobody can tick somebody else''s.';
end
$$;

commit;

notify pgrst, 'reload schema';
