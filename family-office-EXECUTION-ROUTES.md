# Execution routes — mutual funds and bank payments

Version 1.0 · 11 September 2026 · Resolves PRD section 11, decisions 10 and 11

## 1. Mutual fund execution

### What is not available

| Route | Status | Why |
|---|---|---|
| Zerodha Kite Connect MF API | **Read-only** | Kite's MF endpoints are GET only (orders, SIPs, holdings, instrument master). Zerodha removed order placement because a purchase needs a debit from the investor's bank account. No sandbox either. |
| Upstox / Angel One / Dhan / ICICI Direct APIs | No MF order placement | Equity/derivative APIs only. |
| MF Central | No transaction API for third parties | Investor portal; CAS/statement retrieval only. |
| AMC websites | No APIs | — |

Consequence: the PRD's "Kite MF orders" route is withdrawn. MF purchases, redemptions, switches and SIP mandates through the platform require an **exchange MF platform code** — or they stay *assisted* (pre-filled instruction, human completes on Coin / MF Central / AMC site).

### What is available

**BSE StAR MF** (also NSE NMF II and MF Utilities) is the industry order-routing platform. Access requires the transacting intermediary to be one of:

| Registration | Who can hold it | Plans transacted | Getting it | Cost / effort |
|---|---|---|---|---|
| **SEBI Registered Investment Adviser (RIA)** | Individual (NISM X-A/X-B, graduate + 5 yrs experience) or corporate/LLP (principal officer qualified; net worth / deposit norms) | **Direct plans** (no commission, lowest TER) | SEBI application via BASL; 3–6 months | ₹1–3 L set-up incl. BASL membership, deposit, compliance; annual compliance audit |
| **AMFI Mutual Fund Distributor (ARN)** | Individual (NISM V-A) or company/LLP (EUIN holders); HUF cannot hold an ARN | **Regular plans** (distributor earns trail) | NISM exam + AMFI registration; 4–8 weeks | ~₹15–25 K; trivial compliance |
| **Existing RIA/MFD's code via API partner** | Family becomes a client of a friendly RIA | Direct (RIA) or regular (MFD) | Agreement + client onboarding on their BSE code; weeks | Advisory fee |

**API layer options over BSE StAR MF**

- **Direct BSE StAR MF web services** — SOAP 1.2, member web-service ID + password + pass-key per session, test market credentials on request, order entry / SIP / mandate / additional services; payment via e-mandate (NACH), net-banking link or UPI per order. Heavy but free.
- **Cybrilla Fintech Primitives** — REST wrapper over BSE with KYC, mandates, orders, folios, reconciliation; you still need your own ARN/RIA code, which they onboard as a tenant. Paid; fastest to build on.
- **MF Utilities (MFU)** — alternative platform with its own API; common with RIAs; direct plans supported.

**Funding the purchase without a human at the bank.** Register a **NACH e-mandate** per investor (Arjun, Spouse; HUF via its current account) in favour of BSE StAR MF, once. Lump-sum purchases and SIPs then draw against the mandate up to its limit, so an approved intent completes end to end with no net-banking step. Mandate limits are set at registration (commonly up to ₹1 crore/day through e-mandate) — set them at the policy caps.

### The direct-plan question

An ARN is quick, but a distributor can only route the family into regular plans, whose TER is typically 0.5–1.0 pp higher. On a portfolio of a few crores that exceeds the cost of RIA registration in the first year. Some family offices register an LLP as the distributor and invest their own money in regular plans, taking the trail commission back as LLP income — it neutralises the TER but adds taxable income and a compliance oddity; ask the CA before relying on it.

### Recommendation

1. **Now:** MF kinds run as *assisted* intents (pre-filled ISIN, amount, folio; human completes on Coin or MF Central; the platform reconciles from CAS). Zero registration; keeps momentum.
2. **Start immediately:** RIA registration for a family LLP/company (or the family's existing adviser's RIA code if one exists). Target: direct plans via BSE StAR MF with NACH mandates, using Cybrilla FP to cut integration time; fall back to raw SOAP if the vendor cost is unacceptable.
3. **Kite Connect** stays for equity/ETF/REIT/SGB orders and for MF *read* (holdings, SIP status) as a second reconciliation source.

## 2. Bank payment execution

### What is available

