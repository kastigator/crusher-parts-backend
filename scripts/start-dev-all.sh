#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="/Users/aleksandrlubimov/project/crusher-parts-backend"
FRONTEND_ROOT="/Users/aleksandrlubimov/project/crusher-parts-frontend"

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
  cd "$BACKEND_ROOT"
  npm run start:local
) &
backend_pid=$!

(
  cd "$FRONTEND_ROOT"
  npm run dev -- --host
) &
frontend_pid=$!

wait -n "$backend_pid" "$frontend_pid"
