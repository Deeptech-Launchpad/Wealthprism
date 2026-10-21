# Family Office — application monorepo

Runnable foundation for the platform specified in `../family-office-PRD.md`. `../BUILD-STATUS.md` lists what is implemented and what each remaining ticket adds.

```
apps/api          Fastify + TypeScript API: auth + TOTP step-up, RLS-scoped Postgres access, portfolio, action plane, GL, module reads,
                  501 stubs for the rest of api/openapi.yaml, migrate/seed runner, worker (scheduler), CLI, integration tests
apps/executor     Separate execution service (executor_user role, kill-switch aware, sandbox adapter)
apps/web          React 19 + Vite: login, shell, dashboard, investments (lots), real estate (rent), startups, goals & buckets, banking,
                  working capital, tasks, action plane (propose/approve/oversight), books (trial balance, day book, periods)
apps/mobile       Expo (React Native): login, dashboard, holdings, property + rent, approvals (biometric step-up, kill switch), tasks, more
packages/finance  XIRR, FIFO lots, bonus/split, capital gains (grandfathering, exemptions), bucket drift, working capital — unit-tested
deploy/           Dockerfiles used by ../deploy/docker-compose.yml
```

## Quick start (local)
```bash
createdb familyoffice                      # Postgres 16, superuser postgres/postgres
pnpm install && pnpm --filter @fo/finance build
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/familyoffice DB_DIR=$(pwd)/../db APP_DB_PASSWORD=app pnpm --filter @fo/api seed
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm dev:api    # :4000
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm --filter @fo/api worker      # scheduler (optional)
DATABASE_URL=postgres://executor_user:exec@localhost:5432/familyoffice SANDBOX_ONLY=true pnpm --filter @fo/executor dev   # executor (optional)
pnpm dev:web                                                                      # :5173, proxies /api → :4000
cd apps/mobile && pnpm start                                                      # Expo; set extra.apiUrl in app.json to your LAN IP
```
Sign in as `arjun@example.com` / `Prototype!2026` (also priya, ops, ca — the CA is a viewer and cannot change tasks). Step-up code in development is `000000`; set `NODE_ENV=production` to require real TOTP. Set the executor role password once: `psql -d familyoffice -c "alter role executor_user with password 'exec'"`.

## Tests
```bash
pnpm --filter @fo/finance test                                                    # engine
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm --filter @fo/api test   # API incl. RLS and roles
pnpm --filter @fo/web build && pnpm --filter @fo/mobile typecheck
```

## Docker
`cd ../deploy && cp .env.example .env && docker compose up -d` — see `../deploy/HOSTINGER_SETUP.md`. The `migrate` one-shot applies `db/*.sql`.

## Conventions
- Every tenant query runs inside `withFamily()` so `app.family_id` is set and Postgres RLS is the last line of defence; the API connects as `app_user`, never as the owner.
- Money is returned as decimal strings per `../api/openapi.yaml`.
- Calculations live in `packages/finance` as pure, tested functions; routes only orchestrate.
- New endpoints: add to `api/openapi.yaml` first, then implement, then add a page (copy `pages/Dashboard.tsx`) and a screen (copy `screens/Tasks.tsx`).
