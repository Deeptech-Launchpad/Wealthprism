# Ticket breakdown — phases 0 to 2, plus planning & taxation, benchmark gaps, general ledger, action plane, investment policy, rebalancing engine and research

Import `phases_0-2_tickets.csv` into Jira/Linear (Key → issue key, Depends on → blocked-by links). Points are Fibonacci story points (relative effort, not duration). Phases are ordered by dependency; the team plans its own sprints from the Depends-on column.

## Phase 0 — Foundation — 12 tickets, 49 points

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-1 | Monorepo scaffold | 3 | P0 |  |
| FO-2 | Docker Compose dev environment | 3 | P0 | FO-1 |
| FO-3 | Apply schema migration and seed | 3 | P0 | FO-2 |
| FO-4 | API skeleton with RLS per request | 5 | P0 | FO-3 |
| FO-5 | Auth: password login, refresh rotation, TOTP MFA | 8 | P0 | FO-4 |
| FO-6 | Families, entities, GSTINs, members, invites | 5 | P0 | FO-5 |
| FO-7 | Audit log on all writes | 3 | P0 | FO-4 |
| FO-8 | Web shell | 5 | P0 | FO-5 |
| FO-9 | Mobile shell | 5 | P0 | FO-5 |
| FO-10 | Shared schemas package | 3 | P0 | FO-1 |
| FO-11 | CI pipeline | 3 | P0 | FO-2 |
| FO-12 | Observability baseline | 3 | P1 | FO-4 |

### FO-1 — Monorepo scaffold

pnpm workspace with apps/api, apps/web, apps/mobile, packages/schemas, packages/ui-tokens, packages/finance, packages/parsers; TypeScript strict; ESLint + Prettier shared config.

**Acceptance:** `pnpm -r build` and `pnpm -r test` pass on a clean clone; CI runs both.

### FO-2 — Docker Compose dev environment

docker-compose.yml with postgres:16, redis:7, minio, api, worker, web (Vite dev). See deploy/. Seed on first start.

**Acceptance:** `docker compose up` gives a working app at localhost with the seeded Mehta family in < 5 min.

### FO-3 — Apply schema migration and seed

Adopt db/001_init.sql as migration 0001 in the chosen tool (Drizzle or Prisma migrate with raw SQL). Seed script runs db/002_seed.sql in dev/staging only.

**Acceptance:** Fresh DB migrates with zero errors; seed produces 7 holdings, 4 properties, 7 tasks; RLS test (no family_id → 0 rows) passes in CI.

### FO-4 — API skeleton with RLS per request

Fastify + zod. Middleware reads JWT, X-Family-Id, verifies membership, opens a transaction and runs set_config('app.family_id'). Problem+json errors. OpenAPI served at /api/docs from api/openapi.yaml.

**Acceptance:** Any tenant query without a valid family header returns 403; integration test proves a user in family A cannot read family B holdings.

### FO-5 — Auth: password login, refresh rotation, TOTP MFA

argon2 hashing, access 15 min, refresh 30 d rotating with reuse detection, TOTP enrol/verify (otplib), recovery codes, MFA mandatory for owner/operator.

**Acceptance:** All /auth endpoints in OpenAPI implemented; refresh reuse revokes the family of tokens; MFA cannot be skipped for owner.

### FO-6 — Families, entities, GSTINs, members, invites

CRUD per OpenAPI. PAN encrypted at column level (AES-GCM, per-family key from KMS/env), only last4 stored in clear. Invite by email with role and optional entity_scope.

**Acceptance:** Entity with invalid PAN/GSTIN regex rejected; viewer with entity_scope only sees scoped entities in every list endpoint.

### FO-7 — Audit log on all writes

Generic write interceptor records before/after JSON to audit_log with user and family.

**Acceptance:** Every POST/PATCH/DELETE produces one audit row; audit rows are not readable via API (v1).

### FO-8 — Web shell

React 18 + Vite + React Router + TanStack Query + Zustand. Navigation rail, entity switcher, top bar, notifications badge, protected routes, login/MFA screens. Design tokens from packages/ui-tokens (IBM Plex Sans, palette from PRD 7.1).

**Acceptance:** Matches prototype layout; entity switch re-queries every screen; keyboard focus visible; Lighthouse a11y ≥ 90.

### FO-9 — Mobile shell

Expo (React Native) app with bottom tabs (Dashboard, Investments, Real estate, Startups, More), header entity switcher, login/MFA, biometric unlock, shared API client and tokens.

**Acceptance:** Runs on iOS simulator and Android emulator; login persists across restarts; EAS build config committed.

### FO-10 — Shared schemas package

Generate zod schemas + TS types from api/openapi.yaml (openapi-zod-client or similar); API validates requests/responses with them; web/mobile import types.

**Acceptance:** A change to openapi.yaml fails typecheck in api/web/mobile until regenerated; generation is a CI step.

### FO-11 — CI pipeline

GitHub Actions: lint, typecheck, unit tests, API integration tests against Postgres service, web Playwright smoke, mobile typecheck. Docker image build + push on main.

**Acceptance:** PR cannot merge with red checks; images tagged with git SHA.

### FO-12 — Observability baseline

pino structured logs, OpenTelemetry traces (OTLP), /healthz and /readyz, BullMQ dashboard behind auth.

**Acceptance:** Request id flows from web → api → worker logs; health endpoints used by Docker healthchecks.

## Phase 1 — Investments parity — 20 tickets, 104 points

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-20 | Instruments master and search | 5 | P0 | FO-3 |
| FO-21 | Price feeds: AMFI NAV and NSE/BSE EOD | 5 | P0 | FO-20 |
| FO-22 | Finance package: lots, FIFO, cost basis | 8 | P0 | FO-1 |
| FO-23 | Finance package: XIRR | 3 | P0 | FO-22 |
| FO-24 | Finance package: capital-gains engine | 8 | P0 | FO-22 |
| FO-25 | Holdings and lots API | 5 | P0 | FO-23 |
| FO-26 | Manual investment transactions | 3 | P0 | FO-25 |
| FO-27 | Import pipeline framework | 8 | P0 | FO-4 |
| FO-28 | Parser: CAMS/KFintech CAS PDF | 8 | P0 | FO-27 |
| FO-29 | Parser: Zerodha tradebook + generic mapped contract notes | 5 | P0 | FO-27 |
| FO-30 | Email ingest | 5 | P1 | FO-27 |
| FO-31 | PMS/AIF statements and commitments | 5 | P0 | FO-27 |
| FO-32 | Corporate actions | 5 | P0 | FO-22 |
| FO-33 | Capital gains API and Schedule CG export | 5 | P0 | FO-24 |
| FO-34 | Tax-loss harvesting candidates | 3 | P1 | FO-24 |
| FO-35 | Web: Investments screens | 8 | P0 | FO-25 |
| FO-36 | Web: Dashboard v1 | 5 | P0 | FO-35 |
| FO-37 | Mobile: Dashboard + Holdings | 5 | P0 | FO-9 |
| FO-38 | Historical valuation job | 3 | P0 | FO-21 |
| FO-39 | CA review of capital-gains outputs | 2 | P0 | FO-33 |

### FO-20 — Instruments master and search

instruments table loaders: AMFI scheme master (nightly), NSE/BSE security master; GET /instruments/search with fuzzy match on name/symbol/ISIN.

**Acceptance:** Search 'parag' returns the PPFAS schemes; ISIN lookup is exact; master refresh is idempotent.

### FO-21 — Price feeds: AMFI NAV and NSE/BSE EOD

Workers: amfi.nav (23:15 IST) parses NAVAll.txt; prices.eod (18:30 IST) parses bhavcopy. Backfill command for history. Benchmark index closes.

**Acceptance:** Prices for all held instruments present by 23:30 IST; missing-price alert task raised for any held instrument > 2 trading days stale.

