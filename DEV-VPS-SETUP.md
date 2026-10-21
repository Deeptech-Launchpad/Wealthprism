# Setting up a development VPS

For a team standing up their **own** instance on a separate VPS — a development or staging box,
independent of production. Tested on Hostinger KVM; any Ubuntu 22.04/24.04 VPS behaves the same.

If you are deploying *production*, read `VPS-DEPLOYMENT.md` instead. If you are developing on a
laptop, read `DEV-SETUP.md`. This file is the middle case, and it differs from both in ways that
matter — most of them about not letting a development box touch real money or real data.

---

## 1. The box

| | |
|---|---|
| Size | Hostinger **KVM 2** or better — 2 vCPU, 8 GB RAM, 40 GB disk |
| OS | Ubuntu 22.04 or 24.04 |
| User | a normal user with `sudo`, not root |
| DNS | a subdomain A-record → the VPS IPv4, e.g. `dev.yourteam.in` (optional for a first run, required for HTTPS) |
| Firewall | 22, 80, 443 inbound. Nothing else. |

8 GB is not excessive: the stack is nine containers and the first image build compiles the whole
TypeScript monorepo. A 4 GB box will fail partway through the build.

## 2. Repository access

Each developer needs access to `vellayan-code/familyoffice`. Clone over HTTPS and type your
fine-grained personal access token at the interactive `Password:` prompt — **never on the command
line**, where it is written to shell history and to any log that captures the command.

```bash
git clone https://github.com/vellayan-code/familyoffice.git && cd familyoffice
git config credential.helper store      # optional; stores it for later pulls
```

## 3. Bootstrap

```bash
DOMAIN=dev.yourteam.in EMAIL=dev@yourteam.in SEED=true bash deploy/bootstrap-vps.sh
```

The script installs Docker, generates `deploy/.env` with fresh random secrets, decides how to handle
the public edge, builds the four images, starts the stack and checks `/healthz`. The first build takes
five to ten minutes.

It picks the edge mode by looking at port 80:

- **free** → Caddy serves the site itself and, with `DOMAIN` set, obtains a Let's Encrypt certificate
  on the first request. Nothing else to do.
- **in use** (Hostinger panels often run something there) → Caddy binds `127.0.0.1:8080` and the script
  prints the nginx server block and the certbot command to paste. Do both and you are done.

Log in as `arjun@example.com` / `Prototype!2026`. Step-up code for approvals is `000000`. The other
seeded users are `priya` (member), `ops` (operator) and `ca` (viewer), same password.

Without `SEED=true` you get an empty instance and create the first user yourself:

```bash
cd deploy && sudo docker compose exec api node dist/cli.js \
  create-owner --email you@yourteam.in --name 'Your Name' --family 'Your Family'
```

## 4. Three rules for a non-production box

**Seed it, never restore it.** `SEED=true` loads the demo Mehta family, which is invented data.
`VPS-DEPLOYMENT.md` §5 describes restoring a production backup — that is for migrating production to
new hardware, and it must not be used to populate a development box. A production backup contains real
client data: PANs, bank accounts, holdings, documents. It does not belong on a machine where people are
trying things out.

**Generate secrets, never copy them.** The bootstrap writes fresh random values. Do not copy
`deploy/.env` from production. This matters most for `FIELD_ENCRYPTION_KEY`: it decrypts stored
connector credentials, so sharing it between environments means a development box can decrypt
production secrets.

**Leave the safety flags alone.** The generated `.env` sets:

```
SANDBOX_ONLY=true          # every connector uses its sandbox adapter; no live order can be placed
EMAIL_TRANSPORT=log        # invitations and reports are printed, not sent
WHATSAPP_PROVIDER=log      # likewise
```

Turning any of these off on a shared box means real e-mail to real people, or an order attempt against
a real broker. Change them only on a machine where you have decided that is what you want, one
provider at a time.

## 5. Developing on it

The bootstrap gives you a production-shaped stack: right for demos, integration testing and showing
someone the app, but the code is baked into images, so there is no hot reload.

### The trap: do not use the dev overlay as-is on a public VPS

`deploy/docker-compose.dev.yml` publishes the datastores so a laptop can reach them:

```yaml
postgres: ports: ["5432:5432"]
redis:    ports: ["6379:6379"]
minio:    ports: ["9000:9000", "9001:9001"]
```

On a laptop that is harmless. On a VPS it exposes Postgres to the internet — and `.env.dev` pairs it
with the password `app`. The file says so itself: *"Developer defaults — safe for laptops only. Never
use on a server."* The base `docker-compose.yml` publishes nothing but the edge, deliberately.

So on a VPS, either keep 5432/6379/9000 closed at the firewall, or skip the overlay entirely.

### Recommended: tunnel instead of publishing

Run the dev servers on the box and reach them through SSH:

```bash
# on your machine
ssh -L 5173:localhost:5173 -L 4000:localhost:4000 dev@your-vps

# on the box, inside the repo
cd app && pnpm install && pnpm --filter @fo/api... build
DATABASE_URL=postgres://app_user:<APP_DB_PASSWORD>@localhost:5432/familyoffice pnpm dev:api
pnpm dev:web
```

Take `APP_DB_PASSWORD` from `deploy/.env`. To reach the containerised Postgres from the host without
publishing it, either run the dev servers inside the Compose network or add a temporary
`127.0.0.1:5432:5432` mapping — bound to loopback, not `0.0.0.0`.

VS Code Remote-SSH or JetBrains Gateway is the smoothest way to work this way: editor on your machine,
everything else on the box, no ports exposed.

## 6. Prove it works before writing code

Run the same check list CI runs (`HANDOVER.md` §3):

```bash
cd app
pnpm --filter @fo/finance build && pnpm --filter @fo/finance test
pnpm --filter @fo/parsers build && pnpm --filter @fo/parsers test
pnpm --filter @fo/api... build
DATABASE_URL=postgres://app_user:<APP_DB_PASSWORD>@localhost:5432/familyoffice pnpm --filter @fo/api test
pnpm --filter @fo/web build && pnpm --filter @fo/mobile typecheck
```

If anything fails on a fresh clone, that is the first bug to fix, and it is an onboarding bug — fix the
documentation along with it.

## 7. Workflow

Feature branch → pull request to `main`. Never push to `main` directly. CI runs the same two jobs on
your pull requests: the full API suite against a real Postgres, and a build of all three Dockerfiles.

To update the box afterwards, use the sequence in `HANDOVER.md` §7:

```bash
git checkout main && git pull
cd deploy
docker compose build api executor web
docker compose --profile ops run --rm migrate
docker compose up -d api worker executor web
```

`deploy/scripts/deploy.sh` is written for a registry workflow (`docker compose pull`) and will not work
with locally built `:local` images.

## 8. What you will not inherit

Provider sandbox credentials are issued per account. Zerodha Kite, BSE StAR MF, ICICI Corporate, Setu
BBPS and the Account Aggregator each need their own sandbox registration in the development team's
name. That is commercial lead time, not engineering time — start the paperwork before the sprint that
needs it.

## 9. Housekeeping

- Backups are configured but usually pointless on a development box. Leave `RCLONE_REMOTE` empty and
  let the local retention expire.
- Rebuild from scratch whenever the data gets messy — that is the advantage of seeded data:
  `docker compose down -v` then re-run the bootstrap.
- Keep the box patched (`unattended-upgrades`) and do not let it become a second production
  environment by accident. If real client data ever needs to be on it, it is production, and
  `VPS-DEPLOYMENT.md` §7 (security checklist) applies.
