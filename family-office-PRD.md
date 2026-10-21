# Family Office — Product Requirements Document

Version 2.1 · 11 September 2026 · Status: in build — foundation code delivered (see CODEBASE.md)

Companion artifact: `family-office-prototype.jsx` / `.html` (clickable prototype; screen names in this document match the prototype's navigation).

---

## 1. Summary

Family Office is a multi-entity wealth operations platform for Indian HNIs and family offices. It tracks every asset class an Indian family actually holds — listed securities, mutual funds, PMS/AIF, bonds and deposits, real estate, private/startup investments and cash — and then goes beyond reporting into operations: rent and GST, property tax and maintenance, goal-driven three-bucket allocation, live bank feeds, and deployment of idle cash into tax-efficient instruments.

The benchmark is mProfit's Family Office plan. Everything mProfit does (multi-asset tracking, multi-entity, XIRR, capital gains for ITR, corporate actions, benchmark comparison, imports from 700+ sources, Tally export) is table stakes here. The differentiators are the eight operational modules that mProfit does not have: Real estate, Startups, Goals & buckets, Planning & taxation (what-if simulation and tax optimisation), Banking (live), Working capital, a General ledger that makes the platform the system of record, and an AI-assisted action plane that turns approved decisions into broker and bank instructions under human control.

### 1.1 Goals

1. One consolidated, always-current view of net worth across all family entities.
2. Zero manual re-keying: every recurring data source is imported or fed automatically.
3. Every rupee is assigned to a bucket (Liquidity / Income / Growth) and a goal, and drift from target is visible and actionable.
4. Property, tax and compliance obligations (rent, TDS, GST, property tax, lease renewals) are tracked with deadlines, never missed.
5. Idle cash is detected within a day and a tax-aware deployment plan is proposed.
7. Any material financial decision can be simulated first: projected tax, cash and allocation are visible before the family acts, and execution is tracked against the plan.
8. Approved actions can be executed from inside the platform through broker and bank connectors, with policy limits, four-eyes approval, cooling-off and a kill switch, so the loop from analysis to execution to books closes without re-keying.
9. The platform is the family's system of record: every financial event posts double-entry into each entity's books, so investment reporting and the accounts never disagree, and the CA works from the platform's trial balance rather than a rebuilt Tally.
6. Reports that a CA can use directly for ITR and GST filing.

### 1.2 Non-goals (v1)

- Autonomous execution. The platform (and its AI assistant) can *prepare and submit* orders and payments through connected broker and bank APIs, but only after policy checks and explicit human approval with step-up authentication (3.18). Nothing executes without a person approving that specific action. Where no API exists, the platform prepares an assisted instruction the person completes manually.
- Investment advice. The assistant explains, simulates and drafts actions the family has framed (rebalance to targets, deploy idle cash per the ladder, pay what is due); it does not originate security recommendations, and every draft shows its reasoning and simulated effect.
- Full multi-currency reporting (base currency other than INR) and automated foreign broker feeds (v2). Tracking foreign holdings in INR, with FX, Schedule FA and DTAA credit, is in v1 — see 3.2.
- Advisor/multi-client mode (v2; schema should not preclude it).

### 1.3 Personas

| Persona | Needs | Typical device |
|---|---|---|
| Principal (family head) | Net worth, drift, what needs my decision now | Mobile first, web for deep dives |
| Family member (spouse, adult child) | Own entity view, goals, approvals | Mobile |
| Operator (family office manager / EA) | Imports, reconciliation, task execution, rent follow-ups, document filing | Web |
| CA / accountant | Books: journals, trial balance, period close, ITR mapping, Tally sync, capital gains, GST register, TDS reconciliation | Web |

---

## 2. Product map (end-to-end flow)

This is the spine of the product; every module plugs into one stage.

1. **Onboard** — create the family and its entities (Individual, HUF, spouse, later: private trust, LLP, company); capture PAN, GSTIN, tax slab; set bucket targets; connect banks via Account Aggregator consent; import MF CAS and broker contract notes; add properties and private investments.
2. **Ingest** — daily: AMFI NAVs, NSE/BSE EOD prices (15-min delayed intraday optional), AA bank feed; on arrival: email-forwarded contract notes, CAS PDFs; monthly: PMS/AIF statements; manual: startup rounds, property events, maintenance.
3. **Reconcile & post** — match bank credits to rent / dividends / coupons / redemptions; match demat e-CAS to holdings; match TDS to Form 26AS; apply corporate actions and surface exceptions; every matched event auto-posts a balanced journal into the entity's books.
4. **Analyse** — net worth, XIRR, allocation, bucket drift, idle cash, capital gains position, upcoming commitments.
5. **Plan** — what-if scenarios (sell, defer, harvest, transfer, regime change, property sale with 54EC/54F) simulated into projected tax by FY, cash, allocation and goal impact; compared, reviewed, approved.
6. **Act** — generate tasks (rebalance, deploy cash, send rent reminder, file GSTR, renew lease, pay property tax); assign; mark done; verify on next import.
7. **Report** — statements and schedules, PDF/Excel, scheduled delivery to family and CA.

---

## 3. Functional requirements by module

Each module lists: purpose, key screens (matching the prototype), user stories with acceptance criteria (AC), and business rules. Priority: **P0** = must ship in v1, **P1** = v1 if time allows, **P2** = later.

### 3.1 Entities & family setup (P0)

**Purpose.** Everything is scoped to an entity; the family is the container.

**Screens.** Settings → Entities; entity switcher in the navigation rail (web) and header (mobile).

**Stories**

- As a principal I can create a family and add entities of type Individual, HUF, Private Trust, LLP, Company with PAN, optional GSTIN(s), residential status, and tax regime (old/new) and slab.
  - AC: entity type drives which tax rules apply (e.g., HUF has its own ₹1.25 L LTCG exemption; GST threshold tracked per GSTIN).
- As a principal I can invite family members and assign roles: Owner, Member (own entities), Operator (all entities, no billing/role changes), Viewer (read-only, optionally scoped to reports only).
  - AC: every read and write is checked against `family_id` and role; a Viewer cannot see documents unless explicitly granted.
- As any user I can switch the active entity filter to "All entities" or one entity and every screen respects it.
- As an owner I can invite an **external viewer** (CA, advisor, banker) with a scope (entities, modules, specific reports) and an expiry date; access is revocable and every view is audit-logged; external viewers never see documents or bank transactions unless the scope says so.

### 3.2 Investments (P0)

**Purpose.** mProfit-parity tracking of listed and pooled investments.

**Screens.** Investments → Holdings · Capital gains · Corporate actions · Imports.

**Asset types (v1).** Every asset class in a standard Indian HNI allocation framework is a first-class instrument type:

| Allocation class | Instrument types | Valuation source | Notes |
|---|---|---|---|
| Equity | Stocks, ETFs, equity/hybrid MFs, PMS, AIF (Cat III), unlisted (via 3.4) | NSE/BSE EOD, AMFI NAV, statements | Hybrid and multi-asset funds are decomposed by look-through (below) |
| Debt and fixed income | Listed bonds/NCDs, G-Secs, T-bills, debt MFs (liquid/overnight/arbitrage/target maturity), FDs/RDs, NPS, PPF, EPF, AIF (Cat II credit), insurance (surrender/fund value) | Prices, NAV, accrual, statements | EPF/PPF included or excluded from allocation by policy toggle |
| Gold and precious metals | Physical gold and silver (weight, purity), digital gold, SGBs, gold/silver ETFs and FoFs | IBJA daily rate for physical, NSE for ETFs/SGBs, AMFI for FoFs | SGB coupon and maturity exemption handled |
| Real estate | Direct property (3.3), REITs and InvITs | Valuations, NSE | REIT/InvIT distributions split into interest / dividend / return of capital for tax |
| Cash and liquid | Bank balances, overnight and liquid funds, cash | AA feed, AMFI | Working-capital module (3.7) |
| Global | Foreign stocks and ETFs via LRS, international FoFs / global funds (INR), GIFT City products, foreign bank/broker cash | Price in instrument currency × RBI reference rate; SBI TTBR on transaction dates for tax | LRS remittance register (USD 250k limit, TCS), Schedule FA report, dividend withholding and DTAA credit (Form 67) |
| Alternatives | AIF Cat I/II, startups (3.4), other manual assets | Statements, marks | |

F&O and commodities: P1. Crypto: not in v1.

**Stories**

- Import MF holdings from CAMS/KFintech CAS (PDF, password-protected) and via MF Central API refresh.
  - AC: parser handles consolidated CAS with multiple PANs; each folio maps to an entity by PAN; transactions de-duplicated on (folio, date, amount, units).
- Import broker contract notes and tradebooks (Zerodha, ICICI Direct, HDFC Sec, Kotak, Groww, Upstox, Angel — CSV/XLS/PDF) and via email forwarding to a per-family ingest address.
  - AC: unknown broker formats are queued for "mapping assistant" where an operator maps columns once; the mapping is saved.
- Import PMS/AIF monthly statements (PDF) and record NAV/valuation, capital calls, distributions, fees.
  - AC: unfunded commitment is computed and shown; drawdown due dates create tasks.
- View holdings with cost (FIFO lots), current value, unrealised gain, XIRR, bucket, entity; filter and group by any of these; export.
- Compute capital gains per entity per financial year with lot-level detail.
  - Rules: FIFO per demat/folio; equity STCG ≤ 12 months at 20%, LTCG > 12 months at 12.5% above ₹1.25 L exemption per entity; grandfathering of cost to 31 Jan 2018 FMV for equity/equity MF; debt MF bought after 1 Apr 2023 taxed at slab; listed bonds LTCG > 12 months at 12.5%; unlisted shares LTCG > 24 months at 12.5%; real estate LTCG > 24 months at 12.5% without indexation (or 20% with indexation for property acquired before 23 Jul 2024, whichever is lower); STT and brokerage included in cost. All rates live in a `tax_rules` table keyed by FY so changes are data, not code.
  - AC: output matches ITR-2 Schedule CG structure and exports to Excel in that layout.
- Apply corporate actions automatically (bonus, split, dividend, rights, buyback, demerger with cost apportionment, merger, name/ISIN change) from a corporate-actions feed; flag any that need review.
- Tax-loss harvesting: list positions with unrealised loss that can offset realised gains in the current FY.
- Look-through exposure: for hybrid, balanced-advantage, multi-asset, FoF, international and REIT/InvIT instruments, hold a composition (equity / debt / gold / real estate / cash / global, with country) from AMFI monthly portfolio disclosures or fact sheets, editable manually; allocation and drift are shown both headline and look-through.
  - AC: a 65/35 balanced fund contributes 65 % to equity and 35 % to debt in the look-through view; "10 equity funds" that are all large-cap show as one concentrated equity exposure.
- LLM-assisted extraction: any uploaded PDF (capital call, NAV statement, contract note from an unknown broker, PMS statement, loan or insurance statement) is passed to a document-extraction model that returns structured fields with a confidence score into a **review queue**; an operator corrects/approves and the approval creates the import. Rule-based parsers remain the first choice for known formats; extraction handles the long tail.
  - AC: a capital-call notice PDF yields fund, amount, due date and bank details with ≥ 0.9 confidence on the sample set; nothing is written to holdings or commitments until approved.
- Position-level reconciliation: nightly compare platform holdings to NSDL/CDSL e-CAS, MF CAS, AA balances and PMS statements; exceptions (quantity/amount mismatch, missing either side) go to a queue with accept-source / keep-platform / ignore actions and an audit trail; reconciliation status shown on the dashboard.
- Global holdings: record foreign stocks/ETFs with instrument currency, cost in that currency and the SBI TT buying rate on the transaction date; value daily at RBI reference rate; capital gains computed in INR per Rule 115; dividends recorded gross with foreign tax withheld; LRS remittances tracked per entity per FY against the USD 250 k limit with TCS; Schedule FA export lists every foreign asset with peak and closing values in INR.
  - AC: a US ETF bought in USD and sold 30 months later produces a 12.5 % LTCG line in Schedule CG and an entry in Schedule FA; the withholding shows in the Form 67 credit register.

### 3.3 Real estate (P0)

**Purpose.** Full lifecycle of each property: value, tenancy, rent, taxes, GST, maintenance, capital improvements.

**Screens.** Real estate → Properties · Rent ledger · Taxes & GST · Maintenance.

**Stories**

- Add a property with type (residential / commercial / land / under-construction), entity owner(s) with ownership %, acquisition date and cost (with stamp duty and registration), current valuation (manual, with valuation history), documents.
- Add a lease: tenant (name, PAN, contact), rent, escalation rule, deposit, start/end, GST applicability, TDS applicability, due day.
  - AC: rent expected entries are generated monthly; lease end creates a task 90 days ahead.
- Rent ledger: expected vs received, auto-matched to bank credits by tenant name/amount/date window; overdue after due day + grace; one-tap reminder (WhatsApp/email template).
- GST on commercial rent: per GSTIN, SAC 997212 at 18%; monthly GSTR-1 and GSTR-3B liability computed; filing status tracked; threshold monitor at ₹20 L aggregate turnover per GSTIN; residential rent to individuals exempt.
  - AC: GST register export matches GSTR-1 B2B format.
- TDS under 194-I: expected TDS computed when tenant is liable; reconciled against Form 26AS import; mismatches flagged.
- Property tax: per-property schedule (half-yearly/annual) with authority, assessment number, amount, due date; paid status matched to bank debit.
- Maintenance log: date, vendor, item, amount, receipt; tagged as revenue expense or capital improvement (capital improvements roll into cost of acquisition for capital gains).
- Property P&L: rent − (property tax + maintenance + insurance + society charges + loan interest) with gross and net yield on current valuation.

### 3.4 Startups & private investments (P0)

**Purpose.** Register and value private holdings, which have no price feed and instrument-specific mechanics.

**Screens.** Startups (list, detail with round history, exit scenario).

**Stories**

- Add an investment with instrument type: Equity, CCPS, CCD, SAFE/iSAFE (post-money or pre-money, valuation cap, discount), convertible note, angel fund units (AIF Cat I), with date, amount, shares/units, entity, SHA/term sheet documents.
- Record rounds: pre-money, amount raised, post-money, new share count; system computes diluted holding %; unconverted instruments show "conversion pending" with modelled conversion at cap/discount.
- Valuation mark: last priced round by default; manual override with reason; history retained.
- Commitments: fund drawdown schedule with due dates → tasks and working-capital outflows.
- Exit scenario: partial/full at a price; computes gain, holding period, tax (unlisted LTCG > 24 months at 12.5%), and effect on bucket allocation.
- Status: Active, Unconverted, Exited, Written off (loss recorded for set-off).

### 3.5 Goals & buckets (P0)

**Purpose.** The allocation framework that turns holdings into a strategy.

**Screens.** Goals & buckets (strategy bar, goals, rebalancing tasks, glide path). The three-bucket bar also appears on the Dashboard.

**Two lenses on the same holdings.**

1. **Buckets** — Liquidity (near-term needs), Income (cash-yielding assets covering lifestyle), Growth (long-horizon). Every asset is assigned a default bucket by type (editable per asset). This is the goal-based lens.
2. **Asset classes** — Equity / Debt / Gold / Real estate / Cash / Global / Alternatives, computed headline and look-through. This is the conventional risk lens used by advisers (e.g. 60-30-10, 70-15-15, conservative/moderate/aggressive). Targets carry optional min–max bands for tactical ranges.

Both lenses have targets at family level (optionally per entity), both show drift, and both feed the rebalancing engine. Targets, bands, glide paths and the allocation policy are clauses of the active Investment Policy (3.19); editing them creates a policy amendment. An **allocation policy** records the family's strategy type (strategic, tactical, dynamic, core-satellite, goal-based), the model portfolio in use, review cadence (default annual, generating a review task), the band-breach threshold that raises a rebalancing task, and whether self-occupied property and EPF/PPF count in the denominator. Holdings can be tagged **core** or **satellite** so the satellite share is reported separately.

**Model portfolios.** System models (Conservative 30/60/10, Moderate 60/30/10, Aggressive 80/12/8, 70-15-15, Multi-asset with global) plus family-defined ones; applying a model sets the asset-class targets and bands in one step.

**Stories**

- Set target % per bucket; the strategy bar shows actual vs target and drift per bucket.
- Set asset-class targets and bands directly or by applying a model portfolio; the asset-class card shows headline vs look-through actual, band breaches, and satellite share.
- Life-stage and risk-profile guidance: the glide path can be driven by a risk profile (conservative / moderate / aggressive) as well as by a goal date.
- Add a goal: name, target year, amount needed (today's money + inflation assumption), funding entity, bucket, linked assets (optional). Funded % = linked/allocated value ÷ inflated need; on-track test uses an assumed return per bucket.
- Rebalancing: drift and band breaches trigger the rebalancing engine (3.21), which proposes timed, tax-aware moves (from over-weight to under-weight bucket) preferring: tax-free moves first (new cash, maturities), then lowest-tax sales (LTCG within exemption, loss lots), and creates tasks.
- Glide path: per-goal or family-level rule that steps Growth down and Income up as the retirement/income-floor date approaches; visualised as target line vs actual.

### 3.6 Banking (P0)

**Purpose.** Live balances and categorised transactions across all bank and card accounts.

**Screens.** Banking → Accounts · Cash flow · Transactions.

**Stories**

- Connect accounts through an RBI Account Aggregator (Finvu, Onemoney, or Setu as AA aggregator SDK) with consent per entity; consent expiry tracked (12 months) with renewal task.
  - AC: balances refresh at least every 4 hours; transactions pulled daily and on demand ("Sync now").
- Fallback: CSV/XLS/PDF statement import for any bank; de-duplicated by (account, date, amount, narration hash).
- Auto-categorisation by rules (regex on narration, amount ranges, counterparty) and learned from user corrections; categories include Rental income, Dividend, Interest, Redemption, SIP/Investment, Property tax, Maintenance, Tax payment, Household, Medical, Education, Travel, Transfer (internal, excluded from cash flow).
- Link transactions to the asset that produced/consumed them (rent → property/lease; dividend → holding; SIP → folio; drawdown → fund); this is what drives reconciliation.
- Cash flow view: inflows/outflows by category for 30/90/365 days per entity.
- Credit cards: balance and due date; due creates a working-capital outflow.

### 3.7 Working capital (P0)

**Purpose.** Detect idle cash and propose a horizon-matched, tax-efficient deployment ladder.

**Screens.** Working capital (float vs excess, committed outflows, deployment plan, instrument ladder).

**Rules (all configurable per family)**

- Required float = sum of committed outflows in the next N days (default 60) + a buffer of M months of average household outflow (default 1).
- Committed outflows are sourced automatically: advance tax dates (15 Jun/Sep/Dec/Mar) estimated from YTD income, GST liabilities, property tax schedule, fund drawdowns, card dues, SIP mandates, EMIs, plus manually added items (school fees, events).
- Idle flag: savings/current balance above required float for ≥ 30 days.
- Deployment ladder maps each rupee of excess to the horizon at which it is needed and picks the instrument class for that horizon:
  - 0–7 days: overnight fund
  - 7–90 days: liquid fund
  - dated commitments 3–12 months: T-bill (91/182/364) or bank FD if better post-tax
  - undated 6–12+ months in a 30% slab entity: arbitrage fund (equity taxation)
  - 1–3 years: target-maturity debt fund / high-quality bonds
- Post-tax yield = gross yield × (1 − applicable rate) where rate depends on entity slab, instrument tax treatment (`tax_rules`), and expected holding period; the ladder table shows gross and post-tax side by side.
- "Create tasks" turns the plan into executable tasks with amounts, entity, instrument and destination account; marked done by the operator; verified when the corresponding debit and MF purchase appear.
- Drag metric: (post-tax yield of best available instrument − savings rate) × idle amount × idle days ÷ 365.
- **Cash-flow forecast (12–36 months)**: monthly projected inflows (rent with escalations, dividends from history, coupons and maturities, fund distributions, salary/fees) and outflows (EMIs, premiums, SIPs, property tax, GST, advance tax from the planner, capital calls, school fees and other committed items, average lifestyle spend); cumulative cash line with the required-float threshold; months that dip below float raise a task in advance.

### 3.8 Tasks & alerts (P0)

**Purpose.** The single queue that connects analysis to action across modules.

**Screens.** Dashboard "Needs attention"; a Tasks inbox (web: under Dashboard; mobile: More → Tasks); in-module task lists.

- Task = {title, why (generated reason), module, entity, amount, due date, assignee, status (open / done / dismissed), verification (pending / verified / mismatch), source record link}.
- Generators: rent overdue, lease expiry, property tax due, GST filing due, TDS mismatch, advance tax due, drift > threshold, idle cash, fund drawdown, consent expiry, corporate action review, import failure, unmatched bank credit > ₹X.
- Notifications: in-app, push (mobile), email digest (daily/weekly), optional WhatsApp for rent reminders to tenants (template messages via a BSP such as Gupshup/Twilio; P1).

### 3.9 Reports (P0)

**Screens.** Reports (list + preview + export).

| Report | Contents | Formats |
|---|---|---|
| Consolidated net worth statement | By asset class × entity, by bucket, MoM/YoY change, as-of date | PDF, Excel |
| Capital gains — ITR Schedule CG | Lot-level, STCG/LTCG split, grandfathering, exemptions used, per entity per FY | Excel (ITR layout), PDF |
| Rental income & GST register | Per property, per GSTIN, rent/GST/TDS/net, GSTR-1 B2B layout | Excel, PDF |
| TDS reconciliation | Expected vs 26AS by deductor | Excel |
| XIRR by entity and asset class | 1Y/3Y/5Y/SI vs benchmarks (Nifty 50, Nifty 500, CRISIL composite bond, custom blends) | PDF, Excel |
| Bucket drift & rebalancing history | Monthly target vs actual, tasks executed | PDF |
| Working capital utilisation | Idle days, drag, deployed yield | PDF, Excel |
| Private investments register | Rounds, marks, MOIC, unfunded commitments | Excel |
| Cash flow statement | By category, bank, entity | Excel, PDF |
| Property P&L | Per property, yields | PDF, Excel |
| Allocation vs model | Headline and look-through asset-class allocation vs targets/bands, satellite share, per entity | PDF, Excel |
| Schedule FA (foreign assets) | Every foreign holding/account with peak and closing INR values, income, per entity per FY | Excel (ITR layout) |
| Look-through exposure | Underlying equity/debt/gold/global exposure across all funds and REITs | PDF |
| Balance sheet | Assets by class incl. lifestyle and business − liabilities, headline and look-through by ownership | PDF, Excel |
| Performance (TWR + XIRR) | Per scope and period vs benchmark, with divergence note | PDF, Excel |
| Exposure | Sector, market cap, geography, currency, issuer, rating, duration, manager, liquidity | PDF, Excel |
| IPS compliance | Rules, current values, breaches and resolution | PDF |
| Fees and cost of ownership | Fees by kind/instrument/entity, drag vs return | PDF, Excel |
| Cash-flow forecast | 12–36 months by kind with float threshold | PDF, Excel |
| Private-market metrics | DPI/TVPI/IRR/PME per fund, J-curve forecast | PDF, Excel |
| Succession gaps | Assets without nominee, unverified, documents due | PDF |
| Tax computation | Per entity per FY: heads, deductions, tax, advance tax, interest — baseline or scenario | PDF, Excel |
| Tax plan / scenario comparison | Scenario actions, projected effect, side-by-side vs baseline, review trail | PDF |
| Books: trial balance, P&L, balance sheet, capital account, cash flow, ledger, ITR mapping, bank reconciliation | Per entity and consolidated with eliminations | PDF, Excel |
| Tally sync | Masters + vouchers XML export; day-book import | XML |
| Research digest / investment proposal / source track record | Weekly call-to-action digest, proposal memos, source leaderboard | PDF |
| Rebalance plan / funding calendar / rebalance history | Timed moves with constraints and coverage; needs timeline; runs and outcomes | PDF, Excel |
| Investment Policy Statement | Rendered IPS per scope with clauses, allocations, limits, guardrails, signatures, change log | PDF |
| Policy compliance / review pack | Nightly compliance history, risk metrics vs limits, drift, review findings | PDF, Excel |
| Execution audit / approval log / connector activity | Intents with simulation, policy, approvals (auth evidence), executions, reconciliation | PDF, Excel |

**Report packs**: a pack is an ordered set of reports with parameters for an audience (principal, family, CA, advisor, trustee), generated as one PDF with a cover and table of contents, versioned per period; a corrected pack supersedes the prior version with a correction note and both are retained. Packs can be scheduled (e.g. quarterly to the CA) and shared with external viewers.

All reports: entity filter, period filter, scheduled email delivery (monthly to family, quarterly to CA), watermark with family name and generation timestamp.

### 3.10 Documents (P1)

- Folder tree per entity with system folders (Deeds, Tax filings, Statements, SHAs, Bank statements, Insurance, Wills) and custom folders; documents link to the record they belong to (property, holding, investment, lease).
- Storage: S3-compatible object store with server-side encryption; virus scan on upload; 25 MB per file, PDF/JPG/PNG/XLS/DOCX.
- Full-text search over PDF text (P2).

### 3.12 Planning & taxation (P0)

**Purpose.** Let the family test decisions before making them. A scenario is a named list of "if" actions; the engine returns the "then": projected tax per entity per FY, cash freed, resulting bucket allocation and goal funding. Scenarios are versioned, reviewed and compared; an approved scenario becomes tasks whose execution is tracked against plan.

**Screens.** Planning & tax → Scenarios (builder + results + review thread) · Compare · Tax position · Optimiser · Execution.

**Concepts**

- **Baseline** — one auto-maintained scenario per family with no actions; recomputed nightly from current holdings, leases, commitments and paid advance tax. Every scenario is measured against it.
- **Scenario** — name, description, base date, horizon (default 3 FYs), entity scope, assumptions (expected return per bucket, inflation, regime per entity, property price growth), status (draft → in review → approved → executing → completed / archived), version and parent (cloning creates a new version).
- **Action kinds** — sell holding (qty/price/date), buy instrument, switch, redeem before a date, defer sale to a FY, harvest loss, book gain within exemption, transfer between entities (gift / loan / HUF), change tax regime, sell property, reinvest under 54EC / 54F, prepay loan, exit private investment, donate (80G), contribute NPS / PPF, change rent / lease, deploy cash, custom (amount + tax head).
- **Result** — summary (tax total, saving vs baseline, post-tax cash, projected net worth, max drift), per-FY per-entity tax computation (heads, deductions, slab tax, special-rate tax, surcharge, cess, rebate), advance-tax instalments with shortfall and 234B/C interest, allocation after, goal funding after, monthly cash ladder, warnings.
- **Suggestion** — an optimiser output with code, rationale, estimated saving and ready-made actions; can be added to a scenario or dismissed.

**Stories**

- As a principal I create a scenario, add actions in sequence, and see the projected result update after each simulate.
  - AC: simulate returns in < 3 s for ≤ 50 actions; each action shows its own gain/term/tax/cash effect and warnings (e.g. lot becomes short-term, 54EC window, clubbing).
- As a principal I compare up to four scenarios side by side (tax by FY, saving, cash, drift, income bucket, projected net worth, execution risk) with the baseline always included.
- As a family member or CA I comment on a scenario; the owner sends it for review and approves it; the approval records who and when and freezes the version.
  - AC: only Owner can approve; an approved scenario cannot be edited — clone to change.
- On approval every action becomes a task (module = planning, source = plan_action) with due date, entity, amount and assignee; the scenario moves to executing.
  - AC: two executing scenarios cannot act on the same holding/property (409 on approve).
- As an operator I mark actions done or the system does it: the reconciliation job matches imported transactions (instrument, entity, quantity ± 2 %, date window ± 10 days) to planned actions and records actual amount/date and variance.
  - AC: variance beyond tolerance (price ± 5 % or date ± 15 days) re-runs the simulation and flags the tax delta on the scenario.
- As a principal I see the execution tracker: progress %, next due action, planned vs realised saving, per-action variance.
- Tax position: per entity per FY projected computation for the baseline (or any scenario), old vs new regime comparison with recommendation, advance-tax schedule with shortfalls and interest exposure; exports "Tax computation" and "Tax plan" reports.
- Optimiser: nightly and on demand, checks the rules below and lists suggestions ordered by estimated saving.

**Optimiser rules (v1)**

| Code | Check |
|---|---|
| use_ltcg_exemption | Unused ₹1.25 L equity LTCG exemption per entity with long-term lots in gain |
| harvest_loss | Loss lots that offset gains already booked this FY (short against short/long, long against long) |
| split_across_fy | A planned sale whose gain exceeds exemption can be split across 31 March |
| wait_for_long_term | Lots within 90 days of crossing the long-term threshold where slab rate > LTCG rate |
| regime_switch | Old vs new regime per entity given deductions available (80C, 80D, 24(b), 80CCD, HRA) |
| route_to_entity | New investment or SIP should sit in the entity with the lowest marginal rate, subject to clubbing (64(1)(iv), 64(2)) and gift rules |
| sec_54ec / sec_54f | Property or long-term asset sale with gain that can be sheltered (caps, timelines) |
| advance_tax_gap | Cumulative instalment paid < due → 234C interest; final shortfall → 234B |
| nps_80ccd / donate_80g | Headroom in 80CCD(1B) and 80G with qualifying-limit maths |
| defer_to_next_fy | Sale planned in the last 45 days of a FY where next FY's exemption/slab is better |

**Business rules and guardrails**

- All rates, slabs, surcharge, cess, rebate and deduction limits are data (`tax_rules`, `tax_slabs`, `tax_surcharge`, `tax_deduction_limits`) keyed by FY and regime; the engine has no hard-coded numbers.
- Surcharge on 111A/112/112A gains is capped at 15 %; marginal relief applied.
- Clubbing: transfers from an individual to spouse or to HUF (by karta) carry a warning and, by default, keep the income in the transferor's computation.
- Grandfathering, indexation choice for pre-23 Jul 2024 property, and holding-period thresholds come from the capital-gains engine (3.2) — the planner calls the same functions.
- The planner never executes anything; it produces tasks. Simulations are labelled "projection, not advice" in exports.

### 3.14 Balance-sheet completeness (P1)

**Purpose.** Net worth that a family office would recognise: every asset and every liability, owned through whatever structure, with succession mapped. Closes gaps A1–A3, A5, B1, B3 in the benchmark (`family-office-BENCHMARK.md`).

**Screens.** Balance sheet (assets vs liabilities by entity and class; look-through by ownership) · Liabilities · Insurance · Lifestyle assets · Ownership & succession.

**Stories**

- Liabilities: home loans, loans against securities/property, personal/vehicle/education loans, credit lines, guarantees — lender, outstanding, rate (fixed/floating), EMI and day, amortisation schedule, security (linked property/holding) with LTV, tax section (24(b), 80C, 80E). EMIs match to bank debits; interest flows to the tax computation (house-property head) and to cash-flow forecast; LTV breach on a loan against securities raises a task.
- Insurance register: term/endowment/ULIP/health/critical-illness/property/vehicle/liability policies with sum assured, premium and frequency, next due (task + committed outflow), maturity, surrender/fund value (counts in net worth), what the policy covers (person, property, vehicle), nominee, tax section. Coverage adequacy view: life cover vs liabilities + goals, health cover per member, uninsured properties and vehicles.
- Lifestyle assets: art, jewellery, vehicles, watches, collectibles — cost, manual valuation with history, insurance link, include/exclude from net worth, documents (invoices, valuation certificates).
- Operating business interests: family company / LLP stakes via `private_investments` with `instrument = operating_business`; valuation by manual mark or multiple of audited profit; dividends/drawings linked from bank.
- Ownership graph: an entity can own another entity, a property, a private investment, a lifestyle asset or an account with a percentage and role (shareholder, partner, trustee, beneficiary, karta, member). Look-through net worth by ultimate individual owner; consolidated view per branch; effective-dated so history is preserved.
- Nominations and succession: nominee per asset (holding/folio, demat, bank, policy, property, private investment), registered-with and verification date; succession documents register (will, trust deed, POA, HUF deed) with review dates; **gap report**: assets with no nominee, unverified nominations, wills overdue for review, nominee-vs-will inconsistencies.
  - AC: adding a holding without a nominee raises a low-severity task within 24 h; the gap report reconciles to zero after nominations are recorded.

### 3.15 Performance and risk analytics (P1)

**Purpose.** Institutional-grade measurement without institutional complexity. Closes C1, C3, C4, C7, C8.

**Stories**

- Time-weighted return (daily valuation, Modified Dietz within period, geometric linking) alongside XIRR for every scope (asset, entity, bucket, family, goal) and period (1Y/3Y/5Y/SI/custom); benchmark and excess return; the report explains when TWR and XIRR diverge (large flows).
  - AC: TWR matches an Excel reference to 2 dp on 10 fixtures including mid-period contributions and withdrawals.
- Exposure by dimension using look-through and instrument attributes: sector, market-cap band, geography, currency, issuer, credit rating, duration band, manager, liquidity class (T+0 … locked). Attributes loaded from AMFI portfolio disclosures, NSE master, rating agencies, fact sheets; manual override.
- IPS rules (owned by the active policy version, 3.19): configurable limits (max single issuer %, max single manager %, min credit rating, max illiquid %, max sector %, max unrated %, min liquidity months, max leverage %) per family/entity; nightly evaluation writes breaches and raises tasks; IPS compliance report.
- Private-market metrics per fund/investment: DPI, RVPI, TVPI, MOIC, IRR, PME vs a listed benchmark; call and distribution history from `fund_cashflows`; forecast calls/distributions from commitment schedule and manager guidance (J-curve), feeding the cash-flow forecast and working capital.
- Fees and cost of ownership: implied TER from NAV-based expense ratios, PMS management/performance fees, AIF fees, brokerage, STT, DP charges, advisor fees — by entity, instrument and FY; fee drag as % of AUM and vs return; report.

### 3.16 Open data (P1)

- Family-scoped API keys with scopes and expiry; the same REST API the apps use (`/api/v1`), rate-limited.
- Webhooks for task.created, import.done, rent.overdue, ips.breach, plan.approved, reconciliation.mismatch with HMAC signatures and retry.
- Bulk export of any core dataset as CSV or Parquet (signed URL), for Excel/Power BI or the family's own analysis; scheduled exports P2.
- MCP server exposing read tools over the API so an AI assistant can answer questions on the family's own data: v1.1 (E5).

### 3.17 General ledger (P0)

**Purpose.** Entity-level double-entry books that are produced by the platform, not reconstructed from it. Investment book of record (holdings, lots, valuations) and accounting book of record (journals) share the same source events, so they cannot drift. The CA's deliverables — trial balance, P&L / income & expenditure, balance sheet, capital account, ITR head mapping — come straight out of the books.

**Screens.** Books → Journals (day book) · Ledger · Trial balance · Statements (P&L, balance sheet, capital account, cash flow) · Periods & close · Reconciliation (bank, investments) · Chart of accounts · Posting rules · Tally.

**Concepts**

- **Book** — one per entity: basis (accrual default; cash optional for individuals), FY start month, books start date, mark-to-market election (post unrealised gains to a reserve at period end), depreciation election (business entities), maker-checker toggle.
- **Chart of accounts** — a system template (84 accounts, Indian family-office groups, Tally parent-group mapping, ITR tax-head tag on income/expense accounts) copied into each book; families add accounts under the groups; system accounts are protected because posting rules depend on them.
- **Journal** — balanced set of lines (debit = credit enforced by the database), sequential number per entity per FY, source (auto, manual, recurring, opening, closing, Tally import, reversal), link to the source event (investment transaction, bank transaction, rent row, property expense, EMI, premium, capital call, fee, corporate action, valuation), optional sub-ledger on each line (holding, property, tenant, bank account, liability, private investment, vendor). **Posted journals are immutable**; corrections are reversals. Periods can be open, soft-closed or locked; locked periods reject postings at the database level.
- **Posting rules** — event type (+ optional instrument class and basis) → line template with symbolic amounts (`gross`, `net`, `tds`, `cost_of_lots_sold`, `gain_by_term`, `principal`, `interest`, `return_of_capital` …). 26 system defaults; families override per event. Auto-posting runs after every import/reconciliation; events with no applicable rule land in an **unposted queue** rather than being silently skipped.
- **Inter-entity** — gifts, loans, reimbursements and shared expenses between entities post mirrored journals in both books with a common group id; consolidated statements eliminate them.
- **Partner capital** — for LLP/partnership/HUF books, partner/member capital accounts with profit-share %; year-end close allocates surplus by share.

**Stories**

- On creating an entity book the CoA is copied, periods for the FY are created, and opening balances are generated from platform data (holdings at cost, properties at cost + improvements, bank balances, liabilities, deposits) into a balanced opening journal that the CA reviews before posting.
- Every subsequent source event posts automatically: a share sale posts proceeds, charges, cost of lots sold (from FIFO) and gain by term; rent accrual posts receivable, income and GST output; receipt posts bank, TDS receivable and clears the receivable; an EMI posts principal and interest split from the amortisation schedule; a capital call moves cash into the private-investment asset; a fund distribution splits income and return of capital.
  - AC: for the seeded family, auto-posting every seeded event produces a trial balance that balances and whose investment, bank and receivable balances equal the platform's holdings cost, bank balances and outstanding rent respectively.
- An operator posts manual and recurring journals; with maker-checker on, a second user approves drafts.
- Reversal, never edit: a posted journal can only be reversed (with reason); the pair is shown together.
- Period close: soft-close blocks auto-posting except by the closer; lock requires zero unposted items and a completed bank reconciliation; year-end close transfers income/expense to capital (or partner capital by share), posts MTM if elected, and opens the next FY.
- Reconciliation: bank ledger vs statement (unmatched both sides, difference to explain); investment sub-ledger cost/quantity vs holdings (ABOR vs IBOR) per instrument.
- Reports (per entity and consolidated with eliminations): trial balance, P&L / income & expenditure with prior period, balance sheet, capital account, cash & fund flow, ledger statement (account or sub-ledger with running balance), ITR head mapping reconciled to the tax projection (3.12), bank reconciliation statement.
- Tally two-way sync: export masters and vouchers as Tally XML for a date range; import a Tally day book (vouchers become journals, ledgers mapped by name, duplicates by GUID) so a CA who keeps working in Tally can still round-trip.

**Business rules and guardrails**

- INR is the book currency; foreign-asset lines carry the original currency and rate; realised FX gain/loss posts on disposal, unrealised FX under MTM only.
- Capital gains by term come from the same engine as the tax module (3.2); the GL never recomputes them.
- Corporate actions that change quantity without cash (bonus, split) post no journal; demergers post a cost re-allocation between the two instruments.
- The GL does not file anything and does not replace the CA; it hands the CA a closed, reconciled set of books.

### 3.18 AI-assisted execution and the action plane (P1)

**Purpose.** Close the loop from decision to execution without giving up control. An **intent** is a structured, simulated, policy-checked instruction (buy/sell/redeem/switch/SIP, transfer/bill/tax/GST payment, capital-call payment, rent reminder, or an assisted manual instruction). Intents are drafted by the AI assistant, an operator, or a rule; they are approved by humans with step-up authentication; they are executed by a separate executor service through connectors; they are reconciled on import and posted to the GL. The design principle is **separation of powers**: the AI can propose, only humans can approve, only the executor can execute, and the database enforces the state machine.

**Screens.** Action plane → Approvals (inbox) · Assistant · In-flight & history · Connectors · Policies & payees · Oversight. Mobile: approvals inbox with biometric step-up, kill switch, assistant chat.

**Flow**

1. **Draft.** Sources: assistant session (e.g. "deploy the idle cash per the ladder", "rebalance HUF to targets", "pay everything due this week"), an operator form, or a rule (rent reminder on overdue, deployment plan → intents, approved plan action → intent, IPS breach → rebalance intent). Each intent carries a payload validated against the per-kind JSON schema, an amount, the source it came from, and a rationale.
2. **Simulate.** The same engines as the rest of the product: tax delta (3.12), bucket/asset-class drift after (3.5), cash after and float check (3.7), IPS rules (3.15). Warnings are attached (lot becomes short-term, exemption exhausted, payee new, outside trading hours).
3. **Policy check.** The effective Investment Policy (3.19) is consulted first — prohibited instruments, bands the intent would breach, guardrail caps — then execution policies configurable per family/entity/kind: max single amount, daily and monthly caps, orders per day, approvers required (with amount tiers), cooling-off minutes above a threshold, allowed/blocked instruments, allow-listed payees only, new-payee blocking period, trading-hours only, simulation required, tax check required on sells, IPS pass required. Any failure → `policy_failed` with the reasons; the intent cannot proceed until edited or a policy is changed by an owner (audit-logged).
4. **Approve.** Approvers see the intent, its simulated effect, policy results, the assistant's reasoning and the exact provider request that will be sent. Step-up auth (TOTP, device biometric, passkey) is required per approval or per batch. **Four-eyes**: the human who proposed cannot approve; N approvals above tiers; cooling-off delays queueing for large amounts so a second look is possible; expiry after 24 h by default. Batch approval covers a whole deployment plan or rebalance with one step-up while each intent still passes its own policy.
5. **Execute.** A separate **executor** service (own DB role, own container, allow-listed egress to provider domains, no access to the LLM) pulls `queued` intents, refuses if the kill switch is on, submits via the connector with an idempotency key, records the redacted request/response and provider reference, and tracks status to filled/failed. Retries only for idempotent failures. Partial fills are visible; cancels are attempted on request.
6. **Reconcile and post.** The next contract-note/CAS/bank import matches the fill or payment to the intent (variance recorded), the GL posting rule fires, and the originating task or plan action is marked done and verified.

**Connectors (v1 set; each ships with a sandbox mode)**

| Kind | Providers | What we can do | Constraints |
|---|---|---|---|
| Broker | Zerodha Kite Connect, Upstox, Angel One SmartAPI, ICICI Direct Breeze, Dhan | Place/modify/cancel equity, ETF, REIT/InvIT, SGB and listed-bond orders; read positions; Kite MF **read only** (holdings, orders, SIP status) | Kite requires a daily login (request token) and TOTP — the human completes it, which keeps every order a manual, human-initiated order under SEBI's API/algo framework (static IP registered, no algo tagging needed at our order rates). No broker offers MF order placement by API. |
| MF platform | BSE StAR MF (SOAP web services, or via Cybrilla Fintech Primitives) or MFU, under the family's own SEBI RIA code (direct plans) or AMFI ARN (regular plans); NACH e-mandate per investor funds purchases without a net-banking step | Purchase, redemption, switch, SIP mandate | Requires the intermediary registration (see `family-office-EXECUTION-ROUTES.md`); until then all MF kinds run as *assisted* intents |
| Bank API | ICICI Corporate API Suite (first: HUF current account ••0928), then HDFC ENet / Axis / Yes / Kotak API banking for other current accounts | NEFT/IMPS/RTGS/UPI to pre-registered payees, transaction status, balance and statement; bank-side "with portal authorisation" mode keeps the bank's checker in the loop initially | Current accounts only; static IP, certificates, UAT sign-off. Individual savings accounts have no payment-initiation API — UPI-intent assisted, plus NACH e-mandates for MF purchases |
| Bills & tax | BBPS agent API (Setu / Razorpay) for property tax, utilities, insurance premiums; GSTN challan + bank API for GST; income-tax e-pay challan (assisted) | Fetch bill, pay, receipt | Biller coverage varies by municipality |
| Payout | RazorpayX / Decentro-style payouts from a family-controlled virtual account | Vendor payments, refunds | Money first moves to the virtual account (an intent itself) |
| Assisted | — | Pre-filled instructions: UPI intent link, RBI Retail Direct bid, PMS/AIF forms, cheque details; person completes and confirms | Always available as fallback |

**The assistant**

- Runs on the Anthropic API with a tool manifest: read tools over the family's own data (holdings, cash, tasks, plans, IPS, tax projection, prices, policies) and exactly one write tool, `propose_intent`. It cannot approve, queue, execute, change policies or connectors, or read credentials.
- Every session, message, tool call and result is stored with model and version; proposed intents cite the data they used.
- Prompts include the family's policies and the current simulation so drafts arrive pre-checked; the assistant explains trade-offs in plain language and never claims an action has happened.
- Guardrails: no free-text amounts or payees — payloads come from tool results (instrument ids, payee ids, computed amounts); rate-limited; PII minimised; refuses actions outside the family's own accounts.

**Oversight plane**

- Approvals inbox (web and mobile) with severity, expiry and batch grouping; daily digest.
- In-flight and history with provider references, fills, fees, variance, and links to the task, plan action, import and GL journal.
- Limits consumed today/month per entity and kind; connector health and session expiry; policy change log.
- Anomaly signals: new payee, amount > 3× the 90-day median for that kind, outside trading hours, repeated failures, intent proposed and approved within 60 seconds, connector used from a new IP.
- **Kill switch**: any owner or member can pause all execution instantly (queued intents stay queued); only an owner can resume with a reason. Executor refuses to run while paused (database-enforced).
- Reports: execution audit, approval log, connector activity.

**Stories**

- As a principal I ask the assistant to deploy this month's idle cash; it returns four intents matching the working-capital ladder with tax and drift effects; I approve the batch on my phone with Face ID; the executor places two MF purchases via Kite MF and two T-bill bids as assisted instructions; fills reconcile from the next CAS import and post to the books.
  - AC: no intent leaves `pending_approval` without an approval row from a different user with step-up evidence; the executor log shows the idempotency key; the GL journal links back to the intent.
- As an operator I turn an overdue rent into a reminder intent (WhatsApp/email) — low-risk kinds can be auto-approved by policy for operators, everything that moves money cannot.
- As an owner I set policies: single amount ≤ ₹5 L for one approver, ₹5–25 L needs two approvers, > ₹25 L two approvers plus 30-minute cooling-off; payees must be verified by a second user and are blocked for 24 h after creation.
- As any family member I hit the kill switch from the mobile app; the executor stops within one polling interval (≤ 30 s).

**Security and regulatory guardrails**

- Credentials live in a vault (KMS-encrypted; HashiCorp Vault or cloud KMS), referenced by id; the API can register/revoke them, only the executor can read them; TOTP seeds for broker logins are stored the same way.
- Executor runs as its own container and DB role (`executor_user`: read intents/policies, write executions, update intent status only); egress allow-list of provider domains; no LLM access; static IP registered with brokers.
- SEBI (API trading/algo framework): orders are individually human-approved and submitted at low frequency, i.e. non-algorithmic manual orders via broker APIs; if order rates ever approach the threshold, algo registration is required — a policy cap (`max_orders_per_day`) keeps us well below.
- RBI/payments: account-to-account payments use the bank's own corporate API or a licensed BBPS/payout partner; the platform never holds funds; Account Aggregator remains read-only.
- Every approval records auth method, device, IP; every policy change is audit-logged with before/after; the execution audit report is exportable for the family's auditor.
- Sandbox first: every connector supports a sandbox flag; a family goes live per connector after a dry-run intent succeeds end to end.

### 3.19 Investment Policy Framework (P0)

**Purpose.** One governing document — the Investment Policy Statement — per family, per entity and per goal, built through a wizard, expressed as machine-checkable clauses, monitored every night, and reviewed on a cadence or on triggers. The buckets (3.5), asset-class targets and bands (3.5), IPS rules (3.15), execution guardrails (3.18), glide paths and benchmarks stop being loose settings: each lives inside a policy version, so a change to any of them is a policy amendment with a version, an approver, a signature and a diff.

**Screens.** Investment policy → Policies · Builder (wizard) · Allocation & bands · Risk & guardrails · Compliance · Reviews · Document.

**Scopes and inheritance.** The family policy sets defaults; an entity policy (e.g. Mehta HUF) and a goal policy (e.g. Retirement income floor) inherit every clause and override only what differs (a goal five years out gets tighter drawdown and higher liquidity than the family default). The effective policy for any portfolio is parent ∘ override, shown clause by clause with its origin.

**What a policy version contains**

| Section | Clauses | Machine-checked against |
|---|---|---|
| Objectives | Purpose, return objective (real/nominal), horizon, spending need | Projected return vs objective (simulation); goal funded % |
| Risk | Profile (from questionnaire), capacity vs tolerance, max drawdown accepted | Risk metrics (3.15 + new): volatility, max drawdown, VaR, beta, tracking error, Sharpe |
| Strategic allocation | Bucket targets; asset-class, sub-class, geography and currency targets with min–max bands; glide path | Look-through allocation nightly; band breach → warning/breach |
| Constraints | Liquidity months, tax preferences (direct plans, LTCG-first, exemption use), legal, unique circumstances | Liquidity coverage months; planner and optimiser respect tax preferences |
| Permitted & prohibited | Instrument types, minimum rating, prohibited list, approved managers | Holdings and *intents* checked; a prohibited instrument cannot be proposed by the assistant or approved in the action plane |
| Concentration & structure | Max single issuer / manager / sector / illiquid / unrated / leverage / FX / duration | IPS rules (3.15) evaluated nightly |
| Rebalancing policy | Bands and/or calendar, tolerance, new-cash-first, tax-aware | Rebalancing engine settings (3.5) |
| Monitoring | Benchmark, tracking-error limit, who receives reports, review cadence, triggers | Report packs (3.9); review scheduling |
| Guardrails | Execution policies and approval tiers (3.18) derived from the policy | Action plane enforces them |
| Governance | Approver, signatories, effective dates, change summary | Version history and diff |

**Builder (wizard)**

1. Choose scope (family / entity / goal) and starting point: risk questionnaire, model portfolio, copy of parent, or blank.
2. Risk profile: 12-question system questionnaire across capacity, tolerance, horizon and knowledge (families can add their own); scoring where **capacity caps tolerance** (a family that wants risk it cannot afford is profiled to what it can afford), producing one of five profiles and a suggested model portfolio and limit set.
3. Objectives and constraints in plain language with numbers.
4. Allocation: start from the model, adjust targets and bands per lens; the builder shows current actual vs proposed and the tax cost of getting there.
5. Risk limits and IPS rules: pre-filled from the profile, editable.
6. Permitted list and managers.
7. Rebalancing, monitoring and review cadence.
8. Guardrails: approval tiers and execution caps proposed from the profile and amounts.
9. **Simulate**: compliance of the current portfolio against the draft, required moves (tax-aware), expected return/vol vs objective.
10. Review → approve → sign (step-up auth) → activate with an effective date. Activation writes the clauses into the live tables (bucket_targets, asset_class_targets, ips_rules, execution_policies, glide_paths) so every other module reads the policy, not a separate setting.

**Monitoring and review**

- Nightly compliance snapshot per active policy: allocation bands, risk limits, permitted list, IPS rules, liquidity, glide path; overall status compliant / warning / breach; breaches raise tasks and, where the rebalancing policy allows, rebalancing intents.
- Scheduled reviews on the cadence (default annual; quarterly for goal policies within 5 years) create a review task 30 days ahead with findings pre-filled: compliance history, drift trend, metric trends, goal progress, life events logged since the last review (new goal, property sale, liability, entity added).
- Trigger reviews open automatically on: a breach persisting more than 30 days, a market move beyond the policy's drawdown clause, a goal date or amount change, a new entity, or a regulation flag from the tax-rules table.
- A review ends in no change (next date reset), amended (new draft version linked) or superseded.
- The rendered Investment Policy Statement (PDF) carries all clauses, allocation tables, limits, guardrails, signatures and the change log; the review pack adds compliance and metric history.

**Stories**

- As a principal I complete the questionnaire for the family and for the retirement goal; the family profiles moderate and the goal moderately conservative; the builder proposes 60/30/10 with bands for the family and 40/50/10 with a 10 % max-drawdown limit and 36 liquidity months for the goal.
  - AC: capacity score below tolerance score yields the capacity band; the goal policy shows its overrides with the parent's values beside them.
- As an owner I activate a policy version with my signature; the same night the compliance job reports a breach on equity (72 % vs max 70 %) and an issuer concentration warning; a rebalancing task appears with tax-aware moves.
- As a CA reviewer I open the annual review; findings show 11 months of compliance, one breach resolved in 14 days, TWR vs objective, and two life events; I record "amended" and the new draft opens with the diff.
- As the assistant I refuse to propose an intent in a prohibited instrument and say which clause blocks it.

**Business rules**

- Only one active version per policy; activation supersedes the previous with `effective_to` set; history is immutable.
- Allocations per lens must sum to 100 ± 0.5; min ≤ target ≤ max.
- Goal policies cannot be riskier than their entity policy's capacity band unless the owner overrides with a note.
- The action plane consults the effective policy of the intent's entity/goal; a prohibited instrument, a band breach the intent would worsen, or an execution cap above the policy's guardrails fails the policy check.

### 3.20 Research assistant and investment proposals (P1)

**Purpose.** Every recommendation the family receives — research-house reports, broker calls, advisor notes, PMS manager letters, newsletters, media, and tips from friends — lands in one inbox, is turned into structured recommendations, is judged against the Investment Policy (3.19) and the current portfolio, and either dies quietly with a reason or becomes a written **investment proposal**. A periodic **digest** presents the proposals as calls to action; approve converts a proposal into action-plane intents (3.18), which still go through their own policy checks and human approval. The research agent proposes; it never decides.

**Screens.** Research → Inbox · Recommendations · Proposals · Digest · Sources & track record · Settings (channels).

**Ingestion channels**

| Channel | How | Notes |
|---|---|---|
| Email | Dedicated research ingest address per family (separate from the statements address); sender allow-list maps to sources | Newsletters, broker morning notes, advisor emails, forwarded reports |
| Upload / paste | Web and mobile; PDF, image, text | Research PDFs, screenshots of WhatsApp forwards, a friend's message |
| WhatsApp | WhatsApp Business inbox number the family forwards to | P1; media and text |
| RSS / web watch | Feeds and watched pages | Public research, exchange announcements |
| API | Broker/research-house APIs where available | P2 |

**Pipeline**

1. **Ingest** — de-duplicate by content hash; attach to a source (auto from sender, else "unattributed" for triage); extract text (PDF/image OCR via the extraction service, 3.2).
2. **Extract** — the research agent turns each item into zero or more recommendations: instrument (resolved to the instruments master, else kept as text), action (buy/sell/hold/accumulate/reduce/avoid/switch/subscribe/redeem/watch), thesis, target, stop, horizon, conviction, publish date and price. Low-confidence extractions go to a review queue.
3. **Cluster** — same instrument and direction across sources within a window become one cluster with a consensus line ("4 of 5 bullish; one broker sell") and a trust-weighted conviction.
4. **Assess** — against the effective Investment Policy for the proposed entity/goal: permitted list and prohibited instruments, bands the position would move, issuer/manager/sector caps, liquidity and rating clauses, tax preferences; against the portfolio: already held (and at what weight), overlap through look-through, correlation with existing exposures; **sizing** from policy headroom (issuer cap, bucket band, cash available). Verdict: fits / fits with conditions / conflicts / prohibited / insufficient information. Prohibited and conflicting clusters are dismissed with the clause cited; they appear in the digest's "declined" section so nothing is silently dropped.
5. **Propose** — for clusters that fit (or on request for any idea), the agent drafts a proposal memo: summary; thesis in the family's words; sources with their track record and conflict-of-interest flags; the strongest counter-view (from a bearish source, or one the agent constructs from the data); policy fit clause by clause; portfolio impact (allocation after, drift, concentration); tax impact and cash after from the planner (3.12); risks; sizing rationale; execution plan (which entity, which connector, staged or single, limit vs market); exit plan (target, stop, review trigger, horizon); monitoring triggers. Every number cites the tool result it came from.
6. **Digest** — weekly by default: what arrived, what was dismissed and why, themes, source leaderboard movement, and the proposals awaiting decision, each with approve / reject / defer. One step-up authentication decides the batch. Approved proposals with `convert` create an intent batch in the action plane; deferred ones return in a later digest; rejected ones are recorded with a note and feed the source's track record.

**Source track record.** Each recommendation is evaluated at 3, 6, 12 and 24 months against price and a benchmark: hit rate and excess return per source and per horizon, with sample size. Trust scores update from the record and weight future consensus. Conflicts of interest are recorded per source (earns brokerage, distributes regular plans, manages the PMS being recommended) and shown on every proposal. A "friend" source starts at low trust and is never proposed without an independent thesis.

**The research agent**

- Same separation of powers as 3.18: read tools over research items, holdings, policy, planner, prices and track record; write tools limited to `create_recommendation`, `create_assessment`, `draft_proposal` and `draft_digest`. It cannot decide, approve, or create intents.
- Prompts include the effective policy clauses and the sizing headroom, so drafts arrive pre-checked; it must produce a counter-view for every proposal and cite sources for every claim; it labels its own inferences as such.
- Regulatory posture: the platform produces internal decision memos for the family's own money; it does not distribute research or advice to third parties (no SEBI Research Analyst registration is implied). Proposals carry that statement.

**Stories**

- As a principal I forward a broker note, a research-house PDF and a friend's WhatsApp tip; by evening the inbox shows three items, five recommendations, two clusters, one dismissed as prohibited (small-cap below the rating clause) with the clause cited, one assessed "fits with conditions" (issuer cap allows ₹8,000).
  - AC: duplicates of the same PDF are ingested once; the friend's tip is attributed to a low-trust source and flagged as needing an independent thesis.
- As a principal I open Sunday's digest: two proposals await; one is approved with a smaller amount, one deferred to the next quarter; approval creates a two-intent batch that appears in the action-plane inbox for the second approver.
- As a member I read a proposal: thesis, the bear case, policy fit line by line, "already held 8.1 % via HDFC Bank; this would take the issuer to 9.6 % of the cap 10 %", tax and cash impact, and a staged execution plan.
- As the family I see, after a year, that the research house is 62 % right at 12 months with +4.1 % excess, the broker 48 % with −1.2 %, and a friend 2 for 7.

**Business rules**

- No proposal without an assessment; no assessment without an effective policy version.
- Proposals expire (default 30 days) unless deferred; conversion always goes through the action plane's own policy check and approvals.
- Dismissals are recorded with reasons and are reversible; "avoid" and "sell" recommendations on held positions always surface in the digest even when the source is low-trust.

### 3.21 Rebalancing and liquidity-timing engine (P0)

**Purpose.** Turn the policy's allocation clauses and the family's dated cash needs into a schedule of specific, tax- and cost-aware moves, each with a date — not "sell some equity" but "redeem 41.2 units of the balanced-advantage fund on 7 Oct (exit load expires 2 Oct, LTCG-eligible), settling 10 Oct, to fund the ₹20,000 Varaha drawdown due 14 Oct". Replaces the simple rebalancing proposal in 3.5 and feeds the action plane (3.18).

**Screens.** Rebalancing → Programs & triggers · Funding needs · Plan (timed moves) · Calendar · History.

**Programs.** One per scope (family, entity, goal), created from the policy's rebalancing clause. A program defines what triggers a run and under which constraints:

| Trigger | Fires when |
|---|---|
| Calendar | RRULE cadence (monthly, quarterly, annual, e.g. first business day of April) |
| Band breach | Any policy allocation leaves its min–max (look-through) |
| Drift threshold | Sum of absolute drift across a lens exceeds N pp |
| Milestone | Goal years-to-go crosses a step (e.g. 5, 3, 1), goal funded % reaches a level, a glide-path step date, a life event (retirement, sale of business, inheritance), net worth crosses a threshold, age |
| Funding need | A dated need enters the look-ahead window (default 120 days) that cash and maturing instruments cannot meet |
| Large flow | Inflow/outflow above x % of scope value (bonus, property sale proceeds, capital call) |
| Tax year-end | February–March run to use LTCG exemptions and harvest losses before 31 March |
| Policy change | A new policy version activates |
| Manual | On demand with a chosen objective |

Constraints: minimum trade size, maximum turnover per run, avoid exit loads, respect lock-ins, prefer new cash and maturities before sales, tax-aware lot selection, wait up to N days for LTCG eligibility, cap on tax cost per run, settlement buffer days.

**Funding needs (liability-driven timing).** Dated cash requirements gathered automatically — goal drawdowns from the goal schedule, fund capital calls from commitment schedules, advance-tax and GST instalments from the planner, EMIs and loan maturities, insurance premiums, planned expenses from the cash-flow forecast, buffer rebuilds when the working-capital float is breached — plus manual needs (school fees, a wedding, a distribution to a family member). Each has an amount, a date, flexibility (how late it may be met), a priority (hard: tax and calls; firm; soft) and a destination account. The engine tracks coverage: which cash balance, maturity or planned move funds it, and when that money is available.

**The solver (per run)**

1. Snapshot: look-through allocation on every lens, cash by account, needs inside the look-ahead window, lot constraints, prices.
2. Objective: back to target, to band edge, fund needs only, needs plus bands, or glide step.
3. Sources of funds in order: idle cash above float → maturities and distributions inside the window → new contributions/SIPs redirected → sales from over-weight classes, choosing lots by tax cost (loss lots, then long-term within exemption, then highest cost basis), skipping lots under lock-in and, where allowed, deferring lots inside an exit-load window or within `ltcg_wait_days` of eligibility.
4. Uses of funds: needs by priority and date, then under-weight classes toward target, then glide-step adjustments.
5. **Timing**: for each move compute the earliest date (constraints clear), the latest date (need date minus settlement minus buffer), and pick the planned date closest to the need to keep money invested longest; sequence dependencies (buy after the sell settles); split across financial years when it saves tax; hold cash explicitly when the need is imminent.
6. Output a plan: moves with dates, amounts, lots, reasons, estimated gain/tax/cost/exit load, constraint checks; allocation after; cash timeline vs needs; summary and warnings (uncovered needs, turnover cap hit, tax cost above cap, band still outside after plan).
7. Simulate through the planner (3.12) and policy compliance (3.19) so the plan is checked before anyone sees it.

**Approval and execution.** A drafted plan goes to review; the owner approves with step-up auth; converting creates action-plane intents *scheduled on each move's planned date* (the executor holds them until then; assisted where no connector exists). Fills reconcile back to moves; needs flip to funded/met as cash arrives; a run that finds nothing to do records "no action" so the history shows the engine looked.

**Calendar.** One timeline of everything that has a date: planned moves and their settlements, needs, calendar runs, milestone dates, and the lot-level gates that delay moves — LTCG-eligibility dates, exit-load and lock-in expiries.

**Stories**

- As a principal I see the Varaha drawdown of ₹20,000 due 14 Oct inside the 120-day window with only ₹11,000 of idle cash above float; the engine plans a ₹9,400 balanced-advantage redemption on 7 Oct (after the exit-load window ends 2 Oct, LTCG-eligible, settling 10 Oct) and marks the need fully covered.
  - AC: the move's earliest date is the later of exit-load expiry and LTCG date; the latest date is need date − settlement − buffer; planned date falls in that window.
- As an owner I set the family program to quarterly calendar plus band triggers, and the retirement-goal program to a 5-year milestone that steps equity down 10 pp, funded from new SIPs for six months before any sale.
- As the family in March, the tax year-end run proposes booking ₹1,250 LTCG in TCS (exemption) and harvesting the Axis Small Cap loss, both timed before 31 March, and defers one equity trim to 3 April because it lands in next year's exemption.
- As an operator I exclude one move from a draft and change a date; the plan re-solves, re-simulates and becomes v2 with the diff.

**Business rules**

- The engine never sells under lock-in and never breaches a hard need; if a need cannot be met without breaking a constraint it raises a task rather than a plan.
- Every plan carries its policy version and simulation; approval requires no new compliance breach after the plan (or an owner override with a note).
- Programs are owned by the policy version's rebalancing clause; editing a program is a policy amendment when it changes bands, cadence or tax-awareness.

### 3.13 Dashboard (P0)

- KPIs: net worth (with 12-month trend), live bank balances, idle funds flagged, rent due/received/overdue this month, capital gains YTD with estimated tax.
- Three-bucket strategy bar with drift pills.
- Allocation donut by asset class coloured by bucket.
- Net worth by entity with MoM and XIRR.
- Needs attention: top 5 open tasks by severity and due date.

---

## 4. Calculations

- **XIRR**: Newton-Raphson on dated cash flows including current value as terminal flow; computed per asset, entity, bucket, family; cached nightly; on-demand for custom periods.
- **Cost basis**: FIFO by default; average cost for MF where folio-level FIFO is not applicable; lot table retains every purchase with remaining quantity.
- **Valuation**: listed = last close × qty; MF = NAV × units; PMS/AIF = last statement NAV; property = last manual valuation; private = last mark; deposits = principal + accrued interest; insurance = fund/surrender value.
- **Bucket drift**: (actual % − target %) per bucket on total investable net worth (real estate included in Income by default; configurable to exclude self-occupied property).
- **Goal funded %**: allocated value ÷ (need × (1 + inflation)^(years)); on-track if projected value at assumed bucket return ≥ inflated need.
- **Working capital**: see 3.7.
- **Post-tax yield**: uses `tax_rules` for the instrument's taxation (slab, equity STCG/LTCG, listed debt) and entity slab.
- **Scenario simulation**: clone the current state (lots, properties, private marks, leases, cash, commitments, advance tax paid); apply actions in date order, each through the same lot/FIFO and capital-gains functions used for actuals; roll holdings forward at assumed bucket returns to each FY end; compute each entity's tax computation per FY (heads → deductions → slab tax + special-rate tax → surcharge with marginal relief → cess → rebate 87A → interest 234B/C); derive allocation, drift, goal funded % and a monthly cash ladder. Baseline = same run with no actions. Deterministic: same inputs → identical result (`engine_version` recorded).

---

## 5. Data model (PostgreSQL 16)

Conventions: `uuid` primary keys, `family_id` on every tenant table, `created_at/updated_at`, soft delete via `deleted_at`, money as `numeric(18,2)`, quantities `numeric(18,6)`, all timestamps `timestamptz`. Row-level security enabled on tenant tables with `family_id = current_setting('app.family_id')::uuid`.

### 5.1 Core

```
families(id, name, base_currency 'INR', created_at)
users(id, email, phone, name, password_hash, mfa_secret, created_at)
family_members(id, family_id, user_id, role enum[owner,member,operator,viewer], entity_scope uuid[] null)
entities(id, family_id, type enum[individual,huf,trust,llp,company], name, pan, dob_or_incorp, residential_status, tax_regime enum[old,new], slab_rate numeric, created_at)
entity_gstins(id, entity_id, gstin, state_code, registered_on, active)
```

### 5.2 Investments

```
instruments(id, type enum[stock,etf,mf,pms,aif,bond,sgb,gsec,tbill,fd,rd,nps,ppf,epf,insurance,gold], isin, symbol, name, amfi_code, exchange, default_bucket, meta jsonb)
accounts(id, family_id, entity_id, kind enum[demat,mf_folio,pms,aif,bank,card,fd,other], provider, identifier_masked, meta jsonb)
holdings(id, family_id, entity_id, account_id, instrument_id, quantity, avg_cost, bucket enum[liquidity,income,growth], goal_id null, last_valued_at)
lots(id, holding_id, buy_date, quantity, remaining_qty, unit_cost, charges, grandfathered_fmv null, source_txn_id)
investment_txns(id, family_id, entity_id, account_id, instrument_id, type enum[buy,sell,dividend,interest,bonus,split,rights,buyback,merger,demerger,sip,switch_in,switch_out,redemption,capital_call,distribution,fee,maturity], txn_date, quantity, price, amount, charges, source enum[cas,contract_note,manual,api,corporate_action], source_ref, hash unique)
prices(instrument_id, price_date, close, source, primary key(instrument_id, price_date))
corporate_actions(id, instrument_id, type, ex_date, record_date, ratio_num, ratio_den, cash_per_unit, new_instrument_id, cost_split_pct, status enum[pending,applied,review], source)
realized_gains(id, family_id, entity_id, instrument_id, lot_id, sell_txn_id, fy, buy_date, sell_date, quantity, cost, proceeds, gain, term enum[short,long], asset_class, tax_rate_applied, exemption_used)
tax_rules(id, fy, asset_class, term, rate, exemption_amount, holding_months_for_long, indexation bool, notes)
benchmarks(id, code, name) ; benchmark_prices(benchmark_id, price_date, value)
xirr_cache(scope_type enum[asset,entity,bucket,family,goal], scope_id, period enum[1y,3y,5y,si], value, computed_at)
```

### 5.3 Real estate

```
properties(id, family_id, type enum[residential,commercial,land,under_construction], name, address jsonb, acquisition_date, acquisition_cost, stamp_duty, registration, self_occupied bool, bucket default 'income', status)
property_owners(property_id, entity_id, ownership_pct)
property_valuations(id, property_id, valued_on, value, source, note)
tenants(id, family_id, name, pan, phone, email, type enum[individual,company])
leases(id, property_id, tenant_id, entity_gstin_id null, start_date, end_date, rent, due_day, escalation_pct, escalation_every_months, deposit, gst_applicable bool, tds_applicable bool, notice_days, status, document_id)
rent_schedule(id, lease_id, period_month, expected_rent, expected_gst, expected_tds, due_date, received_amount, received_on, bank_txn_id null, status enum[due,received,partial,overdue,waived])
property_taxes(id, property_id, authority, assessment_no, period, amount, due_date, paid_on, bank_txn_id null, status)
property_expenses(id, property_id, expense_date, category enum[maintenance,repair,society,insurance,loan_interest,brokerage,other], capital_improvement bool, vendor, amount, bank_txn_id null, document_id null, note)
gst_returns(id, entity_gstin_id, period_month, form enum[gstr1,gstr3b], taxable_value, tax_amount, filed_on, arn, status)
tds_26as(id, entity_id, fy, quarter, deductor_tan, deductor_name, section, amount_paid, tds_deducted, source_file)
```

### 5.4 Private investments

```
private_companies(id, family_id, name, cin null, sector, website)
private_investments(id, family_id, entity_id, company_id, instrument enum[equity,ccps,ccd,safe_post,safe_pre,conv_note,fund_units], invested_on, amount, shares_or_units, valuation_cap, discount_pct, status enum[active,unconverted,exited,written_off], bucket default 'growth', goal_id null)
private_rounds(id, company_id, round_name, closed_on, pre_money, raised, post_money, total_shares_post, price_per_share)
private_marks(id, private_investment_id, marked_on, value, basis enum[last_round,manual,nav], note)
fund_commitments(id, private_investment_id, total_commitment, drawn, schedule jsonb)
private_exits(id, private_investment_id, exit_on, shares_or_units, proceeds, gain, tax_estimate)
```

### 5.5 Goals & buckets

```
bucket_targets(id, family_id, entity_id null, liquidity_pct, income_pct, growth_pct, drift_threshold_pp default 1.5, effective_from)
goals(id, family_id, entity_id, name, target_year, amount_today, inflation_pct, bucket, assumed_return_pct, status)
goal_links(goal_id, holding_id null, private_investment_id null, property_id null, allocation_pct)
glide_paths(id, family_id, goal_id null, steps jsonb)  -- [{year, growth_pct}]
```

### 5.6 Banking

```
bank_accounts(id, family_id, entity_id, bank, account_masked, type enum[savings,current,card,od], aa_link_id null, balance, balance_as_of, sync_mode enum[aa,csv,manual])
aa_consents(id, family_id, entity_id, provider, consent_handle, status, granted_on, expires_on)
bank_txns(id, family_id, bank_account_id, txn_date, value_date, narration, amount, balance_after, category_id null, counterparty, link_type enum[none,rent,dividend,interest,redemption,sip,drawdown,property_tax,expense,transfer], link_id null, hash unique, source)
categories(id, family_id null, name, kind enum[inflow,outflow,transfer], parent_id)
categorisation_rules(id, family_id, pattern, field, category_id, link_type, priority, learned bool)
```

### 5.7 Working capital, tasks, documents, reports

```
wc_settings(family_id, float_days default 60, buffer_months default 1, idle_days default 30, instrument_prefs jsonb)
committed_outflows(id, family_id, entity_id, kind enum[advance_tax,gst,property_tax,drawdown,card_due,sip,emi,manual], due_date, amount, source_id, status)
deployment_plans(id, family_id, created_at, excess_amount, lines jsonb, status enum[proposed,tasked,executed])
tasks(id, family_id, entity_id null, module, title, reason, amount null, due_date, assignee_user_id null, status enum[open,done,dismissed], verification enum[na,pending,verified,mismatch], source_type, source_id, created_by enum[system,user], done_at)
notifications(id, user_id, task_id null, channel enum[inapp,push,email,whatsapp], sent_at, read_at)
documents(id, family_id, entity_id null, folder_id, name, mime, size, storage_key, sha256, uploaded_by, linked_type, linked_id)
folders(id, family_id, parent_id, name, system bool)
report_schedules(id, family_id, report_code, params jsonb, cron, recipients text[], format)
import_jobs(id, family_id, source enum[cas,contract_note,pms_stmt,bank_csv,26as,ecas], file_document_id, status, rows_total, rows_ok, rows_error, error_log jsonb, mapping_id null)
audit_log(id, family_id, user_id, action, table_name, row_id, before jsonb, after jsonb, at)
```

### 5.8 Planning & taxation

```
plan_scenarios(id, family_id, name, description, is_baseline, parent_scenario_id, version, base_date, horizon_fys, entity_scope uuid[], assumptions jsonb, status enum[draft,in_review,approved,executing,completed,archived], created_by, approved_by, approved_at)
plan_actions(id, family_id, scenario_id, seq, kind enum[sell_holding,buy_instrument,switch,redeem_before_date,defer_sale_to_fy,harvest_loss,book_gain_within_exemption,transfer_to_entity,change_tax_regime,sell_property,reinvest_54ec,reinvest_54f,prepay_loan,exit_private,donate_80g,contribute_nps,contribute_ppf,change_rent,deploy_cash,custom], entity_id, target_type, target_id, params jsonb, planned_date, planned_amount, status enum[planned,in_progress,done,skipped], task_id, actual_date, actual_amount, actual_ref_type, actual_ref_id, variance jsonb, note)
plan_results(id, family_id, scenario_id, computed_at, engine_version, summary jsonb, by_fy jsonb, allocation_after jsonb, goals_after jsonb, cash_ladder jsonb, warnings jsonb)
plan_comments(id, family_id, scenario_id, user_id, body, created_at)
tax_suggestions(id, family_id, scenario_id null, entity_id null, code, title, rationale, est_saving, fy, proposed_actions jsonb, status enum[new,added_to_plan,dismissed])
tax_slabs(fy, regime, entity_type, slab_from, slab_to, rate) ; tax_surcharge(fy, regime, income_from, rate, capped_on_gains_pct) ; tax_deduction_limits(fy, regime, code, limit_amount, notes)
```
Migration: `db/003_planning_taxation.sql` (validated); sample scenarios in `db/004_seed_planning.sql`.

### 5.9 Asset-class coverage and allocation lens

```
instruments += currency, country, alloc_class ; instrument_type += silver, reit, invit, foreign_stock, foreign_etf, foreign_fund, gift_city
holdings += core_satellite enum[core,satellite], cost_ccy ; investment_txns += fx_rate
fx_rates(ccy, rate_date, rate_inr, source enum[rbi_reference,sbi_ttbr,manual])
instrument_exposure(instrument_id, as_of, alloc_class, country, pct, source)
asset_class_targets(id, family_id, entity_id null, alloc_class, target_pct, min_pct, max_pct, effective_from)
model_portfolios(id, family_id null=system, code, name, risk_profile, mix jsonb, bands jsonb)
allocation_policies(family_id, strategy, model_portfolio_id, review_every_months, next_review_on, rebalance_trigger_pp, include_self_occupied, include_epf_ppf)
lrs_remittances(id, family_id, entity_id, fy, remitted_on, ccy, amount_ccy, amount_inr, purpose, tcs_collected, bank_txn_id)
foreign_tax_credits(id, family_id, entity_id, fy, country, income_type, income_inr, foreign_tax_inr, dtaa_article, form67_filed_on)
```
Migration: `db/005_asset_class_coverage.sql` (validated) — also adds tax rules for gold ETF/FoF, REIT/InvIT, foreign equity, international funds and SGB, and the five system model portfolios.

### 5.10 Balance sheet, analytics, open data

```
liabilities(id, family_id, entity_id, kind, lender, principal_original, outstanding, rate_pct, rate_type, emi, emi_day, start/end_date, secured_by_type/id, ltv_pct, tax_section, status) ; liability_schedule(liability_id, due_date, principal, interest, paid_on, bank_txn_id)
insurance_policies(id, family_id, entity_id, kind, insurer, sum_assured, premium, premium_frequency, next_premium_due, maturity_date, surrender_value, fund_value, covers_type/id, nominee, tax_section, status)
lifestyle_assets(id, family_id, entity_id, kind, name, cost, current_value, valued_on, insured_policy_id, include_in_net_worth)
ownership_links(id, family_id, owner_entity_id, owned_type, owned_id, pct, role, effective_from/to)      -- property_owners migrated in
nominations(id, family_id, asset_type, asset_id, nominee_name, relation, share_pct, registered_with, registered_on, verified_on) ; succession_documents(...)
valuations_daily(family_id, scope_type, scope_id, as_of, value, net_flow) ; twr_cache(...) ; instrument_attributes(instrument_id, as_of, sector, market_cap_band, credit_rating, modified_duration, issuer, manager, liquidity_class, expense_ratio_pct)
ips_rules(id, family_id, entity_id, code, params, severity, active) ; ips_breaches(...) ; fund_cashflows(private_investment_id, flow_date, kind, amount, forecast) ; fees_ledger(...)
document_extractions(id, document_id, doc_type, model, extracted jsonb, confidence, status, reviewed_by, applied_import_job_id) ; reconciliation_items(id, run_at, source, entity_id, instrument_id, platform_qty, source_qty, status, note)
cashflow_forecast(family_id, entity_id, month, kind, amount, source_type/id)
report_packs(id, name, audience, sections jsonb, cron, recipients) ; report_pack_runs(pack_id, version, period_label, storage_key, supersedes_run_id, correction_note)
external_access(id, user_id, label, scope jsonb, expires_on, revoked_at) ; api_keys(id, label, key_hash, scopes, expires_on) ; webhooks(id, url, secret_hash, events, active)
```
Migration: `db/006_balance_sheet_analytics.sql` (validated).

### 5.11 General ledger

```
gl_accounts(id, family_id null=system, entity_id null=template, code, name, type enum[asset,liability,equity,income,expense], parent_code, is_group, is_system, tax_head, tally_ledger_name, tally_parent_group, active)
gl_books(entity_id, basis enum[accrual,cash], fy_start_month, books_start_date, mark_to_market, depreciation, maker_checker, default_bank_account_id)
gl_periods(id, entity_id, fy, period_start, period_end, status enum[open,soft_closed,locked], closed_by, closed_at)
gl_journals(id, entity_id, journal_no, fy, entry_date, source enum[auto,manual,recurring,opening,closing,tally_import,reversal], source_type, source_id, narration, status enum[draft,posted,reversed], posted_by, approved_by, reversed_by_journal_id, reverses_journal_id, intercompany_group, tally_voucher_guid)
gl_lines(id, journal_id, line_no, account_id, debit, credit, ccy, amount_ccy, fx_rate, sub_ledger_type, sub_ledger_id, cost_centre, narration)
gl_posting_rules(id, family_id null=system, event_type, instrument_class, basis, lines jsonb, priority, active)
gl_opening_balances(entity_id, account_id, as_of, debit, credit, sub_ledger_type/id) ; gl_recurring(...) ; gl_partner_capital(entity_id, partner_entity_id, partner_name, capital_account_id, profit_share_pct) ; gl_tally_sync(...)
gl_balances  -- materialised view: entity × FY × account → debit, credit, balance
```
Database-enforced invariants: every journal balances (deferred constraint trigger); posted journals are immutable (reversal only); postings into a locked period are rejected; one auto journal per source event. Migration: `db/007_general_ledger.sql` (validated in the 001→007 chain, invariants smoke-tested).

### 5.12 Action plane

```
connectors(id, family_id, entity_id, kind enum[broker,mf_platform,bank_api,bbps,payout,custom], provider, label, account_ref, linked_account_id, linked_bank_account_id, status enum[pending_auth,active,expired,revoked,error,sandbox], scopes text[], credential_ref, session_expires_at, static_ip, sandbox, last_health_at, last_error)
execution_policies(id, family_id, entity_id null, intent_kind null, code, params jsonb, active) ; execution_limits_usage(...) ; payees(id, name, kind, account_masked, ifsc, vpa, bbps_biller_id, linked_type/id, verified_by, verified_at, active) ; kill_switches(family_id, paused, paused_by, paused_at, reason)
agent_sessions(id, user_id, model, purpose) ; agent_messages(session_id, seq, role enum[user,assistant,tool,system], content, tool_name, tool_args, tool_result, tokens)
action_intents(id, entity_id, kind enum[...12 kinds], status enum[draft,policy_failed,pending_approval,approved,rejected,expired,queued,submitted,partially_filled,filled,failed,cancelled,reconciled,posted], connector_id, payload jsonb, amount, rationale, proposed_by_kind enum[agent,user,rule], proposed_by_user_id, agent_session_id, source_type/id, simulation jsonb, policy_result jsonb, approvers_required, cooling_off_until, expires_at, batch_id, idempotency_key unique)
action_approvals(intent_id, approver_user_id, decision, note, auth_method, device_id, ip, decided_at)  -- unique per approver
action_executions(intent_id, attempt, connector_id, request jsonb redacted, response jsonb, provider_ref, status, filled_qty, avg_price, fees, error)
action_reconciliations(intent_id, matched_type/id, variance, gl_journal_id)
```
### 5.15 Rebalancing & liquidity timing

```
rebalance_programs(id, scope, entity_id, goal_id, policy_id, name, calendar_rrule, band_trigger, drift_threshold_pp, milestone_triggers jsonb, need_lookahead_days, large_flow_pct, tax_year_end, constraints jsonb, auto_draft, auto_convert_low_risk, active)
funding_needs(id, entity_id, goal_id, kind enum[goal_drawdown,capital_call,tax_instalment,liability_payment,insurance_premium,planned_expense,distribution_to_family,buffer_rebuild,other], label, need_date, amount, flexibility_days, source_type/id, priority, status, funded_amount, bank_account_id)
lot_constraints(lot_id, lock_in_until, exit_load_until, exit_load_pct, ltcg_eligible_on, settlement_days, liquidity_class)
rebalance_runs(id, program_id, triggered_by enum[calendar,band_breach,drift_threshold,milestone,funding_need,glide_step,large_flow,tax_year_end,policy_change,manual], trigger_detail, run_at, snapshot, drift, status, plan_id)
rebalance_plans(id, run_id, version, status enum[draft,in_review,approved,converted,superseded,cancelled], objective, allocation_after, summary jsonb, warnings, agent_session_id, approved_by, intent_batch_id)
rebalance_moves(id, plan_id, seq, kind enum[sell,buy,switch,redeem,transfer_cash,hold_cash,sip_change,stp,swp], entity_id, from_holding_id, from_lot_ids, to_instrument_id, to_bank_account_id, quantity, amount, planned_date, earliest_date, latest_date, settles_on, reason, need_id, est_gain/tax/cost, exit_load, constraints_checked, depends_on_move_id, intent_id, status)
need_coverage(need_id, move_id | bank_account_id, amount, available_on)
```
Database-enforced plan state machine. Migration: `db/011_rebalancing_engine.sql` (validated in the 001→011 chain; 136 tables total).

### 5.14 Research & proposals

```
research_sources(id, kind enum[research_house,broker,advisor,pms_manager,newsletter,friend,media,internal,other], name, organisation, conflict_of_interest, sebi_registration, trust_score, active)
research_channels(id, kind enum[email,upload,paste,rss,whatsapp,api,web], label, config jsonb, default_source_id)
research_items(id, channel_id, source_id, received_at, title, sender, body_text, document_id, sha256 unique, status, extraction_id)
research_recommendations(id, item_id, source_id, instrument_id, instrument_text, action enum[...10], thesis, target_price, stop_loss, horizon_months, conviction, published_on, price_at_publish, cluster_id, status, confidence)
recommendation_clusters(id, instrument_id, direction, first/last_seen, source_count, weighted_conviction, consensus, status)
recommendation_assessments(id, cluster_id, policy_version_id, entity_id, goal_id, verdict enum[fits,fits_with_conditions,conflicts,prohibited,insufficient_info], fit_score, checks jsonb, already_held jsonb, sizing jsonb, agent_session_id)
source_track_record(source_id, recommendation_id, horizon_months, price_then/now, return_pct, benchmark_return_pct, excess_pct, hit)
investment_proposals(id, cluster_id, assessment_id, version, title, instrument_id, action, entity_id, goal_id, amount, sections jsonb, simulation jsonb, agent_session_id, status enum[draft,in_review,approved,rejected,deferred,converted,expired], digest_id, decided_by, decided_at, decision_note, defer_until, intent_batch_id, expires_at)
research_digests(id, period_start/end, cadence, summary jsonb, proposal_ids, document_id, sent_to, status)
```
Database-enforced: proposal state machine; decisions require `decided_by`. Migration: `db/010_research_proposals.sql` (validated in the 001→010 chain; 129 tables total).

### 5.13 Investment Policy Framework

```
investment_policies(id, family_id, scope enum[family,entity,goal], entity_id, goal_id, name, parent_policy_id, current_version_id, review_every_months, next_review_on)
policy_versions(id, policy_id, version, status enum[draft,in_review,active,superseded,archived], effective_from/to, objectives jsonb, risk jsonb, constraints jsonb, permitted jsonb, rebalancing jsonb, monitoring jsonb, guardrails jsonb, change_summary, created_by, approved_by, approved_at, signed_by jsonb, document_id)   -- one active per policy
policy_allocations(policy_version_id, lens enum[bucket,asset_class,sub_class,geography,currency], key, target_pct, min_pct, max_pct)
policy_risk_limits(policy_version_id, metric, operator, limit_value, warn_value, severity)
ips_rules / asset_class_targets / bucket_targets / execution_policies / glide_paths += policy_version_id  (activation writes them)
risk_questionnaires(id, family_id null=system, name, version, questions jsonb, scoring jsonb) ; risk_questionnaire_responses(id, questionnaire_id, entity_id, goal_id, answers, score, capacity/tolerance/horizon scores, profile)
risk_metrics(scope_type, scope_id, as_of, metric, value, lookback, benchmark_id)
policy_compliance(policy_version_id, as_of, overall, checks jsonb, breaches, warnings, task_ids)
policy_reviews(policy_id, kind enum[scheduled,trigger,ad_hoc], trigger_reason, due_on, status, reviewer, findings jsonb, outcome, resulting_version_id, task_id)
```
Migration: `db/009_investment_policy.sql` (validated in the 001→009 chain; 120 tables total). Ships the 12-question system risk questionnaire with capacity-caps-tolerance scoring.

Database-enforced (action plane): legal state transitions only; `approved` requires ≥ `approvers_required` approval rows; the human proposer cannot approve; `queued` is refused during cooling-off or while the kill switch is on; a separate `executor_user` role can only read intents/policies/connectors, write executions and update intent status. Migration: `db/008_action_plane.sql` (validated in the 001→008 chain; seven invariant tests pass).

---

## 6. API (Node.js 20, TypeScript, Fastify or Express, REST + JSON)

Base path `/api/v1`. Auth: JWT access (15 min) + refresh (30 days, rotating); MFA (TOTP) mandatory for Owner/Operator. Every request carries `X-Family-Id`; the server sets `app.family_id` for RLS. Pagination: cursor-based. Errors: RFC 7807 problem+json. OpenAPI 3.1 spec generated from route schemas (zod) and published at `/api/docs`.

| Area | Endpoints (representative) |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/mfa/verify`, `/auth/invite`, `/auth/accept` |
| Family | `GET/POST /families`, `GET/POST/PATCH /entities`, `POST /entities/:id/gstins`, `GET/POST /members` |
| Dashboard | `GET /dashboard?entity=` → KPIs, trend, buckets, allocation, attention |
| Investments | `GET /holdings`, `GET /holdings/:id/lots`, `GET/POST /investment-txns`, `GET /capital-gains?fy=&entity=`, `GET /capital-gains/export`, `GET/POST /corporate-actions/:id/apply`, `GET /harvest-candidates` |
| Imports | `POST /imports` (multipart), `GET /imports/:id`, `POST /imports/:id/mapping`, `POST /imports/cas/refresh` |
| Prices & exposure | internal jobs; `GET /instruments/search?q=`, `GET/PUT /instruments/:id/exposure`, `GET /fx-rates` |
| Global | `GET/POST /global/lrs`, `GET/POST /global/foreign-tax-credits` |
| Real estate | `GET/POST/PATCH /properties`, `/properties/:id/valuations`, `/leases`, `GET /rent-schedule?month=`, `POST /rent-schedule/:id/receive`, `POST /rent-schedule/:id/remind`, `/property-taxes`, `/property-expenses`, `GET /gst/register?gstin=&month=`, `PATCH /gst/returns/:id`, `POST /tds/26as/import`, `GET /tds/reconciliation` |
| Private | `/private-companies`, `/private-investments`, `/private-investments/:id/rounds`, `/marks`, `/commitments`, `POST /private-investments/:id/exit-scenario` |
| Goals & allocation | `GET/PUT /bucket-targets`, `GET /buckets/drift`, `POST /buckets/rebalance-proposal`, `/goals`, `/goals/:id/links`, `/glide-paths`, `GET/PUT /asset-class-targets`, `GET /allocation/status?look_through=`, `GET/PUT /allocation/policy`, `GET/POST /model-portfolios` |
| Banking | `/bank-accounts`, `POST /aa/consent/initiate`, `POST /aa/consent/callback`, `POST /bank-accounts/:id/sync`, `GET /bank-txns?...`, `PATCH /bank-txns/:id` (category/link), `/categorisation-rules`, `GET /cashflow?days=` |
| Working capital | `GET /working-capital/summary`, `GET /committed-outflows`, `POST /committed-outflows`, `POST /working-capital/plan`, `POST /working-capital/plan/:id/tasks`, `GET /working-capital/ladder` |
| Planning & tax | `/plans` (CRUD, `:id/clone`, `:id/actions`, `:id/simulate`, `:id/results`, `:id/comments`, `:id/status`, `:id/execution`), `GET /plans/compare?ids=`, `GET /tax/projection`, `GET /tax/regime-compare`, `GET/POST /tax/suggestions`, `:id/apply`, `:id/dismiss`, `GET /tax/advance-tax` |
| Balance sheet | `/liabilities` (+`:id/schedule`), `/insurance-policies`, `GET /insurance/coverage`, `/lifestyle-assets`, `GET/PUT /ownership`, `/nominations`, `GET /succession/gaps`, `GET /net-worth` |
| Analytics | `GET /performance`, `GET /exposure?by=`, `/ips-rules`, `GET /ips-breaches`, `GET /private-investments/:id/metrics`, `GET /fees` |
| Data ops | `POST /documents/:id/extract`, `/extractions`, `GET/POST /reconciliation`, `:id/resolve`, `GET /cashflow/forecast` |
| Reports & sharing | `/report-packs` (+`:id/run`), `/external-access` |
| General ledger | `/gl/books`, `/gl/accounts`, `/gl/journals` (+`:id/reverse`, `:id/approve`), `/gl/posting-rules`, `GET/POST /gl/unposted`, `/gl/periods` (+`:id/status`), `PUT /gl/opening-balances`, `POST /gl/year-end-close`, `GET /gl/reconcile/bank`, `GET /gl/reconcile/investments`, `GET /gl/reports/{trial-balance,profit-loss,balance-sheet,capital-account,cash-flow,ledger,itr-mapping}`, `POST /gl/tally/export`, `POST /gl/tally/import`, `/gl/recurring` |
| Investment policy | `/policies` (+`:id/versions`, `:id/compliance`, `:id/reviews`), `/policy-versions/:id` (+`/simulate`, `/status`, `/sign`, `/document`, `/diff`), `/policy-reviews/:id`, `/risk-questionnaires` (+`:id/respond`), `GET /risk-metrics` |
| Rebalancing | `/rebalance/programs` (+`:id/run`), `/rebalance/runs`, `/rebalance/plans/:id` (+`/simulate`, `/status`), `/funding-needs`, `GET /rebalance/calendar`, `GET /holdings/:id/lot-constraints` |
| Research | `/research/sources`, `/research/channels`, `/research/items`, `/research/recommendations`, `/research/clusters` (+`:id/assess`, `:id/dismiss`), `/research/proposals` (+`:id/decide`, `:id/document`), `/research/digests` (+`:id/decide`), `GET /research/track-record` |
| Action plane | `/connectors` (+`:id/session`, `:id/health`), `/execution-policies` (+`/usage`), `/payees` (+`:id/verify`), `GET/POST /kill-switch`, `GET /actions/schemas`, `/actions` (+`:id/approve`, `:id/reject`, `:id/cancel`, `:id/executions`), `POST /actions/batch/approve`, `POST /actions/from-source`, `/agent/sessions` (+`:id/messages`), `GET /agent/tools`, `GET /oversight` |
| Open data | `/api-keys`, `/webhooks`, `POST /export` |
| Tasks | `GET /tasks?status=&module=`, `PATCH /tasks/:id`, `POST /tasks` |
| Reports | `GET /reports`, `POST /reports/:code/run` (returns job id), `GET /reports/jobs/:id` (signed URL), `/report-schedules` |
| Documents | `POST /documents` (signed upload), `GET /documents?linked_type=&linked_id=`, `/folders` |

**Background jobs** (BullMQ on Redis): `prices.eod` (18:30 IST), `amfi.nav` (23:15 IST), `aa.sync` (every 4 h + on demand), `email.ingest` (IMAP poll every 5 min), `corporate_actions.fetch` (daily), `reconcile.bank` (after every sync/import), `xirr.recompute` (nightly + on write), `tasks.generate` (hourly), `reports.scheduled` (cron), `wc.evaluate` (daily 08:00 IST), `plan.baseline` (nightly, recompute baseline + re-simulate executing scenarios), `tax.optimise` (nightly + on demand), `plan.match_actuals` (after every import), `valuations.daily` (nightly snapshot for TWR), `ips.evaluate` (nightly), `recon.positions` (nightly + after e-CAS/CAS import), `cashflow.forecast` (nightly), `attributes.refresh` (monthly), `webhooks.deliver` (event-driven), `gl.autopost` (after every import/reconciliation and nightly sweep), `gl.balances.refresh` (nightly + after post), `gl.recurring` (daily), `gl.mtm` (period end if elected), `actions.expire` (every 5 min), `actions.reconcile` (after imports), `connectors.health` (every 15 min), `oversight.anomalies` (on intent create/approve), `risk.metrics` (nightly), `policy.compliance` (nightly after metrics), `policy.reviews` (daily: schedule and trigger reviews), `research.ingest` (email/RSS/WhatsApp poll every 15 min), `research.extract` (on item), `research.cluster_assess` (hourly), `research.track_record` (nightly), `research.digest` (weekly, configurable), `rebalance.needs` (nightly: gather dated needs from goals, commitments, planner, liabilities, premiums, forecast), `lots.constraints` (nightly), `rebalance.evaluate` (nightly + on trigger events), `rebalance.schedule` (daily: release scheduled intents on their planned date). The **executor** is a separate process: polls `queued` intents every 10 s, single-flight per connector, honours the kill switch.

**Integrations**

| Need | Provider options | Notes |
|---|---|---|
| MF NAV | AMFI NAVAll.txt (free) | Nightly |
| Fund composition (look-through) | AMFI monthly portfolio disclosures / AMC fact sheets; vendor (Morningstar/ACE MF) optional | Monthly |
| Gold/silver spot | IBJA daily rates | Daily |
| FX | RBI reference rates (daily); SBI TT buying rates for tax (daily) | Daily |
| Foreign prices | Vendor EOD (e.g. Alpha Vantage / EODHD) for US/UK/other listed | Daily; P1 |
| MF holdings/transactions | CAMS + KFintech CAS PDF parser; MF Central API (paid) | PDF password = PAN |
| Listed prices | NSE/BSE bhavcopy (free EOD); vendor (TrueData / Global Datafeeds) for 15-min intraday | Intraday P1 |
| Corporate actions | NSE/BSE CA feed (scrape) or vendor | Review queue for demergers |
| Bank feeds | AA via Finvu / Onemoney / Setu (FIU registration required, or partner with a TSP) | CSV fallback mandatory |
| Demat holdings | NSDL/CDSL e-CAS PDF | Monthly reconcile |
| Form 26AS / AIS | PDF/JSON import from income-tax portal | Manual upload |
| GST | Register export in GSTR-1 format; GSTN API filing P2 | |
| Benchmarks | NSE indices EOD; CRISIL indices where licensed | |
| Email ingest | Per-family address (e.g. `abc123@ingest.domain`) on SES/Postmark inbound | Attachments → import_jobs |
| Notifications | FCM/APNs, SES, WhatsApp BSP (P1) | |
| Tally | Tally XML masters + vouchers export; day-book XML import | Two-way |
| Broker order APIs | Zerodha Kite Connect, Upstox, Angel SmartAPI, ICICI Breeze, Dhan | Human-approved orders only; daily session by user |
| MF transactions | BSE StAR MF / MFU (own intermediary code) or broker MF API | Registration decision (section 11) |
| Bank payments | ICICI CIB / HDFC / Axis corporate APIs (current accounts); BBPS agent (Setu/Razorpay); payout partner (RazorpayX) | Allow-listed payees; never holds funds |
| Assistant model | Anthropic API (Claude) with tool use; structured outputs | Action plane: read tools + propose_intent only; Research: read tools + create_recommendation / create_assessment / draft_proposal / draft_digest |
| Research ingest | Second inbound email address per family; WhatsApp Business API (Gupshup/Twilio) inbox; RSS | Sender allow-list maps to sources |
| Vault | HashiCorp Vault or cloud KMS | Executor-only read of credentials |

---

## 7. Front end

### 7.1 Web (React 18, TypeScript, Vite)

- Routing: React Router; state: TanStack Query for server state, Zustand for UI state (entity filter, preview mode).
- Charts: Recharts. Tables: TanStack Table with column visibility, sort, filter, CSV export.
- Forms: react-hook-form + zod schemas shared with the API package.
- Layout: 224 px navigation rail with entity switcher; top bar with screen title, global search (assets, tenants, transactions), notifications, avatar. Content max-width 1440 px.
- Design system (from the prototype): typeface IBM Plex Sans, tabular numerals for all money; palette navy `#12213A` (rail, primary buttons), ink `#1B2A41`, paper `#F5F6F8`, teal `#0E7C6B` (positive/primary), amber `#B7791F` (attention), red `#B93B31` (negative/overdue), blue `#2F5D9C`, violet `#6B4FA0`; bucket colours Liquidity blue, Income teal, Growth violet used consistently in every chart, pill and legend. Cards: 1 px border, 10 px radius, no shadows. Money is always right-aligned. Empty states tell the user what to do next. Keyboard focus visible; WCAG AA contrast.
- Screens: Dashboard, Investments (4 tabs), Real estate (4 tabs), Startups, Goals & buckets, Planning & tax (5 tabs), Investment policy (7 tabs), Rebalancing (5 tabs), Research (5 tabs), Books (GL), Action plane (6 tabs), Banking, Working capital, Reports, Documents, Tasks, Settings (Entities, Members, Buckets, Working-capital rules, Categories, Integrations, Report schedules).

### 7.2 Mobile (React Native with Expo, TypeScript; iOS + Android)

- Shares the API client, zod schemas, formatting helpers and design tokens with web via a monorepo package.
- Navigation: bottom tabs Dashboard · Investments · Real estate · Startups · More (Goals, Planning & tax, Banking, Working capital, Reports, Documents, Tasks, Settings); entity switcher in the header.
- Mobile-specific: approvals inbox with biometric/passkey step-up, kill switch, assistant chat, research digest with approve/reject/defer and share-sheet ingestion (forward a PDF or screenshot into the inbox); push notifications for tasks and pending approvals; biometric unlock; camera capture for maintenance receipts and rent receipts; share sheet for PDF reports; offline read cache of last dashboard and holdings.
- Mobile is read-and-act: view everything, complete tasks, approve rebalancing proposals, review/approve/comment on scenarios (building scenarios is web-only), log expenses, mark rent received, upload documents. Bulk imports and rule editing are web-only.

### 7.3 Repository layout

```
/apps/web            React web app
/apps/mobile         Expo app
/apps/api            Node API + workers
/packages/schemas    zod schemas, shared types (generated from OpenAPI)
/packages/ui-tokens  colours, spacing, typography
/packages/finance    XIRR, FIFO, tax engine, working-capital engine (pure TS, 100% unit-tested)
/packages/parsers    CAS, contract notes, bank CSV, 26AS, e-CAS parsers with fixture files
/infra               Docker Compose (dev), Terraform (prod), migrations (Prisma or Drizzle)
```

---

## 8. Non-functional requirements

- **Security**: TLS everywhere; execution credentials only in Vault/KMS readable by the executor; step-up auth (TOTP/biometric/passkey) on every approval; four-eyes and kill switch enforced in the database; AES-256 at rest (RDS + S3 SSE-KMS); PAN, account numbers and GSTIN encrypted at column level with per-family keys; RLS in Postgres; MFA; session revocation; rate limiting; OWASP ASVS L2; annual pen test; audit log on all writes; data export and deletion on request (DPDP Act 2023 compliance); AA consent artefacts stored and revocable in-app.
- **Performance**: dashboard < 1.5 s p95 for a family with 5 entities, 500 holdings, 50k bank transactions; reports generated async and delivered within 60 s; imports of a 200-page CAS within 30 s.
- **Reliability**: 99.9% monthly; RPO 15 min (PITR), RPO/RTO documented; nightly logical backups retained 35 days.
- **Observability**: structured logs, OpenTelemetry traces, job dashboards (BullMQ UI), alerting on failed syncs/imports, per-family sync health visible in Settings → Integrations.
- **Environments and hosting**: everything runs as Docker containers (`deploy/docker-compose.yml`): Caddy (TLS), web (nginx), api, worker, **executor** (separate image/role, allow-listed egress to provider domains, vault access), Postgres 16, Redis 7, MinIO (S3-compatible documents), Vault (or KMS), backup. Dev = the same compose with a dev overlay; staging and production = one Hostinger KVM VPS each (Ubuntu 24.04, ap-south region), see `deploy/HOSTINGER_SETUP.md`. Nothing is host-specific, so the stack ports to any VPS or cloud by restoring the three volumes (Postgres, MinIO, Redis) and switching DNS; a later move to managed Postgres/S3 only changes `DATABASE_URL` and the S3 endpoint. CI: GitHub Actions — lint, type-check, unit tests (finance and parsers must stay green), Playwright smoke on web, EAS build for mobile, Docker images pushed to GHCR.
- **Data residency**: choose Hostinger's India (Mumbai) location; offsite backups to an Indian-region bucket.

---

## 9. Acceptance test scenarios (end-to-end)

1. Onboard a family with three entities, import one CAS covering two PANs, one Zerodha tradebook, add three properties with leases and two startup investments; dashboard net worth equals the sum of module totals to the rupee.
2. Sell a lot bought before 31 Jan 2018; Schedule CG shows grandfathered cost and correct LTCG after exemption; Excel export opens in the ITR utility layout.
3. Bank sync brings a credit matching a tenant's rent; rent schedule flips to Received, GST register for that GSTIN updates, and the overdue task (if any) auto-closes.
4. Drift on Liquidity exceeds threshold after a market rally; a rebalancing proposal appears with a tax-aware move; marking the task done and importing the resulting MF purchase sets verification to Verified.
5. Balances sit above required float for 30 days; working-capital screen shows the excess, a ladder with post-tax yields for the entity's slab, and "Create tasks" produces one task per line.
6. A fund drawdown notice is added; it appears in committed outflows, reduces deployable excess, and creates a due-date task.
7. Build a scenario that sells a property and reinvests under 54EC; simulation shows tax falling to zero on that gain with a 6-month-window warning; approve it; three tasks appear; importing the sale contract marks the first action done with zero variance.
8. Apply the Moderate 60/30/10 model; a family holding a balanced-advantage fund, a gold ETF, a REIT and a US ETF shows correct headline and look-through class percentages, a band breach on equity raises a rebalancing task, and the Schedule FA report lists the US ETF with peak and closing INR values.
9. Create books for all three seeded entities with generated opening balances; auto-post every seeded event; the HUF trial balance balances, rent receivable equals the overdue Saibaba rent, investments at cost equal holdings cost, bank ledger equals AA balances; lock Q1 and confirm a back-dated journal is rejected; export Tally XML and re-import it into an empty test book with zero duplicates.
10. Ask the assistant to deploy the seeded ₹31,000 idle cash; four intents appear in pending_approval with simulation and policy results; the operator who chatted cannot approve them; the owner approves the batch with TOTP in sandbox; the executor submits two test-market MF orders against NACH mandates and two assisted instructions; pausing the kill switch mid-way stops the remaining intent; resuming completes it; the sandbox fill reconciles and posts to the HUF book.
11. Complete the questionnaire for the family (moderate) and the retirement goal (moderately conservative); build and activate both policies; the goal policy shows overridden clauses beside inherited ones; the nightly compliance run flags equity at 72 % vs a 70 % max and opens a rebalancing task; an assistant intent in a prohibited instrument is refused citing the clause; the annual review pre-fills findings and produces an amended v2 with a diff.
12. Forward a broker note, a research PDF and a WhatsApp tip; the inbox shows five recommendations in two clusters; the small-cap cluster is dismissed citing the rating clause; the other is assessed 'fits with conditions' with sizing from the issuer cap; the agent drafts a proposal with a counter-view and cited numbers; Sunday's digest presents it; approving with a reduced amount creates an intent batch that appears in the action-plane inbox for a second approver.
13. With the Varaha ₹20,000 call due 14 Oct and ₹11,000 idle cash, the nightly run drafts a ₹9,400 balanced-advantage redemption dated 7 Oct (exit-load expiry 2 Oct, LTCG-eligible, settles 10 Oct), covering the need; approving and converting creates an intent held by the executor until 7 Oct; the March tax-year-end run proposes the TCS exemption booking and the Axis loss harvest before 31 March and defers a trim to 3 April.
14. A Viewer role can open Reports and download the GST register but cannot see Documents or bank transactions.

---

## 10. Delivery sequence

Phases are ordered by dependency, not scheduled. The team sizes and sequences sprints from the ticket breakdown.

| Phase | Scope | Depends on |
|---|---|---|
| 0 — Foundation | Monorepo, auth/MFA, families/entities/roles, RLS, design tokens, web shell + mobile shell, CI, Docker environment | — |
| 1 — Investments parity | Instruments, holdings, lots, CAS + contract-note parsers, AMFI/NSE feeds, XIRR, capital gains + tax_rules, corporate actions, Investments screens, net worth dashboard; **GL core** (books, CoA, journal engine, invariants) so later modules can post | 0 |
| 2 — Banking + tasks | AA integration + CSV fallback, categorisation, linking, cash flow, task engine, notifications | 1 |
| 3 — Real estate | Properties, leases, rent schedule + reconciliation, GST register, property tax, maintenance, TDS/26AS | 2 |
| 4 — Buckets, goals, working capital, investment policy, rebalancing engine | Bucket targets, drift, rebalancing proposals, goals, glide path, working-capital engine and ladder; **Investment Policy Framework** (builder, questionnaire, versions, compliance, reviews) which owns the targets/bands/rules from here on; **rebalancing and liquidity-timing engine** (programs, needs, solver, calendar) | 2 |
| 5 — Planning & taxation | Tax computation engine (slabs/regimes/advance tax), scenario builder and simulator, compare, review/approval, optimiser, execution tracking | 1 (engine), 2 (tasks), 4 (allocation) |
| 6 — Startups, reports, documents | Private investments, rounds/marks/exits, all reports with scheduling, Tally export, documents | 3, 4, 5 |
| 6a — General ledger | Books, CoA, auto-posting rules, journals, periods, reconciliation, statements, ITR mapping, Tally two-way, partner capital | 1, 2, 3 (rules for each event type land with its module) |
| 6b — Balance sheet, analytics, open data | Liabilities, insurance, lifestyle assets, ownership graph, succession; TWR, exposure, IPS, private metrics, fees; extraction queue, reconciliation, cash-flow forecast; report packs, external viewers, API keys/webhooks/export | 1, 2, 6 |
| 7 — Action plane and research | Connectors (sandbox first), policies/payees/kill switch, intents + approvals + executor, assistant with tool manifest, oversight, reconciliation to GL; **research ingestion, extraction, clustering, policy-fit assessment, proposals, digests, track record** |
| 8 — Hardening + launch | Pen test, load test, mobile store submission, CA review of tax outputs | all |

Phases 3 and 4 can run in parallel; phase 5's engine work (FO-70) can start as soon as the phase-1 capital-gains engine is merged.

---

## 11. Open decisions for the product owner

1. AA route: register as FIU directly or go through a TSP (faster, adds per-account fees).
2. Intraday prices in v1 or EOD only (vendor cost).
3. Whether self-occupied property counts in the Income bucket denominator.
4. WhatsApp rent reminders in v1 (requires BSP onboarding and template approval).
5. Tally export format: ledgers only, or full vouchers.
6. Advisor mode (v2) — decide now whether `families` should support an `advisor_org_id` to avoid a later migration.
7. General ledger — **decided: included** (3.17). Remaining question: cash-basis books for individuals by default, or accrual for all entities? The template supports both; default is accrual.
8. Bill pay / payment execution — rejected for v1 (licence/partner needed); confirm.
9. Crypto — v2; confirm no v1 demand.
10. MF execution route — **recommended**: start RIA registration for a family LLP/company (direct plans) and integrate BSE StAR MF via Cybrilla FP with NACH mandates; MF intents stay assisted meanwhile. Broker MF APIs are read-only, so there is no shortcut. Alternative: ARN (fast, regular plans) — see `family-office-EXECUTION-ROUTES.md`. Confirm.
11. Bank payment route — **recommended**: ICICI Corporate API Suite on the HUF's existing current account (portal-authorisation mode first), BBPS agent (Setu) for bills across entities, individuals assisted via UPI intent with NACH mandates for MF. No aggregator or payout partner in v1. Confirm.
12. Default policy tiers — confirm ₹5 L / ₹25 L approval and cooling-off thresholds and the 24 h new-payee block.
14. Research channels — enable the WhatsApp Business inbox in v1 (BSP onboarding) or start with email/upload only? Digest cadence (weekly recommended) and who decides (owner only, or members for their own entities)?
13. Assistant scope — allowed purposes (rebalance, deploy cash, pay bills, tax plan, questions) and whether members other than the owner can open sessions.

---

## Appendix A — mProfit Family Office feature parity checklist

| mProfit capability | Covered by |
|---|---|
| Multi-asset tracking (Stocks, MFs, PMS, AIF, bonds, FDs, insurance, NPS) | 3.2 |
| Manage investments above ₹25 Cr, multiple entities under one family office | 3.1 (no AUM ceiling) |
| Capital gains reports for ITR | 3.2, 3.9 |
| XIRR across portfolios; benchmark comparison incl. blends | 4, 3.9 |
| Holistic asset allocation and equity exposure look-through | 3.13, 3.5 |
| Automated corporate actions | 3.2 |
| Portfolio cash-flow tracking | 3.6 |
| Imports from 700+ brokers/institutions, email forwarding | 3.2, 6 |
| MF CAS API refresh | 6 |
| Global consolidated AUM reporting | 3.9 |
| Tally integration | 3.17 (two-way) |
| Web + mobile logins | 7 (unlimited members, role-based) |
| Dedicated relationship manager | n/a (product, not service) |

## Appendix D — Asset-class coverage check

Reference framework: the six asset classes and allocation practices described in Ckredence Wealth's "Asset Allocation India" guide (equity; debt and fixed income incl. EPF/PPF; gold and precious metals; real estate; cash and liquid; global investments; strategic/tactical/dynamic/core-satellite/goal-based strategies; risk-profile model mixes; life-stage glide; annual rebalancing; look-through diversification; tax-efficient placement).

| Framework element | Product coverage |
|---|---|
| Equity | 3.2 — stocks, ETFs, MFs, PMS, AIF; look-through for hybrids |
| Debt incl. bonds, debt MFs, EPF, PPF | 3.2 — all types; EPF/PPF toggle in allocation policy |
| Gold and precious metals | 3.2 — physical gold/silver (IBJA), digital, SGB, ETFs, FoFs; tax rules per type |
| Real estate | 3.3 direct property; 3.2 REITs/InvITs with distribution splits |
| Cash and liquid | 3.6 banking, 3.7 working capital |
| Global investments | 3.2 — foreign stocks/ETFs, international funds, GIFT City; FX; LRS/TCS; Schedule FA; DTAA credit |
| Model mixes (60-30-10, 70-15-15, risk profiles) | 3.5 — system model portfolios with bands |
| Strategic / tactical / dynamic / core-satellite / goal-based | 3.5 and 3.19 — investment policy versions with allocation, bands, core/satellite, rebalancing method |
| Age / life-stage allocation | 3.5 — glide path by goal date or risk profile |
| Rebalancing at least annually | 3.5 — review cadence task; band-breach and drift triggers |
| Diversification vs over-allocation | 3.2 look-through; concentration shown by underlying class |
| Tax-efficient allocation | 3.12 planning & optimiser; harvest/offset/placement rules |

## Appendix E — Benchmark against established family office platforms

See `family-office-BENCHMARK.md` for the full matrix against Addepar, Aleta, Masttro, Asset Vantage, Archway, FundCount, Black Diamond, Landytech, QPLIX, Copia, Eton and Asora. Gaps adopted into v1 are specified in 3.14–3.16 and the 3.1/3.2/3.7/3.9 extensions; gaps deferred (crypto, Monte Carlo, white label, SSO, SOC 2 audit, MCP, attribution, stress tests, structure chart) are listed with their release; gaps rejected (general ledger, bill pay, ESG) are recorded as product decisions in section 11.

## Appendix B — Sample data in the prototype

The prototype ships with a three-entity family (Arjun Mehta, Mehta HUF, Spouse), a net worth of ₹51.4 L, four properties, five private investments, five bank accounts and a ₹31 K working-capital excess. Seed the dev database from the same fixtures so screens and tests match the prototype.

## Appendix C — Handover bundle contents

| Path | What it is |
|---|---|
| `family-office-prototype.jsx` / `.html` | Clickable reference UI (web + mobile preview) |
| `db/001_init.sql` | Full schema, enums, RLS policies, app role, tax rules, benchmarks, system categories — validated on Postgres 16 |
| `db/002_seed.sql` | Dev/staging seed matching the prototype (Mehta family) — validated |
| `db/003_planning_taxation.sql` · `db/004_seed_planning.sql` | Planning & taxation tables, slab/surcharge/deduction data, sample scenarios — validated |
| `db/005_asset_class_coverage.sql` | Precious metals, REIT/InvIT, global assets, FX, look-through, asset-class targets, model portfolios — validated |
| `db/006_balance_sheet_analytics.sql` | Liabilities, insurance, lifestyle assets, ownership graph, succession, TWR/exposure/IPS/fees, extraction, reconciliation, forecast, report packs, external access, API keys — validated |
| `db/007_general_ledger.sql` | General ledger: CoA template, books, periods, immutable balanced journals, posting rules, partner capital, Tally sync — validated, invariants tested |
| `db/011_rebalancing_engine.sql` | Rebalancing & liquidity timing: programs, funding needs, lot constraints, runs, timed plans and moves, coverage — validated |
| `db/010_research_proposals.sql` | Research & proposals: sources, channels, items, recommendations, clusters, assessments, track record, proposals (state machine), digests — validated |
| `db/009_investment_policy.sql` | Investment Policy Framework: versioned policies, allocations, risk limits, questionnaire, compliance, reviews — validated |
| `db/008_action_plane.sql` | Action plane: connectors, policies, payees, kill switch, agent sessions, intents state machine, four-eyes approvals, executions, executor role — validated, 7 invariant tests |
| `family-office-BENCHMARK.md` | Feature benchmark vs 12 established platforms with gap disposition |
| `family-office-EXECUTION-ROUTES.md` | Decision memo: MF (BSE StAR MF / RIA vs ARN / Cybrilla / mandates) and bank (ICICI CIB, BBPS, assisted) execution routes |
| `api/openapi.yaml` | OpenAPI 3.1 contract, 231 paths, 113 schemas — validated |
| `samples/` | Format-faithful parser inputs (tradebook, contract note, CAS text, bank CSV, AA JSON, 26AS, PMS) + README |
| `tickets/phases_0-2_tickets.csv` / `.md` | 44 tickets for phases 0–2 plus 12 for phase 5 (planning & taxation), dependencies |
| `deploy/` | Docker Compose (prod + dev overlay), Dockerfiles, Caddy, Vault, backup/restore/deploy scripts, Hostinger guide |
| `apps/`, `packages/`, `CODEBASE.md` | Running code: API (Fastify, RLS, JWT, stubs for the full contract), web (React), mobile (Expo), executor, finance package with tests — see CODEBASE.md for the live/stubbed matrix |
