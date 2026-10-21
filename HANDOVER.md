# Handover to the development team

WealthPrism / Family Office — wealth-management platform for Indian HNI families.
Prepared 15 September 2026. Canonical copy: this file on `main`.

This document is the starting point for a team taking the project over. It says what exists, how to run
it, what must not be broken, how production is actually deployed, and which traps have already cost
time. It does not repeat the specification (`family-office-PRD.md`) or the implementation status
(`BUILD-STATUS.md`) — it points at them.

---

## 1. Current state, honestly

Milestones 1–15 are complete: 21 modules, 364 OpenAPI paths all routed (nothing answers 501),
30 migrations, 27 API integration test files (210 tests), 24 web pages, 17 mobile screens, four
calculation packages with their own unit tests.

The platform is live at **https://wealthprism.in**, running the same commit CI validates.

What is *not* done is provider certification: every external adapter (Zerodha Kite, BSE StAR MF,
ICICI Corporate, Setu BBPS, the Account Aggregator, WhatsApp, SES/SMTP, Tally) is implemented and
verified against a sandbox or an in-test fake, but none has been run against a live counterparty with
real credentials. That is the bulk of the remaining work and it needs commercial onboarding, not code.
`BUILD-STATUS.md` → *Remaining (ticket map)* lists each one with its starting point in the code.

Treat the sandbox adapters as proven and the live ones as unproven.

---

## 2. Where everything is

| | |
|---|---|
| Repository | `github.com/vellayan-code/familyoffice`, default branch `main` |
| CI | GitHub Actions `.github/workflows/ci.yml` — a `test` job (full suite against a real Postgres) and an `images` job (builds all three Dockerfiles) |
| Production | VPS `srv1876912`, checkout at `/home/vellayan/handover`, Compose project in `deploy/` |
| Production secrets | `deploy/.env` on the server only — never in git |
| Specification | `family-office-PRD.md` (v2.0) — modules 3.x, schema 5.x, API 6, calculations 4 |
| Tickets | `tickets/phases_0-2_tickets.md` and `.csv` — 130 tickets with acceptance criteria; the CSV imports into Jira/Linear |
| Reference UI | `family-office-prototype.html` — open in a browser; every screen, Web/Mobile toggle |
| Conventions | `CLAUDE.md` — read this before writing code; it is the house style and the ticket workflow |
| Your own VPS | `DEV-VPS-SETUP.md` — standing up a development or staging box of your own, and what must not be copied from production |
| Build status | `BUILD-STATUS.md` — implemented vs remaining, per module, with ticket numbers |
| History | `PROGRESS.md` — what each milestone delivered and its known limits |

---

## 3. Running it locally

Prerequisites: Docker, Node 22, pnpm 12.4.1 (`corepack enable && corepack prepare pnpm@12.4.1 --activate`).

```bash
git clone https://github.com/vellayan-code/familyoffice.git && cd familyoffice

# infrastructure: Postgres (seeded with the demo family), Redis, MinIO
cd deploy && docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.dev up -d postgres redis minio && cd ..

cd app
pnpm install
pnpm --filter @fo/api... build          # the api AND every workspace package it imports

DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm dev:api    # :4000
pnpm dev:web                                                                     # :5173, proxies /api
```

Demo login `arjun@example.com` / `Prototype!2026` (owner). Also `priya` (member), `ops` (operator),
`ca` (viewer), same password. Dev step-up code for approvals: `000000`.

Full check, the same one CI runs:

```bash
cd app
pnpm --filter @fo/finance build && pnpm --filter @fo/finance test
pnpm --filter @fo/parsers build && pnpm --filter @fo/parsers test
pnpm --filter @fo/api... build
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm --filter @fo/api test
pnpm --filter @fo/web build && pnpm --filter @fo/mobile typecheck
```

**Use `pnpm --filter <target>... build`, never a hand-written list of packages.** The `...` suffix means
"and its dependencies" and resolves the graph topologically. Every place that hand-listed packages
has broken: two Dockerfiles and the CI workflow, each shipping a product that could not start.

`DEV-SETUP.md` is more detailed but predates the current package set — where the two disagree, this
file is right. To run the platform on a VPS of your own rather than a laptop, follow
`DEV-VPS-SETUP.md`: the bootstrap is one command, but a development box must be seeded rather than
restored from a production backup, must generate its own secrets, and must not use the dev Compose
overlay unfirewalled — that overlay publishes Postgres to the internet.

