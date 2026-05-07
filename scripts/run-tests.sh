#!/bin/bash
# Run the full PilotSwarm local integration test suite using vitest.
#
# Usage:
#   ./scripts/test-local.sh                  # run all suites in parallel (default)
#   ./scripts/test-local.sh --parallel       # run suites in parallel explicitly
#   ./scripts/test-local.sh --suite=smoke    # run only matching suite(s)
#   ./scripts/test-local.sh smoke            # same as --suite=smoke
#   ./scripts/test-local.sh --sequential     # force suites one at a time
#
# Prerequisites:
#   - PostgreSQL running with DATABASE_URL in .env
#   - GITHUB_TOKEN in .env (for Copilot SDK)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SDK_DIR="packages/sdk"
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Create it with DATABASE_URL and GITHUB_TOKEN."
    exit 1
fi

print_help() {
        cat <<'EOF'
Usage:
    ./scripts/run-tests.sh                    Run all suites in parallel (default)
    ./scripts/run-tests.sh --parallel         Run all suites in parallel explicitly
    ./scripts/run-tests.sh --sequential       Run all suites sequentially
    ./scripts/run-tests.sh --suite=<name>     Run matching suite(s)
    ./scripts/run-tests.sh <name>             Same as --suite=<name>
    ./scripts/run-tests.sh <name1> <name2>    Run multiple matching suites
    ./scripts/run-tests.sh --help
    ./scripts/run-tests.sh -h

Examples:
    ./scripts/run-tests.sh smoke
    ./scripts/run-tests.sh wait-affinity
    ./scripts/run-tests.sh session-policy
    ./scripts/run-tests.sh sub-agents reliability
    ./scripts/run-tests.sh --suite=contracts --suite=durability --sequential

Notes:
    - Positional suite names and --suite=<name> can be mixed.
    - Suite names are substring matches against files under packages/sdk/test/local.
    - Unknown options fail fast.
    - A full run (no suite filter) also runs the deploy-scripts tests
      (node --test against deploy/scripts/test/*.test.mjs) and the
      mcp-server unit tests (node) before the SDK suites. Set
      SKIP_DEPLOY_SCRIPTS_TESTS=1 or SKIP_MCP_SERVER_TESTS=1 to skip.
      The mcp-server LIVE integration suite is opt-in via
      `npm run test:mcp-server:integration` (or :all).
EOF
}

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            print_help
            exit 0
            ;;
    esac
done

# Build
echo "🔨 Building TypeScript..."
(cd "$SDK_DIR" && npm run build) || { echo "❌ Build failed"; exit 1; }

# Build mcp-server (its tests import from packages/mcp-server/dist/...).
# Cheap incremental tsc — only rebuilds when sources changed.
(cd "$REPO_ROOT/packages/mcp-server" && npm run build) \
    || { echo "❌ mcp-server build failed"; exit 1; }

# Run the deploy-scripts test suite (Node `node --test`, not vitest) when
# no SDK suite filter is in effect. The deploy orchestrator's helpers
# live under deploy/scripts/test/*.test.mjs and are wired through the
# top-level "test:deploy-scripts" npm script. Per repo convention every
# test file must be runnable from this entrypoint, so we always run them
# as part of a full local test pass. If any --suite=<name> or positional
# suite filter is supplied, we are scoping to specific SDK suites and
# skip this stage so iteration loops stay fast.
run_deploy_scripts_tests() {
    if [ "${SKIP_DEPLOY_SCRIPTS_TESTS:-0}" = "1" ]; then
        echo "⏭  Skipping deploy-scripts tests (SKIP_DEPLOY_SCRIPTS_TESTS=1)."
        return 0
    fi
    echo "🧪 Running deploy-scripts tests (node --test)..."
    (cd "$REPO_ROOT" && npm run --silent test:deploy-scripts) \
        || { echo "❌ deploy-scripts tests failed"; exit 1; }
}

# Run the mcp-server unit suite when no SDK suite filter is in effect.
# The mcp-server has a small pure-mock unit test (no DB, no Copilot) plus
# LIVE integration smokes that are opt-in via test:mcp-server:integration.
# Mirrors the deploy-scripts pattern. Set SKIP_MCP_SERVER_TESTS=1 to skip.
run_mcp_server_tests() {
    if [ "${SKIP_MCP_SERVER_TESTS:-0}" = "1" ]; then
        echo "⏭  Skipping mcp-server tests (SKIP_MCP_SERVER_TESTS=1)."
        return 0
    fi
    echo "🧪 Running mcp-server unit tests (node)..."
    (cd "$REPO_ROOT" && npm run --silent test:mcp-server) \
        || { echo "❌ mcp-server tests failed"; exit 1; }
}

# Suppress duroxide Rust WARN logs in tests (AKS workers use INFO via their own env)
export RUST_LOG="${RUST_LOG:-error}"

# Load .env for vitest (vitest doesn't have --env-file)
set -a; source "$ENV_FILE"; set +a

cleanup_test_state() {
    echo "🧹 Cleaning stale local test state..."
    node "$REPO_ROOT/scripts/cleanup-test-schemas.js"
}

cleanup_test_state
trap cleanup_test_state EXIT

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
        --*)
            echo "ERROR: unknown option: $arg"
            exit 1
            ;;
        *)
            SUITE_FILTERS+=("$arg")
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
    run_deploy_scripts_tests
    run_mcp_server_tests
    exec npx vitest "${VITEST_ARGS[@]}"
fi
