#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo ".env.local not found: $ENV_FILE" >&2
  exit 1
fi

while IFS=$'\t' read -r key value_b64; do
  [ -n "$key" ] || continue
  value="$(printf '%s' "$value_b64" | base64 --decode)"
  export "$key=$value"
done < <(
  ROOT_DIR="$ROOT_DIR" ENV_FILE="$ENV_FILE" node <<'NODE'
const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const rootDir = process.env.ROOT_DIR
const envFile = process.env.ENV_FILE
const parsed = dotenv.parse(fs.readFileSync(envFile))

for (const [key, rawValue] of Object.entries(parsed)) {
  let value = String(rawValue ?? '')
  if (key === 'GOOGLE_APPLICATION_CREDENTIALS' && value && !path.isAbsolute(value)) {
    value = path.resolve(rootDir, value)
  }
  process.stdout.write(`${key}\t${Buffer.from(value, 'utf8').toString('base64')}\n`)
}
NODE
)

export ROOT_DIR
