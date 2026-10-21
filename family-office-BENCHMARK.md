# Family Office — Feature Benchmark Against Established Platforms

Version 1.0 · 11 September 2026 · Companion to the PRD (v2.0)

## 1. Reference set

Twelve platforms that define the category, grouped by what they are best at. Sources: vendor product pages and three 2026 comparison guides (Aleta, FundCount, Asset Vantage — each vendor-published, so cross-checked against each other).

| Platform | Category | Signature capabilities |
|---|---|---|
| Addepar | Investment analytics for large SFOs/MFOs | Multi-custodian aggregation, ownership structures across entities and generations, TWR/IRR and attribution, exposure and risk analytics, Monte Carlo, configurable reporting, open API, Addison AI |
| Aleta | Total-wealth "command centre" | Every asset class incl. lifestyle and digital assets, AI document ingestion for private markets, private-markets cash-flow forecasting, open API + MCP + data cube, white label, mobile-first, sustainability reporting |
| Masttro | Visual wealth map for UHNW | Visual net-worth map, liabilities and insurance, collectibles and digital assets, fund-report extraction, report template library, secure document sharing |
| Asset Vantage | Accounting-grade reporting (US/India) | Native general ledger, partnership accounting, CBOR/IBOR/ABOR, TWR and IRR/PME, cash-flow forecasting, IPS compliance monitoring, bill pay, document vault, mobile |
| Archway / FundCount / SumIt / Asseta | Accounting and operations | GL, partnership accounting, intercompany, bill pay, banking, report packages, portal delivery |
| Black Diamond | Advisory-led reporting | Consolidated performance, client/family portals, report packs, RIA workflows |
| Landytech Sesame | Data validation at scale | Global custodian network, automated validation, exposure and risk analytics, ownership visualisation |
| QPLIX | European multi-asset with real estate | Lease management, white-label family app, private hosting |
| Copia Wealth Studios | Alternatives intelligence | Entity relationship mapping, deal pipeline, private cash flows |
| Eton AtlasFive | Family office ERP | Workflow, compliance, system of record |
| Asora | Simple wealth tracking | Aggregation, private assets, tasks, documents, transparent pricing |
| mProfit (India) | Investor portfolio tracker | Already benchmarked — PRD Appendix A |

What all of them share (baseline): consolidated view across entities, asset classes and currencies; automated aggregation; liquid and illiquid assets; stakeholder-specific reporting; document vault; role-based security; mobile; SOC 2 Type II.

## 2. Benchmark matrix

Legend — **Full**: specified in PRD; **Partial**: partly covered; **Gap**: not covered. Disposition — **v1**: added to PRD now; **v1.1**: first release after launch; **v2**: later; **No**: intentionally out of scope.

