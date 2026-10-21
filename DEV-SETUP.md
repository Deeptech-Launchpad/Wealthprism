# Developer setup — Family Office

Everything a developer needs is in this repository. Two ways to run it. Taking the project over? Read
`HANDOVER.md` first. Running it on a VPS of your own rather than a laptop? `DEV-VPS-SETUP.md`.

## Option A — infrastructure in Docker, code with hot reload (recommended for development)

Prerequisites: Docker Desktop, Node 22, pnpm 12 (`corepack enable && corepack prepare pnpm@12.4.1 --activate`).

```bash
git clone https://github.com/vellayan-code/familyoffice.git && cd familyoffice

# 1. Database (auto-applies db/001–030 and loads the demo family), Redis, MinIO
cd deploy && docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.dev up -d postgres redis minio && cd ..

# 2. Install and build. The `...` suffix builds the api AND every workspace package it imports, in
#    dependency order — never hand-list them: a fresh checkout has no dist/ for the others to resolve through.
cd app && pnpm install && pnpm --filter @fo/api... build

# 3. Run the API, worker, executor and web (separate terminals)
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm dev:api                     # http://localhost:4000
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm --filter @fo/api worker
DATABASE_URL=postgres://executor_user:exec@localhost:5432/familyoffice SANDBOX_ONLY=true pnpm --filter @fo/executor dev   # executor_user's password comes from EXECUTOR_DB_PASSWORD (set by the seed / migrate.ts); the API tests drive the executor in-process through EXECUTOR_DATABASE_URL
pnpm dev:web                                                                                      # http://localhost:5173 (proxies /api → :4000)

# 4. Mobile
cd apps/mobile && pnpm start     # Expo; set extra.apiUrl in app.json to http://<your-lan-ip>:4000/api/v1
```

Sign in as `arjun@example.com` / `Prototype!2026` (also priya, ops, ca). Dev step-up code for approvals: `000000`.

Documents go to MinIO when `S3_ENDPOINT` / `S3_ACCESS_KEY` are set (compose does); otherwise to `STORAGE_DIR` (default `app/.data/documents`, git-ignored). Report PDFs, Excel and Parquet are produced by `packages/reports` with no native dependencies.

Tests — the same list CI runs:

```bash
pnpm --filter @fo/finance build && pnpm --filter @fo/finance test
pnpm --filter @fo/parsers build && pnpm --filter @fo/parsers test
pnpm --filter @fo/reports test
pnpm --filter @fo/api... build
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm --filter @fo/api test
pnpm --filter @fo/web build && pnpm --filter @fo/mobile typecheck
```

The API suite drives the executor in-process, so `executor_user` needs its password set — the seed does that only
when `EXECUTOR_DB_PASSWORD` is in the environment. The dev compose stack sets it; if you seed by hand, pass
`APP_DB_PASSWORD=app EXECUTOR_DB_PASSWORD=exec`, or the connectors tests fail to authenticate (`28P01`). Role
passwords are cluster-wide, so dropping the database does not clear them.

Reset the database to the seed: `cd deploy && docker compose down -v postgres && docker compose … up -d postgres`.

## Option B — the whole stack in Docker exactly as production

```bash
cd deploy && cp .env.dev .env && docker compose build && docker compose up -d
```
Then open http://localhost (Caddy on port 80 in this mode; on the VPS it is bound to 127.0.0.1:8080 behind nginx). No hot reload; rebuild with `docker compose build <service>` after changes.

## What is where

| Path | Purpose |
|---|---|
| `db/*.sql` | Schema and seed migrations 001–030, applied in order and tracked in `schema_migrations`; the dev stack applies them on first Postgres start |
| `api/openapi.yaml` | The API contract, 364 paths — every one implemented; unknown paths are plain 404s |
| `app/apps/{api,web,mobile,executor}`, `app/packages/{finance,parsers,connectors,reports}` | The code |
| `deploy/` | Compose files, Dockerfiles (under `app/deploy`), Caddy, nginx edge config, VPS bootstrap |
| `family-office-PRD.md`, `tickets/`, `BUILD-STATUS.md` | Spec, backlog, what is done |
| `HANDOVER.md`, `DEV-VPS-SETUP.md`, `CLAUDE.md` | Taking it over, your own VPS, house style |

## Production (for reference)

Hostinger VPS, everything in Docker via `deploy/docker-compose.yml`; nginx on the host terminates TLS for wealthprism.in (`deploy/nginx/wealthprism.conf`) and proxies to Caddy on 127.0.0.1:8080. Deploy after merging to main, from `~/handover`:

```bash
git checkout main && git pull
cd deploy
docker compose build api executor web
docker compose --profile ops run --rm migrate      # --profile goes BEFORE run; migrate before the new code starts
docker compose up -d api worker executor web
```