| Bank | Product | Payment modes | Auth model | Notes |
|---|---|---|---|---|
| ICICI Bank | Corporate API Suite / CIB APIs (developer portal, sandbox, UAT → prod) | NEFT, RTGS, IMPS, UPI, internal transfer; beneficiary registration; transaction status; balance/statement; virtual accounts; e-mandate | API call **with or without portal authorisation** — i.e. the bank can require a checker to approve in CIB, or accept the API as fully authorised | Best-documented; existing corporate customers onboard fastest |
| HDFC Bank | Corporate API banking (ENet) | NEFT, RTGS, IMPS, A2A; single with/without portal authorisation; bulk NEFT with single OTP | Signature validation / JOSE | Certificate-based |
| Axis Bank | API Banking | NEFT, RTGS, IMPS, A2A | AES/RSA + signature | |
| Yes Bank | API Banking | NEFT, RTGS, IMPS, A2A | Signature | Historically the most fintech-friendly |
| Kotak | API Banking | NEFT, RTGS, IMPS, A2A | AES/RSA | |
| SBI, BoB, others | Limited / UAT | — | — | Not for v1 |

Common requirements: a **current account** in the entity's name, corporate internet banking with maker/checker set up, a signed API agreement, UAT sign-off, **static IP allow-listing**, client certificates or RSA key pairs, beneficiary pre-registration (often with a cooling period), and per-transaction limits set by the bank.

Aggregators (Decentro, Setu, Zwitch, Signzy) wrap several banks behind one API; payout products (RazorpayX, Cashfree Payouts) give an API-driven current account at a partner bank (RBL/Yes/ICICI) in the entity's name. Both are legitimate routes; both add a counterparty and fees.

### What is not available

- **Savings accounts (individuals)** — no third-party payment-initiation API. Account Aggregator is read-only by design.
- Workarounds that keep the individual's money movable by the platform:
  - **UPI intent / deep link** (assisted): the platform prepares payee + amount + note; the person taps and approves in their UPI app. Fine for bills and small transfers.
  - **NACH e-mandate** from the savings account to a destination the family controls (e.g. BSE StAR MF for MF purchases, or the family LLP's current account for a sweep) — registered once with net-banking/debit-card authentication, then debits are API-triggered. Moving money to another family entity has gift/loan/clubbing consequences; use it for MF mandates first.
  - **Standing instructions** for fixed recurring items (property tax cannot use these; premiums can).

### Mapping to the family's entities

| Entity | Account today | Route |
|---|---|---|
| HUF | ICICI current ••0928 | ICICI Corporate API Suite — full API payments; HUF registers for CIB with karta as authoriser |
| Individuals (Arjun, Spouse) | HDFC / Kotak savings | Assisted (UPI intent) for payments; NACH mandates for MF purchases; optionally open a personal *current* account at ICICI/Yes/Axis for API access |
| LLP/company (if created for RIA) | New current account | Full API; can act as the family's payment hub for vendor bills |

Bills (property tax, utilities, insurance premiums) go through **BBPS** regardless of bank — a BBPS agent API (Setu, Razorpay) fetches the bill by consumer/assessment number and pays from a linked account; receipts reconcile automatically. This covers the most frequent payment intents without touching savings-account APIs at all.

### Recommendation

1. **HUF on ICICI Corporate API Suite** first: one bank, one entity, the account already exists. Enable "with portal authorisation" initially so the bank's own checker step remains until the platform's approval flow has run for a month; then move to "without".
2. **BBPS agent (Setu)** for property tax, utilities and premiums across all entities.
3. **Individuals stay assisted** via UPI intent, with NACH mandates for MF purchases. Revisit a personal current account only if assisted volume becomes a burden.
4. Skip aggregators in v1 (one bank, one entity does not justify them); reconsider when a second bank or a payout hub is needed.

## 3. What changed in the spec

- PRD 3.18 connectors table: Kite = equity/ETF orders + MF read; MF execution = BSE StAR MF (RIA/MFD code, NACH mandates, Cybrilla FP or SOAP); banks = ICICI CIB for HUF, BBPS for bills, assisted for savings accounts.
- Intent kinds `mf_purchase / mf_redemption / mf_switch / mf_sip_mandate` are *assisted* until the MF connector (FO-126) is live; the capability matrix at `/actions/schemas` says so per kind.
- Tickets FO-124, FO-126, FO-127 reworded; new FO-134 (NACH e-mandate registration and tracking).
- Decisions 10 and 11 in PRD section 11 now carry the recommendation above and await your confirmation.
