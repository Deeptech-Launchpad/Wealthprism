#!/usr/bin/env bash
# One-shot deployment of Family Office on a fresh Ubuntu 22.04/24.04 VPS (tested on Hostinger KVM).
# Usage (as a normal user with sudo), from the repository root:
#   DOMAIN=app.example.in EMAIL=you@example.in bash deploy/bootstrap-vps.sh
# Optional: GH_OWNER / GH_REPO (create+push a GitHub repo via gh), ZIP=path (extract a handover zip first),
#           SEED=true (load the demo family — staging only).
# Modes, chosen automatically:
#   • ports 80/443 free  → Caddy serves the site itself; with DOMAIN set it obtains HTTPS automatically.
#   • port 80 in use     → Caddy binds 127.0.0.1:8080 and the script prints the nginx server block to add.
set -euo pipefail
DOMAIN="${DOMAIN:-}"; EMAIL="${EMAIL:-admin@example.com}"; SEED="${SEED:-false}"
GH_OWNER="${GH_OWNER:-}"; GH_REPO="${GH_REPO:-familyoffice}"; ZIP="${ZIP:-}"
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Prerequisites"
sudo apt-get update -qq
sudo apt-get install -y -qq unzip git curl ca-certificates gnupg openssl >/dev/null
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER" || true; }

if [ -n "$ZIP" ]; then say "Extracting $ZIP"; unzip -q "$ZIP" -d "$HOME"; cd "$HOME/handover"; fi
[ -f deploy/docker-compose.yml ] || { echo "run from the repository root (where deploy/ is)"; exit 1; }
ROOT=$(pwd)

say "Git"
if [ ! -d .git ]; then git init -b main >/dev/null; git config user.name "${GIT_NAME:-deploy}"; git config user.email "${GIT_EMAIL:-$EMAIL}"; git add . && git commit -q -m "Initial import"; fi
if [ -n "$GH_OWNER" ]; then
  command -v gh >/dev/null || { sudo mkdir -p -m 755 /etc/apt/keyrings; curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null; echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null; sudo apt-get update -qq && sudo apt-get install -y -qq gh >/dev/null; }
  gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web
  if ! git remote get-url origin >/dev/null 2>&1; then
    gh repo create "$GH_OWNER/$GH_REPO" --private --source=. --remote=origin --push 2>/dev/null \
      || { git remote add origin "https://github.com/$GH_OWNER/$GH_REPO.git"; git push -u origin main --force; }
  else git push -u origin main || true; fi
fi

say "Edge mode"
if sudo ss -tlnp | grep -q ':80 '; then MODE=nginx; CADDY_HTTP=127.0.0.1:8080; CADDY_HTTPS=127.0.0.1:8443; SITE=":80";
else MODE=caddy; CADDY_HTTP=0.0.0.0:80; CADDY_HTTPS=0.0.0.0:443; SITE="${DOMAIN:-:80}"; fi
echo "mode=$MODE  caddy=$CADDY_HTTP  site=$SITE"
sed -i "0,/^[^#{ ].* {$/s##$SITE {#" deploy/caddy/Caddyfile   # first non-global site block key
grep -n "^$SITE {" deploy/caddy/Caddyfile >/dev/null || { echo "could not set site address in Caddyfile"; exit 1; }

say "Environment"
cd deploy
if [ ! -f .env ]; then
  gen() { openssl rand -base64 32 | tr -d '/+=' | cut -c1-32; }
  cat > .env <<ENV
CADDY_HTTP=$CADDY_HTTP
CADDY_HTTPS=$CADDY_HTTPS
CADDY_EMAIL=$EMAIL
GH_ORG=${GH_OWNER:-local}
IMAGE_TAG=local
POSTGRES_PASSWORD=$(gen)
APP_DB_PASSWORD=$(gen)
EXECUTOR_DB_PASSWORD=$(gen)
MINIO_ROOT_USER=familyoffice
MINIO_ROOT_PASSWORD=$(gen)
NODE_ENV=production
JWT_SECRET=$(gen)$(gen)
REFRESH_SECRET=$(gen)$(gen)
FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)
SEED_ON_START=$SEED
SANDBOX_ONLY=true
APPROVAL_EXPIRY_HOURS=24
RCLONE_REMOTE=
BACKUP_RETAIN_DAYS=35
ENV
  echo "wrote deploy/.env (SEED_ON_START=$SEED)"
fi

say "Build and start (first build ≈ 5–10 min)"
sudo docker compose build api worker executor web
sudo docker compose up -d
sleep 20; sudo docker compose ps
PORT=$(echo "$CADDY_HTTP" | cut -d: -f2)
curl -fsS "http://localhost:$PORT/healthz" && echo

if [ "$MODE" = nginx ]; then
  say "Port 80 is used by nginx — add this server block, then run certbot"
  cat <<NGX
sudo tee /etc/nginx/sites-available/familyoffice >/dev/null <<'EOT'
server {
    listen 80; listen [::]:80;
    server_name ${DOMAIN:-YOUR.DOMAIN};
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOT
sudo ln -sf /etc/nginx/sites-available/familyoffice /etc/nginx/sites-enabled/familyoffice
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx --expand -d ${DOMAIN:-YOUR.DOMAIN} --redirect -m $EMAIL --agree-tos -n
NGX
else
  echo; echo "Open ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$(curl -fsS -4 ifconfig.me)}"
fi
[ "$SEED" = true ] && echo "Demo login: arjun@example.com / Prototype!2026" || echo "Create the first owner: cd deploy && sudo docker compose exec api node dist/cli.js create-owner --email you@example.in --name 'Your Name' --family 'Your Family'"
echo "Logs: cd $ROOT/deploy && sudo docker compose logs -f api"
