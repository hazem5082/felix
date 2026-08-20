-- ============================================================
-- 0034 — ETA SUBMISSIONS: THE QUEUE AND THE AUDIT OF WHAT WE FILED
--
-- 0024 added four slots on `contracts` for the identifiers the ETA
-- portal issues, and its header was explicit about what it was not
-- doing: "actual ETA API integration is out of scope (the showroom
-- submits on the ETA portal by hand and transcribes the identifiers
-- here)". Decision 281/2025 removed the option. Every business over
-- EGP 250,000 of revenue must e-invoice, B2C e-receipts are mandatory
-- per branch per POS, and the penalty is EGP 20,000 plus 1,000 a day.
-- A ten-branch group transcribing UUIDs by hand is ten places to be
-- late, and no way to prove afterwards that it was not.
--
-- So FELIX now submits. This migration is the record of that: one row
-- per ATTEMPT, carrying the document that was sent, the answer that came
-- back, and — crucially — WHICH AUTHORITY IT WAS SENT TO.
--
-- WHY A TABLE AND NOT FOUR MORE COLUMNS ON `contracts`
-- ---------------------------------------------------
-- 0024's columns answer "what is the identifier of this sale's
-- e-invoice", which is a property of the sale and rightly lives beside
-- `serial`. This table answers a different question — "what did we send,
-- when, by whom, and what did they say" — and that one is a history, not
-- a value. Three things follow from it being a history:
--
--   * A rejected filing must survive the corrected one. Squashed into
--     columns, a re-submission overwrites the evidence of the first
--     attempt, which is precisely the evidence an auditor asks for.
--   * The request payload has to be kept verbatim. `request_payload`
--     is the exact JSON that went to the authority; without it,
--     "we filed the right numbers" is a claim rather than a fact.
--   * `mode` has to be recorded per attempt, not per deployment. A
--     submission accepted by the sandbox and one accepted by the
--     authority look identical in every field except this one, and a
--     year from now nobody will remember which mode the showroom was
--     running in March.
--
-- 0024's columns are still filled — by the service, through the same
-- session, on acceptance — so the existing panel, the printed contract's
-- ETA footer and any report reading `contracts.eta_uuid` keep working
-- unchanged. This table is added beside them, not instead of them.
--
-- THE UNIQUE INDEX, AND WHAT "NON-FAILED" MEANS
-- ---------------------------------------------
--   uniq_eta_submission_live: one row per contract among the statuses
--   'queued', 'submitted' and 'accepted'.
--
-- Read it as three separate guarantees:
--
--   accepted   A sale has ONE e-invoice. ETA documents are immutable
--              once accepted; the remedy for a wrong one is a credit
--              note, which is a different document type against a
--              different sale, not a second invoice for this one. So an
--              accepted row permanently closes the contract to further
--              submissions, and that is intended.
--   queued /   An attempt in flight blocks a second one. Two accountants
--   submitted  on the same ticket, or one impatient double-click, would
--              otherwise file the same sale twice — and ETA would accept
--              both, because they are two documents with two internal
--              IDs as far as it can tell. The database refuses the
--              second insert (23505) and the action says so in words.
--
--   rejected / Excluded from the index, so a corrected re-submission is
--   failed     an ordinary insert. This is the ONLY way a contract gets
--              a second attempt, and it is deliberate: something must
--              have gone wrong, and the previous row stays to say what.
--
-- `failed` and `rejected` are not the same event and the distinction is
-- load-bearing. `rejected` means the authority (or the sandbox
-- validator) looked at the document and refused it — the data is wrong.
-- `failed` means the attempt never got an answer: signing was not
-- configured, the transport threw, the document failed our own
-- pre-flight. One is a bookkeeping problem, the other an operations
-- problem, and an accountant staring at the timeline needs to know
-- which.
--
-- THE AUDIT TRIGGER COPIES THE PAYLOADS, AND THAT IS ACCEPTED
-- ------------------------------------------------------------
-- record_audit() writes before_data/after_data as whole rows, so every
-- status change on a submission copies request_payload and
-- response_payload into audit_log again. One vehicle invoice is a single
-- line item — a few kilobytes — and a submission moves through at most
-- three updates, so the cost is tens of kilobytes per sale against a
-- table that already records every price change on every ticket. It is
-- worth naming because the shape does not generalise: a future batch
-- submission carrying fifty documents in one payload would want the
-- payload columns moved to a child table, or the trigger narrowed to the
-- status columns. At one document per row it is the wrong optimisation.
--
-- NO DELETE — GRANT OR POLICY
-- ---------------------------
-- §6f of 0009 grants DELETE on nothing and assertion (j) inside
-- platform.create_tenant_schema() PROVES it: a tenant role holding
-- delete on any relation aborts provisioning. Granting DELETE here would
-- break every new showroom's creation, in a file that never mentions
-- eta_submissions. It is also the right design independently — a tax
-- filing record that the filer can erase is not a record. service_role
-- keeps delete, as 0031 §2 gives customers, for the seed/demo scripts
-- and the operator's data-repair path.
--
-- NO NEW SECURITY DEFINER FUNCTIONS. Assertion (f) requires EXACTLY
-- twenty per schema and 0030's header explains at length why that count
-- is not worth rewriting a 300-line function to change. The branch
-- predicate below is therefore the ordinary can_read_branch() call every
-- other child table makes, and there is no eta_* helper.
--
-- VISIBILITY, AND WHY IT IS NOT THE PARENT'S
-- ------------------------------------------
-- 0016's lead_vehicle_interests copies its parent lead's visibility
-- exactly. This table deliberately does not copy `contracts_select`,
-- which admits the SALESPERSON who owns the ticket. A salesperson has no
-- business in the tax-filing trail: it carries the buyer's national ID,
-- the exact VAT position of the sale and the authority's complaints
-- about both. So:
--
--   select  is_accountant_or_above() org-wide (the CEO and the
--           accountant, who own the filing), OR a branch manager over
--           their own branches — via the TICKET's branch_id and
--           can_read_branch(), which 0030 widened to include grants, so
--           an area manager sees every branch they were granted.
--   insert  is_accountant_or_above(), with created_by pinned to
--           auth.uid() the way employee_targets.set_by and
--           vehicle_listings.posted_by are, and with contract_id and
--           deal_ticket_id required to name the SAME deal — a row
--           pairing one sale's contract with another's ticket would
--           corrupt the trail in a way no later query could detect.
--   update  is_accountant_or_above(), USING and WITH CHECK. The service
--           walks one row through queued -> submitted -> accepted, and
--           the WITH CHECK stops a row from being re-pointed at a
--           contract the caller could not have inserted against.
--
-- STRUCTURE MIRRORS 0031/0030/0016 — template + live loop, anchored and
-- verified substitutions, per-tenant search_path in §3 because policy
-- expressions, FK targets and the triggers' functions are resolved and
-- frozen at CREATE time. Idempotent: re-running is safe.
--
-- LINE ENDINGS: the anchors are authored with LF; the stored template is
-- whatever the client that applied 0009 sent (CRLF, in the live
-- database). §2 normalises every anchor AND every replacement to the
-- template's own convention before touching it — see 0030's header for
-- the full argument.
--
-- ORDERING: gated on 0031 (the migration immediately before this one)
-- and on 0024, whose spliced text three of the five anchors are written
-- against.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0034 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  if to_regclass('platform.tenants') is null then
    raise exception
      '0034 PRECONDITION FAILED: platform.tenants does not exist. Apply 0008 first.';
  end if;

  -- Anchors 2a, 2c and 2e are 0024's own spliced text, byte for byte.
  if position('  eta_uuid              text,' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0034 PRECONDITION FAILED: the template has no contracts.eta_* columns. Apply 0024 first.';
  end if;

  -- Batch-ordering gate on the migration immediately before this one.
  -- 0034 needs nothing from 0031 — none of the anchors overlap, and no
  -- policy here names customers — but a template amended out of order is
  -- a template nobody can reason about afterwards, so a database that
  -- skipped it fails here rather than three anchors deep with a
  -- misleading message about drift.
  if position('create table if not exists customers' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0034 PRECONDITION FAILED: the template has no customers. Apply 0031 first.';
  end if;
end
$$;

-- ============================================================
-- 2. AMEND THE TEMPLATE — showrooms not yet provisioned
--
-- Five anchors. The table goes in FIRST, immediately after 0024's
-- partial unique index on contracts — which is the tail of the contracts
-- section — because eta_submissions' foreign keys name contracts,
-- deal_tickets and profiles, and Postgres resolves an FK target at
-- CREATE time. deal_tickets and profiles are declared long before
-- contracts, so anchoring on the contracts tail satisfies all three.
--
-- The trigger anchor is in the audit-trigger block, which the template
-- places BEFORE the RLS and policy sections; the order of the five
-- substitutions in this file is table -> triggers -> RLS -> policies ->
-- grants, matching the template's own layout.
-- ============================================================
do $mig$
declare
  v_tpl  text := platform.tenant_ddl_template();
  v_nl   text;
  v_done int  := 0;

  -- None of these is `constant`: every one is rewritten into the
  -- template's own line-ending convention before it is used.

  -- 2a. the table, after 0024's contracts index.
  c_tbl_from text := $k1$create unique index if not exists uniq_contracts_eta_uuid
  on contracts(eta_uuid) where eta_uuid is not null;$k1$;
  c_tbl_to   text := $k2$create unique index if not exists uniq_contracts_eta_uuid
  on contracts(eta_uuid) where eta_uuid is not null;

-- ------------------------------------------------------------
-- 12-bis. ETA SUBMISSIONS  (0034)
--
-- One row per attempt to file this sale's e-invoice with the Egyptian
-- Tax Authority. 0024's columns on `contracts` hold the ANSWER; this
-- holds the attempt, the document, and which authority answered.
--
-- mode              'mock' files nothing and exists so the pipeline can
--                   be demonstrated end to end without credentials;
--                   'preprod' is ETA's sandbox; 'production' is the
--                   authority. Recorded per row because a year from now
--                   nothing else distinguishes the three.
-- request_payload   the exact ETA document JSON that was sent. Kept
--                   verbatim: "we filed the right numbers" is only a
--                   fact if the numbers are still here.
-- response_payload  the authority's answer, likewise verbatim.
-- warnings          issue codes from the builder (lib/eta/document.ts),
--                   e.g. placeholderItemCode — the sale was filed with a
--                   substituted product code because 0026's item_code
--                   was null. NOT NULL default '{}' so no read site
--                   needs a coalesce.
-- attempt           1 for the first, 2 for the first re-submission after
--                   a rejection, and so on. A label on the trail; the
--                   unique index below is what actually serialises them.
-- ------------------------------------------------------------
create table if not exists eta_submissions (
  id                uuid        primary key default gen_random_uuid(),
  contract_id       uuid        not null references contracts(id) on delete cascade,
  deal_ticket_id    uuid        not null references deal_tickets(id) on delete cascade,
  status            text        not null default 'queued',
  mode              text        not null,
  request_payload   jsonb,
  response_payload  jsonb,
  eta_submission_id text,
  eta_uuid          text,
  eta_long_id       text,
  error_detail      text,
  warnings          text[]      not null default '{}',
  attempt           int         not null default 1,
  created_by        uuid        references profiles(id),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  constraint eta_submissions_status_check check (
    status in ('queued','submitted','accepted','rejected','failed')
  ),
  constraint eta_submissions_mode_check check (
    mode in ('mock','preprod','production')
  ),
  constraint eta_submissions_attempt_check check (attempt > 0)
);

create index if not exists idx_eta_submissions_contract on eta_submissions(contract_id);
create index if not exists idx_eta_submissions_ticket   on eta_submissions(deal_ticket_id);
create index if not exists idx_eta_submissions_created  on eta_submissions(created_at desc);

-- ONE LIVE SUBMISSION PER CONTRACT. 'accepted' is inside the predicate
-- on purpose: a sale has one e-invoice, ETA documents are immutable once
-- accepted, and the remedy for a wrong one is a credit note rather than
-- a second invoice. 'rejected' and 'failed' are outside it, which is the
-- only way a contract ever gets a second attempt. See the file header.
create unique index if not exists uniq_eta_submission_live
  on eta_submissions(contract_id)
  where status in ('queued','submitted','accepted');$k2$;

  -- 2b. the triggers, after financing_requests' audit trigger. Both are
  --     needed: updated_at is how the timeline renders the moment the
  --     verdict landed as distinct from the moment it was sent, and the
  --     audit trigger is what makes a hand-edited status visible.
  c_trg_from text := $k3$drop trigger if exists trg_audit_financing_requests on financing_requests;
create trigger trg_audit_financing_requests
  after insert or update or delete on financing_requests
  for each row execute function record_audit();$k3$;
  c_trg_to   text := $k4$drop trigger if exists trg_audit_financing_requests on financing_requests;
create trigger trg_audit_financing_requests
  after insert or update or delete on financing_requests
  for each row execute function record_audit();

-- eta_submissions (0034). A row walks queued -> submitted -> accepted
-- within one request, and updated_at is the only column that says when
-- the last of those happened.
drop trigger if exists trg_eta_submissions_updated_at on eta_submissions;
create trigger trg_eta_submissions_updated_at
  before update on eta_submissions
  for each row execute function set_updated_at();

drop trigger if exists trg_audit_eta_submissions on eta_submissions;
create trigger trg_audit_eta_submissions
  after insert or update or delete on eta_submissions
  for each row execute function record_audit();$k4$;

  -- 2c. RLS
  c_rls_from text := $k5$alter table contracts              enable row level security;$k5$;
  c_rls_to   text := $k6$alter table contracts              enable row level security;
alter table eta_submissions        enable row level security;$k6$;

  -- 2d. the policies, after 0024's contracts_eta_update.
  c_pol_from text := $k7$drop policy if exists "contracts_eta_update" on contracts;
create policy "contracts_eta_update" on contracts for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());$k7$;
  c_pol_to   text := $k8$drop policy if exists "contracts_eta_update" on contracts;
create policy "contracts_eta_update" on contracts for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());