---

## 4. Architecture in one page

```
app/apps/api        Fastify + TypeScript. Routes in src/routes (26 files), registered in server.ts.
                    Also hosts the worker (src/worker.ts), CLI (src/cli.ts) and migrator (src/migrate.ts).
app/apps/executor   The only service that executes anything externally. Separate DB role, own credentials.
app/apps/web        React 19 + Vite. src/pages, src/lib/api.ts, src/components.tsx.
app/apps/mobile     Expo / React Native. src/screens.
app/packages/finance      pure calculations: xirr, lots, capitalGains, buckets, workingCapital, tax, rebalance
app/packages/parsers      CAS, contract notes, bank CSV, AA JSON, 26AS, PMS/AIF, e-CAS
app/packages/connectors   provider request builders, sandbox + live adapters, field encryption
app/packages/reports      PDF / XLSX / CSV / HTML / Parquet writers
db/                 migrations 001–030, applied in order, tracked in schema_migrations
api/openapi.yaml    the contract, 364 paths — source of truth for request/response shapes
```

Request path: **web/mobile → API route → `withFamily()` transaction → calculation package → response**.
Routes orchestrate; they do not calculate. Calculations are pure functions with their own unit tests.

Three database roles: the migrator (owner), `app_user` (the API — RLS applies to everything it does),
and `executor_user` (the executor — narrower grants, and the only role that can read credential
ciphertext).

---

## 5. Four invariants. Do not break these.

1. **Separation of powers** (PRD 3.18). Anything that *proposes* — AI, rules, research, MCP — cannot
   approve. An approval requires step-up auth and a **different user** from the proposer. Only the
   executor executes. Database triggers in `db/008` enforce this; they are not advisory and must not be
   worked around. If a feature seems to need bypassing them, the design is wrong.
2. **RLS is the last line of defence.** The API connects as `app_user`, never as the owner. Every
   tenant query runs inside `withFamily(req.family!.familyId, async (c) => …)`. No query outside it.
   Note that a *materialised view does not enforce RLS* — `db/030` exists because a blanket grant on
   one was a latent cross-tenant read.
3. **Tax rules are data.** Rates, slabs, exemptions, surcharges, holding periods and indexation live in
   `tax_rules`, `tax_slabs`, `tax_surcharge`, `tax_deduction_limits`, `tax_params`,
   `cost_inflation_index`. No numeric tax constant belongs in code — a Finance Act change must be a
   data change.
4. **Posted journals are immutable.** Corrections are reversals (`db/007`). Never edit a posted row.

Also: money is `numeric(18,2)` in SQL and decimal strings in JSON (`money()` server-side, `inr()` for
display); dates are ISO strings; never edit an applied migration — add `db/031` onward.

---

## 6. The ticket workflow

`CLAUDE.md` has the full pattern. In short: read the ticket and the PRD section it cites → confirm or
add the path in `api/openapi.yaml` → calculations into `packages/finance` with vitest tests → route in
`apps/api/src/routes` inside `withFamily()` with `requireRole()` on writes → integration test in
`apps/api/test` → web page following `Dashboard.tsx` → mobile screen following `Tasks.tsx` → run the
full check list → commit with the ticket key first (`FO-27: CAS importer for CAMS/KFintech`) → PR to
`main`, never a direct push.

Tests must be self-cleaning: snapshot the ids that exist in `beforeAll`, delete only what the test
created, in both `beforeAll` and `afterAll`. The suite runs against a database seeded once and must be
re-runnable without a reseed.

---

## 7. Production runbook

Everything below is run from `/home/vellayan/handover/deploy`. **Always `cd` there first** — Compose
resolves `.env` relative to the working directory, and running from `~` silently substitutes blank
values into image tags and passwords.

**Deploy a new version.** Note that `deploy/scripts/deploy.sh` is written for a registry workflow
(`docker compose pull`), but this server builds images locally and tags them `:local`. The actual
procedure is:

```bash
cd /home/vellayan/handover
git checkout main && git pull
cd deploy
docker compose build api executor web
docker compose --profile ops run --rm migrate     # --profile BEFORE run; Compose rejects it after
docker compose up -d api worker executor web
docker compose ps
```

Migrate before starting the new containers, not after: the new code may depend on the new schema.
The migrator is idempotent — it skips what `schema_migrations` already records.

**Back up.** The script runs *inside* the backup container (the host has no `pg_dump`):

