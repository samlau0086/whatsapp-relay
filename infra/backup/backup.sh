#!/bin/sh
set -eu
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p /backup/postgres /backup/minio
pg_dump --format=custom --no-owner "$DATABASE_URL" > "/backup/postgres/relay-$stamp.dump"
mc alias set relay "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc mirror --overwrite "relay/$S3_BUCKET" "/backup/minio/$stamp"
find /backup/postgres -type f -mtime +30 -delete
find /backup/minio -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;
