#!/bin/sh
# Pull new images, run migrations, restart with zero data loss. Run from the deploy/ directory.
set -e
docker compose pull
docker compose --profile ops run --rm migrate
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps
