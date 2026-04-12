#!/usr/bin/env bash

set -euo pipefail

DATABASE_URL=${DATABASE_URL:-}
if [[ -z "${DATABASE_URL}" ]]; then
    echo "[starter] DATABASE_URL is not set." >&2
    exit 1
fi

timeout_seconds=${PILOTSWARM_DB_WAIT_SECONDS:-90}
deadline=$((SECONDS + timeout_seconds))

until pg_isready -d "${DATABASE_URL}" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
        echo "[starter] Timed out waiting for PostgreSQL after ${timeout_seconds}s." >&2
        exit 1
    fi
    sleep 1
done
