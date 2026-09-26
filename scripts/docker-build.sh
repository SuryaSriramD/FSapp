#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Stream only build inputs. This also avoids Docker xattr errors on macOS ExFAT.
fsapp_tar_options=()
if [[ "$(uname -s)" == Darwin ]]; then
  fsapp_tar_options+=(--no-xattrs --disable-copyfile)
fi
COPYFILE_DISABLE=1 tar -c "${fsapp_tar_options[@]}" \
  --exclude '._*' --exclude node_modules --exclude target --exclude dist \
  --exclude test-results --exclude playwright-report --exclude static \
  -f - Dockerfile .dockerignore web backend | docker build -t "${1:-fsapp:local}" -
