# Deploying Family Office on your own VPS

Everything runs in Docker from this repository; the only host-level piece is the public edge (TLS). This guide is the
exact sequence that produced the running production instance, including every problem met on the way and its fix.

## 1. What you need

- A VPS with Ubuntu 22.04 or 24.04, 2 vCPU / 8 GB RAM / 40 GB disk or more (Hostinger KVM 2 is fine), root or sudo user.
- A domain or subdomain pointed at the VPS (A record → VPS IPv4). Optional for a first run; required for HTTPS.
- This repository (clone from GitHub or extract the handover zip).

## 2. One-shot deployment

```bash
git clone https://github.com/<owner>/familyoffice.git && cd familyoffice      # or: unzip family-office-handover.zip && cd handover
DOMAIN=app.example.in EMAIL=you@example.in bash deploy/bootstrap-vps.sh
```
Add `SEED=true` for a staging box that should load the demo family (`arjun@example.com` / `Prototype!2026`). Never on production.

The script installs Docker (and `gh` if you pass `GH_OWNER` to create/push a GitHub repo), generates `deploy/.env` with random secrets,
detects whether port 80 is free, sets the Caddy site address, builds the four images, starts the stack and checks `/healthz`.

- **Fresh VPS, port 80 free** → Caddy serves the site directly; with `DOMAIN` set it obtains a Let's Encrypt certificate on first request. Done.
- **Port 80 already used** (another site on nginx/Apache) → Caddy binds `127.0.0.1:8080`; the script prints an nginx server block and the certbot
  command to put your domain in front of it. Copy-paste those, and you are done.

## 3. What runs

| Service | Image | Role |
|---|---|---|
| caddy | caddy:2-alpine | reverse proxy: `/api/*` → api, everything else → web; TLS when it owns 80/443 |
| web | built from `app/deploy/web.Dockerfile` | React app served by nginx |
| api | built from `app/deploy/api.Dockerfile` | Fastify API on :4000, `/healthz`, `/readyz` |
| worker | same image, `dist/worker.js` | scheduler: expiring intents, cooling-off release, overdue rent, GL balance refresh |
| executor | `app/deploy/executor.Dockerfile` | execution loop on its own DB role; sandbox until `SANDBOX_ONLY=false` |
| postgres | postgres:16-alpine | applies `db/001…013` on first start (`deploy/scripts/pg-init.sh`); seeds if `SEED_ON_START=true` |
| redis, minio, backup | redis:7, quay.io/minio/minio, postgres:16 | queue store, documents, nightly dump + rclone offsite |

Data lives in Docker volumes `pg_data`, `minio_data`, `redis_data`, `backups`, `caddy_data`.

## 4. Day-2 operations

```bash
cd deploy
sudo docker compose ps                        # status
sudo docker compose logs -f api               # logs (worker, executor, caddy, postgres likewise)
git pull && sudo docker compose build && sudo docker compose up -d     # deploy a new version
sudo docker compose exec api node dist/cli.js create-owner --email you@x.in --name "Name" --family "Family"   # first real user
sudo docker compose exec api node dist/cli.js set-password --email you@x.in --password 'NewPass!'
sudo docker compose exec backup /backup.sh    # manual backup (runs inside the backup container, which has pg_dump); nightly runs automatically
./scripts/restore.sh /backups/<stamp>         # restore
```
Reset a staging database to the seed: `sudo docker compose down -v postgres && sudo docker compose up -d postgres`.

## 5. Porting to another VPS

1. On the old server: `cd deploy && sudo docker compose exec backup /backup.sh` and copy the newest `/backups/<stamp>` directory off the box
   (`sudo docker cp familyoffice-backup-1:/backups/<stamp> ./`).
2. On the new server: clone the repo, copy the old `deploy/.env` (same secrets, or the field-encryption key must match),
   run `DOMAIN=… bash deploy/bootstrap-vps.sh`, then `docker compose stop api worker` and `./scripts/restore.sh <dir>`, then `up -d`.
3. Switch DNS. Nothing is host-specific.

## 6. Troubleshooting — every error met during the first deployment