-- ------------------------------------------------------------
-- 5o-bis. ETA SUBMISSIONS — 0034
--
-- DELIBERATELY NARROWER THAN contracts_select, which admits the
-- salesperson who owns the ticket. This trail carries the buyer's
-- national ID, the exact VAT position of the sale and the authority's
-- complaints about both; it is the accountant's file, and a branch
-- manager's for their own branches.
--
-- The branch predicate goes through the TICKET, because that is where
-- branch_id lives (contracts has none), and it uses can_read_branch()
-- rather than a comparison against current_branch_id() so that 0030's
-- grants widen it exactly as they widen everything else.
--
-- NO DELETE POLICY, and §6d withholds the grant besides. A tax filing
-- record the filer can erase is not a record.
-- ------------------------------------------------------------
drop policy if exists "eta_submissions_select" on eta_submissions;
create policy "eta_submissions_select" on eta_submissions for select
  using (
    is_accountant_or_above()
    or exists (
      select 1 from deal_tickets t where t.id = eta_submissions.deal_ticket_id
      and is_manager_or_above() and can_read_branch(t.branch_id)));

-- created_by pinned to the caller, as employee_targets.set_by and
-- vehicle_listings.posted_by are. The contract/ticket agreement check is
-- the one integrity rule no later query could recover: a row naming one
-- sale's contract and another's ticket is silently wrong forever.
drop policy if exists "eta_submissions_insert" on eta_submissions;
create policy "eta_submissions_insert" on eta_submissions for insert
  with check (
    is_accountant_or_above()
    and created_by = auth.uid()
    and exists (
      select 1 from contracts c
       where c.id = eta_submissions.contract_id
         and c.deal_ticket_id = eta_submissions.deal_ticket_id));

