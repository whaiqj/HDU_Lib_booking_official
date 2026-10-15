#!/bin/sh
set -eu
release_dir=/root/library-seat-releases/20261013-frequency-guard
project_dir=/root/workspace/HDU_libseat_server

cp "$release_dir/grab-seat-worker.before.ts" "$project_dir/src/modules/grab-seat/grab-seat-worker.service.ts"
cp "$release_dir/seat-preparse.before.ts" "$project_dir/src/modules/grab-seat/seat-preparse.service.ts"
docker tag hdu_libseat_server-backend:rollback-frequency-20261013 hdu_libseat_server-backend:latest
cd "$project_dir"
docker compose up -d --no-deps --no-build --force-recreate backend