| # | Capability | Who has it | Our spec | Disposition |
|---|---|---|---|---|
| | **A. Balance-sheet completeness** | | | |
| A1 | Liabilities: mortgages, loans against securities, personal loans, credit lines, guarantees; net worth = assets − liabilities | Masttro, Asset Vantage, Aleta, all GL platforms | Gap (only EMIs as outflows, card balances) | **v1** — 3.14 |
| A2 | Insurance register: life, health, property, vehicle; sum assured, premiums, renewals, coverage adequacy | Masttro, Aleta | Partial (policy at surrender value only) | **v1** — 3.14 |
| A3 | Lifestyle / passion assets: art, jewellery, vehicles, collectibles, with valuations and insurance link | Aleta, Masttro | Gap | **v1** — 3.14 (manual valuation) |
| A4 | Digital assets (crypto) | Masttro, Aleta | Gap (excluded) | v2 — Indian tax (30 % flat, 1 % TDS, no set-off) and custody make this a separate piece of work |
| A5 | Operating business interests (family company, LLP stakes) with valuation and dividends | Aleta, Asset Vantage | Partial (private_investments covers unlisted equity) | v1 — reuse private_investments with `kind = operating_business` — 3.14 |
| | **B. Structure and ownership** | | | |
| B1 | Ownership graph: entity owns entity (trust → LLP → property), look-through consolidation by ownership % | Addepar, Landytech, Asset Vantage, Copia | Partial (property_owners % only) | **v1** — 3.14 ownership links |
| B2 | Family tree / structure chart visualisation | Landytech, Masttro | Gap | v1.1 |
| B3 | Nominees, beneficiaries, wills and succession mapping; assets with no nominee flagged | Masttro (partial), advisors' tools | Gap (folder only) | **v1** — 3.14 |
| B4 | Partnership / capital accounting per partner | Archway, FundCount, Asset Vantage | Gap → Partial | **v1** — 3.17 partner capital accounts and profit-share close; full partnership tax allocation v1.1 |
| | **C. Performance and risk analytics** | | | |
| C1 | Time-weighted return alongside XIRR; annualised vs cumulative; per period | Addepar, Asset Vantage, Black Diamond | Gap (XIRR only) | **v1** — 3.15 |
| C2 | Performance attribution / contribution by asset class, entity, manager | Addepar | Gap | v1.1 |
| C3 | Exposure dimensions: sector, market cap, geography, currency, issuer, credit rating, duration | Addepar, Landytech | Partial (asset class + country) | **v1** — 3.15 |
| C4 | Concentration and IPS rule monitoring (max single issuer %, min rating, max illiquid %, max manager %) | Asset Vantage, Addepar | Partial → **Full+** | **v1** — 3.15 rules inside a full **Investment Policy Framework** (3.19): versioned IPS per family/entity/goal, risk questionnaire, builder, nightly compliance, scheduled and trigger reviews, signed document. Asset Vantage monitors an IPS; none of the reference set builds and versions one. |
| C5 | Stress tests / scenario shocks (equity −30 %, rates +200 bp, INR −10 %) | Addepar, Landytech | Gap | v1.1 |
| C6 | Monte Carlo goal-success probability | Addepar | Gap (deterministic projection) | v2 |
| C7 | Private markets metrics: DPI, TVPI, RVPI, PME; J-curve and capital-call forecasting | Aleta, Addepar, Copia, Asset Vantage | Partial (MOIC, unfunded) | **v1** — 3.15 |
| C8 | Fees and cost-of-ownership analysis: TER, PMS/AIF fees, brokerage, advisor fees vs returns | Addepar, Asset Vantage | Gap | **v1** — 3.15 |
| | **D. Data and operations** | | | |
| D1 | AI/LLM extraction from PDFs (capital calls, NAV statements, contract notes, unusual formats) | Aleta, Masttro, Landytech, Addepar | Partial (rule-based parsers + mapping assistant) | **v1** — 3.2 addition |
| D2 | Position-level reconciliation dashboard (demat e-CAS vs holdings, bank vs ledger) with exception queue | Landytech, Asset Vantage | Partial (import health) | **v1** — 3.2 addition |
| D3 | 12–36 month cash-flow forecast across rent, dividends, coupons, capital calls, taxes, lifestyle | Asset Vantage, Aleta, Asseta | Partial (90-day committed outflows) | **v1** — 3.7 extension |
| D4 | Bill pay / payments execution | Asseta, Archway, Asset Vantage | Gap → **Full+** | **v1** — 3.18 action plane: broker orders, MF transactions, bank/BBPS payments with policy, four-eyes approval, cooling-off, kill switch; AI drafts, humans approve, executor executes. None of the reference platforms combine AI drafting with approval-gated execution to brokers. |
| D5 | General ledger, double-entry books, audit-ready financial statements | Asset Vantage, FundCount, SumIt, Archway | Gap → **Full** | **v1** — 3.17 (decided after review) |
| D6 | Maker-checker approvals on data changes | Eton, GL platforms | Partial → journals covered | **v1** for journals (3.17); other data v1.1 |
| | **E. Reporting and access** | | | |
| E1 | Report packs: quarterly pack for principal / trustee / CA, versioned, with corrected-report handling | Addepar, Archway, Black Diamond | Partial (scheduled single reports) | **v1** — 3.9 extension |
| E2 | External viewer portal (CA, advisor, banker) with scoped access and expiry | Black Diamond, Archway, Masttro | Partial (Viewer role) | **v1** — 3.1 extension |
| E3 | White-label family app | QPLIX, Aleta | Gap | v2 |
| E4 | Open API keys, webhooks, bulk export (CSV/Parquet), BI connector | Aleta (API/MCP/Data Cube), Addepar | Partial (OpenAPI for own clients) | **v1** — 3.16 |
| E5 | Natural-language Q&A over own data (Addison, Aleta Intelligence, MCP) | Addepar, Aleta | Gap | v1.1 — expose MCP server over the API |
| E6 | Visual net-worth map / drill-down from total to transaction | Masttro, Aleta | Partial (dashboard drill by entity/class) | v1.1 |
| | **F. Governance, security, compliance** | | | |
| F1 | SOC 2 Type II | All | Gap (ASVS L2, pen test) | v1.1 — start audit after launch |
| F2 | SSO (SAML/OIDC), device management, IP allow-list | Addepar, Asset Vantage | Gap | v2 (single-family use) |
| F3 | Sustainability / ESG reporting | Aleta | Gap | No |
| F4 | Multi-family / advisor mode | Black Diamond, MFO platforms | v2 already | v2 |
| F5 | Multi-currency base reporting | All global platforms | v2 already | v2 |