### FO-22 — Finance package: lots, FIFO, cost basis

packages/finance: pure functions applyTxn(lots, txn) for buy/sell/bonus/split/demerger/merger; FIFO consumption; average-cost mode; charges into cost.

**Acceptance:** 100% unit-test coverage with fixtures; property test: sum(remaining_qty) == holding.quantity after any txn sequence.

### FO-23 — Finance package: XIRR

Newton-Raphson with bisection fallback; handles same-day flows, zero-value terminal, > 1000 flows.

**Acceptance:** Matches Excel XIRR to 4 dp on 20 fixture cases; converges on pathological cases within 200 iterations.

### FO-24 — Finance package: capital-gains engine

Term classification per asset_class from tax_rules; grandfathering (31 Jan 2018 FMV) for equity; exemption allocation per entity per FY; STT/charges in cost; realized_gains rows on sell.

**Acceptance:** Fixture suite covers: pre-2018 equity, debt MF pre/post Apr-2023, listed bond, unlisted, property with/without indexation; outputs reviewed by CA (sign-off ticket FO-39).

### FO-25 — Holdings and lots API

GET /holdings with entity/bucket/type filters, totals, XIRR from cache; GET /holdings/{id}/lots; nightly xirr.recompute job; recompute on write.

**Acceptance:** p95 < 300 ms for 500 holdings; XIRR cached values match on-demand recompute.

### FO-26 — Manual investment transactions

POST /investment-txns with validation, hash de-dup, lot/holding recompute in the same transaction.

**Acceptance:** Duplicate submit is rejected with 409; sell exceeding remaining qty is rejected with a clear error.

### FO-27 — Import pipeline framework

POST /imports (multipart to MinIO/S3), import_jobs, BullMQ worker, parser registry by source+provider, header-signature detection, needs_mapping state, POST /imports/{id}/mapping saves import_mappings and re-runs.

**Acceptance:** Unknown CSV goes to needs_mapping with detected headers; after mapping, re-run imports rows; job shows rows_ok/rows_error with per-row messages.

### FO-28 — Parser: CAMS/KFintech CAS PDF

pdf text extraction (pdftotext/pdf.js) with password; parse folios, schemes (AMFI code, ISIN), transactions incl. SIP, redemption, switch, dividend; map folio PAN → entity; upsert accounts/holdings/txns.

**Acceptance:** samples/cams_cas_extracted_text_sample.txt imports to the seeded units exactly; real anonymised CAS x3 import with 0 row errors.

### FO-29 — Parser: Zerodha tradebook + generic mapped contract notes

Zerodha CSV parser; generic mapped parser using import_mappings for ICICI Direct/HDFC Sec/Kotak/Groww/Upstox/Angel; charges handling.

**Acceptance:** Both sample files import; sell creates realized_gains; mapping persists for next upload of same header signature.

### FO-30 — Email ingest

Inbound email (SES or Postmark) to per-family ingest_address; attachments create import_jobs; sender allow-list per family; PDF password from entity PAN.

**Acceptance:** Forwarding a contract note email results in a completed import within 5 min; unknown sender is quarantined with a task.

### FO-31 — PMS/AIF statements and commitments

Manual entry + text-extract parser for monthly statements: closing value, fees, capital calls, distributions; unfunded commitment; drawdown schedule → committed_outflows + tasks.

**Acceptance:** Sample PMS statement imports; AIF drawdown creates a task and outflow with the right due date.

### FO-32 — Corporate actions

Daily fetch (NSE CA feed) into corporate_actions; auto-apply bonus/split/dividend where unambiguous; demerger/merger to review; POST /corporate-actions/{id}/apply.

**Acceptance:** HDFC Bank 1:1 bonus fixture doubles qty and halves unit cost; demerger with cost split creates new holding and adjusts lots.

### FO-33 — Capital gains API and Schedule CG export

GET /capital-gains summary + lots; XLSX export in ITR-2 Schedule CG layout; PDF version.

**Acceptance:** Export for seeded FY 2026-27 shows LTCG 1,100 + 1,400 and STCG −200 by entity; CA confirms layout.

### FO-34 — Tax-loss harvesting candidates

GET /harvest-candidates: unrealised loss lots by term, offsettable against current FY realised gains per entity.

**Acceptance:** Seeded family shows Orbital (written off) and any loss lots; excludes lots < 1 day old.

### FO-35 — Web: Investments screens

Holdings table (TanStack Table: sort, filter, column picker, CSV export), Capital gains tab, Corporate actions tab, Imports tab with upload + mapping assistant.

**Acceptance:** Matches prototype; mapping assistant lets an operator map a new broker CSV in < 2 min.

### FO-36 — Web: Dashboard v1

Net worth KPI with 12-month trend, allocation donut, by-entity table, attention list (tasks), bank KPIs stubbed until Phase 2.

**Acceptance:** Numbers reconcile to /holdings totals; trend uses month-end valuations (historical valuation job).

### FO-37 — Mobile: Dashboard + Holdings

Read-only dashboard and holdings list with entity filter; pull-to-refresh; offline cache of last payload.

**Acceptance:** Renders seeded data; works offline after first load.

### FO-38 — Historical valuation job

Month-end snapshot of holdings value per entity/bucket into a valuations table for trends and drift history.

**Acceptance:** 12 back-filled month-ends from price history; dashboard trend reads from snapshots.

### FO-39 — CA review of capital-gains outputs

Walk the CA through fixture outputs and Schedule CG export; log corrections as tickets.

**Acceptance:** Sign-off recorded; all corrections merged before Phase 2 starts.

## Phase 2 — Banking and tasks — 12 tickets, 73 points

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-50 | Bank accounts CRUD and CSV import | 5 | P0 | FO-27 |
| FO-51 | Account Aggregator integration | 13 | P0 | FO-50 |
| FO-52 | Auto-categorisation engine | 5 | P0 | FO-50 |
| FO-53 | Transaction linking and reconciliation job | 8 | P0 | FO-52 |
| FO-54 | Cash flow API | 3 | P0 | FO-52 |
| FO-55 | Task engine | 8 | P0 | FO-53 |
| FO-56 | Notifications | 5 | P0 | FO-55 |
| FO-57 | Web: Banking screens | 8 | P0 | FO-53 |
| FO-58 | Web: Tasks inbox and dashboard attention | 3 | P0 | FO-55 |
| FO-59 | Mobile: Banking, Tasks, push | 5 | P0 | FO-56 |
| FO-60 | Committed outflows (auto) | 5 | P1 | FO-53 |
| FO-61 | Security hardening pass | 5 | P0 | FO-11 |

### FO-50 — Bank accounts CRUD and CSV import

Accounts per entity; bank CSV parsers (HDFC, ICICI, SBI, Kotak, Axis) + generic mapped; hash de-dup; balance_after tracking.

**Acceptance:** samples/hdfc_bank_statement_sep2026.csv imports 6 rows with 0 duplicates on re-import.

### FO-51 — Account Aggregator integration

Provider adapter (Finvu default; interface for Onemoney/Setu): consent initiate (redirect URL), webhook callback with signature verification, FI data fetch + decryption, normalise to bank_txns, balance update, consent expiry tracking → task 30 days before.

**Acceptance:** Sandbox consent flow completes end-to-end; aa.sync runs every 4 h and on demand; expired consent raises a task.

### FO-52 — Auto-categorisation engine

Rules table (regex on narration/counterparty, priority), system defaults, learned rules from PATCH /bank-txns with learn_rule; internal transfer detection between own accounts.

**Acceptance:** ≥ 90% of seeded/sample transactions categorised without user input; transfers excluded from cash flow.

### FO-53 — Transaction linking and reconciliation job

