#!/bin/bash
# Run durable-copilot-sdk locally
#
# Usage:
#   ./run.sh              # TUI mode — local runtime + local DB
#   ./run.sh chat         # Simple console chat
#   ./run.sh remote       # TUI mode — local runtime + remote DB
#   ./run.sh scaled       # TUI mode — client-only, AKS workers execute
#
# Prerequisites:
#   - Docker container 'duroxide-pg' running on localhost:5432
#   - GITHUB_TOKEN set in .env (or run: gh auth token)

set -euo pipefail
cd "$(dirname "$0")"

# Ensure .env exists
if [ ! -f .env ]; then
    echo "Creating .env with fresh GitHub token..."
    cat > .env <<EOF
GITHUB_TOKEN=$(gh auth token)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/durable_copilot
EOF
    echo "✅ .env created"
fi

# Refresh GitHub token (they expire)
if command -v gh &>/dev/null; then
    FRESH_TOKEN=$(gh auth token 2>/dev/null || true)
    if [ -n "$FRESH_TOKEN" ]; then
        sed -i '' "s|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$FRESH_TOKEN|" .env
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

MODE="${1:-tui}"

case "$MODE" in
    tui)
        echo "🚀 Starting TUI chat — local runtime (Ctrl+C to quit, Tab to switch panes)"
        node --env-file=.env examples/tui.js
        ;;
    chat)
        echo "🚀 Starting console chat (type 'exit' to quit)"
        node --env-file=.env examples/chat.js
        ;;
    scaled)
        echo "🚀 Starting TUI chat — scaled mode, AKS workers (Ctrl+C to quit)"
        node --env-file=.env.remote examples/tui.js scaled
        ;;
    remote)
        echo "🚀 Starting TUI chat — local runtime, remote DB (Ctrl+C to quit)"
        node --env-file=.env.remote examples/tui.js
        ;;
    *)
        echo "Usage: $0 [tui|chat|scaled|remote]"
        exit 1
        ;;
esac
