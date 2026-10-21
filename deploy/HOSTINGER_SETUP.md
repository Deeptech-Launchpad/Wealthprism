# Deploying on a Hostinger VPS (Docker)

Target: Hostinger KVM 2 (2 vCPU / 8 GB / 100 GB NVMe) or larger, Ubuntu 24.04. Everything runs in Docker, so
moving later to AWS/GCP/another VPS is: copy `deploy/`, copy the three volumes, change DNS.

## 1. Provision
1. In hPanel create the VPS with the **Ubuntu 24.04 with Docker** template (or plain Ubuntu and install Docker with `curl -fsSL https://get.docker.com | sh`).
2. Add your SSH key; disable password SSH (`/etc/ssh/sshd_config` → `PasswordAuthentication no`).
3. Firewall (hPanel firewall or `ufw`): allow 22, 80, 443 only. MinIO (9000/9001), Postgres (5432) and Redis are never exposed.
4. Point DNS: `A app.yourdomain.in → VPS IP`, `A api.yourdomain.in → VPS IP`, and an `MX` for `ingest.yourdomain.in` at your inbound-email provider (SES/Postmark).

## 2. First deploy
```bash
ssh root@<vps-ip>
adduser deploy && usermod -aG docker,sudo deploy && su - deploy
git clone git@github.com:<org>/familyoffice.git && cd familyoffice/deploy
cp .env.example .env && nano .env        # fill every value; generate secrets with: openssl rand -base64 32
docker login ghcr.io                     # PAT with read:packages
docker compose pull                      # or: docker compose build (builds on the VPS; slower)
docker compose up -d
docker compose logs -f api               # wait for "listening on :4000"
```
Caddy obtains TLS certificates automatically from Let's Encrypt on first request to each domain.

First start runs `db/001_init.sql` automatically (via `scripts/pg-init.sh`). To load the prototype family on
staging set `SEED_ON_START=true` in `.env` **before** the first `up`; never on production.

Create the first owner: `docker compose exec api node dist/cli.js create-owner --email you@domain --name "Your Name"`
(prints a one-time password; MFA enrolment is forced on first login).

## 3. Updating
CI builds images tagged with the git SHA and `latest`. On the VPS:
```bash
cd ~/familyoffice/deploy && git pull && ./scripts/deploy.sh
```
`deploy.sh` pulls images, runs the `migrate` one-shot container, then restarts services. Downtime is a few seconds while `api` restarts; for zero-downtime later, add a second `api` replica behind Caddy.

## 4. Backups
The `backup` container runs `scripts/backup.sh` daily: `pg_dump` (custom format) + MinIO documents tarball, kept 7 days locally and pushed offsite with rclone (Backblaze B2, Wasabi, S3, or Google Drive) for `BACKUP_RETAIN_DAYS`. Test a restore on staging monthly: `./scripts/restore.sh /backups/<stamp>`.

Hostinger's VPS snapshot/backup add-on is a second, coarse layer; keep it on.

## 5. Monitoring
- `docker compose ps` and `docker stats` for the basics.
- API exposes `/healthz` (process) and `/readyz` (DB + Redis). Point an uptime checker (UptimeRobot / Better Stack free tier) at `https://api.../healthz` and `https://app...`.
- Logs: `docker compose logs -f --tail=200 api worker`. Ship to Grafana Cloud/Loki later by adding a `promtail` service.
- Postgres slow queries (> 500 ms) are logged by the `log_min_duration_statement` flag in compose.

## 6. Sizing and limits
- KVM 2 comfortably runs 1 family with 50 k bank transactions. Move Postgres to a managed instance (or a bigger VPS) beyond ~10 families or 1 M rows.
- MinIO is single-node; documents volume grows with uploads (25 MB cap per file). Watch `df -h`.
- Redis persistence is AOF; queue state survives restarts.

## 7. Porting to another host
1. `docker compose down` on the old host after a final `docker compose exec backup /backup.sh`.
2. On the new host: clone repo, copy `.env`, `docker compose up -d postgres minio`, run `scripts/restore.sh` with the backup directory, then `docker compose up -d`.
3. Switch DNS. Caddy re-issues certificates automatically.
Nothing in the stack is Hostinger-specific.

## 8. Action plane (execution) on the VPS

- `executor` is a separate container with its own DB role (`executor_user`), read-only filesystem, no capabilities, and an egress allow-list of provider domains; it reads credentials from `vault` and never from `.env`.
- `vault` runs on the internal Docker network only. First start: `docker compose exec vault vault operator init` (store the unseal keys offline), unseal, create the `executor` (read) and `api` (write/revoke) policies, and put the two tokens in `.env`. Vault must be unsealed after every restart — a small ops step that is deliberate.
- Register the VPS's static IP with each broker (Kite Connect, Breeze) and the bank's corporate-API allow-list.
- Set the executor role password: `docker compose exec postgres psql -U postgres -d familyoffice -c "alter role executor_user with password '<EXECUTOR_DB_PASSWORD>'"`.
- Keep `SANDBOX_ONLY=true` until each connector's dry-run intent completes end to end; go live one connector at a time.
- Kill switch: any owner/member from the app; or from the VPS `docker compose stop executor` (queued intents wait).

## 9. Mobile app
The Expo app is not deployed on the VPS; it is built with EAS and points at `https://api.yourdomain.in`. Push notifications go through Expo's push service using `EXPO_ACCESS_TOKEN` from the worker.