reconcile.bank job: match credits to rent_schedule (tenant/amount±TDS/date window), dividends to holdings (ex-date, qty × dps), SIP debits to folios, property tax/expense debits; set link_type/link_id; unmatched credits > threshold → task.

**Acceptance:** Kovai NEFT links to Race Course lease and flips rent row to received; HDFC dividend links to the holding; unmatched credit creates a task.

### FO-54 — Cash flow API

GET /cashflow for 30/90/365 days by category and entity; excludes transfers.

**Acceptance:** Seeded 30-day view shows inflows, outflows, net and category bars as in prototype.

### FO-55 — Task engine

tasks table CRUD; generators as pluggable functions run hourly: rent overdue, lease expiry (notice_days), property tax due, GST due, consent expiry, drawdown, unmatched credit, import failure, stale price; de-dup by source; verification hooks (pending → verified on matching import).

**Acceptance:** Each generator has a unit test; a task is never duplicated for the same source; marking a rent task done then importing the credit sets verified.

### FO-56 — Notifications

In-app inbox; push via FCM/APNs (Expo push); daily email digest (SES) with open tasks by severity; per-user preferences.

**Acceptance:** Owner receives push within 1 min of a severity-1 task; digest lists tasks grouped by module.

### FO-57 — Web: Banking screens

Accounts list with sync state and 'Sync now'; connect-account flow (AA redirect + CSV upload); transactions table with search, filters, inline re-categorise/link with 'learn rule'; cash flow card.

**Acceptance:** Matches prototype; re-categorising with learn applies to future imports.

### FO-58 — Web: Tasks inbox and dashboard attention

Tasks page with filters, assign, mark done/dismiss; dashboard 'Needs attention' shows top 5 by severity/due.

**Acceptance:** Task state changes reflect on dashboard within one refetch.

### FO-59 — Mobile: Banking, Tasks, push

Accounts and transactions screens (read + re-categorise), task list with swipe to done, push notification handling deep-links to the task.

**Acceptance:** Push opens the task; marking done syncs to web.

### FO-60 — Committed outflows (auto)

Derive advance-tax instalments from YTD income estimate, GST liabilities, card dues, SIP mandates (from txns), drawdowns; manual add; used by Phase 4 working capital.

**Acceptance:** Seeded family shows the five prototype outflows; advance tax dates are 15 Jun/Sep/Dec/Mar.

### FO-61 — Security hardening pass

Rate limiting, CSRF for cookie flows, secure headers, dependency audit, secrets scan, backup restore drill on staging.

**Acceptance:** OWASP ZAP baseline scan clean; restore from nightly backup verified.


## Phase 5 — Planning & taxation — 12 tickets, 96 points

Broken down now because it shares the capital-gains engine with Phase 1; FO-70 can start as soon as FO-24 is merged.

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-70 | Tax computation engine | 13 | P0 | FO-24 |
| FO-71 | Baseline projection job | 5 | P0 | FO-70 |
| FO-72 | Scenario CRUD, versioning, cloning | 5 | P0 | FO-4 |
| FO-73 | Action model and per-kind handlers | 13 | P0 | FO-72 |
| FO-74 | Simulation engine | 13 | P0 | FO-73 |
| FO-75 | Compare and reports | 5 | P0 | FO-74 |
| FO-76 | Review workflow and approval to tasks | 5 | P0 | FO-72 |
| FO-77 | Execution tracking and actuals matching | 8 | P0 | FO-74 |
| FO-78 | Optimiser | 8 | P0 | FO-74 |
| FO-79 | Regime comparison | 3 | P0 | FO-70 |
| FO-80 | Web: Planning & tax screens | 13 | P0 | FO-74 |
| FO-81 | Mobile: scenario review and approval | 5 | P1 | FO-76 |

### FO-70 — Tax computation engine

packages/finance/tax: per entity per FY computation from heads (salary/fees, house property with 30% + interest, business, capital gains by class/term from FO-24, other sources) → deductions by regime → slab tax (tax_slabs) + special-rate tax → surcharge with marginal relief and 15% cap on 111A/112/112A → cess → 87A rebate → 234B/234C interest given instalments paid. All parameters read from tax_* tables.

**Acceptance:** Fixture suite of 25 computations (individual/HUF × old/new × with/without gains, surcharge band edges, marginal relief) matches CA-prepared workings to the rupee; no numeric constants in code.

### FO-71 — Baseline projection job

plan.baseline nightly: build the family's baseline scenario result from current lots, leases (rent to lease end + escalation), commitments, advance tax paid; store plan_results; expose GET /tax/projection and /tax/advance-tax.

**Acceptance:** Seeded family baseline reproduces the prototype's Tax position table; advance-tax shortfall for Q2 = 835.

### FO-72 — Scenario CRUD, versioning, cloning

/plans endpoints; parent/version; entity scope; assumptions; soft delete; baseline protected.

**Acceptance:** Clone copies actions with new ids; editing an approved scenario returns 409; baseline delete returns 409.

### FO-73 — Action model and per-kind handlers

plan_actions CRUD + handlers for all 20 kinds that mutate a cloned state (lots/properties/private/cash/leases/regime). Handlers emit per-action effect (gain, term, tax, cash, warnings).

**Acceptance:** Every kind has unit tests; unsupported params rejected with field-level errors; handlers never touch real tables.

### FO-74 — Simulation engine

POST /plans/{id}/simulate: clone state → apply actions in date order → roll forward at assumed returns → tax computation per FY per entity (FO-70) → allocation, drift, goals, cash ladder, warnings; sync ≤ 50 actions else job; engine_version stamped.

**Acceptance:** Seeded scenarios 1–3 reproduce prototype summaries within rounding; deterministic across runs; p95 < 3 s for 50 actions.

### FO-75 — Compare and reports

GET /plans/compare (2–4 ids + baseline); reports tax_computation, tax_plan, scenario_compare (PDF/XLSX) with 'projection, not advice' footer.

**Acceptance:** Compare grid matches prototype; CA can open the tax computation PDF and reconcile to FO-70 fixtures.

### FO-76 — Review workflow and approval to tasks

Comments; status transitions with role checks (owner approves); approve freezes version and creates one task per action (module=planning, source=plan_action); conflict check on targets across executing scenarios.

**Acceptance:** Transition matrix tested; approving scenario 2 creates 3 open tasks; second scenario touching TCS lot returns 409.

### FO-77 — Execution tracking and actuals matching

plan.match_actuals after each import: match investment_txns / private_exits / bank_txns to planned actions (instrument, entity, qty ±2%, date ±10 d); set actual_*, variance; tolerance breach re-simulates and flags tax delta; GET /plans/{id}/execution with realised saving.

**Acceptance:** Importing the Axis Small Cap redemption marks the harvest action done with zero variance; a sale 6% off planned price triggers re-simulation and a warning task.

### FO-78 — Optimiser

tax.optimise nightly + on demand: implements the 10 rule codes in PRD 3.12 against baseline or a scenario; writes tax_suggestions with est_saving and proposed_actions; apply/dismiss endpoints.

**Acceptance:** Seeded family yields the five prototype suggestions; apply adds actions to a draft scenario; dismissed suggestions do not reappear for the same FY.

### FO-79 — Regime comparison

GET /tax/regime-compare: run FO-70 under both regimes for an entity/FY with deductions available; recommendation and saving; 'Add to scenario' creates change_tax_regime action.

**Acceptance:** HUF comparison matches prototype (old saves 290); individuals with no deductions recommend new.

### FO-80 — Web: Planning & tax screens

Five tabs per prototype: scenario list + builder (action form per kind with target pickers), results panel with per-action effects and warnings, review thread, compare grid + chart, tax position + advance tax + regime compare, optimiser list, execution tracker.

**Acceptance:** Matches prototype; building a 4-action scenario and simulating takes < 2 min for an operator; keyboard accessible.

