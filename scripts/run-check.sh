#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
LOCK_DIR="$REPO_DIR/.cron-lock"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
  printf '[%s] node was not found on PATH.\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$LOG_DIR/cron.log"
  exit 1
fi

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf '[%s] Skipping run because a previous run is still active.\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$LOG_DIR/cron.log"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR"
}

trap cleanup EXIT

cd "$REPO_DIR" || exit 1

printf '\n[%s] Starting check.\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$LOG_DIR/cron.log"
"$NODE_BIN" "$REPO_DIR/src/index.js" >> "$LOG_DIR/cron.log" 2>&1