## 3. What we already do that most of them don't

Worth stating for positioning — these are India-specific operational depths absent from the global platforms:

- Rent, GST (per GSTIN, GSTR-1/3B), TDS 194-I and 26AS reconciliation, property-tax calendar.
- Indian capital-gains engine (grandfathering, 112A exemption, indexation choice, regime comparison, advance tax and 234B/C).
- What-if tax planning with optimiser and execution tracking (only Addepar's scenario modelling is comparable, and it is not tax-aware for India).
- Working-capital deployment ladder with post-tax yields by entity slab.
- Account Aggregator live bank feeds and CAS/contract-note ingestion.
- Three-bucket goal lens plus asset-class lens with Indian model portfolios.

## 4. Gaps accepted into v1 (summary of PRD changes)

| PRD section | Added |
|---|---|
| 3.1 | External viewer invitations (CA/advisor) with scope and expiry |
| 3.2 | LLM-assisted document extraction with confidence + review queue; position-level reconciliation dashboard |
| 3.7 | 12–36 month cash-flow forecast |
| 3.9 | Report packs (composable, versioned, audience-specific) |
| 3.14 (new) | Balance-sheet completeness: liabilities, insurance register, lifestyle assets, operating businesses, ownership graph, nominees and succession map |
| 3.15 (new) | Performance and risk analytics: TWR, exposure dimensions, IPS rules, private-markets metrics and call forecasting, fee analysis |
| 3.16 (new) | Open data: API keys, webhooks, bulk export |
| 3.18 (new) | AI-assisted execution and action plane: connectors, intents, policies, four-eyes approval with step-up auth, executor, oversight, kill switch |
| 3.21 (new) | Rebalancing and liquidity-timing engine: calendar/band/milestone/need triggers, tax- and cost-aware lot selection respecting lock-ins, exit loads and LTCG dates, solver that dates each move to settle before the cash need, calendar. Addepar and Black Diamond offer rebalancing; none time moves to funding needs with Indian lot constraints. |
| 3.20 (new) | Research assistant and investment proposals: multi-channel ingestion, extraction, clustering, policy-fit assessment, source track record, proposal memos, periodic call-to-action digest → action plane. Copia Wealth Studios tracks deal pipelines; no reference platform ingests recommendations and writes policy-checked proposals. |
| 3.19 (new) | Investment Policy Framework: builder, risk profiling, versioned allocation/limits/guardrails per family/entity/goal, compliance, reviews |
| 3.17 (new) | General ledger: entity books, CoA, auto-posting, immutable journals, periods, reconciliation, statements, ITR mapping, Tally two-way |
| 5.10 / 5.11 | Schema for the above (`db/006_balance_sheet_analytics.sql`, `db/007_general_ledger.sql`) |
| Tickets | FO-90 to FO-101 (unphased backlog; sequencing notes indicate dependencies) |

## 5. Deliberately not adopted (decisions for the product owner)

1. ~~General ledger~~ — **reversed**: GL included in v1 (PRD 3.17). Partnership tax allocation beyond capital accounts remains v1.1.
2. ~~Bill pay / payment execution~~ — **reversed**: included via the action plane (PRD 3.18) using bank corporate APIs, BBPS and payout partners; the platform never holds funds.
3. **Crypto** — separate tax regime and custody model; v2 if demanded.
4. **ESG reporting** — no demand signal for Indian single-family use.
5. **White label / multi-family** — v2 with advisor mode.
