#!/bin/bash
# Stop the PilotSwarm web portal started by portal-start.sh.

set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE=".portal.pids"

if [ ! -f "$PIDFILE" ]; then
  echo "[portal] No running portal found (no $PIDFILE)"
  # Fallback: kill by port
  lsof -ti:3001 2>/dev/null | xargs kill 2>/dev/null || true
  exit 0
fi

echo "[portal] Stopping portal..."
while IFS= read -r pid; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "  Stopping PID $pid"
    kill "$pid" 2>/dev/null || true
  fi
done < "$PIDFILE"

sleep 1

# Force kill if still alive
while IFS= read -r pid; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "  Force killing PID $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
done < "$PIDFILE"

rm -f "$PIDFILE"
echo "[portal] Stopped"
