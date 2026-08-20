-- ============================================================
-- 0030 — MULTI-BRANCH AUTHORITY
--
-- A profile has exactly one branch_id, and every branch predicate in the
-- schema reduces to a scalar equality against it. That is the right
-- model for a two-branch showroom and the wrong one for a ten-branch
-- group: the area manager who covers Nasr City, Heliopolis and Sheraton
-- has one home branch and no way to say so; the salesperson who works
-- two floors of the same building is locked out of half their own
-- stock; head office has standing nowhere.
--
-- This migration adds ONE table and widens TWO functions. That is the
-- whole of it.
--
-- NO NEW ROLES — DELIBERATELY
-- ---------------------------
-- The obvious shape is an 'area_manager' role. It is the wrong shape.
-- A role is a statement about WHAT a person may do; this is a statement
-- about WHERE. Adding a role to say "where" would mean touching all four
-- places that know the role list (0029's header enumerates them), then
-- teaching every is_*() predicate about it, then discovering that an
-- area manager and a branch manager want identical permissions over
-- different sets of branches. An area manager is a branch_manager with
-- grants. A two-floor salesperson is a sales_exec with one grant. Head
-- office is whoever holds grants over everything. The role list is
-- untouched by this file, and platform.invite_staff() never learns a new
-- word.
--
-- WHAT A GRANT IS, AND WHAT IT IS NOT
-- -----------------------------------
-- A grant EXTENDS authority to an additional branch. It moves nobody:
-- profiles.branch_id remains the home branch, which is still what
-- crm/actions.ts stamps on a new lead and still what current_branch_id()
-- returns. A grant is purely additive, so a schema with an empty
-- branch_grants table behaves exactly as it did before this file ran —
-- which is the property that makes the widening below safe to apply to
-- every live showroom at once.
--
-- READ AND ACT ARE GRANTED TOGETHER
-- ---------------------------------
-- 0009 keeps can_read_branch() and can_act_on_branch() as two functions
-- whose bodies are textually identical, and says why: read scope and
-- write scope are the same rule by coincidence, not by definition. Both
-- are widened here, identically, and they stay two functions. The
-- decision behind that is worth stating rather than leaving to be
-- inferred: a grant confers BOTH. There is no read-only grant.
--
-- The reason is that a read-only grant would be a lie in this product.
-- Every screen a branch manager can read is a screen with an approve or
-- an edit button on it, and the branch predicate is what decides both.
-- A grant that let someone open another branch's deal queue but not act
-- on it would produce a UI full of controls that fail on submit, and the
-- CEO granting it would reasonably believe they had delegated the work.
-- If a genuine read-only scope is ever needed, it is a column on this
-- table (`can_act boolean default true`) and a one-line divergence
-- between the two functions — which is exactly the change 0009 kept them
-- separate to make cheap. It is not needed today, so it is not here.
--
-- WHY THE PREDICATE IS INLINE AND NOT A THIRD HELPER FUNCTION
-- -----------------------------------------------------------
-- The tidy version of this migration adds
-- has_branch_grant(uuid) SECURITY DEFINER, in the shape of 0009's two
-- cycle-breakers, and calls it from both functions. It cannot: assertion
-- (f) inside platform.create_tenant_schema() requires EXACTLY twenty
-- SECURITY DEFINER functions per schema, and that count is deliberately
-- part of the template's contract. Adding a twenty-first would mean
-- rewriting a 300-line function to change one integer — the same trade
-- 0016 declined when it left lead_vehicle_interests out of c_tables.
--
-- Inline is also correct on its own merits. can_read_branch() is
-- expanded into a dozen policies, so the subquery it now carries is
-- expanded there too, and branch_grants' own RLS is expanded inside
-- that. Every one of those expansions must terminate, which is why
-- branch_grants_select below names no other table (see its comment). An
-- exists() over a unique index, guarded by a policy that is two function
-- calls and a column comparison, is a cheap thing to expand. A subquery
-- on profiles inside that policy would not have been.
--
-- REVOCATION IS AN UPDATE, NOT A DELETE
-- -------------------------------------
-- revoked_at is not decoration. It is there because §6f grants DELETE on
-- nothing, and assertion (j) inside create_tenant_schema() PROVES it: a
-- tenant role holding delete on any relation aborts provisioning.
-- Granting DELETE on branch_grants would break every new showroom's
-- creation, in a file that never mentions branch_grants.
--
-- It is also the better design. 0009 §6f's model is that records are
-- superseded rather than removed, and an authority record is the last
-- one that should vanish: "who could approve Heliopolis deals in March"
-- must remain answerable in June. Re-granting a revoked branch is an
-- UPDATE that clears revoked_at, which is why the unique index is on
-- (profile_id, branch_id) with no revoked_at in it — one row per pair,
-- forever, with its whole history in audit_log.
--
-- The cost of a soft revoke is that `revoked_at is null` must appear in
-- every predicate that consults this table, and forgetting it is a
-- privilege leak rather than a visible bug. There are exactly two such
-- predicates, both written in §2 of this file, and §4 asserts that both
-- carry the clause in every live schema.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * It does not add 'branch_grants' to the c_tables array inside
--     platform.create_tenant_schema(), for the reason 0016's header
--     gives: assertion (a) is the belt to assertion (b)'s and guard
--     (5)'s braces, and §4 below verifies the table across every live
--     schema directly.
--   * It does not touch profiles, the role CHECK, invite_staff(), or any
--     is_*() predicate.
--   * It does not widen current_branch_id(). "My branch" still means one
--     branch — the home one — because everything that WRITES a branch
--     onto a new record (a lead, a meeting) must pick exactly one, and
--     the home branch is the only defensible answer.
--   * It grants no new EXECUTE. can_act_on_branch(uuid) and
--     can_read_branch(uuid) are already granted to the tenant role by
--     0009 §6h, and create-or-replace preserves grants.
--
-- LINE ENDINGS
-- ------------
-- The anchors below are authored with LF. The stored template is
-- whatever the client that applied 0009 sent — CRLF, in the live
-- database, because 0009's file is CRLF. A multi-line anchor in the
-- wrong convention matches nothing, replace() silently returns the
-- string unchanged, and the verification after it raises a "template
-- drifted" error that is a lie. §2 therefore normalises every anchor AND
-- every replacement to the template's own convention before touching it,
-- so the spliced text does not turn the template into a mixture that
-- breaks the NEXT migration's anchors.
--
-- STRUCTURE MIRRORS 0029/0027/0016 — template + live loop, anchored and
-- verified substitutions, per-tenant search_path in §3 because policy
-- expressions, FK targets and the trigger's function are resolved and
-- frozen at CREATE time. Idempotent: re-running is safe.
-- ============================================================

begin;

-- ============================================================
-- 1. PRECONDITIONS
-- ============================================================
do $$
begin
  if to_regprocedure('platform.tenant_ddl_template()') is null then
    raise exception
      '0030 PRECONDITION FAILED: platform.tenant_ddl_template() does not exist. Apply 0009 first.';
  end if;

  -- §2 splices the table onto the tail of what 0029 added, so 0029 is
  -- the batch-ordering gate. A database that skipped it fails here
  -- rather than three anchors deep with a misleading drift message.
  if position('create table if not exists vehicle_listings' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0030 PRECONDITION FAILED: the template has no vehicle_listings. Apply 0029 first.';
  end if;

  -- The two functions this migration exists to widen. Checked by name
  -- only; §2's anchors check the bodies byte for byte.
  if position('create or replace function can_act_on_branch(p_branch_id uuid)' in platform.tenant_ddl_template()) = 0
     or position('create or replace function can_read_branch(p_branch_id uuid)' in platform.tenant_ddl_template()) = 0 then
    raise exception
      '0030 PRECONDITION FAILED: the template has no can_act_on_branch/can_read_branch. Apply 0009 first.';
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

  -- None of these is `constant`: every one is rewritten into the
  -- template's own line-ending convention before it is used. See the
  -- header, and the normalisation block at the top of the body.

  -- 2a. the table, immediately after vehicle_listings' unique index —
  --     the tail of what 0029 spliced into §8. branch_grants belongs in
  --     SECTION 1 and nowhere else: the two functions in SECTION 2 name
  --     it, and a `language sql` body is parsed at CREATE time, so a
  --     table declared after them would fail provisioning outright.
  c_tbl_from text := $b1$create unique index if not exists uniq_vehicle_listing_channel
  on vehicle_listings(vehicle_id, channel);$b1$;
  c_tbl_to   text := $b2$create unique index if not exists uniq_vehicle_listing_channel
  on vehicle_listings(vehicle_id, channel);

-- ------------------------------------------------------------
-- 8e. BRANCH GRANTS  (0030)
--
-- One row per (staff member, additional branch). The home branch stays
-- on profiles.branch_id and is NOT duplicated here — a grant is what a
-- profile has in ADDITION to where it lives, so an empty table means
-- "nothing has changed", which is what makes this additive to every
-- showroom already trading.
--
-- granted_by   who last stated this grant. Pinned to auth.uid() by the
--              write policies, exactly as employee_targets.set_by and
--              vehicle_listings.posted_by are.
-- note         why. "Covers Heliopolis while Tarek is on leave" is the
--              difference between an authority list and a mystery.
-- revoked_at   set to revoke, cleared to re-grant. Never a DELETE: see
--              the file header, and §6f.
--
-- ON DELETE CASCADE on both foreign keys is the one place a row here
-- does disappear, and it is right that it does: a closed branch or a
-- removed profile makes the grant meaningless rather than historical,
-- and audit_log holds the row either way.
-- ------------------------------------------------------------
create table if not exists branch_grants (
  id          uuid        primary key default gen_random_uuid(),
  profile_id  uuid        not null references profiles(id) on delete cascade,
  branch_id   uuid        not null references branches(id) on delete cascade,
  granted_by  uuid        references profiles(id),
  note        text,
  revoked_at  timestamptz,
  created_at  timestamptz default now()
);

-- The lookup the CEO's employee list makes: every grant for a profile.
create index if not exists idx_branch_grants_profile on branch_grants(profile_id);

-- One row per pair, forever. revoked_at is deliberately NOT part of this
-- index: re-granting a revoked branch must reuse the row (and its audit
-- history), not open a second answer to "may they act on Heliopolis?".
create unique index if not exists uniq_branch_grant_profile_branch
  on branch_grants(profile_id, branch_id);$b2$;

  -- 2b. can_act_on_branch() gains the grant arm.
  --
  --     The two function bodies in 0009 are byte-identical, so each
  --     anchor carries its own CREATE line to stay unambiguous —
  --     anchoring on the shared body alone would rewrite both, and the
  --     post-substitution check would still pass.
  c_act_from text := $b3$create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id());
$fn$ language sql stable;$b3$;
  c_act_to   text := $b4$create or replace function can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      -- 0030: and any branch this profile has been granted. Additive —
      -- with branch_grants empty this arm is false and the function is
      -- the one 0009 wrote.
      --
      -- `revoked_at is null` is load-bearing. Without it a revoked grant
      -- still authorises, and nothing anywhere would report it.
      --
      -- The null guard is kept for symmetry with the line above rather
      -- than out of necessity: `g.branch_id = null` matches no row, so
      -- the exists() is already false for a null branch.
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$b4$;

  -- 2c. can_read_branch() gains the same arm.
  --
  --     Still a separate function, still with a body identical to its
  --     twin. 0009 kept them apart so that a future divergence is a
  --     one-function change; widening both by the same clause is what
  --     "a grant confers read and act together" means in SQL, and the
  --     header states the decision so nobody later reads the identical
  --     bodies as an invitation to merge them.
  c_read_from text := $b5$create or replace function can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id());
