# WealthPrism / Family Office — Project Memory & Handover Notes

**Purpose:** running notes from Claude Code sessions on this project, so any teammate (or Claude, in a
future session) can pick up exactly where things left off. This file is safe to share as-is — no secrets in it.

**Last updated:** 2026-10-08

---

## Where things stand

### Local dev environment — up and running
- **Database:** PostgreSQL 16 installed **natively** on this Windows machine — not Docker. Docker Desktop
  was tried first but failed (`Virtualization support not detected`) on this hardware (AMD A6-9225, an old
  low-power CPU); native Postgres was the lighter working alternative.
- Database `familyoffice` created, all 30 migrations applied, demo "Mehta Family" data seeded.
- pnpm 12.4.1 installed globally (`npm install -g pnpm@12.4.1`); app dependencies installed; `@fo/api` and
  its workspace dependencies built.
- **Postgres superuser password:** ask Jey directly — intentionally not written in this shared file.
- **To run locally** (two terminals, both from `app/`):
  ```
  cd familyoffice-main/app
  $env:DATABASE_URL='postgres://app_user:app@localhost:5432/familyoffice'
  pnpm dev:api      # http://localhost:4000

  cd familyoffice-main/app
  pnpm dev:web      # http://localhost:5173
  ```
  Redis, MinIO and the worker/executor were **not** set up — not required to view and use the app; only
  background jobs (scheduled feeds, reminders) are off.
- **Demo login:** `arjun@example.com` / `Prototype!2026` (also `priya` / `ops` / `ca` @example.com). Step-up
  approval code: `000000`.

### App-level change made
- Added a public landing page: `app/apps/web/src/pages/Welcome.tsx`. It shows at `/` **only when signed
  out**; a "Client login →" link goes to `/login`. Everything else — the login page itself, protected routes,
  what happens after signing in — is unchanged. Routing logic is in `app/apps/web/src/main.tsx` (`Root`
  component).
- The original static file `wealthprism-index.html` (outer project root) is **no longer used** by the running
  app — superseded by the page above. Left in place, harmless, just inactive.

### Reviewed and documented
- Walked all 20 sections of the app live in the browser (Playwright) and explained each one in plain,
  non-technical language with a real example pulled from the actual demo data. Full detail is in the chat
  history of that session.
- **One live bug found, not yet fixed:** Analytics → Cash-flow forecast throws a raw database error on an
  invalid calculated date (`"2027-09-31"` — September has 30 days). Everything else on that page works.

### Deliverable already sent to "head"
A full project-flow and enhancement-roadmap document was written and published:

**https://claude.ai/code/artifact/0e37d843-edca-45ab-9bde-00c178189a8e**

Contents: the app's 7-stage operating flow (Onboard → Ingest → Reconcile → Analyse → Plan → Act → Report,
as a diagram), every one of the 20 modules mapped to that flow with its purpose, the platform's built-in
safeguards (separation of powers, double-entry books, kill switch, RLS, etc.), a build-status table per
module, and 9 prioritized enhancement recommendations (highest: fix the bug above, turn on the nightly
scheduler, auto-generate tasks for insurance/succession gaps).

### Multi-account login & self-signup — built, tested, working
The original ask was: one email should be able to hold different roles (Owner/Member/Operator/Viewer) across
multiple separate family accounts, see all of them after login, and switch between them.

- **Turned out to be mostly already built:** the backend already returns every family + role for a login
  (`families: [{id, name, role}]`), and the sidebar dropdown in `Shell.tsx` already lists and switches between
  them (`X-Family-Id` header scopes every API call). This was *not* new code — just confirmed and demoed.
- **What was actually missing and got built:** a way for someone to *become* an Owner.
  - `app/apps/web/src/pages/Login.tsx` — after sign-in, if the email has no Owner role anywhere, shows a
    "Create owner account" card (calls the existing `POST /families`, which was backend-complete but had zero
    UI wired to it).
  - **New:** self-service sign-up for emails that don't exist in the system at all (there was previously no
    registration path — every user was invite-only). Added `POST /auth/register` (new backend route +
    `api/openapi.yaml` contract entry) and a second card on the login page for this case. **This is an
    intentional, reversible decision: open signup, not invite-only.** If asked to "undo" this later, revert
    `routes/auth.ts` (`/auth/register`), `lib/api.ts` (`register()`), `pages/Login.tsx` (the `isNewEmail` card),
    and the `api/openapi.yaml` entry — four isolated spots, no DB schema involved.
  - Tested live end to end with Playwright: existing-owner login unchanged; existing-non-owner (the CA demo
    user) gets the "create owner account" card and it works; a brand-new email registers, becomes Owner of a
    new empty family, and the dropdown correctly lists all of that person's accounts/roles side by side.

