#!/bin/bash
# Start the PilotSwarm browser-native web portal.
#
# Usage:
#   ./scripts/portal-start.sh              # local mode — embedded workers, remote PG (default)
#   ./scripts/portal-start.sh local        # same as above
#   ./scripts/portal-start.sh local --db   # local mode — embedded workers, local PG
#   ./scripts/portal-start.sh remote       # remote mode — AKS workers, client-only
#   ./scripts/portal-start.sh --port 3001  # custom port
#
# Equivalent to ./run.sh but serves the shared browser workspace.
#
# Stop with: ./scripts/portal-stop.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE=".portal.pids"
PORT=3001
MODE="local"
USE_LOCAL_DB=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    local)   MODE="local"; shift ;;
    remote)  MODE="remote"; shift ;;
    --db)    USE_LOCAL_DB=true; shift ;;
    --port)  PORT="$2"; shift 2 ;;
    *)       echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Select env file based on mode (same logic as run.sh)
if [[ "$MODE" == "local" && "$USE_LOCAL_DB" == "true" ]]; then
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

# Kill any previous instances
if [ -f "$PIDFILE" ]; then
  echo "[portal] Stopping previous instance..."
  ./scripts/portal-stop.sh 2>/dev/null || true
fi

echo "[portal] Starting server (port $PORT, mode $TUI_MODE)..."
echo "[portal] Building browser app..."
npm run build --workspace=packages/portal >/tmp/portal-build.log 2>&1
PORTAL_ENV_FILE="$ENV_FILE" PORTAL_TUI_MODE="$TUI_MODE" node --env-file="$ENV_FILE" packages/portal/server.js > /tmp/portal-server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# Wait for server to be ready
echo -n "[portal] Waiting for server..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
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
echo ""
echo "  Browser-native workspace is served from packages/portal/dist."
echo ""
echo "  Stop: ./scripts/portal-stop.sh"
echo "  Logs: tail -f /tmp/portal-server.log"
echo "══════════════════════════════════════════════════════"
