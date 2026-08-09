#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_root="$(cd "${script_dir}/.." && pwd)"
frontend_root="$(cd "${backend_root}/../crusher-parts-frontend" && pwd)"

backend_pid=""
frontend_pid=""

cleanup() {
  if [ -n "${frontend_pid}" ] && kill -0 "${frontend_pid}" 2>/dev/null; then
    kill "${frontend_pid}" 2>/dev/null || true
    wait "${frontend_pid}" 2>/dev/null || true
  fi
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

(
  cd "$backend_root"
  npm run start:local
) &
backend_pid=$!

(
  cd "$frontend_root"
  npm run dev -- --host
) &
frontend_pid=$!

while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$backend_pid" 2>/dev/null; then
  wait "$backend_pid"
else
  wait "$frontend_pid"
fi
