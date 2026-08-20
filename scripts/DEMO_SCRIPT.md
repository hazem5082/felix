# The demo walkthrough

Ten scenes, in the order they build on each other. Every one of them is
real data written through the real code paths — no screenshots, no
mock-ups, nothing typed into the page before the meeting.

## Before the meeting

```bash
npm run seed                       # the flagship: staff, cars, pipeline, showcase
node --env-file=.env.local scripts/demo-photos.mjs    # optional: photographs
```

`scripts/seed-demo.mjs` is idempotent and safe to re-run on a demo tenant
people have already been clicking around in — every scene is probe-guarded
and adds only what is missing. It prints one line per scene; anything it
could not lay down is listed at the end with the reason, and the rest of
the demo is still intact.

Sign in in **Arabic** (`/ar/login`) and keep two browser profiles open:
the **CEO** (`ceo@filex.demo`) and the **accountant**
(`accountant@filex.demo`). The branch manager (`manager@filex.demo`) is
the third persona and only needed for the transfer.

The showcase cars are priced in EGP. The four original demo cars (Fusion,
Civic, Camry, BMW) are not — they predate the Egyptian build and one of
them is sold with its waterfall already posted, so they were deliberately
left alone. Steer the walkthrough onto the cars named below.

---

## 1. CEO dashboard — `/ar/ceo`

> "This is the whole group on one screen: what's in stock, what's tied up
> in it, what's waiting for your signature, and what the floor is being
> asked for that you don't have."

Point at the approvals count (there is a real ticket waiting) and the
demand panel — two buyers want a Hilux the showroom does not stock.

## 2. Inventory ageing — `/ar/inventory`

> "Every car carries its own clock. Green is fresh, red has been standing
> over ninety days and is costing you money every week."

All four buckets are populated: the Civic at ~15 days, the Elantra at
~45, the MG5 at ~75, the **Kia Sportage at ~120**. Open the Sportage:
its price history shows **1,050,000 → 985,000**, written by the database
when somebody cut it, not typed into a note.

## 3. The consignment car — `/ar/inventory` → 2019 Nissan Sunny

> "This one isn't yours. It's منى عبد الرحمن's, and you're selling it
> بالأمانة on 5%. The system knows: no capital, no investor share, and
> when it sells the money becomes a debt to her, not a profit to split."

The banner names the consignor. Note there is no cap table on the car —
the database refuses one.

## 4. Trade-in: approve and execute — `/ar/deals` → the Elantra ticket

> "A real deal, half cash and half تبديل. Watch what happens to the old
> car when I sign."

Tick the three review checks, approve, then execute. The **2019 Lanos**
appears in stock the same second, booked to the house at the 210,000
allowance — inside the same transaction as the sale, so a settled deal
can never leave a trade-in unrecorded.

## 5. The instalment book — the executed Kia Cerato deal

> "You are the bank. 300,000 over 24 months at 7.5% flat — the rate you
> already advertise — and the schedule is yours, not a bank's report you
> wait for."

Two instalments are collected, and the third fell due two weeks ago.
**Record a payment** live against the next line and watch the outstanding
balance, the next-due date and the arrears move together.

## 6. The bounced cheque — same deal, cheques panel

> "Four post-dated cheques in the safe. Two cleared, one is still with
> the bank — and this one came back."

Cheque 441209, Banque Misr, بنك مصر — bounced, recent. Point out that the
system would not let anyone record it as cleared and then quietly change
its mind: a cheque only moves along the road the schema allows.

## 7. Accountant hub — `/ar/accountant` (sign in as the accountant)

> "Two questions an owner asks every morning: who owes me, and who do I
> owe."

**Receivables** shows the arrears ageing with a live figure in the 1–30
day bucket. **Consignment payouts** shows money owed to سعيد الجندي on the
Chery Tiggo that sold — an outsider's money, deliberately kept out of the
profit ledger so no report ever counts it as the group's.

## 8. Accept the transfer — `/ar/inventory` → the MG5 (sign in as the manager)

> "Nasr City has had this car standing for 75 days. Heliopolis says it can
> move it. One request, one acceptance, and the stock is where the buyers
> are."

The manager can see both branches because the CEO granted them Heliopolis
— one row, not a new role. Accept the transfer and watch the car change
branch.

## 9. The e-invoice — the Cerato deal → ETA panel

> "The invoice is already filed. This is the sandbox, but it is the same
> document, the same validation and the same submission log that goes to
> the authority on the day you switch it on."

The timeline shows the accepted submission with its UUID and long ID, and
the same identifiers on the contract itself — so the printed contract's
footer agrees with the screen.

## 10. Migrating their own data — the importer, live

```bash
node --env-file=.env.local scripts/import-legacy.mjs --tenant felix ./scripts/import/demo-legacy
```

> "This is the part everyone is afraid of. Give me your Excel export and I
> will tell you exactly what will happen before anything is written."

It is a **dry run by default** — you have to pass `--commit` to write. No
`--map` is needed: the Arabic headers in `scripts/import/demo-legacy/` are
ones the importer already recognises.

Open `import-report.md` next to the CSVs and read the reject table out
loud:

- **`vehicles.csv`** — 14 rows, 13 pass. The Daewoo Lanos is rejected:
  `year "199" is not a sane vehicle year`. A missing digit in their own
  spreadsheet, found before it became a car in the system.
- **`customers.csv`** — 13 rows, 12 pass. حسام الدين عادل بدر is rejected:
  the national ID column has a passport number in it.
- The Mitsubishi's year was written `٢٠١٤` and the Hilux's price
  `"1,150,000 جنيه"` — both read correctly, without anyone cleaning the
  file first.
- محمود عبد العزيز شاهين is already a customer (he is the instalment
  buyer), so he is reported as a **match**, not inserted twice.

> "Fix those two cells, re-run, add `--commit`. Your accountant checks the
> reconciliation table at the bottom against their own books, and signs
> off."

---

## What each scene is actually proving

| Scene | Migration | The claim |
| --- | --- | --- |
| 1, 8 | 0030 | Authority is a grant over a branch, not a new job title |
| 2 | 0036 | Every car has an odometer, a provenance and an ageing clock |
| 2 | 0036 | Price changes are history the database keeps, not a note |
| 3, 7 | 0032 | بالأمانة is modelled as a debt, never as profit |
| 4 | 0032 | تبديل puts the old car in stock inside the same transaction |
| 5, 6, 7 | 0033 | The showroom's own book: flat-rate schedule, cheques, arrears |
| 8 | 0035 | Stock moves between branches by request and acceptance |
| 9 | 0024, 0034 | The e-invoice is filed and logged, not transcribed by hand |
| 10 | — | Their existing Excel becomes FELIX with the errors named first |