| Symptom | Cause | Fix |
|---|---|---|
| `unzip: command not found` | fresh Ubuntu | `sudo apt install -y unzip` |
| `git init` created a repo in `$HOME` and staged other projects | ran before `cd` into the extracted folder | `rm -rf ~/.git`, then `cd handover` and re-run |
| `gh repo create`: "Name already exists" | repo pre-created on GitHub | bootstrap now falls back to `git remote add … && git push --force` |
| Docker build: `COPY apps/web: not found`, `lstat deploy/api: no such file` | compose pointed at old Dockerfiles / wrong context | compose builds from `../app` with `app/deploy/*.Dockerfile` (fixed in repo) |
| `dockerfile parse error … unknown instruction` | a sed edit left a fragment line | Dockerfiles are now written whole; do not patch with sed |
| pnpm: `ERR_PNPM_IGNORED_BUILDS … esbuild` | pnpm 12 refuses postinstall scripts non-interactively | `pnpm install … --dangerously-allow-all-builds` (in the Dockerfiles) |
| `pull access denied for minio/minio` | Docker Hub anonymous pull denied | image is `quay.io/minio/minio:latest` |
| api/worker restarting: `Cannot find module /repo/apps/api/apps/api/dist/server.js` | doubled path | commands are `node dist/server.js` / `dist/worker.js` (fixed) |
| caddy restarting: `server block without any key is global configuration` | empty site address placeholder | Caddyfile site block is `:80 {` or `your.domain {` (bootstrap sets it) |
| caddy: `failed to bind host port 0.0.0.0:80: address already in use` | nginx/Apache on the host | bootstrap detects this and binds Caddy to `127.0.0.1:8080`; put nginx in front |
| Browser: blank page, console `Minified React error #527` | `react` and `react-dom` resolved to different versions | both pinned to `19.0.0` in `app/apps/web/package.json` and the lockfile |
| Browser: `DNS_PROBE_FINISHED_NXDOMAIN` for `1.2.3.4.com` | Chrome appended `.com` to a bare IP | type `http://` before the IP |
| `curl localhost:8080` empty while containers "Up" | Caddy still in restart back-off after config change | `sudo docker compose restart caddy` |
| `Permission denied` on `pnpm-lock.yaml` after running pnpm in a container | file written as root | `sudo chown $USER:$USER app/pnpm-lock.yaml` |
| `./scripts/backup.sh: pg_dump: not found` | the script is meant to run inside the backup container | `sudo docker compose exec backup /backup.sh` |
| `git fetch`: `Invalid username or token. Password authentication is not supported` | GitHub needs a token, not the account password | create a fine-grained token (Contents: read) and paste it at the password prompt after `git config --global credential.helper store` |
| `cannot open '.git/FETCH_HEAD': Permission denied` | an earlier `git` ran as root inside a user's checkout | `sudo chown -R $USER:$USER <checkout>` |
| `migrate`: `type "member_role" already exists` on `001_init.sql` | the database was created by `pg-init.sh` (plain psql) and has no `schema_migrations` rows | baseline once: `create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())` and insert the file names `pg-init.sh` applied (001–013), then re-run `migrate` |
| `unknown flag: --profile` | flag order | `docker compose --profile ops run --rm migrate` (profile before `run`) |
| `docker compose` warns every variable is unset and tags images `ghcr.io//…` | run from the wrong directory, so compose found another project's file | `cd <checkout>/deploy` first; the right build prints `ghcr.io/<owner>/familyoffice-api:local` |
| image build: `sh: tsc: not found` in a `packages/*` build step | the install filter selected the app only, so its workspace dependency had no devDependencies | install with the `...` suffix (`--filter @fo/executor...`) and build with `pnpm --filter @fo/executor... build` |
| image build: api `tsc` cannot find `@fo/parsers` | the Dockerfile did not copy that workspace package | every Dockerfile copies all workspace manifests and the packages it builds; CI builds the three images on each push |
| Domain shows a different site | no nginx server block for that hostname, default site answered | add the server block for the exact hostname(s) and reload nginx |
| certbot: "existing certificate contains a portion of the domains" | expanding an earlier cert | add `--expand` |
| nginx config contains `[www.…](https://…)` | chat/markdown client rewrote the pasted text | retype the line; see `deploy/nginx/wealthprism.conf` for the clean version |
| Browser times out on a port that works with `curl` on the VPS | provider firewall | hPanel → VPS → Firewall → allow the port, or route via nginx on 80/443 |

## 7. Security checklist before real data

- `SEED_ON_START=false`, database reset, first owner created via the CLI, MFA enrolled.
- HTTPS on (Caddy or nginx + certbot); port 8080 bound to `127.0.0.1` when behind nginx.
- Provider firewall: only 22, 80, 443 open. `deploy/.env` never committed (it is git-ignored); keep an offline copy of `FIELD_ENCRYPTION_KEY`.
- `RCLONE_REMOTE` set so nightly backups leave the box; test `scripts/restore.sh` on a staging server.
- `SANDBOX_ONLY=true` stays until each connector passes its dry run (PRD 3.18).

## 8. Rotating the secrets in `deploy/.env`

> **This file was tracked in git until 15 September 2026.** Every value generated by
> `bootstrap-vps.sh` on the production box — the three database passwords, the MinIO password,
> `JWT_SECRET`, `REFRESH_SECRET` and `FIELD_ENCRYPTION_KEY` — is in the history of this repository.
> The repository is private and unforked, so the exposure is to everyone who has or is given access to
> it, which at handover means the incoming team. Those values must be treated as known and rotated;
> rotating them is what makes the history harmless, because the old values stop being worth anything.
> `deploy/.env` is now in `.gitignore` and untracked, so the new values stay out of git — but check
> `git status` after editing it and make sure it does not appear.
>
> A second consequence, now fixed: a fresh clone used to arrive carrying `deploy/.env`, and
> `bootstrap-vps.sh` only generates secrets `if [ ! -f .env ]`. Anyone who cloned and bootstrapped
> inherited production's secrets instead of getting their own.


