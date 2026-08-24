# FILEX

Automotive showroom capital, inventory, and deal management.

FILEX runs the money side of a multi-branch car dealership: vehicles are bought
with pooled equity (the company plus outside investors), carry reconditioning
expenses and a share of branch overhead, and are sold through an approval-gated
deal-ticket workflow. When a sale executes, a Postgres "waterfall" computes net
profit and writes immutable profit-share entries to every holder's ledger.

Bilingual (English / Arabic, RTL-aware) and deployed to Cloudflare Workers.

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router, React 19, Server Actions) — pinned to 15, see below |
| Database & auth | Supabase (Postgres, Row Level Security, Supabase Auth), schema-per-tenant |
| Object storage | Cloudflare R2 via presigned S3 PUTs |
| i18n | next-intl — `en`, `ar`, locale-prefixed routes |
| Styling | Tailwind v4, Radix primitives, framer-motion |
| Validation | zod v4 (server-side, on every action) |
| Hosting | Cloudflare Workers via `@opennextjs/cloudflare` |

> **Next.js version note.** This project is **pinned to Next 15** on
> purpose: Next 16 renames Middleware to Proxy and defaults it to the
> Node.js runtime, and `@opennextjs/cloudflare` rejects a
> Node.js-runtime proxy at build time. The file is `src/middleware.ts`
> and it exports `middleware`. When the adapter gains support, the pin
> (and this paragraph, and the matching comment in the file itself) can
> move together. Consult `node_modules/next/dist/docs/` before changing
> anything in this area — it differs from older Next.js material.

---

## Roles

| Role | Sees | Can do |
| --- | --- | --- |
| `ceo` | Everything, org-wide | Everything, including equity allocation, overhead, commission tiers, staff administration |
| `accountant` | Everything, org-wide | Financing partners, expenses, ledger entries, financing request status |
| `branch_manager` | Their branch (plus granted branches) | Vehicle intake, review and approve deal tickets, execute sales, expenses |
| `sales_exec` | Their own leads and tickets | Create leads and deal tickets, log follow-ups |
| `marketing` | Org-wide inventory | Manage listings across channels; no cost figures |
| `hr` | Staff records (per feature grant) | Payroll/statutory fields on non-CEO rows, attendance admin |
| `investor` | Only their own holdings | Read their portfolio and ledger |

Authorization is enforced **twice**: in the Server Action (role + branch) and
again in Postgres RLS. Neither is treated as sufficient alone — see
[Security model](#security-model).

---

## Getting started

### 1. Install

```bash
npm install
```

### 2. Configure environment

Create `.env.local` (used by `next dev` and the seed script):

```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=<r2 access key>
R2_SECRET_ACCESS_KEY=<r2 secret>
R2_BUCKET_NAME=filex
R2_PUBLIC_URL=https://<bucket>.<account>.r2.dev
```

Mirror the same values in `.dev.vars` for `wrangler dev`. Both files are
gitignored and must stay that way — `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS
completely.

Only the two `NEXT_PUBLIC_*` variables are safe in the browser bundle. Every
other variable is read exclusively from `server-only` modules.

### 3. Apply migrations

In the Supabase dashboard → SQL Editor, run **every numbered file in
`supabase/migrations/` in ascending order** — currently `0001_init.sql`
through the highest `00xx_*.sql` present. Do not stop early: the app
uses features from across the set (multi-tenancy 0008–0013, receivables
0033, attendance 0038, mail 0039–0042, and so on), and a partial apply
renders as silently missing features rather than errors.

Every file is idempotent and safe to re-run. Files that amend the
per-tenant template also patch every live showroom schema in the same
run.

### 4. Create the first CEO

Roles are **never** self-assigned. Insert an invitation, then create the user:

```sql
insert into staff_invitations (email, full_name, role, branch_id)
values ('you@example.com', 'Your Name', 'ceo', null);
```

Then Supabase Dashboard → Authentication → Users → Add User with that email.
The `handle_new_user` trigger consumes the invitation and assigns the role.
Anyone who signs up *without* an invitation lands as `sales_exec`.

### 5. Seed demo data (optional)

Set a password for the seeded accounts first — the script refuses to run
without one, so that no credential is ever committed to this repository:

```bash
SEED_PASSWORD='<a strong passphrase>' npm run seed
```

Creates one user per role (all sharing that password), four vehicles with
equity splits, leads, and deal tickets across every status including one
executed sale so the ledgers are not empty, plus two calendar meetings.

**Demo data only — never run this against a live showroom.** The accounts
it creates are real sign-ins with real privileges: if you seed a tenant
that later goes to a customer, rotate every password from the Employees
tab before handing it over.

### 6. Run

```bash
npm run dev
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |
| `npm run verify` | typecheck + lint + test — run this before pushing |
| `npm run seed` | Seed demo data |
| `npm run preview:cf` | Build for Workers and preview with wrangler |
| `npm run deploy:cf` | Build and deploy to Cloudflare |

---

## Security model

The threat model that matters here: **a Server Action is a public HTTP
endpoint.** Every exported `"use server"` function can be invoked by any
authenticated user with hand-crafted arguments, regardless of what the UI
renders. A `canReview` prop that hides a button is a usability affordance, not
a control.

So authorization is layered:

1. **Server Action** — `authorize(roles)` checks the caller's role, then
   `assertBranch()` checks the record is in scope. Input is parsed with zod
   before anything is read or written.
2. **Postgres RLS** — policies scoped by role *and* branch, so a bug in layer 1
   is not automatically exploitable.
3. **Triggers** — invariants that must hold no matter which path writes
   (status transitions, the equity cap table summing to 100%, `is_ceo_override`,
   sold-vehicle immutability). These also cover direct PostgREST calls that skip
   the app entirely.

Other properties worth knowing:

- **Roles cannot be self-assigned, and invitations carry a one-time
  secret.** `handle_new_user` ignores signup metadata for role/branch and
  reads `staff_invitations` instead; since migration 0052 the signup must
  also present the invitation's one-time token (delivered by the app
  server-to-server), so knowing a new hire's email address is no longer
  enough to take their slot — including for CEO. A trigger blocks any
  non-CEO from changing protected profile columns (role, branch, wage,
  national ID, …) and blocks removing the last CEO.