-- USING **and** WITH CHECK: the service walks one row through its
-- statuses, and without the WITH CHECK a visible row could be re-pointed
-- at a contract the caller was never able to insert against.
drop policy if exists "eta_submissions_update" on eta_submissions;
create policy "eta_submissions_update" on eta_submissions for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());$k8$;

  -- 2e. the grants, after 0024's column-limited contracts UPDATE.
  c_gnt_from text := $k9$grant update (eta_uuid, eta_long_id, eta_submission_status, eta_submitted_at)
  on contracts to {{ROLE}};$k9$;
  c_gnt_to   text := $p1$grant update (eta_uuid, eta_long_id, eta_submission_status, eta_submitted_at)
  on contracts to {{ROLE}};

-- lib/eta/service.ts inserts one row per submission attempt and updates
-- it as the attempt progresses. No DELETE for the tenant role — §6f
-- grants it on nothing and assertion (j) proves it; see the policy note
-- above for why that is also the right design here.
grant select, insert, update on eta_submissions to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on eta_submissions to service_role;$p1$;
begin
  -- The template's own line-ending convention decides the anchors'. Each
  -- string is flattened to LF first — the operator's runbook converts
  -- this whole FILE to CRLF before applying it, so the anchors can
  -- arrive either way — and then rewritten in the template's convention.
  -- Same shape as 0030 §2 and 0031 §2.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_tbl_from := replace(replace(c_tbl_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to   := replace(replace(c_tbl_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_from := replace(replace(c_trg_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_to   := replace(replace(c_trg_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from := replace(replace(c_rls_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to   := replace(replace(c_rls_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_from := replace(replace(c_pol_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_to   := replace(replace(c_pol_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from := replace(replace(c_gnt_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to   := replace(replace(c_gnt_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists eta_submissions' in v_tpl) > 0 then
    raise notice '0034: template already carries eta_submissions — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0034: template anchor 2a (eta_submissions table) did not match. Template drifted from 0024.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0034: template anchor 2b (triggers) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0034: template anchor 2c (rls) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0034: template anchor 2d (policies) did not match. Template drifted from 0024.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0034: template anchor 2e (grants) did not match. Template drifted from 0024.';
    end if;
    v_done := v_done + 1;

    -- Every anchor above is a prefix of its replacement, so `replace`
    -- would fire twice if the template ever carried two copies of one.
    -- 42 = length('create table if not exists eta_submissions').
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists eta_submissions', ''))) <> 42 then
      raise exception '0034: the template carries more than one eta_submissions table.';
    end if;
    -- 27 = length('alter table eta_submissions'). Counted separately
    -- because the RLS line lands in a different section from the table
    -- and a duplicate there would be a second `enable row level
    -- security` that nothing else would notice.
    if (length(v_tpl) - length(replace(v_tpl, 'alter table eta_submissions', ''))) <> 27 then
      raise exception '0034: the template carries more than one eta_submissions RLS line.';
    end if;

    -- `set search_path = pg_catalog` carried over verbatim from 0009;
    -- the PUBLIC revoke is re-issued rather than assumed, as in 0031.
    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0034$ select %L::text $felix_0034$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0034: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0031 §3:
-- the FK targets, the policy expressions and the triggers' functions are
-- resolved and frozen HERE, and each showroom's must bind to its own
-- is_accountant_or_above(), its own can_read_branch(), its own
-- set_updated_at(), its own record_audit().
--
-- The CHECK constraints are dropped-then-added rather than probed, for
-- 0018's reason: conname is not database-unique, so an EXISTS check
-- without a schema qualifier silently skips every tenant after the
-- first. Drop-then-add converges on a re-run instead.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_ddl constant text := $ddl$
create table if not exists eta_submissions (
  id                uuid        primary key default gen_random_uuid(),
  contract_id       uuid        not null references contracts(id) on delete cascade,
  deal_ticket_id    uuid        not null references deal_tickets(id) on delete cascade,
  status            text        not null default 'queued',
  mode              text        not null,
  request_payload   jsonb,
  response_payload  jsonb,
  eta_submission_id text,
  eta_uuid          text,
  eta_long_id       text,
  error_detail      text,
  warnings          text[]      not null default '{}',
  attempt           int         not null default 1,
  created_by        uuid        references profiles(id),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

alter table eta_submissions drop constraint if exists eta_submissions_status_check;
alter table eta_submissions add constraint eta_submissions_status_check check (
  status in ('queued','submitted','accepted','rejected','failed')
);

alter table eta_submissions drop constraint if exists eta_submissions_mode_check;
alter table eta_submissions add constraint eta_submissions_mode_check check (
  mode in ('mock','preprod','production')
);

alter table eta_submissions drop constraint if exists eta_submissions_attempt_check;
alter table eta_submissions add constraint eta_submissions_attempt_check check (attempt > 0);

create index if not exists idx_eta_submissions_contract on eta_submissions(contract_id);
create index if not exists idx_eta_submissions_ticket   on eta_submissions(deal_ticket_id);
create index if not exists idx_eta_submissions_created  on eta_submissions(created_at desc);

create unique index if not exists uniq_eta_submission_live
  on eta_submissions(contract_id)
  where status in ('queued','submitted','accepted');

alter table eta_submissions enable row level security;

drop policy if exists "eta_submissions_select" on eta_submissions;
create policy "eta_submissions_select" on eta_submissions for select
  using (
    is_accountant_or_above()
    or exists (
      select 1 from deal_tickets t where t.id = eta_submissions.deal_ticket_id
      and is_manager_or_above() and can_read_branch(t.branch_id)));

drop policy if exists "eta_submissions_insert" on eta_submissions;
create policy "eta_submissions_insert" on eta_submissions for insert
  with check (
    is_accountant_or_above()
    and created_by = auth.uid()
    and exists (
      select 1 from contracts c
       where c.id = eta_submissions.contract_id
         and c.deal_ticket_id = eta_submissions.deal_ticket_id));

drop policy if exists "eta_submissions_update" on eta_submissions;
create policy "eta_submissions_update" on eta_submissions for update
  using (is_accountant_or_above())
  with check (is_accountant_or_above());

drop trigger if exists trg_eta_submissions_updated_at on eta_submissions;
create trigger trg_eta_submissions_updated_at
  before update on eta_submissions
  for each row execute function set_updated_at();

drop trigger if exists trg_audit_eta_submissions on eta_submissions;
create trigger trg_audit_eta_submissions
  after insert or update or delete on eta_submissions
  for each row execute function record_audit();
$ddl$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- contracts is the FK's target and the table this migration hangs
    -- off; its absence tells a half-provisioned tenant from a complete
    -- one.
    if to_regclass(format('%I.contracts', r.schema_name)) is null then
      raise notice '0034: %.contracts missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- §6b's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards — these three statements are
    -- what makes the table reachable, and by exactly whom. No DELETE for
    -- the tenant role; see the policy note in §2.
    execute format(
      'grant select, insert, update on %I.eta_submissions to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.eta_submissions to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.eta_submissions from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0034: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0034: % tenant schema(s) carry eta_submissions.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — structure, the unique index's exact predicate,
-- isolation, lockdown, and that every policy bound to THIS schema's
-- predicates rather than to whichever schema the session was sitting in.
-- ============================================================
do $$
declare
  r       record;
  v_bad   text[] := '{}';
  v_priv  text;
  v_trg   text;
  v_con   text;
  v_pred  text;
  n       int;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.contracts', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.eta_submissions', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    -- The three CHECKs. A missing status CHECK would let the service
    -- write a state the panel cannot render; a missing mode CHECK would
    -- let a sandbox row claim to be a production filing.
    foreach v_con in array array[
      'eta_submissions_status_check',
      'eta_submissions_mode_check',
      'eta_submissions_attempt_check'
    ] loop
      if not exists (
        select 1
          from pg_constraint c
          join pg_class t      on t.oid = c.conrelid
          join pg_namespace ns on ns.oid = t.relnamespace
         where ns.nspname = r.schema_name and t.relname = 'eta_submissions'
           and c.conname = v_con and c.contype = 'c'
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_con);
      end if;
    end loop;

    -- Both FKs, not just the columns: an unconstrained uuid would let a
    -- submission point at another schema's contract, or at nothing.
    foreach v_con in array array[
      'eta_submissions_contract_id_fkey',
      'eta_submissions_deal_ticket_id_fkey'
    ] loop
      if not exists (
        select 1
          from pg_constraint c
          join pg_class t      on t.oid = c.conrelid
          join pg_namespace ns on ns.oid = t.relnamespace
         where ns.nspname = r.schema_name and t.relname = 'eta_submissions'
           and c.conname = v_con and c.contype = 'f'
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_con);
      end if;
    end loop;

    -- THE UNIQUE INDEX, AND ITS PREDICATE. Existence alone is not enough
    -- — an index over the wrong statuses either blocks the corrected
    -- re-submission this design promises, or fails to block the double
    -- filing it exists to prevent. Both failures are silent.
    select pg_get_expr(i.indpred, i.indrelid) into v_pred
      from pg_index i
      join pg_class ix     on ix.oid = i.indexrelid
      join pg_class t      on t.oid  = i.indrelid
      join pg_namespace ns on ns.oid = t.relnamespace
     where ns.nspname = r.schema_name and ix.relname = 'uniq_eta_submission_live'
       and i.indisunique;
    if v_pred is null then
      v_bad := v_bad || (r.schema_name || ' (uniq_eta_submission_live missing)');
    elsif v_pred !~ 'queued' or v_pred !~ 'submitted' or v_pred !~ 'accepted'
          or v_pred ~ 'rejected' or v_pred ~ 'failed' then
      v_bad := v_bad || format('%s (uniq_eta_submission_live predicate is %s)', r.schema_name, v_pred);
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'eta_submissions'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'eta_submissions';
    if n <> 3 then
      v_bad := v_bad || format('%s (%s policies, expected 3)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's
    -- is_accountant_or_above().
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'eta_submissions'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    -- One privilege per call, deliberately: has_table_privilege() with a
    -- comma-separated list returns true if ANY of them is held, so a
    -- single combined call would pass on SELECT alone and say nothing
    -- about the writes the service needs.
    foreach v_priv in array array['select', 'insert', 'update'] loop
      if not has_table_privilege(
           r.role_name, format('%I.eta_submissions', r.schema_name), v_priv) then
        v_bad := v_bad || format('%s (role has no %s)', r.schema_name, v_priv);
      end if;
    end loop;

    -- DELETE is withheld deliberately; assert it, or a later blanket
    -- grant would hand it over without anyone deciding so — and
    -- assertion (j) inside create_tenant_schema() would then abort every
    -- new showroom's provisioning.
    if has_table_privilege(
         r.role_name, format('%I.eta_submissions', r.schema_name), 'delete') then
      v_bad := v_bad || (r.schema_name || ' (role holds delete)');
    end if;

    if not has_table_privilege(
         'service_role', format('%I.eta_submissions', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.eta_submissions', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.eta_submissions', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege)');
    end if;

    foreach v_trg in array array['trg_eta_submissions_updated_at', 'trg_audit_eta_submissions'] loop
      if not exists (
        select 1 from pg_trigger t
        join pg_class c      on c.oid = t.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = r.schema_name and c.relname = 'eta_submissions'
           and t.tgname = v_trg and not t.tgisinternal
      ) then
        v_bad := v_bad || format('%s (missing %s)', r.schema_name, v_trg);
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0034 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  if position('create table if not exists eta_submissions' in platform.tenant_ddl_template()) = 0
     or position('uniq_eta_submission_live' in platform.tenant_ddl_template()) = 0
     or position('"eta_submissions_select" on eta_submissions' in platform.tenant_ddl_template()) = 0
     or position('trg_audit_eta_submissions' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert, update on eta_submissions' in platform.tenant_ddl_template()) = 0
     or position('on eta_submissions to service_role' in platform.tenant_ddl_template()) = 0 then
    raise exception '0034 VERIFY FAILED: the template does not carry the new table.';
  end if;

  raise notice '0034: verified — every showroom can file, and can prove what it filed.';
end
$$;

-- PostgREST caches the schema; without this the new table is rejected as
-- unknown until the next unrelated reload.
notify pgrst, 'reload schema';

commit;