Rotate at handover, when someone with access leaves, or if a value may have leaked. Not every secret
rotates the same way: three of them are only a string in a file, three need the thing they authenticate
changed at the same moment, and one re-encrypts stored data.

**Back up first** — `sudo docker compose exec backup /backup.sh` — and copy the backup off the box. Keep
the current `.env` somewhere safe until the rotation is proven; losing `FIELD_ENCRYPTION_KEY` before its
data is re-encrypted is unrecoverable.

Generate values the way the bootstrap does: `openssl rand -base64 32 | tr -d '/+=' | cut -c1-32`, and
`openssl rand -base64 32` for `FIELD_ENCRYPTION_KEY`.

### Easy — edit and restart

`JWT_SECRET`, `REFRESH_SECRET`, `INGEST_WEBHOOK_SECRET`.

```bash
cd /home/vellayan/handover/deploy
nano .env                                   # replace the values
docker compose up -d api worker executor
```

Rotating the JWT secrets signs everyone out and invalidates outstanding refresh tokens — everybody logs
in again, which is usually the point. Changing `INGEST_WEBHOOK_SECRET` means the mail gateway must be
given the new value or inbound e-mail stops being accepted.

### Database roles — change the role and the file together

`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `EXECUTOR_DB_PASSWORD`. The file alone is not enough: the role's
password lives in Postgres, and role passwords are cluster-wide.

```bash
cd /home/vellayan/handover/deploy
docker compose exec postgres psql -U postgres -d familyoffice \
  -c "alter role app_user with password 'NEW_APP'" \
  -c "alter role executor_user with password 'NEW_EXEC'" \
  -c "alter role postgres with password 'NEW_POSTGRES'"
nano .env                                   # the same three values
docker compose up -d api worker executor
docker compose logs --since 2m api | grep -i "password authentication" || echo "connections fine"
```

Do the `alter role` and the `.env` edit in one sitting: between them the running containers still hold
their old connections, but anything that reconnects will fail.

### MinIO — restart the datastore too

`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`. Compose passes these to MinIO and to the API as its S3
credentials, so both must move together: `nano .env`, then
`docker compose up -d minio api worker`. Stored documents are unaffected; only the credentials change.

### `FIELD_ENCRYPTION_KEY` — re-encrypt, never just replace

This key protects four stores, all AES-256-GCM:

| Where | What is lost if the key changes without re-encryption |
|---|---|
| `entities.pan_enc` | every PAN — only the last four digits survive elsewhere |
| `connector_credentials.ciphertext` | broker and bank credentials |
| `webhooks.secret_enc` | the secret each delivery is signed with |
| `aa_consents.key_material` | the key pair that decrypts Account Aggregator data; active consents break |

There is no way back from a wrong key, so re-encrypt with the tool rather than editing the file:

```bash
cd /home/vellayan/handover/deploy
OLD=$(grep '^FIELD_ENCRYPTION_KEY=' .env | cut -d= -f2-)
NEW=$(openssl rand -base64 32)

# 1. dry run — reports what it would rewrite and changes nothing
docker compose --profile ops run --rm \
  -e OLD_FIELD_ENCRYPTION_KEY="$OLD" -e NEW_FIELD_ENCRYPTION_KEY="$NEW" \
  migrate node dist/rotatekey.js

# 2. rewrite, in one transaction
docker compose --profile ops run --rm \
  -e OLD_FIELD_ENCRYPTION_KEY="$OLD" -e NEW_FIELD_ENCRYPTION_KEY="$NEW" \
  migrate node dist/rotatekey.js --apply

# 3. only now put the new key in the file, and restart
sed -i "s|^FIELD_ENCRYPTION_KEY=.*|FIELD_ENCRYPTION_KEY=$NEW|" .env
docker compose up -d api worker executor
echo "$NEW"                                 # store this offline before clearing the screen
```

The tool refuses to write anything if any row fails to decrypt with the old key, and is safe to re-run:
rows already on the new key are counted and skipped rather than encrypted twice.

Afterwards, check a PAN still reads (Settings → Family shows the last four) and, if any connector is
live, that a health ping still authenticates.

### Not in this file

Provider credentials — Kite, BSE StAR MF, ICICI, Setu, the AA, WhatsApp, SES — are rotated with the
provider and then pasted into the app, which stores them under the new `FIELD_ENCRYPTION_KEY`. GitHub
tokens are rotated on GitHub. Neither is affected by the steps above.
