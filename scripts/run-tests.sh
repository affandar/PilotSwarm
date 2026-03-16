#!/bin/bash
# Run the full PilotSwarm local integration test suite using vitest.
#
# Usage:
#   ./scripts/test-local.sh                  # run all suites in parallel (default)
#   ./scripts/test-local.sh --suite=smoke    # run only matching suite(s)
#   ./scripts/test-local.sh --sequential     # run suites one at a time
#
# Prerequisites:
#   - PostgreSQL running with DATABASE_URL in .env
#   - GITHUB_TOKEN in .env (for Copilot SDK)

set -euo pipefail
cd "$(dirname "$0")/.."

SDK_DIR="packages/sdk"
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Create it with DATABASE_URL and GITHUB_TOKEN."
    exit 1
fi

# Build
echo "🔨 Building TypeScript..."
(cd "$SDK_DIR" && npm run build) || { echo "❌ Build failed"; exit 1; }

# Suppress duroxide Rust WARN logs in tests (AKS workers use INFO via their own env)
export RUST_LOG="${RUST_LOG:-error}"

# Load .env for vitest (vitest doesn't have --env-file)
set -a; source "$ENV_FILE"; set +a

# Build vitest args
VITEST_ARGS=(--run)
for arg in "$@"; do
    case "$arg" in
        --suite=*) VITEST_ARGS+=(--testPathPattern "${arg#--suite=}") ;;
        --sequential) VITEST_ARGS+=(--fileParallelism=false) ;;
    esac
done

# Run
cd "$SDK_DIR"
exec npx vitest "${VITEST_ARGS[@]}"
