#!/bin/sh
# Nightly: pg_dump + MinIO documents → local volume → rclone to offsite. Retention by BACKUP_RETAIN_DAYS.
set -e
STAMP=$(date +%Y%m%d-%H%M)
DIR=/backups/$STAMP; mkdir -p "$DIR"
pg_dump -h postgres -U postgres -d familyoffice -Fc -f "$DIR/familyoffice.dump"
tar -czf "$DIR/documents.tgz" -C /minio . 2>/dev/null || true
if [ -n "$RCLONE_REMOTE" ]; then
  rclone copy "$DIR" "$RCLONE_REMOTE/$STAMP" --quiet
  rclone delete "$RCLONE_REMOTE" --min-age "${BACKUP_RETAIN_DAYS:-35}d" --quiet || true
fi
find /backups -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
echo "backup $STAMP done"