### Enhancement work — in progress, split into two groups
Working through the roadmap doc's "Partial/Pending" items (see the published doc link below for the full table).

**Group A — real engineering, being built locally:**
1. Fix Analytics → Cash-flow forecast date bug
2. Turn on the background scheduler locally
3. Books — buildings depreciation
4. Rebalancing — scheme exit-load data
5. Reports — MCP server over HTTP (currently stdio-only)
6. Action plane — passkey (WebAuthn) step-up
7. Action plane — vault-backed credential storage
8. Research — intake automation (demoed against a mock inbox, not a real one)

**Group B — parked, waiting on the head (not something code can finish):**
- **Banking — live Account Aggregator (Finvu).** Code is 100% complete (`app/apps/api/src/lib/aa.ts` fully
  implements Finvu's protocol). What's missing is a real Finvu business registration (`AA_CLIENT_ID`,
  `AA_CLIENT_SECRET`, `AA_FIU_ID`, etc.) — a business-side signup, not engineering. **Also:** even with real
  credentials, Finvu's webhook can't reach `localhost` — real AA testing needs a publicly reachable server
  (deployed, or tunnelled), so it's out of scope for local end-to-end testing regardless.
- **Action plane — real broker/bank certification** (Zerodha, ICICI) — same category, an external
  certification process, not code.

Decision as of 2026-10-07: keep both Group B items explicitly pending until the head provides what's needed;
proceed with Group A, then create a fresh demo customer (via the new self-signup flow, not the old seed
script) and test the whole 7-stage loop end to end against it.

---

## In progress / next up

- **Group A progress:**
  - [x] 1. Cash-flow forecast date bug — fixed in `app/apps/api/src/lib/analytics.ts` (`lastDayOfMonth()`
    helper replaces a hardcoded `-31`). Verified against all 34 possible `months` values (3–36), all 200 OK.
  - [x] 2. Background scheduler — running locally (`pnpm --filter @fo/api worker`, background task
    `bchmsznbp`). Also ran `cli valuations:backfill --from 2025-09-01` + `cli performance:refresh` once by
    hand to seed history immediately rather than waiting on the worker's nightly windows. Dashboard
    performance chart now shows real data (TWR 57.86% vs NIFTY50 11.99% over 1y, 14 valuation points).
  - [x] 3. Books — buildings depreciation — `db/031_property_depreciation.sql` adds `properties.land_value`
    (land is never depreciable); `glperiod.ts` now feeds buildings into the schedule using rates already
    seeded since migration 028 (`building` 5% residential, `building_commercial` 10%). Verified live across
    all 3 entities — correct rate per property type, land (Ooty farmland) correctly excluded.
  - [x] 4. Rebalancing — scheme exit-load data — new `POST /instruments/exit-load` + `cli exitload:load`,
    mirroring the existing FMV-loading pattern exactly (writes `instruments.meta.exit_load`, which
    `lotConstraintsFor()` already prioritized over its generic 1%/365-day guess — that wiring pre-existed).
    Loaded real/representative data for the 3 demo mutual funds (`samples/exit_loads_demo_sample.csv`).
    Verified it flows through to the live `lot_constraints` table used by the rebalancing engine.
  - [x] 5. Reports — MCP server over HTTP — new `POST /mcp` in `server.ts` + `injectApiCall()` in `lib/mcp.ts`
    (uses Fastify's `app.inject`, no self-HTTP loopback). Each request authenticates with its own bearer API
    key (unlike stdio's one `FO_API_KEY` per process). Verified live: `initialize`, scope-filtered
    `tools/list`, a real `tools/call` returning live dashboard data, and a correctly-rejected out-of-scope call.
  - [x] 6. Action plane — passkey step-up — `db/032_webauthn_passkeys.sql` (`webauthn_credentials` table +
    `users.webauthn_challenge`), new `routes/webauthn.ts` (register/options, register/verify, credentials
    list/delete, challenge), `verifyStepUp()` in `lib/auth.ts` extended for `method:"passkey"` — this is the
    SAME generic gate every approval type already used (action plane, policy, research, connectors,
    rebalance), so passkey now works everywhere step-up already did, no other route changed. Frontend:
    Settings → Security → Passkeys card (register/list/remove), Action plane detail view gets a second
    "Approve with passkey" button next to the existing step-up one. `@simplewebauthn/server` +
    `@simplewebauthn/browser` added as dependencies. **Fully verified live end to end** during the demo-customer
    walkthrough below, using Chrome's CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator` — the
    standard way to test WebAuthn in automation, not a shortcut): registered a passkey for two different real
    users, then approved an Action plane intent with one of them — the UI correctly recorded the approval as
    "Ravi Iyer (passkey, 127.0.0.1)" and the four-eyes rule still held (the proposer could not approve).
  - [x] 7. Action plane — vault-backed credential storage — `secretEncrypt`/`secretDecrypt` added to
    `apps/api/src/lib/connectors.ts` (encrypt on register) and `apps/executor/src/lib/crypto.ts` (decrypt on
    use), calling HashiCorp Vault's Transit engine HTTP API when `SECRETS_BACKEND=vault` (+ `VAULT_ADDR`,
    `VAULT_TOKEN`, `VAULT_TRANSIT_KEY`), falling back to the existing local AES-256-GCM by default — kept out
    of the shared `@fo/connectors` package deliberately, since its header explicitly says "no network... in
    here". Vault's own ciphertext is self-describing (`vault:v1:…`), so both formats coexist without a bulk
    re-encryption. Also surfaced on Settings → Integrations health as a new row. Verified live: registering a
    connector with the **default** (non-Vault) path still encrypts exactly as before, no regression. **Not
    verified against a real Vault server** — would need `vault server -dev` installed and running locally,
    which nobody asked to stand up; the code follows Vault's actual documented Transit API shape.
  - [x] 8. Research — intake automation — new `pollImap()` in `lib/research.ts`: real IMAP via `imapflow` +
    `mailparser` (host/user/password in `channel.config`, password encrypted at write-time in
    `routes/research.ts`'s `sealChannelConfig`, same scheme as connector credentials), OR a deterministic mock
    inbox (`config.mock: true`, no real mailbox needed) for local/demo testing — same dual-path precedent as
    `lib/aa.ts`'s mock vs Finvu provider. Image/PDF attachments reuse Documents' existing `ocrText()` directly,
    no separate OCR wiring. New `POST /research/channels/:id/poll` for on-demand polling (plus `pollChannels()`
    now also sweeps active `email` channels, alongside the pre-existing `rss` sweep). Verified live end to end:
    created a mock channel ("Research inbox (mock demo)", left in place), polled it, all 3 messages ingested
    and extracted (incl. the friend's WhatsApp-style tip and a PMS letter), confirmed the OCR'd attachment text
    ("Marcellus Investment Managers — ... — Authorised Signatory") correctly appended to that item's body.

### Demo customer — full loop verified end to end (2026-10-07)
Created entirely through the app's own flows (not a seed script) to prove the whole system works for a
genuinely new customer, exercising every item built above:

- **Onboard:** self-registered via `POST /auth/register` — `priya.demo@wealthprism.example` / `DemoPass123!`,
  family "Iyer Family Office". Added entity "Priya Iyer" (individual, PAN BXKPI1234L). Invited a second member
  (`ravi.demo@wealthprism.example` / `RaviDemo123!`, role member) and accepted the invite, specifically so
  four-eyes approval has two distinct real people to test with. Set up the entity's GL book (`PUT /gl/books`
  — a genuine onboarding step, not automatic; a fresh entity has none until this runs).
- **Ingest:** linked a mock HDFC Bank account via the Account Aggregator sandbox (initiate → simulate →
  sync — 2 new transactions). Hand-entered a buy of 20 HDFC Bank shares (₹33,000).
- **Reconcile:** ran `cli gl:autopost` — 3 journals posted, a correct, balanced double-entry trial balance
  (Bank accounts, Listed equity, Interest income, Household & lifestyle).
- **Analyse:** Dashboard correctly shows net worth ₹34,445, 1 live bank account, bucket drift, all attributed
  to the right entity — confirmed both via API and live in the browser.
- **Act:** proposed an mf_purchase intent as Priya; approved it as Ravi using his real passkey (see item 6
  above) — four-eyes held, intent moved to `queued`, visible in the execution audit.

Login for this demo account: `priya.demo@wealthprism.example` / `DemoPass123!` (owner) or
`ravi.demo@wealthprism.example` / `RaviDemo123!` (member, has a passkey registered). Both have passkeys
registered in whichever browser profile ran this session's Playwright tests — they won't work from a different
browser/machine without re-registering.

### Second, richer demo customer — "Menon Family Office" (2026-10-07)
First one above ("Iyer") was deliberately thin, just enough to prove each piece works. This second one is a
fuller, more realistic dataset, built live in the browser starting from the sign-up screen itself (not via API
shortcuts for the account creation step), to show the whole thing convincingly:

- **Owner:** `rajesh.demo@wealthprism.example` / `RajeshDemo123!` (Rajesh Menon). **Member:**
  `meera.demo@wealthprism.example` / `MeeraDemo123!` (Meera Menon) — invited specifically for four-eyes testing.
- **2 entities:** Rajesh Menon (individual) and Menon HUF — both with GL books set up.
- **Banking:** ICICI savings account linked via AA sandbox, balance ₹4.21 L.
- **Investments:** 50 HDFC Bank shares (Rajesh), 2,000 units Parag Parikh Flexi Cap (Menon HUF).
- **Real estate:** "Menon Apartment, Kochi" (Menon HUF, ₹45 L), tenant K. Suresh, 2-year lease at ₹18,000/month
  — 24 months of rent schedule generated automatically; Dashboard correctly flagged the first month overdue.
- **Goals & buckets:** bucket targets set (10/40/50), one goal ("Daughter's education", ₹15 L by 2032).
- **Action plane:** Rajesh proposed a ₹20,000 fund purchase; Meera approved it with a typed step-up code
  (`000000`) — confirmed live: *"Meera Menon (totp, 127.0.0.1)"*, four-eyes held, status moved to `queued`,
  with the full assisted-order instructions shown (Zerodha Coin, folio reference flow).
- **Books:** ran `cli gl:autopost` twice — Menon HUF has 8 posted journals, Rajesh has 3, **trial balance
  shows "Balanced"** with real lines (Bank accounts, Mutual funds, Rent receivable accrued from the lease).
- Dashboard confirmed correct throughout: consolidated net worth ₹51.17 L across both entities, bucket drift,
  rent tracking — checked both via API and visually in the browser.

Not yet done for this account: Startups, Working capital, a generated Report, and Planning scenarios — the
core 7-stage loop is proven; those would be incremental additions using the same pattern (see the API calls
earlier in this session's transcript for the exact request shapes used).

### Real bug found and fixed while testing — corporate actions never reached new families (2026-10-07)
Found by clicking through Investments → Corporate actions for the Menon demo account: HDFC Bank's 1:1 bonus
(ex-date 28 Aug 2026) showed status "Applied" on screen, but Rajesh's holding was still 50 shares, not 100.

**Root cause:** `corporate_actions` has no family scoping — one global row per real-world event. The bonus row
was hand-seeded in `002_seed.sql` with `auto_apply` defaulting to `false` (that column didn't exist yet when
002 was written; it was added later by `016_market_data.sql`). `autoApplyCorporateActions()`
(`app/apps/api/src/jobs/market.ts`) only ever matched `status='pending' and auto_apply` — so this row, sitting
at `status='applied', auto_apply=false`, was never picked up for **any** family, ever. Mehta Family's holding
only shows the bonus because its lot was hand-seeded directly into `002_seed.sql`, bypassing the apply
mechanism (and its tracking) entirely. Any family created after the seed that held HDFC Bank before the
ex-date — Rajesh here, and the earlier "Iyer" test account too — silently never got their bonus shares, with
no error anywhere.

**Fix (3 parts, all applied and verified):**
1. `jobs/market.ts` — `autoApplyCorporateActions()` now matches `status in ('pending','applied')`, not just
   `'pending'`. Safe to re-sweep `'applied'` rows because `applyCorporateAction()` already skips any holding
   with an existing `corporate_action_applications` row — confirmed no double-application is possible.
2. `db/033_corporate_action_backfill.sql` (new migration, since 002/016 are already-applied files and must not
   be edited) — sets `auto_apply=true` on this specific bonus row, and backfills the missing
   `corporate_action_applications` tracking row for Mehta's already-seeded holding (so the broadened sweep
   does not double-apply to Mehta).
3. Ran `cli ca:apply` — **verified in the database and live in the browser**: Mehta stayed at 42 shares
   (untouched, correctly not double-applied), Rajesh went 50 → 100, the older Iyer test account went 20 → 40.
   Rajesh's Investments page now correctly shows 100 shares, cost unchanged at ₹80,080 (bonus shares are free).

**Known, deliberately not fixed:** the seeded TCS dividend action (`...002`) has `auto_apply=false` too, but
for a *different*, correct reason — `cash_per_unit` is genuinely null (missing data), and `applyCorporateAction`
requires it for dividends. That one is correctly gated, not a bug — left as-is since fixing it would mean
inventing a real-world dividend amount with no basis to do so.

**All 8 Group A items are now built AND verified live** (not just compiled). Both caveats from earlier in this
file are resolved. Remaining open items are the two Group B items (Banking live Finvu credentials, Action
plane real broker certification) — still explicitly parked pending the head, per the 2026-10-07 decision above.

### Real bug found and fixed — users logged out automatically after 15 minutes (2026-10-07)
Reported directly by the user while testing. **Root cause:** `app/apps/web/src/lib/api.ts` already requested
a 30-day refresh token at login and the backend's `POST /auth/refresh` already worked correctly — but nothing
in the frontend ever called it. Every API call used the 15-minute access token directly; the instant it
expired, the very next request's 401 wiped the session and hard-redirected to `/login`, regardless of the
refresh token's real remaining 30-day life.

**Fix:** added `refreshSession()` + a shared `request()` helper in `lib/api.ts`. On any 401, it now silently
calls `/auth/refresh` once (concurrent 401s from multiple components dedupe onto the same in-flight refresh
via a shared promise, so simultaneous page requests don't fire 10 separate refreshes), stores the new token
pair, and transparently retries the original request. Only a *failed* refresh (refresh token itself
expired/revoked) now signs the user out.

**Verified live** (Playwright): corrupted only the access token in `localStorage` (kept the real refresh
token), then loaded `/goals`, which fires ~10 parallel API calls. Network log showed all 10 get 401 → exactly
**one** `/auth/refresh` call → 200 → all 10 requests auto-retried → 200 — the page rendered normally and the
user was never bounced to `/login`. A clean reload afterward showed 0 console errors, confirming the session
was genuinely healthy, not just limping along. (The first load still shows ~10 "401" entries in the browser's
console/network panel — that's just the browser logging the initial failed attempt before the retry succeeds;
not a real failure.) Also confirmed working the next day (2026-10-08) across a real overnight gap, unprompted.

### Real bug found and fixed — "Create tasks" always duplicated, never deduped (2026-10-08)
Found by testing the Goals & buckets → Rebalance proposal and Working capital → Deployment plan flows twice
each (exactly what a real user would do if they clicked "Propose"/"Build plan" again before acting on the
first result). Both produced duplicate tasks in the Tasks list every time.

**Root cause (two different bugs, same symptom):**
1. `lib/allocation.ts` (`rebalanceProposal`, `bucket_move` tasks) — the insert had **no de-duplication at all**,
   unlike every one of the 15 automatic task generators in `jobs/tasks.ts`, which all guard with
   `where not exists (... status='open')`. Clicking "Create tasks" twice in a row created two full sets of
   identical tasks.
2. `lib/workingcap.ts` (`buildPlan` / `planTasks`, `deployment_plan` tasks) — a different shape of the same
   problem: each "Build plan" click inserts a **new** `deployment_plans` row with its own fresh id, and tasks
   are keyed off that plan's id (`source_id`) — so per-id dedup can't work across separate plan builds the way
   it does for bucket_move. Two "Build plan" clicks followed by "Create tasks" produced two independent,
   fully-duplicated task sets with no relationship to each other in the data.

**Fix (3 parts, all applied and verified):**
1. `allocation.ts` — added the same `where not exists (status='open')` guard used everywhere else; if a
   matching open task already exists it's reused (its id returned) instead of creating a second one. A
   **done** task is correctly allowed to be re-raised if the underlying drift still exists (verified: doing
   this to an already-`done` bucket_move task created a fresh one, which is correct — nothing was actually
   rebalanced in the real world, so the condition genuinely persists).
2. `workingcap.ts` (`buildPlan`) — a fresh "Build plan" now deletes any other still-`proposed` (i.e. never
   tasked) plan for the same family/entity before inserting its own, so there is only ever one live,
   un-actioned proposal at a time. Plans already `tasked` or `executed` are left alone as history.
3. `workingcap.ts` (`planTasks`) — since a rebuilt plan's id is never the same as an earlier one, added a
   second guard here keyed on the task's own identity (`entity_id` + exact title) while `status='open'`,
   skipping the insert (and reusing nothing, since the existing open task already covers it) when a match
   exists.

**Verified live, end to end, by deliberately reproducing the exact bug sequence after the fix:** clicked
"Propose" → "Create tasks" on Goals & buckets a second time — the still-open HDFC Bank task was correctly
**not** duplicated. Clicked "Build plan" twice in a row on Working capital — confirmed via direct SQL that
only one `proposed` deployment_plans row ever exists at a time. Clicked "Create tasks" on a freshly rebuilt
plan — confirmed via SQL the task count stayed at exactly 2 (no new rows), not 4. Also cleaned up the 6 stray
duplicate task rows that had accumulated in the Menon demo data before the fix (verified via direct `psql`
queries — remember RLS requires `select set_config('app.family_id', '<id>', false)` before querying `tasks`
or any family-scoped table directly, same as the app's own `withFamily()` wrapper does).

**Separately confirmed, not a bug:** the 15-17 "Rent overdue" tasks for the Menon Apartment are all genuinely
distinct — one per unpaid month in the 24-month rent schedule, each with a different `source_id` (a different
`rent_schedule` row), so the existing per-generator dedup is working as designed. This is a real product gap
worth flagging separately (no task consolidates "this tenant owes N months total"), but it is not the same
class of bug as the two above — nothing to fix here without a deliberate product decision on how overdue rent
should be presented.

### Systematic sweep of every "manual" (button-triggered) task-creation path (2026-10-08)
Having mapped all 15 automatic generators (`jobs/tasks.ts`) plus the manual ones in an earlier session, went
through and actually clicked each manual path live rather than just reading the code:

- **"+ New task" (Tasks page)** — verified working, plain manual task created correctly.
- **Investment policy review** — verified working, but **found and fixed a real crash bug** first: creating
  *any* policy from a model portfolio (the normal "Start from: model portfolio" path in the New-policy form)
  threw a 500 every time — `invalid input syntax for type uuid: "moderate"`. Root cause in `lib/policy.ts`
  (`startingClauses`): `where id=$1 or code=$1::text` — Postgres infers `$1`'s type from its *first* usage
  (`id`, a uuid column), so the whole parameter gets bound as uuid and a short code like `"moderate"` fails
  before the `code=$1::text` side ever gets evaluated. Fixed by casting the other side instead:
  `where id::text=$1 or code=$1`. Verified with the exact failing request → 201 after the fix. Went on to
  create, sign and activate a real family-scope "moderate" policy for the Menon account (previously had none),
  then ran "Ad-hoc review" from the Reviews tab — correctly raised a `policy_review` task **and**, as a bonus,
  a second automatic `policy_breach` task, since the moderate model's 60/30/10 equity/debt/gold targets are
  wildly different from this family's actual holdings (3.25%/0%/0% — their money is mostly real estate and the
  startup stake). Both are genuinely useful, correct findings from activating a real policy.
- **Investments → CAS refresh** — the backend endpoint (`POST /imports/cas/refresh`) existed and worked, but
  **had no UI anywhere** — not referenced in any `.tsx` file. Built one: new `CasRefresh` component in
  `Imports.tsx` (entity picker + "Refresh" button, reusing the existing `/entities` list and `api()` helper),
  wired into the Investments → Imports tab (`Investments.tsx`) right under the file-upload panel. Verified
  live end to end: picked "Rajesh Menon," clicked Refresh, got the "Requested — a task will track it..."
  confirmation, and confirmed the resulting task ("CAS refresh for Rajesh Menon — statement pending," module
  `imports`, source `cas_refresh`, due 11 Oct 2026) landed correctly on the Tasks page.
- **Still not yet tested live:** Planning & tax → "Approve → tasks" (needs a scenario with actions, in-review
  status), Rebalancing → "Create from the policy's rebalancing clause" (now unblocked since a real policy
  exists), Action plane → mandate-missing task on an `mf_purchase` propose, Documents → Extract/Review queue
  (needs an actual uploaded file, can't be faked meaningfully).

**Update 2026-10-08, later the same day:** all four of those were also tested live (see further down) — nothing
from the original audit is untested anymore.

### Local dev now has real e-mail sending (Mailtrap sandbox) — set up for the first time
Previously every e-mail (invites, reminders) only ever hit the `log` transport — never actually sent. Set up
properly for local testing:
- `app/apps/api/.env` now exists (it didn't before) with real Mailtrap SMTP sandbox credentials, and
  `PORT`/`DATABASE_URL`/`MIGRATION_DATABASE_URL` so those no longer need retyping into the shell each time.
- **Fixed:** the API was never actually loading any `.env` file — `package.json`'s `dev` script now runs
  `tsx watch --env-file=.env src/server.ts` (Node 24's native env-file support, no new dependency).
- Mailtrap is in **Sandbox** mode, which — by design — never delivers anywhere real, regardless of the
  recipient address typed in; every test send lands only in the Mailtrap web inbox. For a real inbox, switch to
  Gmail SMTP (blocked earlier by 2-Step Verification not being set up) or Mailtrap's "Email API/SMTP" (paid/
  production) product instead of Sandbox.
- Postgres superuser password: unchanged, still ask Jey directly (not written here, as before).

### Real bug found and fixed — invite e-mail links had no domain (2026-10-08)
First real e-mail ever sent from this app (via the new Mailtrap setup, above) immediately surfaced this: the
invite link inside the e-mail read literally `/invite?email=...&token=...` — no `http://localhost:5173` in
front of it. Root cause: `routes/family.ts`'s `/auth/invite` builds the link with
`` `${process.env.PUBLIC_WEB_URL ?? ""}/invite?...` `` — nobody had ever set `PUBLIC_WEB_URL` locally, because
nobody had ever sent a real e-mail locally before. **Fix:** added `PUBLIC_WEB_URL=http://localhost:5173` to the
new `.env`. Verified by re-sending the same invite and confirming the link in the fresh Mailtrap message now
has the full domain. **Flagged for the deployment checklist:** this same gap could bite a real production
launch too — if `PUBLIC_WEB_URL` isn't set on the live server, every invite e-mail goes out with an identical
broken, domain-less link, silently, with no error anywhere.

### Real bug found and fixed — accepting an invite was completely impossible (2026-10-08)
Even after the link above was fixed to point somewhere real, clicking it led nowhere useful: there was **no
`/invite` route in the frontend at all** (`main.tsx`'s route list had `/login` and the authenticated app
shell, nothing else) — React Router's catch-all silently redirected `/invite?...` to `/`, which (no session
yet) bounced to `/login`, where typing anything correctly failed with "Invalid credentials" since no password
had ever been set for that user. The backend half (`POST /auth/invite/accept`, taking `{email, token,
password}`) was complete and correct — there was simply no page in the entire product that could ever call it.
**This meant no one has ever been able to accept a real invite through the UI, at any point in this project's
history.**

**Fix:** built the missing page — new `pages/InviteAccept.tsx` (reads `email`/`token` from the URL, a
password + confirm form, calls the accept endpoint, then logs in automatically since accept itself returns no
session) and a new `acceptInvite()` helper in `lib/api.ts`; wired `<Route path="/invite" element={<InviteAccept />} />`
into `main.tsx`.

**Verified live, the full real chain, start to finish:** real Mailtrap-delivered e-mail → clicked the actual
link from inside the e-mail (not an in-app shortcut) → the new page rendered correctly → set a password →
auto-logged-in as the correct user with the correct role (**viewer**) → confirmed via Settings, logged back in
as the owner, that the membership flipped from "invited — not accepted yet" to "member since 08 Oct 2026."

### Real gap found and fixed — CAS-refresh task never auto-closed (2026-10-08)
While verifying the new CasRefresh button (above), noticed the task's own description promises *"The task
verifies when the CAS imports"* — but no code anywhere actually implemented that. Compare to the Real estate
rent tasks, which genuinely do auto-close the moment rent is marked received (`routes/realestate.ts`); CAS
refresh had no equivalent, so the task would sit open forever even after a successful CAS import.

**Fix:** `routes/imports.ts` (`runImport`, the `kind === "cas"` branch) now tracks which entities a CAS
statement actually touched, and after applying it, closes any open `cas_refresh` task for those entities
(`status='done', verification='verified'`) — mirroring the exact pattern `reconcileRent()` already uses for
rent tasks.

**Verified live, full loop, not just code review:** clicked the new Refresh button for Rajesh Menon → task
appeared. Built a small sample CAS text file (ICICI Prudential Liquid Fund purchase) and imported it via the
same "Import a statement" box, attributed to Rajesh Menon → import succeeded ("done · 1 of 1 rows applied")
→ reloaded Tasks → open count dropped by exactly 1, the CAS-refresh task was gone from "open" and confirmed
sitting in "done" with status **verified**, not just dismissed.

### Remaining manual-trigger items — all now tested live (2026-10-08)
Finished the sweep of every item 3-9 from the earlier audit. All code-level, all verified by actually clicking
through and confirming the resulting task/record, not just reading the source:

- **Planning & tax → "Approve → tasks"** — created a real scenario ("Harvest LTCG"), added a sell-holding
  action (10 units HDFC Bank, Rajesh Menon), sent for review, approved → confirmed a `planning` task ("Sell 10
  units (Rajesh Menon)", source `plan_action`) landed on Tasks.
- **Action plane → mandate-missing task** — proposed a real `mf_purchase` intent (₹7,000 Parag Parikh Flexi
  Cap, Menon HUF) → succeeded, correctly checked against the real Family Investment Policy we'd just
  activated ("investment policy: within Family Investment Policy" shown in the approval detail). **No
  mandate-missing task fired, and that's correct, not a bug**: the connector routed as `"assisted"` (manual/
  sandbox), and the NACH-mandate check in `lib/actions.ts` only runs on the `"executable"` connector path —
  this demo has no connector configured capable of that, so the condition is simply never reached here.
- **Rebalancing → "Create from the policy's rebalancing clause"** — created a family-scope program; it
  correctly pulled real constraints straight from the policy's Builder step 7/8 defaults (quarterly calendar
  trigger, band breach, drift >10pp, min ₹2,000, turnover ≤15%/run, avoid exit loads, LTCG wait ≤45d, etc. —
  none of this was manually typed, all inherited from the policy). Clicked "Run" → got a fully-reasoned
  Plan v1 ("Buy ₹4,21,960 of HDFC Bank, funded from idle cash," tax ₹422, solver trace, before/after allocation
  table honestly showing the band breach isn't fully cleared in one run — correct, since turnover is capped).

### Real bug found and fixed — every document upload crashed on this Windows dev setup (2026-10-08)
Testing item 7 (Documents → Extract/Review queue) surfaced the most impactful bug of the session: **uploading
any document, of any kind, has likely never worked on this local Windows environment.**

**Root cause:** `lib/storage.ts`'s `fsStorage()` computes its default storage directory with
`new URL("../../../../.data/documents", import.meta.url).pathname`. On Windows, a `file://` URL's `.pathname`
keeps the leading `/` before the drive letter (e.g. `/C:/Users/...`). `path.resolve()` then reads that leading
`/` as "root of the current drive" and prepends the real drive letter again, producing a literal, broken path:
`C:\C:\Users\AltiusNXT\Downloads\familyoffice-main\familyoffice-main\app\.data\documents\...`. Every upload
failed with `ENOENT: no such file or directory, mkdir 'C:\C:\Users\...'`.

**Fix:** use Node's `fileURLToPath()` (from `node:url`) instead of `.pathname` — it correctly strips the
leading slash before a drive letter on every platform. One import, one line changed.

**Verified live, full loop:** confirmed the exact 500 and its message first (via a direct `fetch` reproducing
the browser's own failed request), applied the fix, confirmed the API restarted clean, then replayed the exact
same upload → **201 Created**, text extracted (`"has_text": true, "text_chars": 246`). Continued the original
Documents test from there: uploaded a sample insurance-renewal notice as Rajesh Menon, clicked **Extract** →
correctly classified as `insurance`, structured fields pulled out, tagged **"needs review"** (confidence 75%,
`heuristic-v1`) because the extractor had actually mapped the wrong number (pulled the ₹1,00,00,000 sum
assured into the `premium` field instead of the real ₹18,500 premium) — correctly caught by the human-review
gate rather than silently trusted. Rejected it with a note, confirmed the status updated to **rejected** with
the note attached, then deleted the test document to keep the demo data clean.

**This fix matters far beyond this one test** — it unblocks the entire Documents module (library uploads,
extraction, review queue) for local development on Windows, which was silently broken before today.

**All items from the original "incomplete" audit are now resolved, one way or another:**
| # | Item | Outcome |
|---|---|---|
| 1-2 | Goals & buckets / Working capital task creation | Tested — found & fixed 2 duplicate-task bugs |
| 3 | "+ New task" button | Tested — works |
| 4 | Investments → CAS refresh | No UI existed — **built it**, tested, then found & fixed the auto-close gap |
| 5 | Investment policy review | Tested — found & fixed a policy-creation crash (uuid/code bug) |
| 6 | Planning & tax → Approve → tasks | Tested — works |
| 7 | Documents → Extract/Review queue | Tested — found & fixed a Windows path bug blocking **all** uploads |
| 8 | Rebalancing → Create from policy clause | Tested — works, pulls real constraints from the policy |
| 9 | Action plane → mandate-missing task | Tested — doesn't fire here, correctly, no connector supports it |

Nothing is still "untested" from that list. Total real bugs found and fixed this session: 7 — session timeout,
corporate actions (from the prior day), 2× duplicate tasks, policy-creation crash, missing CAS-refresh UI,
CAS-refresh auto-close gap, and the Windows document-upload path bug.
- **Note:** restarting the web/API dev servers will NOT kill the worker (separate process) — but if the
  laptop restarts, the worker needs restarting too: `cd app && $env:DATABASE_URL='postgres://app_user:app@localhost:5432/familyoffice'; pnpm --filter @fo/api worker`.
- **After Group A:** create a demo customer via sign-up, add realistic data, walk the full
  Onboard → Ingest → Reconcile → Analyse → Plan → Act → Report loop end to end with Playwright.

---

## How to continue this in a new chat

Tell Claude Code to read this file (`PROJECT-MEMORY.md`, at the root of this `familyoffice-main` folder) and
it will have the full picture of what's been done and what's next. Update the **"In progress / next up"**
section as work continues, so the file stays a true handover snapshot rather than going stale.