```bash
docker compose exec backup /backup.sh
```

Nightly automatically; `pg_dump` plus the MinIO document store, offsite via rclone if `RCLONE_REMOTE`
is set, retention `BACKUP_RETAIN_DAYS` (default 35).

**Restore.** `./scripts/restore.sh /backups/<stamp>` — stops api and worker, `pg_restore --clean`,
untars documents into MinIO, restarts.

**Rotate the secrets** in `deploy/.env` — at handover, when someone with access leaves, or on a
suspected leak. `VPS-DEPLOYMENT.md` §8 has the procedure per secret. The one that is not a simple
find-and-replace is `FIELD_ENCRYPTION_KEY`: it encrypts PANs, connector credentials, webhook secrets and
Account Aggregator key material, so it must be re-encrypted with
`pnpm --filter @fo/api rotate-field-key` (`node dist/rotatekey.js` in the image) *before* the new value
goes in the file. Replacing it directly destroys all four, irreversibly.

**Health after a deploy:**

```bash
docker compose ps api                                     # expect (healthy)
docker compose logs --since 5m worker | grep -iE "error|gl_balances"
docker compose exec api printenv PUBLIC_WEB_URL
```

The worker ticks every 60s, so five minutes of clean log is five clean ticks.

---

## 8. Traps already hit — read this before your first deploy

Each of these cost real time. They are written into `VPS-DEPLOYMENT.md` (§6, every error met during the first deployment)
and `PROGRESS.md` → *Hardening*, but these are the ones most likely to bite again.

- **A green local test run proves less than you think.** The suite passed locally for weeks while a
  clean checkout could not even load it, because `dist/` lingered from earlier builds. That blind spot
  is exactly what let two broken Dockerfiles reach production. Trust CI over your laptop; when a build
  problem is suspected, reproduce it in a copy with no `node_modules` and no `dist`.
- **Hand-listed package builds.** Covered in §3. Always `--filter <target>...`.
- **`schema_migrations` can be empty on a database that is fully migrated,** if the schema was built by
  `pg-init.sh` (plain psql) rather than by the migrator. Running `migrate` then re-applies `001` and
  fails on `type "member_role" already exists`. The fix is to baseline: insert the filenames that are
  already applied, then migrate normally.
- **`docker compose --profile ops run` — the flag must precede `run`.**
- **Compose from the wrong directory** produces `ghcr.io//familyoffice-api:latest` and blank passwords.
- **Postgres role passwords are cluster-wide, not per-database.** Dropping and recreating the database
  does not reset them, which can hide a missing-password bug locally that fails in CI.
- **Never paste a token on a command line,** even in a comment. Type it at the interactive `Password:`
  prompt. One was leaked this way and had to be revoked.

---

## 9. Handover checklist

Access to transfer:

- [ ] GitHub repository ownership or admin for the incoming team
- [ ] VPS SSH access, and ownership of `/home/vellayan/handover` (`chown -R` to the new user — running
      git as root there once already broke the checkout)
- [ ] `deploy/.env` — walk through it together; it holds every production secret. **Rotate all of it**
      before granting repository access: the file was tracked in git until 15 September 2026, so every
      value is in this repository's history and anyone given access can read it. Follow
      `VPS-DEPLOYMENT.md` §8 — `FIELD_ENCRYPTION_KEY` needs the re-encryption tool, not an edit.
- [ ] DNS / Cloudflare for wealthprism.in, and the Caddy TLS setup
- [ ] Any provider sandbox credentials already issued (Kite, BSE StAR MF, ICICI, Setu, the AA)
- [ ] Backup destination (`RCLONE_REMOTE`) and its credentials

Confirm before signing off: a clean clone passes the §3 check list, and a deploy following §7 reaches
`(healthy)`.

## 10. Suggested first week

1. Run the §3 check list on a fresh clone. If anything fails, that is the first bug and it is an
   onboarding bug — fix the docs with it.
2. Read `CLAUDE.md`, then implement one small ticket end to end to feel the pattern.
3. Refresh `README.md` and `DEV-SETUP.md` — both predate the current state (README still says 231
   OpenAPI paths and migrations 001–013; DEV-SETUP still hand-lists packages to build). Stale
   onboarding docs are how the next team loses a day.
4. Decide the provider-certification order. It is commercial lead time more than engineering time, so
   start the paperwork before the sprint that needs it.
5. Set up staging. Every production issue so far would have been caught by deploying somewhere
   disposable first.