$fn$ language sql stable;$b5$;
  c_read_to   text := $b6$create or replace function can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      -- 0030: a grant confers read as well as act. See the file header
      -- for why there is no read-only grant.
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;$b6$;

  -- 2d. RLS
  c_rls_from text := $b7$alter table vehicle_listings       enable row level security;$b7$;
  c_rls_to   text := $b8$alter table vehicle_listings       enable row level security;
alter table branch_grants          enable row level security;$b8$;

  -- 2e. the policies, after vehicle_listings' four
  c_pol_from text := $b9$drop policy if exists "vehicle_listings_delete" on vehicle_listings;
create policy "vehicle_listings_delete" on vehicle_listings for delete
  using (is_manager_or_above());$b9$;
  c_pol_to   text := $c1$drop policy if exists "vehicle_listings_delete" on vehicle_listings;
create policy "vehicle_listings_delete" on vehicle_listings for delete
  using (is_manager_or_above());

-- ------------------------------------------------------------
-- 5j-quinquies. BRANCH GRANTS — 0030
--
-- NOT ONE OF THESE FOUR PREDICATES NAMES ANOTHER TABLE, and that is the
-- constraint the whole design hangs on rather than a stylistic
-- preference.
--
-- can_read_branch() now reads branch_grants, and can_read_branch() is
-- expanded inside vehicle_expenses_select, deal_ticket_events_select,
-- financing_requests_select and more. Postgres expands a policy
-- subquery at PLAN time, so those policies now expand branch_grants'
-- policies too. A subquery on profiles here — the shape
-- employee_targets_select uses, to let a manager see their own staff's
-- rows — would drag profiles_select into every one of those plans, and
-- would put a cycle one careless edit away: the day profiles_select
-- learns about can_read_branch(), every query in the schema fails with
-- "infinite recursion detected in policy". 0009's two cycle-breakers
-- exist because that already happened here once.
--
-- So the read is own-rows plus the CEO, and a branch manager cannot
-- enumerate their staff's grants through PostgREST. They lose nothing
-- they act on: the grant list is an administrative screen, it lives on
-- the CEO-only employees page, and every person affected can always see
-- their own row — which is also what makes the predicate above
-- self-evaluable for the caller.
--
-- Writing is the CEO alone, in all three verbs. Delegating the power to
-- delegate is how a branch manager grants themselves the branch next
-- door, and no screen asks for it.
-- ------------------------------------------------------------
drop policy if exists "branch_grants_select" on branch_grants;
create policy "branch_grants_select" on branch_grants for select
  using (profile_id = auth.uid() or is_ceo());

