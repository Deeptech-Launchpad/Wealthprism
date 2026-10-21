# Family Office / WealthPrism — instructions for Claude Code

Wealth-management platform for Indian HNI families. The specification, database, API contract, prototype and a running
foundation already exist. Your job is to implement tickets against them, not to redesign.

## Read first (in this order, once per session as needed)
- `BUILD-STATUS.md` — what exists and is verified; which ticket adds what
- `family-office-PRD.md` — the spec; module sections 3.x, schema 5.x, API 6, calculations 4
- `tickets/phases_0-2_tickets.md` — the ticket you are working on, with acceptance criteria
- `api/openapi.yaml` — the API contract; unimplemented paths currently answer 501 via `app/apps/api/src/lib/stubs.ts`
- `family-office-prototype.html` — how every screen should look (open in a browser); the JSX source is `family-office-prototype.jsx`

## Repository layout
```
app/apps/api        Fastify + TypeScript API (routes in src/routes, auth/db helpers in src/lib, worker.ts, cli.ts, migrate.ts, tests in test/)
app/apps/executor   execution service (separate DB role, sandbox adapter)
app/apps/web        React 19 + Vite (src/pages, src/lib/api.ts, src/components.tsx)
app/apps/mobile     Expo / React Native (src/screens, src/lib/api.ts)
app/packages/finance pure, tested calculation engine (xirr, lots, capitalGains, buckets, workingCapital)
db/                 SQL migrations 001–013 + seeds; applied in order; never edit an applied file — add db/014_… onward
api/openapi.yaml    contract, source of truth for request/response shapes
deploy/             Docker Compose, bootstrap script, Caddy/nginx; VPS-DEPLOYMENT.md explains production
samples/            parser fixtures (CAS, contract notes, bank CSV, AA JSON, 26AS, PMS)
```

## Commands
```bash
# infra for local dev (from deploy/): Postgres seeded with the demo family, Redis, MinIO
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.dev up -d postgres redis minio
# from app/
pnpm install && pnpm --filter @fo/finance build
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm dev:api          # :4000
pnpm dev:web                                                                           # :5173 (proxies /api)
pnpm --filter @fo/finance test                                                          # engine unit tests
DATABASE_URL=postgres://app_user:app@localhost:5432/familyoffice pnpm --filter @fo/api test   # API integration tests (needs the DB)
pnpm --filter @fo/web build && pnpm --filter @fo/mobile typecheck
```
Demo login: arjun@example.com / Prototype!2026 (priya = member, ops = operator, ca = viewer). Dev step-up code: 000000.

## How to implement a ticket (the pattern every ticket follows)
1. Read the ticket's description and acceptance criteria, and the PRD section it cites.
2. Contract first: add or confirm the path and schemas in `api/openapi.yaml` (keep it valid OpenAPI 3.1).
3. Calculations go in `app/packages/finance` as pure functions with vitest tests; routes only orchestrate.
4. Routes: `app/apps/api/src/routes/*.ts`, registered in `server.ts`. Every tenant query runs inside `withFamily(req.family!.familyId, async (c) => …)` so Postgres RLS applies. Use `requireRole()` for writes. Return money as decimal strings via `money()`. Add an integration test in `app/apps/api/test/` modelled on `api.test.ts`.
5. Schema changes: a new file `db/0NN_name.sql` with RLS policies and `grant … to app_user` (and `executor_user` where relevant). Prove it applies on a fresh DB (`pnpm --filter @fo/api migrate` against a clean database) before committing.
6. UI: copy `app/apps/web/src/pages/Dashboard.tsx` as the pattern (useApi + Card/Pill), and `app/apps/mobile/src/screens/Tasks.tsx` for mobile. Match the prototype's layout and copy.
7. Run the full check list in Commands. CI runs the same on every push.
8. Commit with the ticket key first (`FO-27: CAS importer for CAMS/KFintech`). Open a PR to `main`; never push to `main` directly.

## Rules that must not be broken
- **Separation of powers** (PRD 3.18): anything that proposes (AI, rules, research) cannot approve; approvals require step-up auth and a different user from the proposer; only the executor executes; the DB triggers in `db/008` enforce this — do not bypass them.
- **RLS is the last line of defence**: the API connects as `app_user`, never as the owner; no query outside `withFamily()`.
- **Tax rules are data**: rates, slabs, exemptions, holding periods live in `tax_rules`, `tax_slabs`, `tax_surcharge`, `tax_deduction_limits`. No numeric tax constants in code.
- **Posted journals are immutable**; corrections are reversals (`db/007`).
- **Secrets never enter git** (`deploy/.env`, API keys). Use `.env.dev` locally.
- Do not edit applied migrations; do not change `db/002`/`004` seeds except to extend demo data consistently with the prototype.
- Money: `numeric(18,2)` in SQL, decimal strings in JSON, `inr()` helper for display. Dates: ISO strings.

## Style
TypeScript strict everywhere; zod for validation; no default exports for components except pages; keep the existing visual tokens
(navy #12213A, teal #0E7C6B, amber #B7791F, red #B93B31; IBM Plex Sans; tabular numerals). Small, reviewable PRs — one ticket each.