### FO-81 — Mobile: scenario review and approval

Scenario list, result summary, comments, approve/send-back, execution progress; builder is web-only.

**Acceptance:** Owner can approve from phone with MFA re-prompt; tasks appear immediately.


## Asset-class coverage additions (phases 1 and 4) — 6 tickets, 44 points

Added after checking coverage against a standard Indian HNI allocation framework (PRD Appendix D): precious metals, REITs/InvITs, global investments, look-through, asset-class targets and model portfolios.

| Key | Phase | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|---|
| FO-40 | 1 | Extended instrument types and precious metals | 5 | P0 | FO-21 |
| FO-41 | 1 | REIT / InvIT distributions | 5 | P0 | FO-40 |
| FO-42 | 1 | Look-through exposure | 8 | P0 | FO-20 |
| FO-43 | 1 | Global holdings, FX and Schedule FA | 13 | P1 | FO-40 |
| FO-44 | 4 | Asset-class targets, bands, model portfolios, allocation policy | 8 | P0 | FO-42 |
| FO-45 | 4 | Web + mobile: asset-class lens | 5 | P0 | FO-44 |

### FO-40 — Extended instrument types and precious metals

Add silver, REIT, InvIT, foreign_stock/etf/fund, gift_city types; currency and country on instruments; IBJA gold/silver daily rate job; physical metal holdings by weight and purity; SGB coupon accrual and maturity exemption.

**Acceptance:** Physical gold entered as 100 g 24k values at the IBJA rate; SGB shows accrued coupon; tax_rules rows for gold_etf/gold_fof/sgb applied in capital gains.

### FO-41 — REIT / InvIT distributions

Parse distribution components (interest, dividend, return of capital, other) from statements or manual entry; return of capital reduces cost basis; interest/dividend flow to the tax computation heads.

**Acceptance:** Embassy REIT distribution of 5.6/unit with 2.1 RoC reduces lot cost accordingly and shows 3.5 as taxable income in the projection.

### FO-42 — Look-through exposure

instrument_exposure loader from AMFI monthly portfolio disclosures (equity/debt/gold/cash/global, country) with manual override; allocation status endpoint returns headline and look-through; concentration warning when many funds map to the same underlying class/style.

**Acceptance:** Balanced-advantage 62/38 fixture decomposes correctly; look-through allocation sums to 100 ± 0.1%; manual override wins over feed.

### FO-43 — Global holdings, FX and Schedule FA

Foreign holdings valued at RBI reference rate; SBI TTBR captured per transaction for INR gains (Rule 115); vendor EOD prices for US/UK listings; dividends gross with withholding → foreign_tax_credits; LRS remittance register per entity/FY with USD 250k limit and TCS; Schedule FA export with peak and closing INR values.

**Acceptance:** US ETF buy/sell fixture produces correct INR LTCG and Schedule FA row; LRS total warns at 90% of limit; Form 67 register lists withholding by country.

### FO-44 — Asset-class targets, bands, model portfolios, allocation policy

asset_class_targets CRUD with bands; system model portfolios seeded; apply-model sets targets; allocation_policies with strategy, review cadence (creates review task), band-breach trigger, denominator toggles; core/satellite tag on holdings with satellite share in status.

**Acceptance:** Applying Moderate sets 60/30/10 with bands; equity at 72% raises a band-breach rebalancing task; review task created 30 days before next_review_on.

### FO-45 — Web + mobile: asset-class lens

Asset-class card beside the bucket bar (target, band, headline, look-through, status), model picker, band editor, policy settings; report allocation_vs_model.

**Acceptance:** Matches prototype; mobile shows read-only lens.


## Phase 6b — Balance sheet, analytics, open data — 15 tickets, 91 points

From the platform benchmark (`family-office-BENCHMARK.md`). All P1: build after the P0 modules; each ticket lists what it depends on.

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-90 | Liabilities module | 8 | P1 | FO-53 |
| FO-91 | Insurance register and coverage adequacy | 5 | P1 | FO-90 |
| FO-92 | Lifestyle assets and operating business | 3 | P1 | FO-31 |
| FO-93 | Ownership graph and look-through consolidation | 8 | P1 | FO-6 |
| FO-94 | Nominations and succession gaps | 5 | P1 | FO-93 |
| FO-95 | TWR engine and daily valuations | 8 | P1 | FO-38 |
| FO-96 | Instrument attributes and exposure dimensions | 8 | P1 | FO-42 |
| FO-97 | IPS rules and breach monitoring | 5 | P1 | FO-96 |
| FO-98 | Private-market metrics and call forecasting | 5 | P1 | FO-31 |
| FO-99 | Fees and cost-of-ownership | 5 | P1 | FO-29 |
| FO-100 | LLM-assisted document extraction with review queue | 8 | P1 | FO-27 |
| FO-101 | Position-level reconciliation queue | 5 | P1 | FO-53 |
| FO-102 | Cash-flow forecast (12–36 months) | 5 | P1 | FO-90 |
| FO-103 | Report packs, versioning, external viewers | 8 | P1 | FO-33 |
| FO-104 | Open data: API keys, webhooks, bulk export | 5 | P1 | FO-4 |

### FO-90 — Liabilities module

liabilities + amortisation schedule; EMI matching to bank debits; interest to house-property head and forecast; LTV monitor for loans against securities/property; net worth = assets − liabilities everywhere (dashboard, balance sheet, entity view).

**Acceptance:** Home loan fixture: schedule matches bank EMI debits; 24(b) interest appears in tax projection; LAS LTV > threshold raises a task.

### FO-91 — Insurance register and coverage adequacy

Policies CRUD; premium due → committed outflow + task; surrender/fund value into net worth; covers link to property/vehicle/person; adequacy view (life cover vs liabilities + goals, health per member, uninsured assets).

**Acceptance:** Uninsured property listed; premium due creates outflow 30 days ahead; ULIP fund value counted once.

### FO-92 — Lifestyle assets and operating business

lifestyle_assets CRUD with valuation history and insurance link; private_investments.instrument=operating_business with multiple-based valuation and dividend linking.

**Acceptance:** Assets included/excluded from net worth per toggle; business dividend links from bank.

### FO-93 — Ownership graph and look-through consolidation

ownership_links CRUD (entity→entity/asset with % and role, effective-dated); look-through net worth by ultimate owner; consolidated per-branch view; property_owners migrated.

**Acceptance:** Trust 100%→ LLP 60% → property: individual beneficiary shows 60% of property value in look-through; history preserved after a change.

### FO-94 — Nominations and succession gaps

nominations + succession_documents CRUD; nightly gap job (no nominee, unverified, will overdue, mismatch) → tasks; succession gaps report.

**Acceptance:** Holding without nominee raises a task within 24 h; gap report empty after data entry.

### FO-95 — TWR engine and daily valuations

valuations.daily job (value + net flow per scope); Modified Dietz + geometric linking; twr_cache; GET /performance with benchmark; divergence note vs XIRR.

**Acceptance:** 10 fixtures match Excel to 2 dp; nightly job < 60 s for 500 holdings.

### FO-96 — Instrument attributes and exposure dimensions

attributes loader (AMFI portfolios, NSE master, ratings, fact sheets) + manual override; GET /exposure?by= over look-through; exposure report.

**Acceptance:** Sector/market-cap/rating/duration/currency/manager/liquidity views sum to 100%; unrated shown explicitly.

### FO-97 — IPS rules and breach monitoring

ips_rules CRUD (8 codes); nightly ips.evaluate → breaches + tasks; compliance report.

**Acceptance:** Max-single-issuer 10% rule flags a 12% position; resolved breach closes its task.

### FO-98 — Private-market metrics and call forecasting

