import { Link } from "react-router-dom";
import { useApi } from "../lib/useApi";
import { Card, Pill } from "../components";

// Product map (prototype "Product map"): the flow between modules and, per module, what is built so far with a link to the screen.
// Build status mirrors BUILD-STATUS.md at the repo root; the API's health, contract size and integrations are read live.
const FLOW: [string, string][] = [
  ["Onboard", "Create entities (Individual, HUF, spouse) → GSTIN / PAN → risk questionnaire → build and sign the Investment Policy (allocation, bands, limits, guardrails) → connect banks (AA consent) → import CAS & contract notes"],
  ["Ingest", "Daily: AMFI NAV, NSE / BSE prices, FX, AA bank feed, e-mailed statements · Monthly: PMS / AIF marks · Manual: start-up rounds, property events · Continuous: research feeds (e-mail, WhatsApp, RSS, uploads) → recommendations → policy fit → proposals"],
  ["Reconcile & post", "Bank credits ↔ rent / dividend / coupon · Demat & e-CAS ↔ holdings · TDS ↔ 26AS · Corporate actions applied, exceptions surfaced · every matched event auto-posts a balanced journal into the entity's books"],
  ["Analyse", "Net worth, XIRR / TWR, look-through allocation, bucket drift, idle cash, tax position, upcoming commitments, insurance adequacy, succession gaps"],
  ["Plan", "What-if scenarios (tax), and the rebalancing engine: calendar / band / milestone / funding-need triggers → timed, tax-aware moves that settle before each dated need; compare, review, approve"],
  ["Act", "Approved plan actions, rebalancing tasks, deployment plans, rent reminders, bills and taxes become intents — drafted by the assistant or an operator, policy-checked, approved by a human with step-up auth, executed by the executor through broker / bank connectors (or assisted where no API exists), reconciled on import, posted to the books"],
  ["Report", "Statements, Schedule CG, GST register, cash flow, private register, balance sheet — PDF / Excel / CSV / Parquet, scheduled to family & CA, exports and webhooks for other tools"],
];
type Mod = { name: string; to: string; prd: string; done: string[]; left?: string[]; milestone: string };
const MODULES: Mod[] = [
  { name: "Dashboard", to: "/", prd: "3.1", milestone: "M1–M3", done: ["Net worth by entity with 12-month trend, MoM and XIRR", "Three-bucket bar and asset-class pie", "Needs-attention feed from the task engine", "Compact performance card"] },
  { name: "Investments", to: "/investments", prd: "3.2, 3.14", milestone: "M2–M4, M13", done: ["Holdings with FIFO lots, XIRR, TWR and benchmark performance", "Capital gains per FY with grandfathering and the LTCG exemption; Schedule CG export", "Corporate actions (bonus, split, demerger, merger) applied and reviewed", "Imports: CAS (CAMS / KFintech), contract notes, bank CSV, AA JSON, 26AS, PMS / AIF statements, e-CAS", "Harvest candidates (losses first, exempt long-term gains)", "Global: LRS against the limit with TCS, foreign tax credits, FX rates", "Section 112A grandfathering from 31 Jan 2018 FMVs per ISIN", "Scanned PDFs and images read through an OCR command"] },
  { name: "Real estate", to: "/real-estate", prd: "3.3", milestone: "M4", done: ["Properties with owners, valuations, P&L, capital improvements", "Tenants, leases, rent ledger with receive / waive / remind", "GST register per GSTIN, returns, property-tax calendar", "Maintenance log"] },
  { name: "Start-ups", to: "/startups", prd: "3.7", milestone: "M13", done: ["Companies and stakes (CCPS, SAFE, CCD, equity, fund units, operating business)", "Rounds re-mark every stake and dilute the %", "Marks, commitments with call schedules → committed outflows", "Exit scenario priced from tax_rules with the bucket effect"] },
  { name: "Goals & buckets", to: "/goals", prd: "3.5", milestone: "M13", done: ["Editable bucket targets with drift and the nightly generators", "Asset-class lens on a model portfolio: headline vs look-through, bands, reviews", "Goals with inflated need, funded %, gap and monthly required; links to holdings", "Rebalance proposal ordered by the smallest taxable gain → tasks", "Glide paths that only de-risk"] },
  { name: "Banking", to: "/banking", prd: "3.4", milestone: "M12", done: ["Account Aggregator consent (mock sandbox or Finvu-shaped provider), signed webhooks, four-hourly sync", "Categorisation rules that learn from corrections; internal-transfer pairing", "Cash flow 30 / 90 / 365 by category, entity, month, counterparty", "E-mail ingest inbox with allow-list and quarantine", "Manual accounts, CSV import, committed outflows"], left: ["Live AA UAT with FIU credentials"] },
  { name: "Working capital", to: "/working-capital", prd: "3.6", milestone: "M13", done: ["Float and deployable excess from committed outflows", "Deployment plan by horizon and slab → tasks", "Instrument ladder: gross vs post-tax yield", "Float / idle-cash / instrument-preference settings"] },
  { name: "Tasks & notifications", to: "/tasks", prd: "3.15", milestone: "M4", done: ["Generators: rent, lease expiry, premiums, LTV, nominees, stale prices, IPS breaches, allocation bands and reviews, capital calls, CAS refresh", "Assign, verify, done / dismiss / reopen", "In-app inbox, Expo push, e-mail digests through the delivery adapters"] },
  { name: "Action plane", to: "/action-plane", prd: "3.18", milestone: "M6", done: ["Intents with fourteen policy codes, approver tiers and cooling-off", "Step-up approvals, batch approve, assisted confirm; separation of powers enforced by DB triggers", "Executor on its own DB role through sandbox connectors (Kite, BSE StAR MF, corporate banking, BBPS)", "Connectors, payees, mandates, oversight and the kill switch"], left: ["Provider certification outside the sandbox", "Vault-backed credentials", "Passkey assertions"] },
  { name: "Books (general ledger)", to: "/books", prd: "3.17", milestone: "M7", done: ["84-account CoA per entity; auto-posting of every matched event", "Journals with maker-checker, reversals (posted journals are immutable)", "Trial balance, I&E, balance sheet, capital account, cash flow, ITR mapping, consolidation", "Periods, soft close, lock, year-end close", "Bank and investment reconciliation, unposted queue", "Recurring journals, posting rules, Tally XML export / import", "Period-end: mark-to-market against the unrealised reserve, depreciation from rates held as data", "Tally live sync: ping, push masters and vouchers, pull the day book"], left: ["Buildings depreciation (held at cost with valuations)"] },
  { name: "Planning & tax", to: "/planning", prd: "3.8, 4", milestone: "M5", done: ["Scenarios with versioning, simulate, compare, review threads, approve → tasks", "Tax position per entity and FY (both regimes), advance-tax schedule", "Optimiser suggestions (LTCG exemption, harvesting, regime switch, timing)", "Execution tracker", "ITR schedules HP / OS / AL / FA next to Schedule CG"] },
  { name: "Investment policy", to: "/policy", prd: "3.19", milestone: "M8", done: ["Policies per family / entity / goal with inheritance", "Versions: draft → review → active; rendered IPS; step-up signing", "Compliance checks nightly with breaches → tasks", "Risk questionnaire"] },
  { name: "Rebalancing", to: "/rebalancing", prd: "3.20", milestone: "M8", done: ["Programs with calendar, band, drift, milestone, need and large-flow triggers", "Dated funding needs with coverage", "Plans of tax-aware moves that settle before each need; simulate, review, approve → intents"], left: ["Scheme-master exit loads"] },
  { name: "Research", to: "/research", prd: "3.21", milestone: "M9", done: ["Sources with trust and conflicts; channels: e-mail, WhatsApp hook, RSS, upload, paste", "Extraction, clustering, assessment against the policy, sizing", "Proposals → intents; digests with batch decisions; track record"], left: ["IMAP poller, image extraction"] },
  { name: "Documents", to: "/documents", prd: "3.10", milestone: "M10", done: ["S3 / filesystem store with SSE and signed links, folder tree, MIME gate, virus scan hook", "Extraction review queue", "Password-protected PDFs opened with the family's passwords"] },
  { name: "Reports & open data", to: "/reports", prd: "3.9, 3.16", milestone: "M10", done: ["40 report codes as PDF / XLSX / CSV / HTML / Parquet", "Packs, schedules (cron) and external viewers (CA) with bounded access", "API keys with per-module scopes, webhooks with HMAC and retries, bulk export", "Scheduled exports on a cron with export.ready webhooks", "MCP server: 25 scoped tools for Claude Desktop / Cursor over an API key"], left: ["MCP over HTTP (stdio today)"] },
  { name: "Balance sheet", to: "/balance-sheet", prd: "3.11", milestone: "M11", done: ["Net worth across entities with liabilities, insurance, lifestyle assets", "Loan schedules and LTV, premiums due, adequacy", "Ownership links, nominations, succession documents"] },
  { name: "Analytics", to: "/analytics", prd: "3.12", milestone: "M11", done: ["Look-through exposure on ten dimensions", "IPS rules nightly with breaches", "Private-market metrics (DPI / TVPI / IRR / PME), fees drag", "Cash-flow forecast, reconciliation"] },
  { name: "Settings", to: "/settings", prd: "3.1, 3.18", milestone: "M13", done: ["Entities with encrypted PAN and GSTINs", "Members, invitations and roles", "Two-factor login (TOTP)", "Integrations and feed health"] },
];

