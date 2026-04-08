#!/bin/bash
# Run the PilotSwarm TUI
#
# Usage:
#   ./run.sh              # local mode — 4 workers inside the TUI, remote PG
#   ./run.sh local        # same as above
#   ./run.sh local --db   # local mode — 4 workers inside TUI, local PG
#   ./run.sh remote       # remote mode — AKS workers, TUI client-only, remote PG
#
# Prerequisites:
#   - .env.remote with DATABASE_URL + GITHUB_TOKEN (remote PG)
#   - .env with DATABASE_URL + GITHUB_TOKEN (local PG, for --db flag)

set -euo pipefail
cd "$(dirname "$0")"

upsert_env_var() {
    local file="$1"
    local key="$2"
    local value="$3"

    [ -f "$file" ] || return 0

    if grep -Eq "^[[:space:]]*${key}=" "$file"; then
        sed -i '' "s|^[[:space:]]*${key}=.*|${key}=${value}|" "$file"
    else
        printf "\n%s=%s\n" "$key" "$value" >> "$file"
    fi
}

# Ensure .env exists (for local DB mode)
if [ ! -f .env ]; then
    echo "Creating .env with fresh GitHub token..."
    cat > .env <<EOF
GITHUB_TOKEN=$(gh auth token)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm
EOF
    echo "✅ .env created"
fi

# Refresh GitHub token in both env files
if command -v gh &>/dev/null; then
    FRESH_TOKEN=$(gh auth token 2>/dev/null || true)
    if [ -n "$FRESH_TOKEN" ]; then
        upsert_env_var .env GITHUB_TOKEN "$FRESH_TOKEN"
        upsert_env_var .env.remote GITHUB_TOKEN "$FRESH_TOKEN"
    fi
fi

# Ensure dependencies are up to date
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build TypeScript if needed
if [ ! -d packages/sdk/dist ] || [ "$(find packages/sdk/src -newer packages/sdk/dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then
    echo "🔨 Building TypeScript..."
    npm run build
fi

MODE="${1:-local}"

# Local runs use a project-local tmp dir for Copilot session state
# so PilotSwarm does not touch the user's real ~/.copilot sessions.
LOCAL_TMP="$(pwd)/.tmp"
export SESSION_STATE_DIR="${LOCAL_TMP}/session-state"
export SESSION_STORE_DIR="${LOCAL_TMP}/session-store"
export ARTIFACT_DIR="${LOCAL_TMP}/artifacts"
export PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS="${PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS:-1000}"
export NODE_ENV="${NODE_ENV:-production}"

case "$MODE" in
    local)
        if [[ "${2:-}" == "--db" ]]; then
            echo "🚀 Starting TUI — 4 local workers, local PG (Ctrl+C to quit)"
            exec node --max-old-space-size=512 packages/cli/bin/tui.js local --env .env
        else
            echo "🚀 Starting TUI — 4 local workers, remote PG (Ctrl+C to quit)"
            exec node --max-old-space-size=2048 packages/cli/bin/tui.js local --env .env.remote
        fi
        ;;
    remote|scaled)
        echo "🚀 Starting TUI — AKS workers, client-only (Ctrl+C to quit)"
        exec node --max-old-space-size=512 packages/cli/bin/tui.js remote --env .env.remote
        ;;
    *)
        echo "Usage: $0 [local|remote] [--db]"
        exit 1
        ;;
esac