`deploy/scripts/deploy.sh` assumes images come from a registry (`docker compose pull`); this server builds them
locally as `:local`, so use the sequence above. Full runbook in `HANDOVER.md` §7.

## Seeing what is built

Start the stack (Option A above), sign in as `arjun@example.com` / `Prototype!2026` and open **Product map** (bottom of the left rail): it lists every module with what is built, what remains, and a link to the screen; **Settings** holds the family, members, two-factor login and integration health. The same list with verification per area is in `BUILD-STATUS.md`; `PROGRESS.md` is the milestone log. Every screen reads the running API (`api/openapi.yaml`, 364 paths), so what you see is the real build, not a mock.

## Milestone 12 extras

- **Account Aggregator sandbox**: with `AA_PROVIDER=mock` (the default outside production) `POST /aa/consent/initiate` creates a pending consent; approve it with `POST /aa/consents/:id/simulate` (or the "Approve (sandbox)" button on Banking → Accounts) and `POST /bank-accounts/:id/sync` pulls deterministic FI data. For Finvu UAT set `AA_PROVIDER=finvu`, `AA_CLIENT_ID` / `AA_CLIENT_SECRET`, `AA_FIU_ID`, `AA_CONSENT_TEMPLATE`, and point the AA's webhook at `POST /api/v1/aa/consent/callback` with `AA_WEBHOOK_SECRET` (HMAC in `X-AA-Signature`) or `AA_PROVIDER_PUBLIC_KEY` (detached JWS).
- **Delivery**: `EMAIL_TRANSPORT=log|ses|smtp`, `WHATSAPP_PROVIDER=log|meta|gupshup`, `SMS_PROVIDER=log|msg91|twilio`; every send lands in `message_log`. `pnpm --filter @fo/api cli reminders:deliver` drains the rent-reminder queue by hand.
- **E-mail ingest**: the mail gateway POSTs parsed messages (our JSON or Postmark inbound) to `POST /api/v1/ingest/email` signed with `INGEST_WEBHOOK_SECRET` in `X-Ingest-Signature`. `GET /ingest/settings` shows the family's ingest address and allow-list; unknown senders are quarantined (Banking → Inbox to release). Passwords for e-mailed PDFs go in `INGEST_PDF_PASSWORDS`.
- **Statements**: paste or upload PMS / AIF statement text and NSDL / CDSL e-CAS text through Imports — `samples/pms_statement_extracted_text_sample.txt`, `aif_statement_extracted_text_sample.txt`, `ecas_nsdl_extracted_text_sample.txt`.
- **Feeds**: `cli feeds:run --which eod,indices,tri,series`, `cli feeds:health`, `cli benchmarks:load --code CRISIL_CBI --file cbi.csv`; `GET /feeds/health` on the API. `FEED_RETRIES`, `FEED_TIMEOUT_MS`, `BSE_FALLBACK`, `NIFTY_TRI_ENABLED`, `BENCHMARK_SERIES_URLS` tune the runner.

## Milestone 13 extras

- **Nothing answers 501 any more**: every path in `api/openapi.yaml` (364) has a handler; `test/global.test.ts` checks the router against the contract without calling the endpoints, and unknown paths are plain 404s.
- **Goals & buckets**: `PUT /bucket-targets` (must total 100; a hand-set target of the same day beats a policy-applied one), `PUT /glide-paths` (steps may only de-risk), `POST /buckets/rebalance-proposal` (`create_tasks: true` raises the moves as tasks), `PUT /asset-class-targets`, `PUT /allocation/policy` (apply a model portfolio, cadence, trigger), `GET /allocation/status?look_through=false` for the headline view. The Goals page has all of it.
- **Working capital**: `PUT /working-capital/settings` (float days, buffer, idle threshold, preferred instrument and assumed yield per horizon), `POST /working-capital/plan` → `POST /working-capital/plan/:id/tasks`, `GET /working-capital/ladder`, `GET /working-capital/plans`.
- **Global**: `PUT /fx-rates` (owner) or `FX_RATES_URL` on the daily feed (`cli feeds:run --which fx`); `GET /global/lrs?fy=2026-27` totals each individual's remittances against `LRS_LIMIT_USD` with TCS above `LRS_TCS_THRESHOLD_INR` at `LRS_TCS_RATE_PCT` (all in `tax_params`); `POST /global/lrs` warns when a remittance takes the entity over the limit; foreign tax credits with Form 67 status under `/global/foreign-tax-credits`. Investments → Global on the web.
- **MFA**: `POST /auth/mfa/setup` → scan the `otpauth_uri` → `POST /auth/mfa/confirm {code}`; login then returns `{ mfa_required, mfa_token }` and `POST /auth/mfa/verify` completes it (`000000` works outside production). `DELETE /auth/mfa {code}` switches it off.
- **Families and members**: `POST /families` makes the caller the owner of a new family (with working-capital and bucket defaults); `POST /auth/invite` (owner) e-mails a 14-day link, `POST /auth/invite/accept {email, token, password}` sets the password; the token is returned in the response outside production. `PATCH/DELETE /members/:userId`. Entities: `POST /entities` stores the PAN encrypted with `FIELD_ENCRYPTION_KEY` (only the last four are readable), `POST /entities/:id/gstins` checks the GSTIN carries the entity's PAN.
- **Investments residue**: `POST /investment-txns` (hand-entered buy / sell through the lot engine, de-duplicated), `GET /harvest-candidates?fy=`, `GET /capital-gains/export?fy=&format=csv|xlsx|pdf`, `POST /imports/cas/refresh {entity_id}` (queued import + task; calls `MFCENTRAL_URL` when set), `GET /integrations/health`. Investments → Harvest on the web.
- **Start-ups**: `POST /private-companies`, `POST /private-companies/:id/rounds` (re-marks every stake at the round price and dilutes the %), `POST /private-investments`, `/marks`, `PUT /commitments` (calls must fit the unfunded amount), `POST /exit-scenario` (tax from `tax_rules`, effect on the growth bucket; records nothing). The Startups page has rounds, marks, commitments and the scenario.