-- granted_by = auth.uid() in WITH CHECK on insert AND update: the row
-- always names whoever last stated it, so a revocation names its
-- revoker and audit_log holds the pair.
drop policy if exists "branch_grants_insert" on branch_grants;
create policy "branch_grants_insert" on branch_grants for insert
  with check (is_ceo() and granted_by = auth.uid());

drop policy if exists "branch_grants_update" on branch_grants;
create policy "branch_grants_update" on branch_grants for update
  using (is_ceo())
  with check (is_ceo() and granted_by = auth.uid());

-- CEO-only, and §6d withholds the DELETE grant regardless — so this
-- policy is reachable only through the service role's data-repair path.
-- Revoking is an UPDATE that sets revoked_at; see the file header.
drop policy if exists "branch_grants_delete" on branch_grants;
create policy "branch_grants_delete" on branch_grants for delete
  using (is_ceo());$c1$;

  -- 2f. the audit trigger, after vehicle_listings'
  c_trg_from text := $c2$drop trigger if exists trg_audit_vehicle_listings on vehicle_listings;
create trigger trg_audit_vehicle_listings
  after insert or update or delete on vehicle_listings
  for each row execute function record_audit();$c2$;
  c_trg_to   text := $c3$drop trigger if exists trg_audit_vehicle_listings on vehicle_listings;