fund_cashflows from statements/extractions; DPI/RVPI/TVPI/MOIC/IRR/PME; forecast calls/distributions from schedule and guidance; feed forecast + working capital.

**Acceptance:** Seeded Varaha fund shows TVPI and forecast calls in the cash-flow forecast.

### FO-99 — Fees and cost-of-ownership

fees_ledger from contract notes (brokerage/STT), PMS/AIF statements, implied TER from expense ratios; GET /fees; report with drag vs return.

**Acceptance:** Fee % of AUM per entity reconciles to statement totals within 1%.

### FO-100 — LLM-assisted document extraction with review queue

POST /documents/:id/extract → model call (structured output per doc_type) → document_extractions; review UI; approval creates import_job; confidence thresholds; PII redaction in prompts; model/version stamped.

**Acceptance:** Capital-call sample extracted ≥ 0.9 confidence; nothing written before approval; rejected items never auto-retry.

### FO-101 — Position-level reconciliation queue

recon.positions job comparing e-CAS/CAS/AA/PMS with platform; reconciliation_items with accept/keep/ignore; dashboard status; audit trail.

**Acceptance:** Injected 10-unit mismatch surfaces next run; accept_source adjusts holding and logs audit row.

### FO-102 — Cash-flow forecast (12–36 months)

cashflow.forecast job combining rent escalations, dividend history, coupons/maturities, distributions, EMIs, premiums, SIPs, taxes (planner), calls, lifestyle average; float threshold; below-float tasks; report.

**Acceptance:** Seeded family shows Oct dip from Varaha call; task raised 45 days ahead.

### FO-103 — Report packs, versioning, external viewers

report_packs with sections and audience; single-PDF generation with cover/TOC; versioned runs with supersedes + correction note; external_access invitations with scope/expiry/revoke; audit-logged views.

**Acceptance:** CA pack (capital gains + rent/GST + TDS recon) generates; corrected v2 supersedes v1 and both retained; expired viewer gets 403.

### FO-104 — Open data: API keys, webhooks, bulk export

Family-scoped keys with scopes/expiry/rate limits; webhook registry with HMAC signing, retries, dead-letter; POST /export to CSV/Parquet with signed URL.

**Acceptance:** Key with read:holdings cannot write; webhook receives task.created within 10 s; Parquet export opens in Power BI.


## General ledger — 14 tickets, 99 points

GL core lands in phase 1 (FO-46/47) so every later module can post its own events (FO-62 in phase 2, FO-63 in phase 3); the remaining GL work is phase 6a.

| Key | Phase | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|---|
| FO-46 | 1 | GL core: books, chart of accounts, journal engine | 8 | P0 | FO-3 |
| FO-47 | 1 | Posting rules engine and auto-posting for investment events | 13 | P0 | FO-46 |
| FO-62 | 2 | Auto-posting for bank and category events; bank reconciliation | 8 | P0 | FO-53 |
| FO-63 | 3 | Auto-posting for rent, GST, TDS, property tax and expenses | 8 | P0 | FO-47 |
| FO-110 | 6 | Opening balances generator | 5 | P0 | FO-47 |
| FO-111 | 6 | Manual, recurring and maker-checker journals | 5 | P0 | FO-46 |
| FO-112 | 6 | Inter-entity journals and consolidation eliminations | 5 | P0 | FO-46 |
| FO-113 | 6 | Liabilities, insurance, private and fee postings | 8 | P0 | FO-90 |
| FO-114 | 6 | Periods, close and year-end | 8 | P0 | FO-110 |
| FO-115 | 6 | Statements and ledger reports | 8 | P0 | FO-112 |
| FO-116 | 6 | Investment sub-ledger reconciliation (ABOR vs IBOR) and ITR mapping | 5 | P0 | FO-115 |
| FO-117 | 6 | Tally two-way sync | 8 | P0 | FO-115 |
| FO-118 | 6 | Web: Books screens | 8 | P0 | FO-115 |
| FO-119 | 6 | CA sign-off on books | 2 | P0 | FO-117 |

### FO-46 — GL core: books, chart of accounts, journal engine

gl_books/gl_accounts/gl_periods/gl_journals/gl_lines per migration 007; CoA template copy on book creation; journal service enforcing balance, immutability, period locks (DB triggers + service checks); sequential numbering per entity/FY; reversal; gl_balances refresh.

**Acceptance:** Migration 007 invariant tests pass in CI (balanced, immutable, locked period, one-journal-per-source); creating a book copies 84 accounts.

### FO-47 — Posting rules engine and auto-posting for investment events

Rule resolver (event_type + instrument_class + basis, family override > system); symbolic amount evaluator (gross/net/tds/cost_of_lots_sold/gain_by_term/charges/return_of_capital); gl.autopost job after imports; unposted queue with reasons; investment events: buy/sell/sip/redemption/dividend/interest/fee/capital_call/distribution; demerger cost re-allocation.

**Acceptance:** Seeded investment events post; TB investments at cost = holdings cost; a sell posts gain by term equal to realized_gains; event without rule appears in /gl/unposted.

### FO-62 — Auto-posting for bank and category events; bank reconciliation

Rules for categorised bank txns (household, medical, education, tax, GST, card payment, internal transfer with sub-ledger both sides), advance tax; bank reconciliation statement (ledger vs statement, unmatched both sides).

**Acceptance:** ICICI ••0928 reconciles to ₹0 difference on seed; internal transfer posts one journal with two 1110 sub-ledger lines.

### FO-63 — Auto-posting for rent, GST, TDS, property tax and expenses

rent.accrued (accrual books) / rent.received (both), GST output and payment, TDS receivable and 26AS true-up, property tax, expense vs capital improvement (5120 vs 1320), deposits received/refunded, tenant sub-ledger.

**Acceptance:** Race Course Road Sep rent produces the two journals in the prototype; tenant sub-ledger shows zero after receipt; cash-basis book posts only on receipt.

### FO-110 — Opening balances generator

PUT /gl/opening-balances: build balanced opening journal from holdings (cost), properties (cost + improvements), bank balances, deposits, liabilities, insurance surrender values, private investments; CA review as draft before posting.

**Acceptance:** Seeded HUF opening journal balances and matches the prototype TB after subsequent events.

### FO-111 — Manual, recurring and maker-checker journals

POST /gl/journals with draft/post; approve by different user when book.maker_checker; gl_recurring with rrule and daily job; audit rows.

**Acceptance:** Maker cannot approve own draft; recurring CA-fee journal posts monthly.

### FO-112 — Inter-entity journals and consolidation eliminations

Gift/loan/reimbursement/shared-expense between entities post mirrored journals with intercompany_group; consolidated statements eliminate 1460/2280 pairs and inter-entity income/expense; clubbing warning hook to planner.

**Acceptance:** Karta→HUF gift posts drawings/bank in Arjun and bank/capital in HUF; consolidated BS shows no inter-entity receivable/payable.

### FO-113 — Liabilities, insurance, private and fee postings

Rules for liability.emi (principal/interest split from schedule), insurance.premium, fund calls/distributions with income vs return-of-capital, fees ledger (5210/5220/5230), MTM to reserve when elected, realised FX on foreign disposals.

**Acceptance:** Home loan EMI splits per schedule; MTM journal reverses on the first day of next period; FX gain posts on US ETF sale.

### FO-114 — Periods, close and year-end

open→soft_closed→locked with preconditions (zero unposted, bank reconciled); year-end close to 3100 or partner capital by profit share; MTM if elected; next FY periods; reopen requires owner + reason.

**Acceptance:** Locking with unposted items returns 409; year-end zeroes income/expense and moves surplus to capital; partner capital split 60/40 on fixture.

### FO-115 — Statements and ledger reports

Trial balance, P&L / I&E with prior period, balance sheet, capital account, cash & fund flow, ledger statement (account or sub-ledger with running balance), consolidated with eliminations; PDF/Excel via report engine.

