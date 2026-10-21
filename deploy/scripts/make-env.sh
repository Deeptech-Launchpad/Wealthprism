#!/usr/bin/env bash
# Writes deploy/.env on THIS machine with freshly generated random secrets. The file never goes into git (it is git-ignored) and the
# script refuses to overwrite an existing one, so re-running it can never change the passwords of a database that already exists.
# Usage, from the repository root:   bash deploy/scripts/make-env.sh [your.domain.in]
#   no domain  -> plain HTTP on 127.0.0.1:8090 (reach it through an SSH tunnel; nothing is exposed to the internet)
#   with domain -> Caddy takes ports 80/443 itself and gets a Let's Encrypt certificate (DNS A record must point here first)
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:-}"
[ -f .env ] && { echo "deploy/.env already exists - not touching it."; exit 0; }
gen() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"${1:-32}"; }
if [ -n "$DOMAIN" ]; then
  SITE="$DOMAIN"; HTTP_BIND="0.0.0.0:80"; HTTPS_BIND="0.0.0.0:443"; WEB_URL="https://$DOMAIN"
else
  SITE=":80"; HTTP_BIND="127.0.0.1:8090"; HTTPS_BIND="127.0.0.1:8453"; WEB_URL="http://localhost:8090"
fi
umask 077
cat > .env <<ENV
# generated $(date -u +%FT%TZ) by deploy/scripts/make-env.sh - keep a copy of FIELD_ENCRYPTION_KEY offline; losing it makes stored PANs and credentials unreadable
COMPOSE_PROJECT_NAME=wealthprism
GH_ORG=local
IMAGE_TAG=local
SITE_ADDRESS=$SITE
CADDY_HTTP_BIND=$HTTP_BIND
CADDY_HTTPS_BIND=$HTTPS_BIND
CADDY_EMAIL=${CADDY_EMAIL:-admin@example.com}
NODE_ENV=production
POSTGRES_PASSWORD=$(gen 32)
APP_DB_PASSWORD=$(gen 32)
EXECUTOR_DB_PASSWORD=$(gen 32)
MINIO_ROOT_USER=wealthprism
MINIO_ROOT_PASSWORD=$(gen 32)
JWT_SECRET=$(gen 64)
REFRESH_SECRET=$(gen 64)
INGEST_WEBHOOK_SECRET=$(gen 32)
FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)
CORS_ORIGIN=$WEB_URL
PUBLIC_WEB_URL=$WEB_URL
PUBLIC_API_URL=$WEB_URL/api/v1
EMAIL_TRANSPORT=log
# the demo family is loaded only so the later migrations (which add reference data) can run; its logins are locked below
SEED_ON_START=true
SEED_DEMO_LOGIN=false
SANDBOX_ONLY=true
APPROVAL_EXPIRY_HOURS=24
RCLONE_REMOTE=
BACKUP_RETAIN_DAYS=35
ENV
chmod 600 .env
echo "wrote deploy/.env (site=$SITE, http bind=$HTTP_BIND). Secrets are in that file only; they were not printed."
