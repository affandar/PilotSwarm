#!/bin/bash
# Stop the PilotSwarm web portal started by portal-start.sh.

set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE=".portal.pids"
PORT="${PORT:-3001}"

# Sweep anything still holding the port, whatever started it.
#
# This used to run ONLY when the PID file was missing. With a PID file present
# the script killed those PIDs and returned, leaving an instance started by any
# other path (a bare `node web/server.js`, an earlier crashed run) still bound
# to the port. portal-start.sh would then probe that survivor, see a healthy
# response, and report "ready" for a server it did not start — handing you a
# stale build with no indication anything was wrong.
sweep_port() {
  local held
  held="$(lsof -ti:"$PORT" 2>/dev/null || true)"
  [ -z "$held" ] && return 0
  echo "  Sweeping port $PORT (pids: $(echo "$held" | tr '\n' ' '))"
  echo "$held" | xargs kill 2>/dev/null || true
  sleep 1
  held="$(lsof -ti:"$PORT" 2>/dev/null || true)"
  [ -z "$held" ] && return 0
  echo "$held" | xargs kill -9 2>/dev/null || true
}

if [ ! -f "$PIDFILE" ]; then
  echo "[portal] No $PIDFILE — sweeping port $PORT for orphans"
  sweep_port
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
# Catch anything the PID file did not know about.
sweep_port
echo "[portal] Stopped"
