#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_load-local-env.sh"

exec mysql \
  -h "${DB_HOST:?DB_HOST is required}" \
  -P "${DB_PORT:-3306}" \
  -u "${DB_USER:?DB_USER is required}" \
  -p"${DB_PASSWORD:?DB_PASSWORD is required}" \
  "${DB_NAME:?DB_NAME is required}"
