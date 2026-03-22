#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_load-local-env.sh"

PREFIX="${1:-}"

ROOT_DIR="$ROOT_DIR" PREFIX="$PREFIX" node <<'NODE'
const { Storage } = require('@google-cloud/storage')

const bucketName = process.env.GCS_DOCS_BUCKET
const prefix = process.env.PREFIX || ''

if (!bucketName) {
  console.error('GCS_DOCS_BUCKET is not set in .env.local')
  process.exit(1)
}

async function main() {
  const storage = new Storage()
  const [files] = await storage.bucket(bucketName).getFiles({ prefix })
  for (const file of files) {
    console.log(`gs://${bucketName}/${file.name}`)
  }
}

main().catch((err) => {
  console.error(err?.message || err)
  process.exit(1)
})
NODE
