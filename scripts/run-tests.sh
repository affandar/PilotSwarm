#!/bin/bash
# Run the full PilotSwarm local integration test suite using vitest.
#
# Usage:
#   ./scripts/test-local.sh                  # run all suites in parallel (default)
#   ./scripts/test-local.sh --parallel       # run suites in parallel explicitly
#   ./scripts/test-local.sh --suite=smoke    # run only matching suite(s)
#   ./scripts/test-local.sh --sequential     # force suites one at a time
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

# Build vitest args.
# Default mode runs with Vitest's normal parallelism. Use --sequential for a
# deterministic one-at-a-time run when debugging contention or backend capacity issues.
VITEST_ARGS=(--run)
SUITE_FILTERS=()
for arg in "$@"; do
    case "$arg" in
        --suite=*) SUITE_FILTERS+=("${arg#--suite=}") ;;
        --sequential)
            VITEST_ARGS=(--run --no-file-parallelism --maxConcurrency=1)
            ;;
        --parallel)
            VITEST_ARGS=(--run)
            ;;
    esac
done

# Run
cd "$SDK_DIR"
TARGET_FILES=()
if [ ${#SUITE_FILTERS[@]} -gt 0 ]; then
    for filter in "${SUITE_FILTERS[@]}"; do
        while IFS= read -r file; do
            TARGET_FILES+=("$file")
        done < <(find test/local -type f -name "*${filter}*.test.js" | sort)
    done

    if [ ${#TARGET_FILES[@]} -eq 0 ]; then
        echo "ERROR: no test files matched suite filter(s): ${SUITE_FILTERS[*]}"
        exit 1
    fi
fi

if [ ${#TARGET_FILES[@]} -gt 0 ]; then
    exec npx vitest "${VITEST_ARGS[@]}" "${TARGET_FILES[@]}"
else
    exec npx vitest "${VITEST_ARGS[@]}"
fi