**Acceptance:** Prototype TB/I&E/BS reproduce for seeded HUF; consolidated BS balances across three entities.

### FO-116 — Investment sub-ledger reconciliation (ABOR vs IBOR) and ITR mapping

GET /gl/reconcile/investments per instrument cost/qty; GET /gl/reports/itr-mapping comparing GL by tax_head with tax-engine projection; differences explained (30% standard deduction, exemptions).

**Acceptance:** ITC demerger difference surfaces as in prototype; ITR mapping differences equal known adjustments only.

### FO-117 — Tally two-way sync

Tally XML export (masters from CoA with parent groups; vouchers by type: receipt/payment/journal/contra) for a date range; day-book XML import mapping ledgers by name with mapping assistant, de-dup by GUID; gl_tally_sync log.

**Acceptance:** Export → import into empty test book reproduces TB with zero duplicates; unmapped ledger names go to mapping assistant.

### FO-118 — Web: Books screens

Seven tabs per prototype: trial balance, day book + journal detail, ledger with sub-ledger search, statements with consolidated toggle, periods & close, reconciliation (bank, investments), posting rules with override editor; CA role landing page.

**Acceptance:** Matches prototype; CA can close a period and export Tally in < 5 clicks.

### FO-119 — CA sign-off on books

Walk the CA through opening balances, auto-posting rules, close procedure and statements on seeded data; corrections as tickets.

**Acceptance:** Sign-off recorded before first family goes live on books.


## Phase 7 — Action plane (AI-assisted execution) — 14 tickets, 133 points

