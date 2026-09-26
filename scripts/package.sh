#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -d web/node_modules ]]; then
  (cd web && npm ci)
fi
(cd web && npm run build)
mkdir -p backend/src/main/resources/static
# Only this ignored build-output directory is replaced.
find backend/src/main/resources/static -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R web/dist/. backend/src/main/resources/static/
(cd backend && ./mvnw -B -ntp "-Dfsapp.buildDirectory=${FSAPP_BUILD_DIR:-$PWD/target}" clean verify)