- **The audit log is append-only** on every live path. Row-level
  UPDATE/DELETE triggers reject tampering, tenant roles hold no
  DELETE/TRUNCATE anywhere, and migration 0051 revoked end-user access to
  the retired pre-0011 `public.*` copy of the books — which had kept its
  Supabase default grants (including TRUNCATE, which row triggers never
  see) until then.
- **Rate limiting** on login (per IP *and* per email), the public referral
  intake, and upload presigning. Counters live in Postgres
  (`platform.consume_rate_limit`) since this deployment has no KV binding.
  It fails **open** and logs loudly — a limiter that takes down login during
  a database hiccup is worse than the abuse it prevents.
- **Uploads** are presigned per folder with a role allowlist, a signed
  `Content-Length`, a sanitised object key, and a 15 MB cap. Mail
  attachments additionally carry their uploader's id in the key, so a
  staged attachment cannot be attached by anyone but its uploader, and
  compose-time size budgets are verified against the stored object rather
 than the client's claim. A financing contract can only be activated with
  a URL this application actually issued.
- **Worker-to-Worker webhooks** (`/api/provision`, `/api/mail/inbound`)
  verify an HMAC-SHA256 signature over timestamp + raw body with replay
  protection; legacy bearer tokens still authenticate during the router's
  transition and are logged loudly when used.
- **Security headers** including a CSP scoped to the Supabase, R2 and NHTSA
  origins are set in `next.config.ts` — with `geolocation=(self)` because
  the attendance geofence needs it.
- **Shared error paths speak your locale**: the auth guards, the Postgres
  error translator and zod validation localize their messages at creation
  (`src/lib/action-messages.ts`), so every form renders localized text
  without each form translating anything.

---

## The waterfall

One function, `compute_sale_waterfall()`, is the single source of truth for
both the preview and the committed sale, so a reviewer cannot see one number
and book another:

```
net_profit = agreed_price
           − purchase_price
           − direct_expenses          (sum of vehicle_expenses)
           − overhead                 (branch monthly_opex × months_in_inventory)
           − discount
```

`net_profit` is then split by `vehicle_equity_splits.percentage`. Per-share
rounding residue is pushed onto the CEO line so the shares sum *exactly* to
`net_profit`. Losses are distributed pro-rata by the same percentages.

The function is `SECURITY DEFINER` with its own scope check, because a
`sales_exec` cannot read `vehicle_expenses` or `overhead_config` — previously
those rows silently coalesced to zero and the preview overstated profit.

### Two modelling assumptions to review

1. **Overhead is charged per vehicle at the full branch rate.** A branch
   holding 20 cars for one month books 20 × its entire monthly opex. If the
   intent is to apportion overhead across concurrent inventory, that belongs in
   `compute_sale_waterfall`.
2. **Commission tiers are cumulative and monthly.** Reaching tier *N* entitles
   the salesperson to `cumulative_amount(N)` for the calendar month, so a sale
   pays the difference from the previous tier. With the seeded ladder
   (`tier_index × 6000`) that is a flat 6,000 per unit; the table can express
   any accelerating schedule.

---

## Deployment (Cloudflare Workers)

```bash
npm run preview:cf
```

```bash
npm run deploy:cf
```

Set secrets on the Worker (never in `wrangler.jsonc`):

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

`GET /api/health` reports dependency reachability and missing configuration
(names only, never values) — 200 when healthy, 503 otherwise. Point your uptime
monitor and deploy gate at it.

---

## Repository layout

```
src/
  app/[locale]/
    (app)/            authenticated shell — ceo, inventory, crm, deals,
                      accountant, investor, calendar, attendance, mail,
                      employees, marketing
    login/            sign-in
    refer/            public, unauthenticated referral intake
  app/api/
    upload/           R2 presign
    provision/        Worker-to-Worker showroom provisioning (HMAC)
    health/           health check
    mail/inbound/     felixmail inbound bridge (HMAC)
    export/           CSV exports (ledger, attendance)
  components/         ui primitives, layout, waterfall
  i18n/               next-intl routing, request config, navigation helpers
  lib/
    auth.ts           getProfile, authorize, assertBranch, role sets
    validation.ts     every zod schema, one place
    action-messages.ts  server-side localization of shared error strings
    rate-limit.ts     Postgres-backed limiter
    r2.ts             presigning, folder to role map, URL provenance
    webhook-auth.ts   HMAC + replay verification for the webhooks
    supabase/         server / client / admin clients, hand-written types
  middleware.ts       session refresh + locale routing (Edge; see the
                      version note above for why this is not proxy.ts)
supabase/migrations/  numbered, self-verifying, applied in full order
messages/             en.json, ar.json (kept at identical key sets)
```

---

## Contributing

Run `npm run verify` before pushing. When changing the schema, add a new
numbered migration rather than editing an existing one, and keep
`src/lib/supabase/types.ts` in step — it is hand-written, since this
environment has no Supabase CLI access to generate it.
