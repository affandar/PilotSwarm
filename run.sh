#!/bin/bash
# Run durable-copilot-sdk TUI
#
# Usage:
#   ./run.sh              # local mode — 4 workers inside TUI, remote PG
#   ./run.sh local        # same as above
#   ./run.sh local --db   # local mode — 4 workers inside TUI, local PG
#   ./run.sh remote       # remote mode — AKS workers, TUI client-only, remote PG
#
# Prerequisites:
#   - .env.remote with DATABASE_URL + GITHUB_TOKEN (remote PG)
#   - .env with DATABASE_URL + GITHUB_TOKEN (local PG, for --db flag)

set -euo pipefail
cd "$(dirname "$0")"

# Ensure .env exists (for local DB mode)
if [ ! -f .env ]; then
    echo "Creating .env with fresh GitHub token..."
    cat > .env <<EOF
GITHUB_TOKEN=$(gh auth token)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/durable_copilot
EOF
    echo "✅ .env created"
fi

# Refresh GitHub token in both env files
if command -v gh &>/dev/null; then
    FRESH_TOKEN=$(gh auth token 2>/dev/null || true)
    if [ -n "$FRESH_TOKEN" ]; then
        sed -i '' "s|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$FRESH_TOKEN|" .env
        [ -f .env.remote ] && sed -i '' "s|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$FRESH_TOKEN|" .env.remote
    fi
fi

# Ensure dependencies are up to date
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build TypeScript if needed
if [ ! -d dist ] || [ "$(find src -newer dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then
    echo "🔨 Building TypeScript..."
    npm run build
fi

MODE="${1:-local}"

case "$MODE" in
    local)
        ENV_FILE=".env.remote"
        if [[ "${2:-}" == "--db" ]]; then
            ENV_FILE=".env"
            echo "🚀 Starting TUI — local worker, local PG (Ctrl+C to quit)"
        else
            echo "🚀 Starting TUI — local worker, remote PG (Ctrl+C to quit)"
        fi
        node --env-file="$ENV_FILE" examples/tui.js
        ;;
    remote|scaled)
        echo "🚀 Starting TUI — AKS workers, client-only (Ctrl+C to quit)"
        node --env-file=.env.remote examples/tui.js --mode scaled
        ;;
    *)
        echo "Usage: $0 [local|remote] [--db]"
        echo ""
        echo "  local        Local worker + TUI, remote PG (default)"
        echo "  local --db   Local worker + TUI, local PG"
        echo "  remote       AKS workers, TUI client-only, remote PG"
        exit 1
        ;;
esac