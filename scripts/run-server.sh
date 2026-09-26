#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for fsapp_jar in "${FSAPP_BUILD_DIR:-$PWD/backend/target}"/*.jar; do
  if [[ -f "$fsapp_jar" ]]; then
    exec java -jar "$fsapp_jar"
  fi
done
echo 'No packaged server found. Run ./scripts/package.sh first.' >&2
exit 1