## Milestone 14 extras

- **Period-end in the books**: turn on `mark_to_market` / `depreciation` per book (Books → Tally live sync card saves the endpoint; the flags are on `PUT /gl/books`). `GET /gl/period-end/preview?entity_id=&as_of=` shows the MTM per investment account (market vs book, latest price on or before the date) and the depreciation schedule from `depreciation_rates` (Income-tax Act blocks, WDV; art / jewellery / collectibles 0%). A soft close or lock posts both once per period (`source_type` `mtm` / `depreciation`); `POST /gl/period-end/post` does the same by hand; `cli gl:period-end --period <id>`.
- **Tally live**: enable Tally's HTTP gateway (port 9000) with the company open, save the URL on the book, then Books → Posting rules → *Tally — live sync*: Ping, Push (masters + vouchers for a range), Pull (day book, GUID de-duplicated). `cli gl:tally-push --entity <id> --from 2026-04-01 --to 2026-09-30`. Without a gateway the XML export / import still works.
- **Scheduled exports**: Reports → Open data → *Scheduled exports*: dataset, format, optional entity, 5-field cron (UTC). Each run is an ordinary export job (Documents › Exports, 7-day link) and fires `export.ready` for subscribed webhooks; the worker runs due schedules hourly; `cli exports:schedules --force` runs them all now.
- **MCP server**: create an API key (Reports → Open data → API keys) with the scopes you want to expose, then add to Claude Desktop / Cursor:
  `{ "mcpServers": { "wealthprism": { "command": "pnpm", "args": ["--filter", "@fo/api", "mcp"], "cwd": "<repo>/app", "env": { "FO_API_URL": "http://localhost:4000/api/v1", "FO_API_KEY": "fo_…" } } } }`.
  Tools are filtered by the key's scopes (read: dashboard, holdings, capital gains, harvest candidates, performance, net worth, liabilities, insurance, exposure, allocation, goals, buckets, cash flow, working capital, outflows, tax, properties, private investments, tasks, trial balance, datasets; write: `create_task`, `run_export`, `propose_intent`). Nothing in MCP approves or executes — intents it drafts wait for a human with step-up auth.

## Milestone 15 extras

- **Scanned documents**: install tesseract (`apt install tesseract-ocr`) and set `OCR_COMMAND="tesseract {in} stdout -l eng"` (or `ocrmypdf --sidecar - {in} /dev/null`). PDFs without a text layer and images are OCR'd at upload (tag `ocr`); without a command they are tagged `needs-ocr`, extraction answers 422 `needs_ocr`, and the next `POST /documents/:id/extract` after the command is configured reads them.
- **Grandfathering (Section 112A)**: load the 31 Jan 2018 FMVs per ISIN with `POST /instruments/fmv` (`{rows:[{isin, fmv}]}` or a CSV body) or `cli fmv:load --file samples/fmv_31jan2018_sample.csv` (sample figures — replace with the exchange highs / AMFI NAVs of that day). The FMV sits on the instrument and on every pre-Feb-2018 lot; a later sale of such an equity lot steps the cost up to the lower of FMV × units and the sale price, `realized_gains.grandfathered` is set and Schedule CG shows the stepped cost.
- **ITR schedules**: report codes `itr_schedule_hp` (house property per property and share, 30% from `tax_params`, 24(b) interest), `itr_schedule_os` (interest / dividends from the books and recorded income sources, TDS by 26AS section), `itr_schedule_al` (assets at cost and liabilities as at 31 March), `itr_schedule_fa` (foreign holdings with look-through share, LRS remittances, foreign income and Form 67) — alongside `capital_gains` (Schedule CG). Run them from Reports with the FY and entity, or put the five in a pack for the CA.
