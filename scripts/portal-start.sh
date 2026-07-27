#!/bin/bash
# Start the PilotSwarm browser-native web portal.
#
# Usage:
#   ./scripts/portal-start.sh                  # local — embedded workers, LOCAL PG (default)
#   ./scripts/portal-start.sh local            # same as above
#   ./scripts/portal-start.sh local --remote-db  # local workers, shared Azure PG
#   ./scripts/portal-start.sh remote           # remote mode — AKS workers, shared Azure PG
#   ./scripts/portal-start.sh --plugin ./plugin
#   ./scripts/portal-start.sh --port 3001  # custom port
#   ./scripts/portal-start.sh --no-auth    # LOCAL DEV ONLY: no sign-in, admin role
#
# Equivalent to ./run.sh but serves the shared browser workspace.
#
# Stop with: ./scripts/portal-stop.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE=".portal.pids"
PORT=3001
MODE="local"
USE_REMOTE_DB=false
PLUGIN_DIR=""
NO_AUTH=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    local)   MODE="local"; shift ;;
    remote)  MODE="remote"; shift ;;
    --db)    shift ;;   # kept as a no-op: local PG is now the default
    --remote-db) USE_REMOTE_DB=true; shift ;;
    --port)  PORT="$2"; shift 2 ;;
    --plugin) PLUGIN_DIR="$2"; shift 2 ;;
    --no-auth) NO_AUTH=true; shift ;;
    *)       echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Select env file.
#
# NOTE: this deliberately DIVERGES from run.sh, which still treats plain
# `local` as "local workers, shared Azure PG". Two independent axes were being
# selected by one word: `local` meant local WORKERS, while the database stayed
# remote unless you also passed --db. The result was a portal that looked local
# but silently required VPN access to shared fleet data.
#
# For the portal, `local` now means local end to end. Reach for the shared
# database explicitly with --remote-db.
if [[ "$MODE" == "local" && "$USE_REMOTE_DB" == "false" ]]; then
    ENV_FILE=".env"
else
    ENV_FILE=".env.remote"
fi

# Determine TUI mode
TUI_MODE="$MODE"

# Validate env
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Copy .env.example to $ENV_FILE and configure it."
  exit 1
fi

# Kill any previous instances. Runs even without a PID file: an instance
# started outside this script still holds the port, and the readiness probe
# below cannot tell that server apart from the one we are about to start.
if [ -f "$PIDFILE" ] || lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "[portal] Stopping previous instance / clearing port $PORT..."
  PORT="$PORT" ./scripts/portal-stop.sh 2>/dev/null || true
fi

# Local-dev auth bypass. Both are required: the `none` provider skips sign-in,
# but authz is secure-by-default (PORTAL_AUTHZ_DEFAULT_ROLE unset => deny), so
# without a default role every request would still be refused.
#
# These are exported into the environment rather than written to the env file:
# node --env-file does NOT override variables already set in the environment,
# so the ambient value wins over .env.remote's PORTAL_AUTH_PROVIDER, and the
# env file is never modified.
if [[ "$NO_AUTH" == "true" ]]; then
  export PORTAL_AUTH_PROVIDER=none
  export PORTAL_AUTHZ_DEFAULT_ROLE=admin
  export PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true
fi

echo "[portal] Starting server (port $PORT, mode $TUI_MODE)..."
echo "[portal] Building browser app..."
npm run build:web --workspace=pilotswarm >/tmp/portal-build.log 2>&1
if [[ -n "$PLUGIN_DIR" ]]; then
  export PLUGIN_DIRS="$(cd "$PLUGIN_DIR" && pwd)"
fi
PORTAL_ENV_FILE="$ENV_FILE" PORTAL_TUI_MODE="$TUI_MODE" node --env-file="$ENV_FILE" packages/app/web/server.js > /tmp/portal-server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# Wait for server to be ready
echo -n "[portal] Waiting for server..."
for i in $(seq 1 30); do
  # Health alone is not proof: a survivor from an earlier run answers it too.
  # Require the port to be held by the process WE started, so a stale server
  # can never be reported as ready.
  if curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1 \
     && lsof -ti:"$PORT" 2>/dev/null | grep -qx "$SERVER_PID"; then
    echo " ready"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo " FAILED"
    echo "[portal] Server crashed. Logs:"
    tail -20 /tmp/portal-server.log
    rm -f "$PIDFILE"
    exit 1
  fi
  sleep 1
  echo -n "."
done

echo ""
echo "══════════════════════════════════════════════════════"
echo "  PilotSwarm Web Portal"
echo "  URL:  http://localhost:$PORT"
echo "  PID:  $SERVER_PID"
echo "  Mode: $TUI_MODE"
echo "  Env:  $ENV_FILE"
if [[ "$NO_AUTH" == "true" ]]; then
  echo ""
  echo "  AUTH: DISABLED — every visitor is admin, no sign-in."
  if [[ "$ENV_FILE" == ".env.remote" ]]; then
    echo "        The server listens on ALL interfaces and $ENV_FILE points at"
    echo "        the SHARED database. Anyone who can reach port $PORT on this"
    echo "        machine has admin over real fleet data. Local dev only."
  else
    echo "        Scoped to the local database in $ENV_FILE, so no shared data"
    echo "        is exposed — but the server does listen on all interfaces."
  fi
fi
if [[ -n "${PLUGIN_DIRS:-}" ]]; then
  echo "  Plugin: $PLUGIN_DIRS"
fi
echo ""
echo "  Browser-native workspace is served from packages/app/web/dist."
echo ""
echo "  Stop: ./scripts/portal-stop.sh"
echo "  Logs: tail -f /tmp/portal-server.log"
echo "══════════════════════════════════════════════════════"
