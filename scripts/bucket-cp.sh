#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <src> <dst>" >&2
  echo "Examples:" >&2
  echo "  $0 ./file.xlsx gs://shared-parts-bucket/path/file.xlsx" >&2
  echo "  $0 gs://shared-parts-bucket/path/file.xlsx ./file.xlsx" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_load-local-env.sh"

SRC="$1"
DST="$2"

ROOT_DIR="$ROOT_DIR" SRC="$SRC" DST="$DST" node <<'NODE'
const fs = require('fs')
const path = require('path')
const { Storage } = require('@google-cloud/storage')

const src = process.env.SRC
const dst = process.env.DST

const parseGsPath = (value) => {
  if (!value.startsWith('gs://')) return null
  const rest = value.slice(5)
  const slash = rest.indexOf('/')
  if (slash === -1) return { bucket: rest, object: '' }
  return {
    bucket: rest.slice(0, slash),
    object: rest.slice(slash + 1),
  }
}

async function main() {
  const storage = new Storage()
  const srcGs = parseGsPath(src)
  const dstGs = parseGsPath(dst)

  if (!!srcGs === !!dstGs) {
    throw new Error('Exactly one path must be gs://...')
  }

  if (srcGs) {
    if (!srcGs.object) throw new Error('Source gs:// path must include object name')
    await storage.bucket(srcGs.bucket).file(srcGs.object).download({ destination: dst })
    console.log(`Downloaded ${src} -> ${path.resolve(dst)}`)
    return
  }

  if (!dstGs || !dstGs.object) throw new Error('Destination gs:// path must include object name')
  await storage.bucket(dstGs.bucket).upload(src, { destination: dstGs.object })
  console.log(`Uploaded ${path.resolve(src)} -> ${dst}`)
}

main().catch((err) => {
  console.error(err?.message || err)
  process.exit(1)
})
NODE
