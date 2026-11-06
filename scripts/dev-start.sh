#!/usr/bin/env bash
# Starts the proxy in the background (used by the devcontainer's postStartCommand).
# Safe to run more than once: it does nothing if the proxy already answers.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"

if curl -fsS "http://127.0.0.1:${PORT}/__health" >/dev/null 2>&1; then
  echo "[dev-start] Proxy already running on port ${PORT}."
  exit 0
fi

nohup node server.js >>/tmp/proxy.log 2>&1 &
echo "[dev-start] Proxy started on port ${PORT} (log: /tmp/proxy.log)."