Separation of powers is the build rule: the assistant proposes (FO-128), humans approve (FO-122), the executor executes (FO-123), the database enforces the state machine (FO-120). MF orders cannot be placed through any broker API (Kite MF is read-only), so FO-126 depends on the RIA/ARN registration; bank payments run only on current accounts (FO-127 starts with the HUF's ICICI account). See `family-office-EXECUTION-ROUTES.md`.

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-120 | Intent model, JSON schemas, state machine service | 8 | P1 | FO-46 |
| FO-121 | Simulation + policy engine for intents | 13 | P1 | FO-120 |
| FO-122 | Approval workflow with step-up auth | 8 | P1 | FO-120 |
| FO-123 | Executor service | 13 | P1 | FO-120 |
| FO-124 | Connector: Zerodha Kite Connect (equity orders + MF read) | 8 | P1 | FO-123 |
| FO-125 | Connector: ICICI Direct Breeze, Upstox, Angel SmartAPI, Dhan | 13 | P2 | FO-124 |
| FO-126 | Connector: BSE StAR MF via RIA/ARN code (Cybrilla FP or SOAP) with NACH mandates | 8 | P2 | FO-123 |
| FO-127 | Connectors: ICICI Corporate API Suite (HUF current account), BBPS agent, assisted UPI intent |
| FO-134 | NACH e-mandate registration and tracking | 5 | P1 | FO-126 | 13 | P2 | FO-123 |
| FO-128 | Assistant service (Claude) with tool manifest | 13 | P1 | FO-121 |
| FO-129 | Rule-driven intents from sources | 5 | P1 | FO-121 |
| FO-130 | Reconciliation to imports and GL | 5 | P1 | FO-53 |
| FO-131 | Oversight dashboard, anomalies, reports | 8 | P1 | FO-122 |
| FO-132 | Web + mobile: Action plane screens | 13 | P1 | FO-122 |
| FO-133 | Security review and go-live checklist | 5 | P1 | FO-131 |

### FO-120 — Intent model, JSON schemas, state machine service

action_intents + per-kind payload JSON schemas; service layer over migration 008 FSM (transitions, approvals threshold, cooling-off, kill switch); idempotency keys; expiry job; batch grouping.

**Acceptance:** Migration 008's seven invariant tests run in CI; illegal transitions and self-approval rejected at API layer with 403/409 and at DB.

### FO-121 — Simulation + policy engine for intents

On create/edit: run tax delta (planner engine), drift after (both lenses), cash/float, IPS; evaluate 14 policy codes incl. tiers, caps with usage windows, payee allow-list and new-payee block, trading hours, orders/day; write policy_result; default policies per family on creation.

**Acceptance:** Seeded ₹31,000 deployment plan yields 4 intents all passing; an intent to an unverified payee fails with the reason; caps decrement on fill and restore on cancel.

### FO-122 — Approval workflow with step-up auth

Approve/reject/cancel endpoints; TOTP, WebAuthn passkey and mobile biometric (secure enclave-signed challenge) as auth_proof; four-eyes; N-of-M by tier; batch approve; push notification with deep link; expiry.

**Acceptance:** Proposer cannot approve; two approvals needed above tier; approval record carries device/IP; batch approve of 3 intents makes one step-up.

### FO-123 — Executor service

Separate app + image + DB role; polls queued; single-flight per connector; vault read; provider adapters via a common interface (submit, status, cancel); redacted request/response logging; retries only on idempotent errors; honours kill switch and cooling-off; health endpoint.

**Acceptance:** Executor cannot select from documents or update policies (role test); pausing kill switch stops next pick-up within 10 s; crash mid-submit does not double-submit (idempotency).

### FO-124 — Connector: Zerodha Kite Connect (equity orders + MF read)

Kite Connect adapter: daily request_token exchange via user login + TOTP; place/modify/cancel equity/ETF/REIT/SGB orders; positions; MF read endpoints (holdings, orders, SIPs) as a reconciliation source. No MF order placement exists on Kite. No vendor sandbox: use a dedicated low-balance test account with the SANDBOX flag enforcing quantity=1 limits.

**Acceptance:** Test-account equity order round-trips; MF holdings read matches CAS; expired session flags connector and blocks queueing with a task for the user to log in.

### FO-125 — Connector: ICICI Direct Breeze, Upstox, Angel SmartAPI, Dhan

Same adapter interface; per-provider auth quirks; capability matrix (which kinds each supports).

**Acceptance:** Capability matrix served by /actions/schemas; each adapter passes the shared contract test suite in sandbox.

### FO-126 — Connector: BSE StAR MF via RIA/ARN code (Cybrilla FP or SOAP) with NACH mandates

Investor onboarding on the family's BSE code (UCC, FATCA, bank), NACH e-mandate registration and status, purchase/redemption/switch/SIP with mandate-based payment, order status polling, allotment → CAS reconciliation; Cybrilla Fintech Primitives adapter first, raw BSE SOAP as fallback; MF kinds flip from assisted to executable per investor once mandate is active.

**Acceptance:** Test-market purchase against a registered mandate allots units and reconciles from CAS; intent for an investor without an active mandate is created as assisted with a task to register one.

### FO-127 — Connectors: ICICI Corporate API Suite (HUF current account), BBPS agent, assisted UPI intent

ICICI CIB APIs: beneficiary registration (payee allow-list sync), NEFT/RTGS/IMPS/UPI initiation with portal-authorisation mode configurable, transaction status/UTR polling, balance; BBPS agent (Setu) fetch-bill/pay/receipt for property tax, utilities, premiums; assisted UPI-intent generator for savings accounts. HDFC/Axis/Yes/Kotak adapters behind the same interface (P2).

**Acceptance:** UAT NEFT returns UTR and reconciles to the AA feed; unregistered beneficiary is rejected before submission; BBPS property-tax bill fetched by assessment number and paid; UPI link opens the correct payee/amount.

### FO-134 — NACH e-mandate registration and tracking

Per-investor e-mandate flow (net-banking/debit-card auth) in favour of BSE StAR MF; mandate limits aligned to policy caps; status, expiry and utilisation tracked; tasks when a purchase would exceed the mandate.

**Acceptance:** Mandate registered in test market; purchase above limit is split or flagged; expiring mandate raises a task 30 days ahead.

### FO-128 — Assistant service (Claude) with tool manifest

Anthropic API with tool use; read tools over the family API; propose_intent as the only write; system prompt with policies + current simulation; structured outputs; session/message storage with model version; rate limits; PII minimisation; refusal rules.

**Acceptance:** Prototype 'deploy cash' transcript reproduces (4 drafts); assistant cannot call approve/queue (tool absent + server-side 403); every tool call logged.

### FO-129 — Rule-driven intents from sources

POST /actions/from-source for tasks, plan actions, deployment plans, rent reminders, committed outflows, IPS breaches, rebalance proposals; auto-approve for operator-scoped low-risk kinds (rent_reminder) per policy.

**Acceptance:** Approving a plan creates intents in one batch; rent reminder auto-approves and sends; nothing that moves money auto-approves.

### FO-130 — Reconciliation to imports and GL

actions.reconcile after imports: match fills/UTRs to investment_txns/bank_txns; variance; mark task/plan action verified; GL posting via existing rules with intent link.

**Acceptance:** A-112 style flow: fill → CAS import → reconciled → journal posted with intent id in narration.

### FO-131 — Oversight dashboard, anomalies, reports

GET /oversight; anomaly signals (new payee, 3× median, off-hours, rapid approve, new IP, repeated failures); limits usage; policy change log; execution audit / approval log / connector activity reports.

**Acceptance:** Prototype oversight tab reproduces on seed; anomaly on new-payee fires for A-116.

### FO-132 — Web + mobile: Action plane screens

Six web tabs per prototype; mobile approvals inbox with biometric step-up, kill switch, assistant chat; push deep links.

**Acceptance:** Owner approves a batch from phone with Face ID in < 20 s; kill switch reachable in 2 taps.

### FO-133 — Security review and go-live checklist

Threat model of the action plane; pen test on executor/vault/approval; SEBI API-trading compliance note (manual orders, static IP, order-rate cap); RBI/payment partner agreements; per-connector dry-run sign-off; kill-switch drill.

**Acceptance:** Findings closed; family goes live one connector at a time with SANDBOX_ONLY flipped per connector.


## Phase 4 — Investment Policy Framework — 8 tickets, 60 points

Owns the targets, bands, rules and guardrails from activation onward; FO-44 (asset-class targets) and FO-95 (TWR/valuations) are prerequisites; FO-121 (action-plane policy check) and FO-128 (assistant) consult the effective policy.

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-140 | Policy model, versions, inheritance | 8 | P0 | FO-44 |
| FO-141 | Risk questionnaire and profiling | 5 | P0 | FO-140 |
| FO-142 | Policy builder (wizard) and activation | 13 | P0 | FO-141 |
| FO-143 | Risk metrics engine | 8 | P0 | FO-95 |
| FO-144 | Nightly compliance and breach tasks | 8 | P0 | FO-142 |
| FO-145 | Reviews: scheduled and trigger | 5 | P0 | FO-144 |
| FO-146 | IPS document, compliance and review-pack reports | 5 | P0 | FO-142 |
| FO-147 | Web + mobile: Investment policy screens | 8 | P0 | FO-142 |

### FO-140 — Policy model, versions, inheritance

investment_policies/policy_versions/policy_allocations/policy_risk_limits per migration 009; one active version; inheritance resolver (family → entity → goal) returning effective clauses with origin; clause-level diff; validation (lens sums to 100, min ≤ target ≤ max).

**Acceptance:** Effective policy for the seeded retirement goal shows 6 overrides and inherited clauses; two active versions on one policy is impossible (DB); diff lists changed clauses only.

### FO-141 — Risk questionnaire and profiling

System questionnaire seeded by 009; family-defined questionnaires; scoring with capacity-caps-tolerance and horizon adjustment; profile → suggested model portfolio and limit set.

**Acceptance:** Seeded answers reproduce the prototype scores (44 → moderately conservative); a high-tolerance/low-capacity response profiles to the capacity band.

### FO-142 — Policy builder (wizard) and activation

10-step builder; pre-fill from profile/model/parent; simulate step (compliance if activated, tax-aware moves, expected return/vol vs objective); approve/sign with step-up; activation writes bucket_targets, asset_class_targets, ips_rules, execution_policies, glide_paths with policy_version_id and supersedes the prior version.

**Acceptance:** Activating a version updates the live tables atomically; editing a target elsewhere is redirected to 'amend policy'; signatures recorded with auth evidence.

### FO-143 — Risk metrics engine

Nightly risk.metrics from valuations_daily and prices: volatility, max drawdown, VaR 95 (historical), beta, tracking error, Sharpe, top-5 concentration, issuer/manager/sector max, illiquid %, liquidity coverage months, unrated %, leverage, FX exposure, duration; per scope; history.

**Acceptance:** Fixtures match reference calculations to 2 dp; runs < 2 min for 500 holdings; metrics available to compliance and reports.

### FO-144 — Nightly compliance and breach tasks

policy.compliance per active version: allocation bands (look-through), risk limits with warn/limit, permitted list, IPS rules, liquidity, glide path; overall status; tasks on breach; rebalancing intents when policy allows; assistant and action-plane policy check consult the effective policy.

**Acceptance:** Prototype compliance snapshot reproduces on seed; a prohibited instrument intent fails with the clause cited; breach task closes when the next snapshot is clean.

### FO-145 — Reviews: scheduled and trigger

policy.reviews daily: schedule by cadence (task 30 days ahead), triggers (breach > 30 d, drawdown beyond clause, goal change, new entity, regulation flag); findings pre-fill; outcome handling (reset date / link amended draft / supersede).

**Acceptance:** Seeded goal breach opens a trigger review after 30 days; completing with 'amended' links the new draft and the diff.

### FO-146 — IPS document, compliance and review-pack reports

Render the Investment Policy Statement PDF (clauses, tables, limits, guardrails, signatures, change log); policy compliance report with metric history; review pack; scheduled delivery to principal/CA per monitoring clause.

**Acceptance:** Prototype document text reproduces for the retirement goal; PDF regenerates on each version; review pack attaches to the review.

### FO-147 — Web + mobile: Investment policy screens

Seven web tabs per prototype; mobile: read policies and compliance, complete questionnaire, sign/approve with biometric.

**Acceptance:** Owner completes questionnaire and signs a version from phone; web builder round-trips a full policy in < 15 min for an operator.


## Phase 7 — Research & proposals — 9 tickets, 65 points

Depends on the extraction service (FO-100), the Investment Policy compliance engine (FO-144) and the action-plane intent model (FO-120). The research agent proposes and drafts; decisions are human; conversion goes through the action plane's own checks.

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-150 | Research sources, channels and ingestion | 8 | P1 | FO-100 |
| FO-151 | Recommendation extraction (agent) | 8 | P1 | FO-150 |
| FO-152 | Clustering and consensus | 5 | P1 | FO-151 |
| FO-153 | Policy-fit assessment and sizing | 8 | P1 | FO-144 |
| FO-154 | Investment proposal drafting (agent) | 13 | P1 | FO-153 |
| FO-155 | Decisions and conversion to intents | 5 | P1 | FO-120 |
| FO-156 | Periodic digest (call-to-action report) | 5 | P1 | FO-154 |
| FO-157 | Source track record and trust scores | 5 | P1 | FO-151 |
| FO-158 | Web + mobile: Research screens | 8 | P1 | FO-156 |

### FO-150 — Research sources, channels and ingestion

research_sources/channels/items per migration 010; second inbound email address per family with sender allow-list → source; upload/paste; RSS/web watch poller; WhatsApp Business inbox (BSP) P1; content-hash de-dup; text extraction via extraction service; unattributed-sender triage.

**Acceptance:** Same PDF forwarded twice is ingested once; email from an allow-listed sender is attributed to its source; unknown sender lands in triage.

### FO-151 — Recommendation extraction (agent)

Research agent extracts zero-or-more structured recommendations per item with instrument resolution against the master, action, thesis, target/stop, horizon, conviction, publish date/price, confidence; low-confidence → review queue; corrections feed back.

**Acceptance:** Sample broker note yields 6 recommendations with ≥ 0.85 confidence; unresolved instrument kept as text and flagged; correction persists.

### FO-152 — Clustering and consensus

Cluster by instrument × direction within a rolling window across sources; trust-weighted conviction; consensus line; supersession when a source flips.

**Acceptance:** Three bullish L&T calls form one cluster with '3 of 3'; a later sell from one source updates consensus and conviction.

### FO-153 — Policy-fit assessment and sizing

Assess a cluster against the effective Investment Policy for an entity/goal (permitted, bands after, issuer/sector/manager caps, rating, liquidity, tax preferences), portfolio overlap via look-through, already-held weight; verdict + fit score + sizing headroom; prohibited/conflicting auto-dismissed with clause; sell/avoid on held positions always surfaced.

**Acceptance:** Prototype verdicts reproduce on seed (fits / fits with conditions / prohibited / conflicts); sizing equals min(issuer headroom, band headroom, cash).

### FO-154 — Investment proposal drafting (agent)

draft_proposal tool: memo sections (summary, thesis, sources with track record and conflicts, counter-view mandatory, policy fit by clause, portfolio impact, tax/cash via planner, risks, sizing, execution plan by entity/connector, exit plan, monitoring triggers); citations to tool results; versioning; PDF render; expiry.

**Acceptance:** Proposal for the L&T cluster contains all sections with cited numbers; a proposal without a counter-view fails validation; PDF renders.

### FO-155 — Decisions and conversion to intents

approve/reject/defer with role checks and notes; batch decide on a digest with one step-up; approve+convert creates an action-plane intent batch (subject to its own checks); deferred re-surfaces; rejected feeds track record; proposal state machine (DB) tested.

**Acceptance:** Approving with a reduced amount creates two intents in pending_approval; illegal transitions rejected; deferred proposal reappears in the next digest.

### FO-156 — Periodic digest (call-to-action report)

research.digest weekly (configurable): items, recommendations, clusters, declined-with-reasons, themes (agent summary), source leaderboard movement, proposals awaiting decision; PDF + in-app + push; monthly copy to CA.

**Acceptance:** Sunday digest reproduces the prototype for the seeded week; every dismissed cluster appears with its reason.

### FO-157 — Source track record and trust scores

research.track_record nightly: evaluate each recommendation at 3/6/12/24 months vs price and benchmark; hit rate, excess return, sample size per source and horizon; trust score update rule; conflict-of-interest display; leaderboard endpoint and report.

**Acceptance:** Backfilled fixture of 40 recommendations yields hit rates within 1 pp of the reference sheet; trust scores move within bounds.

### FO-158 — Web + mobile: Research screens

Five web tabs per prototype; mobile: digest with approve/reject/defer and biometric step-up, share-sheet ingestion (forward a PDF/screenshot into the inbox), proposal reader.

**Acceptance:** Owner decides a digest from phone in < 2 min; sharing a screenshot from WhatsApp creates an inbox item.


## Phase 4 — Rebalancing & liquidity-timing engine — 7 tickets, 55 points

Replaces the simple rebalance proposal (FO-44's engine part). Depends on the policy builder (FO-142), cash-flow forecast (FO-102) and lot engine (FO-22); converts through the action plane (FO-120).

| Key | Summary | Pts | Pri | Depends on |
|---|---|---|---|---|
| FO-160 | Programs and triggers | 8 | P0 | FO-142 |
| FO-161 | Funding needs gatherer and coverage | 8 | P0 | FO-102 |
| FO-162 | Lot constraints | 5 | P0 | FO-22 |
| FO-163 | Solver: sources, uses, lot selection, timing | 13 | P0 | FO-161 |
| FO-164 | Plan lifecycle, simulation and conversion | 8 | P0 | FO-163 |
| FO-165 | Calendar, history and reports | 5 | P0 | FO-164 |
| FO-166 | Web + mobile: Rebalancing screens | 8 | P0 | FO-164 |

### FO-160 — Programs and triggers

rebalance_programs per scope from the policy rebalancing clause; trigger evaluator: calendar (RRULE), band breach, drift threshold, milestones (years-to-go, funded %, glide step, life event, net-worth crossing, age), funding need in look-ahead, large flow, tax year-end, policy change, manual; rebalance.evaluate nightly + event hooks.

**Acceptance:** Each trigger has a unit test; the MBA goal fires at 3 years to go; a large inflow of 6% triggers a run; runs record 'no action' when nothing is needed.

### FO-161 — Funding needs gatherer and coverage

rebalance.needs nightly: goal drawdown schedules, fund commitment schedules, advance tax/GST from planner, liability schedule, premiums, planned expenses from forecast, buffer rebuilds; manual needs; priority/flexibility; need_coverage from cash, maturities, distributions and planned moves; status transitions as cash arrives.

**Acceptance:** Seeded needs reproduce the prototype list; Varaha call shows partial coverage from cash and the rest from move #2; a met need flips status on bank reconciliation.

### FO-162 — Lot constraints

lots.constraints nightly: lock-in (ELSS, SGB, PPF, FD, AIF), exit-load windows from scheme master/fact sheets, LTCG eligibility from tax_rules, settlement days and liquidity class by instrument type; manual override; GET /holdings/:id/lot-constraints.

**Acceptance:** BAF lot bought 02 Nov 2025 shows exit load until 02 Oct 2026 and LTCG on 02 Nov 2026; ELSS lot locked 3 years.

### FO-163 — Solver: sources, uses, lot selection, timing

packages/finance/rebalance: snapshot → objective → sources in order (idle cash, maturities, redirected contributions, tax-aware sales with lot selection skipping lock-ins, deferring exit-load and near-LTCG lots) → uses (needs by priority/date, under-weights, glide) → timing (earliest/latest/planned per move, settlement buffer, dependencies, FY split, hold-cash) → plan with summary and warnings; deterministic; constraints from program.

**Acceptance:** Prototype plan reproduces on seed (move #2 chooses the LTCG-eligible lot and dates 7 Oct; T-bill replaced by liquid fund because maturity is after the need); property tests: no move under lock-in, no hard need left uncovered without a warning, turnover ≤ cap.

### FO-164 — Plan lifecycle, simulation and conversion

Plan versions with edit (exclude/adjust → re-solve); simulate via planner + policy compliance; review/approve with step-up; convert to action-plane intents scheduled on planned_date (executor holds until date; assisted where no connector); reconciliation back to moves and needs; FSM tested.

**Acceptance:** Approving creates dated intents; an intent released only on its planned date; fill marks the move executed and updates need coverage.

### FO-165 — Calendar, history and reports

GET /rebalance/calendar merging moves, settlements, needs, calendar runs, milestones, LTCG/exit-load/lock-in dates; run history; reports rebalance_plan, funding_calendar, rebalance_history.

**Acceptance:** Prototype calendar reproduces; PDF plan lists moves with constraint checks.

### FO-166 — Web + mobile: Rebalancing screens

Five web tabs per prototype with solver trace per move; mobile: needs, plan review/approve with biometric, calendar.

**Acceptance:** Owner approves a plan from phone; operator edits a move date and gets v2 with re-solved timing.

## Sequencing notes

Start the Account Aggregator provider paperwork (needed for FO-51) at the very beginning of the project — sandbox onboarding is the longest external dependency. Ask the CA for the tax-computation fixtures (FO-70) early for the same reason.
