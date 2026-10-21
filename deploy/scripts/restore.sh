#!/bin/sh
# Restore from a backup directory (local or fetched via rclone). Usage: ./restore.sh /backups/20260911-0200
set -e
DIR=$1
docker compose stop api worker
docker compose exec -T postgres pg_restore -U postgres -d familyoffice --clean --if-exists < "$DIR/familyoffice.dump"
docker compose run --rm -v "$DIR":/restore minio sh -c "tar -xzf /restore/documents.tgz -C /data"
docker compose start api worker
