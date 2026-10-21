# Family Office — complete handover

One bundle: specification, verified database and API contract, clickable prototype, the runnable application (web + mobile + API + engines),
Docker deployment for any VPS, and the developer setup. Word versions of every guide are in `docx/`.

## Read in this order

| # | File | What it is |
|---|---|---|
| 1 | `HANDOVER.md` | Start here if you are taking the project over: current state, the four invariants, the production runbook, the traps already hit, and an access checklist |
| 2 | `DEV-SETUP.md` | Run it on a laptop in ten minutes (infra in Docker, code with hot reload) |
| 3 | `DEV-VPS-SETUP.md` | Stand up your own development or staging VPS, and what must never be copied from production |
| 4 | `VPS-DEPLOYMENT.md` | Deploy production on a VPS with one script (`deploy/bootstrap-vps.sh`), day-2 operations, porting to another server, and every error met on the first deployment with its fix |
| 5 | `CLAUDE.md` | House style and the pattern every ticket follows — read before writing code |
| 6 | `BUILD-STATUS.md` | Exactly what is implemented and verified, and which ticket adds each remaining piece |
| 7 | `family-office-PRD.md` | The specification (v2.0): 21 modules, schema, API, calculations, acceptance tests, decisions |
| 8 | `family-office-prototype.html` | Clickable reference UI for every screen (toggle Web/Mobile at the top) |
| 9 | `tickets/phases_0-2_tickets.md` / `.csv` | 130 tickets with acceptance criteria and dependencies; CSV imports into Jira/Linear |
| 10 | `PROGRESS.md` | The milestone log — what each milestone delivered and its known limits |
| 11 | `family-office-BENCHMARK.md`, `family-office-EXECUTION-ROUTES.md` | Why each feature exists; how MF and bank execution actually connect in India |

## Layout

```
app/            monorepo. apps/api (Fastify; also hosts the worker, CLI and migrator), apps/executor,
                apps/web (React 19 + Vite), apps/mobile (Expo);
                packages/finance, packages/parsers, packages/connectors, packages/reports;
                app/deploy/*.Dockerfile
db/             SQL migrations 001–030 (schema, RLS, GL invariants, action-plane state machine) + seeds,
                applied in order and tracked in schema_migrations
api/            openapi.yaml — 364 paths, every one implemented; unknown paths are plain 404s
deploy/         docker-compose.yml (+ dev overlay), .env.example / .env.dev, bootstrap-vps.sh,
                caddy/, nginx/, scripts/ (backup, restore, deploy)
samples/        parser fixtures (CAS, contract notes, bank CSV, AA JSON, 26AS, PMS, e-CAS, FMV)
docx/           Word versions of all guides
.github/        CI — the full API suite against a real Postgres, and a build of all three Dockerfiles
```

## Quick start

```bash
# a VPS — production
DOMAIN=app.example.in EMAIL=you@example.in bash deploy/bootstrap-vps.sh

# a VPS — your own development box (seeded demo data, sandbox connectors); see DEV-VPS-SETUP.md
DOMAIN=dev.example.in EMAIL=you@example.in SEED=true bash deploy/bootstrap-vps.sh

# a laptop
cd deploy && docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.dev up -d postgres redis minio
cd ../app && pnpm install && pnpm --filter @fo/api... build
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm dev:api & pnpm dev:web
# approved Action Plane intents only ever get submitted by the executor — it's a separate process, not part of
# dev:api, and production's docker-compose starts it for you but this laptop path doesn't. Run it too, or
# anything you approve will just sit at "queued" forever:
#   1. create a DB role for it once: psql -U postgres -c "alter role executor_user with password 'executor';"
#   2. apps/executor/.env: EXECUTOR_DATABASE_URL=postgres://executor_user:executor@localhost:5432/familyoffice
#   3. pnpm dev:executor
```

`pnpm --filter <target>... build` — the `...` suffix means "and its dependencies". Never hand-list the packages to
build: every place that did has broken, because a fresh checkout has no `dist/` for the others to resolve through.

Demo login (seeded environments only): `arjun@example.com` / `Prototype!2026`. Step-up code for approvals: `000000`.

Source of truth once cloned: your Git repository. To deploy a new version, build, migrate, then restart — migrate
before the new containers start, because the new code may need the new schema:

```bash
git pull
cd deploy
docker compose build api executor web
docker compose --profile ops run --rm migrate      # --profile goes BEFORE run
docker compose up -d api worker executor web
```