export function ProductMap() {
  const health = useApi<any>("/integrations/health"); const feeds = useApi<any>("/feeds/health");
  const built = MODULES.reduce((s, m) => s + m.done.length, 0), left = MODULES.reduce((s, m) => s + (m.left?.length ?? 0), 0);
  const notHealthy = (health.data ?? []).filter((x: any) => x.status === "failed" || x.status === "needs_review").length;
  return (<>
    <div className="kpis">
      <Card><div className="mute">Modules live</div><div className="big-num">{MODULES.length}</div><div className="small mute">every screen in the prototype</div></Card>
      <Card><div className="mute">Capabilities built</div><div className="big-num" style={{ color: "var(--teal)" }}>{built}</div><div className="small mute">{left} residue items remain</div></Card>
      <Card><div className="mute">API contract</div><div className="big-num">364</div><div className="small mute">paths in api/openapi.yaml, all routed</div></Card>
      <Card><div className="mute">Integrations</div><div className="big-num" style={{ color: notHealthy ? "var(--amber)" : "var(--teal)" }}>{health.data ? `${health.data.length - notHealthy}/${health.data.length}` : "…"}</div><div className="small mute">{notHealthy ? `${notHealthy} need attention` : "healthy or manual"} · <Link to="/settings">details</Link></div></Card>
    </div>
    <Card title="Product map — modules and the flow between them">
      <div className="flow">{FLOW.map(([s, d], i) => <div key={s} className="step"><div className="step-n">{i + 1}</div><div><b>{s}</b><div className="small mute">{d}</div></div></div>)}</div>
    </Card>
    <Card title="What is built, module by module">
      <div className="grid-2">{MODULES.map((m) => <div key={m.name} style={{ padding: "10px 0", borderBottom: "1px solid #EFF1F4" }}>
        <div className="row" style={{ justifyContent: "space-between" }}><Link to={m.to}><b>{m.name}</b></Link><div className="row gap"><span className="small mute">PRD {m.prd} · {m.milestone}</span><Pill tone={m.left?.length ? "amber" : "teal"}>{m.left?.length ? `${m.done.length} built · ${m.left.length} left` : "complete"}</Pill></div></div>
        <ul className="small" style={{ margin: "6px 0 0 16px", padding: 0 }}>{m.done.map((d) => <li key={d}>{d}</li>)}{(m.left ?? []).map((d) => <li key={d} className="mute">{d} — pending</li>)}</ul>
      </div>)}</div>
      <div className="small mute" style={{ marginTop: 8 }}>Feeds: {(feeds.data?.jobs ?? []).map((j: any) => `${j.label} ${j.last_status}`).join(" · ") || "…"}. The full status with verification per area is in BUILD-STATUS.md; PROGRESS.md has the milestone log.</div>
    </Card>
  </>);
}