create trigger trg_audit_vehicle_listings
  after insert or update or delete on vehicle_listings
  for each row execute function record_audit();

-- The most consequential audit trigger in the schema, and the reason
-- this is a table rather than an array column on profiles: the row IS
-- authority. Who widened whose reach, when, and who took it back are
-- questions that must survive the row being revised in place.
drop trigger if exists trg_audit_branch_grants on branch_grants;
create trigger trg_audit_branch_grants
  after insert or update or delete on branch_grants
  for each row execute function record_audit();$c3$;

  -- 2g. the grants
  c_gnt_from text := $c4$grant select, insert, update, delete on vehicle_listings to service_role;$c4$;
  c_gnt_to   text := $c5$grant select, insert, update, delete on vehicle_listings to service_role;

-- employees/actions.ts grants (insert), revokes and re-grants (update);
-- everyone reads their own row so can_read_branch()'s subquery can see
-- it. No DELETE — and here that is not merely the §6f habit: assertion
-- (j) inside create_tenant_schema() would refuse to provision a showroom
-- whose tenant role held delete on any relation at all.
grant select, insert, update on branch_grants to {{ROLE}};
-- seed/demo scripts and the operator's data-repair path.
grant select, insert, update, delete on branch_grants to service_role;$c5$;
begin
  -- The template's own line-ending convention decides the anchors'.
  -- Both directions matter: an LF anchor never matches CRLF text, and a
  -- CRLF replacement spliced into an LF template leaves a mixture that
  -- breaks whichever migration comes next. Each string is flattened to
  -- LF first, in case an editor saved THIS file with CRLF, and then
  -- rewritten in the template's convention.
  v_nl := case when position(chr(13) || chr(10) in v_tpl) > 0
               then chr(13) || chr(10)
               else chr(10) end;

  c_tbl_from  := replace(replace(c_tbl_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_tbl_to    := replace(replace(c_tbl_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_act_from  := replace(replace(c_act_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_act_to    := replace(replace(c_act_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_read_from := replace(replace(c_read_from, chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_read_to   := replace(replace(c_read_to,   chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_from  := replace(replace(c_rls_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_rls_to    := replace(replace(c_rls_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_from  := replace(replace(c_pol_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_pol_to    := replace(replace(c_pol_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_from  := replace(replace(c_trg_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_trg_to    := replace(replace(c_trg_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_from  := replace(replace(c_gnt_from,  chr(13) || chr(10), chr(10)), chr(10), v_nl);
  c_gnt_to    := replace(replace(c_gnt_to,    chr(13) || chr(10), chr(10)), chr(10), v_nl);

  if position('create table if not exists branch_grants' in v_tpl) > 0 then
    raise notice '0030: template already carries branch_grants — skipping amendment.';
  else
    v_tpl := replace(v_tpl, c_tbl_from, c_tbl_to);
    if position(c_tbl_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2a (table) did not match. Template drifted from 0029.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_act_from, c_act_to);
    if position(c_act_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2b (can_act_on_branch) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_read_from, c_read_to);
    if position(c_read_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2c (can_read_branch) did not match. Template drifted from 0009.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_rls_from, c_rls_to);
    if position(c_rls_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2d (rls) did not match. Template drifted from 0029.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_pol_from, c_pol_to);
    if position(c_pol_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2e (policies) did not match. Template drifted from 0029.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_trg_from, c_trg_to);
    if position(c_trg_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2f (audit trigger) did not match. Template drifted from 0029.';
    end if;
    v_done := v_done + 1;

    v_tpl := replace(v_tpl, c_gnt_from, c_gnt_to);
    if position(c_gnt_to in v_tpl) = 0 then
      raise exception '0030: template anchor 2g (grants) did not match. Template drifted from 0029.';
    end if;
    v_done := v_done + 1;

    -- 0027's prefix-of-replacement safety, restated. Five of the seven
    -- anchors above are a prefix of their replacement, so `replace`
    -- would fire twice if the template ever carried two copies of one.
    -- 40 = length('create table if not exists branch_grants').
    if (length(v_tpl) - length(replace(v_tpl, 'create table if not exists branch_grants', ''))) <> 40 then
      raise exception '0030: the template carries more than one branch_grants table.';
    end if;

    -- 2b and 2c are whole-function REPLACEMENTS rather than splices, so
    -- the count above says nothing about them. This one does: the grant
    -- arm must appear exactly twice in the template, once per function
    -- (2 x length('g.revoked_at is null') = 40). Three occurrences would
    -- mean an anchor matched somewhere unintended; one would mean the
    -- two bodies silently diverged.
    if (length(v_tpl) - length(replace(v_tpl, 'g.revoked_at is null', ''))) <> 40 then
      raise exception '0030: the template does not carry exactly two widened branch predicates.';
    end if;

    execute format(
      'create or replace function platform.tenant_ddl_template() returns text '
      'language sql immutable set search_path = pg_catalog '
      'as $felix_0030$ select %L::text $felix_0030$',
      v_tpl
    );
    revoke all on function platform.tenant_ddl_template() from public;
    raise notice '0030: template amended (% substitutions).', v_done;
  end if;
end
$mig$;

-- ============================================================
-- 3. AMEND EVERY EXISTING TENANT SCHEMA
--
-- One ordering rule and nothing else: the TABLE must exist before the
-- two functions are replaced, because a `language sql` body is parsed
-- and its references resolved at CREATE time — a widened
-- can_read_branch() created against a schema with no branch_grants
-- raises 42P01 and leaves the old body in place, which is a failure that
-- reads like a typo and is actually a missing feature.
--
-- Unqualified DDL under a per-tenant search_path, exactly as 0029 §4:
-- the FK targets, the policy expressions and the trigger's function are
-- resolved and frozen HERE, and each showroom's must bind to its own.
--
-- The two functions are the exception and are formatted per tenant
-- instead. They are in create_tenant_schema()'s c_unpinned list, which
-- means they carry NO pinned search_path — a SET clause would stop the
-- planner inlining them into every policy that calls them — and
-- schema-qualify their inner calls instead. {{SCHEMA}} is substituted
-- here by the same mechanism the template uses.
-- ============================================================
do $mig$
declare
  r       record;
  v_count int := 0;

  c_ddl constant text := $ddl$
create table if not exists branch_grants (
  id          uuid        primary key default gen_random_uuid(),
  profile_id  uuid        not null references profiles(id) on delete cascade,
  branch_id   uuid        not null references branches(id) on delete cascade,
  granted_by  uuid        references profiles(id),
  note        text,
  revoked_at  timestamptz,
  created_at  timestamptz default now()
);

create index if not exists idx_branch_grants_profile on branch_grants(profile_id);

create unique index if not exists uniq_branch_grant_profile_branch
  on branch_grants(profile_id, branch_id);

alter table branch_grants enable row level security;

drop policy if exists "branch_grants_select" on branch_grants;
create policy "branch_grants_select" on branch_grants for select
  using (profile_id = auth.uid() or is_ceo());

drop policy if exists "branch_grants_insert" on branch_grants;
create policy "branch_grants_insert" on branch_grants for insert
  with check (is_ceo() and granted_by = auth.uid());

drop policy if exists "branch_grants_update" on branch_grants;
create policy "branch_grants_update" on branch_grants for update
  using (is_ceo())
  with check (is_ceo() and granted_by = auth.uid());

drop policy if exists "branch_grants_delete" on branch_grants;
create policy "branch_grants_delete" on branch_grants for delete
  using (is_ceo());

drop trigger if exists trg_audit_branch_grants on branch_grants;
create trigger trg_audit_branch_grants
  after insert or update or delete on branch_grants
  for each row execute function record_audit();
$ddl$;

  c_fns constant text := $fns$
create or replace function {{SCHEMA}}.can_act_on_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;

create or replace function {{SCHEMA}}.can_read_branch(p_branch_id uuid) returns boolean as $fn$
  select {{SCHEMA}}.is_ceo()
      or {{SCHEMA}}.is_accountant_or_above()
      or (p_branch_id is not null and p_branch_id = {{SCHEMA}}.current_branch_id())
      or (p_branch_id is not null and exists (
            select 1 from {{SCHEMA}}.branch_grants g
             where g.profile_id = auth.uid()
               and g.branch_id  = p_branch_id
               and g.revoked_at is null));
$fn$ language sql stable;
$fns$;
begin
  for r in select schema_name, role_name, slug from platform.tenants order by slug loop
    -- profiles and branches are the FK targets and record_audit() must
    -- exist; checking profiles tells a half-provisioned tenant from a
    -- complete one, as 0027 §3 does.
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      raise notice '0030: %.profiles missing — skipping (tenant not fully provisioned).', r.schema_name;
      continue;
    end if;

    -- Transaction-local and re-set per iteration; `public` absent on
    -- purpose so nothing binds to the flagship's pre-0011 leftovers.
    perform set_config('search_path', quote_ident(r.schema_name) || ', extensions', true);
    execute c_ddl;

    -- Now the functions, schema-qualified rather than path-resolved. The
    -- table above is what makes these parse at all.
    execute replace(c_fns, '{{SCHEMA}}', quote_ident(r.schema_name));

    -- §6b's blanket revoke and §6d's grants ran at provisioning and
    -- cannot reach a table added afterwards. No DELETE for the tenant
    -- role: create_tenant_schema()'s assertion (j) forbids it outright,
    -- and revocation is an UPDATE anyway.
    execute format(
      'grant select, insert, update on %I.branch_grants to %I',
      r.schema_name, r.role_name
    );
    execute format(
      'grant select, insert, update, delete on %I.branch_grants to service_role',
      r.schema_name
    );
    execute format(
      'revoke all on table %I.branch_grants from public, anon, authenticated',
      r.schema_name
    );

    v_count := v_count + 1;
    raise notice '0030: % amended.', r.schema_name;
  end loop;

  -- §4 reads pg_get_expr's schema qualification, which only appears for
  -- objects NOT on the current path — so clear the last tenant's path.
  perform set_config('search_path', 'pg_catalog', true);
  raise notice '0030: % tenant schema(s) carry branch_grants.', v_count;
end
$mig$;

-- ============================================================
-- 4. SELF-VERIFY — structure, isolation, lockdown, that every policy
-- bound to THIS schema's predicates, and that both widened functions
-- read THIS schema's branch_grants with the revocation clause intact.
-- ============================================================
do $$
declare
  r      record;
  v_bad  text[] := '{}';
  v_def  text;
  v_oid  oid;
  n      int;
  f      text;
begin
  for r in select schema_name, role_name from platform.tenants loop
    if to_regclass(format('%I.profiles', r.schema_name)) is null then
      continue;
    end if;

    if to_regclass(format('%I.branch_grants', r.schema_name)) is null then
      v_bad := v_bad || (r.schema_name || ' (table)');
      continue;
    end if;

    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'branch_grants'
         and c.relrowsecurity
    ) then
      v_bad := v_bad || (r.schema_name || ' (rls off)');
    end if;

    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'branch_grants';
    if n <> 4 then
      v_bad := v_bad || format('%s (%s policies, expected 4)', r.schema_name, n);
    end if;

    -- The silent disaster: a policy bound to another schema's helpers.
    -- All four name is_ceo(), so all four must carry the qualification.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'branch_grants'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~ ('\m' || r.schema_name || '\M');
    if n > 0 then
      v_bad := v_bad || format('%s (%s policy expr(s) not bound to this schema)', r.schema_name, n);
    end if;

    -- No policy on this table may name another table — see
    -- 5j-quinquies. Written as a catalogue check rather than a comment
    -- so that the day someone adds a manager arm with a profiles
    -- subquery, a re-run of this migration says so, instead of the
    -- schema quietly gaining a recursion hazard inside a dozen unrelated
    -- policies. pg_get_expr deparses a subquery with the keyword in
    -- upper case, and none of the four legitimate predicates has one.
    select count(*) into n
      from pg_policy p
      join pg_class c      on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = r.schema_name and c.relname = 'branch_grants'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           ~ '\mSELECT\M';
    if n > 0 then
      v_bad := v_bad || format('%s (%s branch_grants policy/policies carry a subquery)', r.schema_name, n);
    end if;

    if not has_table_privilege(
         r.role_name, format('%I.branch_grants', r.schema_name), 'select, insert, update') then
      v_bad := v_bad || (r.schema_name || ' (role cannot write grants)');
    end if;

    -- assertion (j) parity: a DELETE grant here would make the NEXT
    -- showroom's provisioning fail, long after this migration ran and
    -- nowhere near it.
    if has_table_privilege(
         r.role_name, format('%I.branch_grants', r.schema_name),
         'delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (role holds delete/truncate/references/trigger!)');
    end if;

    if not has_table_privilege(
         'service_role', format('%I.branch_grants', r.schema_name),
         'select, insert, update, delete') then
      v_bad := v_bad || (r.schema_name || ' (service_role cannot write)');
    end if;

    if has_table_privilege(
         'authenticated', format('%I.branch_grants', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger')
       or has_table_privilege(
         'anon', format('%I.branch_grants', r.schema_name),
         'select, insert, update, delete, truncate, references, trigger') then
      v_bad := v_bad || (r.schema_name || ' (anon/authenticated hold a privilege)');
    end if;

    if not exists (
      select 1 from pg_trigger t
      join pg_class c      on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = r.schema_name and c.relname = 'branch_grants'
         and t.tgname = 'trg_audit_branch_grants' and not t.tgisinternal
    ) then
      v_bad := v_bad || (r.schema_name || ' (no audit trigger)');
    end if;

    -- The point of the whole migration. Both functions must read THIS
    -- schema's branch_grants, and both must carry the revocation clause
    -- — a widened predicate that forgot `revoked_at is null` authorises
    -- revoked grants forever and would pass every other check here.
    foreach f in array array['can_act_on_branch', 'can_read_branch'] loop
      v_oid := to_regprocedure(format('%I.%I(uuid)', r.schema_name, f))::oid;

      if v_oid is null then
        v_bad := v_bad || format('%s (%s missing)', r.schema_name, f);
        continue;
      end if;

      v_def := pg_get_functiondef(v_oid);

      if position(format('%I.branch_grants', r.schema_name) in v_def) = 0 then
        v_bad := v_bad || format('%s (%s does not read this schema''s branch_grants)', r.schema_name, f);
      end if;

      if position('revoked_at is null' in v_def) = 0 then
        v_bad := v_bad || format('%s (%s lost the revocation clause)', r.schema_name, f);
      end if;

      -- c_unpinned: these two must stay inlinable, so a SET clause must
      -- not have crept in. create_tenant_schema()'s assertion (e) says
      -- the same thing for new showrooms; this says it for live ones.
      if exists (
        select 1 from pg_proc p
         where p.oid = v_oid
           and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                        where cfg like 'search_path=%')
      ) then
        v_bad := v_bad || format('%s (%s gained a pinned search_path and is no longer inlinable)',
                                 r.schema_name, f);
      end if;

      if not has_function_privilege(r.role_name, v_oid, 'execute') then
        v_bad := v_bad || format('%s (%s not executable by the tenant role)', r.schema_name, f);
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception '0030 VERIFY FAILED: %', array_to_string(v_bad, ', ');
  end if;

  -- The template, for showrooms not yet provisioned.
  if position('create table if not exists branch_grants' in platform.tenant_ddl_template()) = 0
     or position('grant select, insert, update on branch_grants' in platform.tenant_ddl_template()) = 0
     or position('on branch_grants to service_role' in platform.tenant_ddl_template()) = 0 then
    raise exception '0030 VERIFY FAILED: the template does not carry the new table.';
  end if;

  if (length(platform.tenant_ddl_template())
      - length(replace(platform.tenant_ddl_template(), 'g.revoked_at is null', ''))) <> 40 then
    raise exception
      '0030 VERIFY FAILED: the template does not carry exactly two widened branch predicates.';
  end if;

  -- And that the template never grants the tenant role DELETE here —
  -- assertion (j) would refuse every showroom created from it.
  if position('delete on branch_grants to {{ROLE}}' in platform.tenant_ddl_template()) > 0 then
    raise exception
      '0030 VERIFY FAILED: the template grants the tenant role DELETE on branch_grants; assertion (j) would refuse to provision.';
  end if;

  raise notice '0030: verified — a grant widens read and act, everywhere it must.';
end
$$;

notify pgrst, 'reload schema';

commit;
