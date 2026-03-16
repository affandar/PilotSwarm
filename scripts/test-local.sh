#!/bin/bash
# Run the full PilotSwarm local integration test suite.
#
# Runs all test levels sequentially and reports a final summary.
# Exits with code 1 if any suite fails.
#
# Usage:
#   ./scripts/test-local.sh                  # run all suites
#   ./scripts/test-local.sh --suite=smoke    # run only matching suite(s)
#   ./scripts/test-local.sh --parallel       # run all suites in parallel (faster, noisier)
#
# Prerequisites:
#   - PostgreSQL running with DATABASE_URL in .env
#   - GITHUB_TOKEN in .env (for Copilot SDK)
#   - npm run build completed (TypeScript compiled)

set -euo pipefail
cd "$(dirname "$0")/.."

# ─── Configuration ────────────────────────────────────────────────

SDK_DIR="packages/sdk"
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Create it with DATABASE_URL and GITHUB_TOKEN."
    exit 1
fi

# Test suites in execution order (levels 1-9 + system agents)
SUITES=(
    "smoke"
    "durability"
    "multi-worker"
    "commands"
    "sub-agents"
    "kv-transport"
    "cms-consistency"
    "contracts"
    "chaos"
    "system-agents"
)

# Parse flags
PARALLEL=false
SUITE_FILTER=""
for arg in "$@"; do
    case "$arg" in
        --parallel) PARALLEL=true ;;
        --suite=*) SUITE_FILTER="${arg#--suite=}" ;;
    esac
done

# ─── Build ────────────────────────────────────────────────────────

echo "🔨 Building TypeScript..."
(cd "$SDK_DIR" && npm run build) || { echo "❌ Build failed"; exit 1; }
echo ""

# ─── Run suites ──────────────────────────────────────────────────

TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS=()

run_suite() {
    local suite="$1"
    local test_file="$SDK_DIR/test/local/${suite}.test.js"

    if [ ! -f "$test_file" ]; then
        echo "⚠️  Suite not found: $test_file"
        return 1
    fi

    local log="/tmp/pilotswarm-test-${suite}.log"
    (cd "$SDK_DIR" && node --env-file=../../"$ENV_FILE" "test/local/${suite}.test.js") > "$log" 2>&1
    local exit_code=$?

    # Extract summary line
    local summary
    summary=$(grep -E "passed, [0-9]+ failed" "$log" | tail -1 || echo "")

    if [ $exit_code -eq 0 ]; then
        local pass_count
        pass_count=$(echo "$summary" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "?")
        echo "  ✅ ${suite}: ${pass_count} passed"
        RESULTS+=("✅ ${suite}: ${summary}")
    else
        local fail_detail
        fail_detail=$(grep -A2 "❌ FAIL" "$log" | head -6 || echo "")
        echo "  ❌ ${suite}: FAILED"
        if [ -n "$fail_detail" ]; then
            echo "$fail_detail" | sed 's/^/     /'
        fi
        RESULTS+=("❌ ${suite}: ${summary}")
    fi

    return $exit_code
}

echo "🧪 Running PilotSwarm integration tests"
echo "   $(date)"
echo ""

FAILED_SUITES=()

if [ "$PARALLEL" = true ]; then
    echo "   Mode: parallel"
    echo ""

    PIDS=()
    SUITE_NAMES=()
    for suite in "${SUITES[@]}"; do
        if [ -n "$SUITE_FILTER" ] && [[ "$suite" != *"$SUITE_FILTER"* ]]; then
            continue
        fi
        test_file="$SDK_DIR/test/local/${suite}.test.js"
        if [ ! -f "$test_file" ]; then continue; fi

        log="/tmp/pilotswarm-test-${suite}.log"
        (cd "$SDK_DIR" && node --env-file=../../"$ENV_FILE" "test/local/${suite}.test.js") > "$log" 2>&1 &
        PIDS+=($!)
        SUITE_NAMES+=("$suite")
    done

    for i in "${!PIDS[@]}"; do
        suite="${SUITE_NAMES[$i]}"
        if wait "${PIDS[$i]}"; then
            summary=$(grep -E "passed, [0-9]+ failed" "/tmp/pilotswarm-test-${suite}.log" | tail -1 || echo "")
            pass_count=$(echo "$summary" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "?")
            echo "  ✅ ${suite}: ${pass_count} passed"
            RESULTS+=("✅ ${suite}")
        else
            echo "  ❌ ${suite}: FAILED"
            fail_detail=$(grep "❌ FAIL" "/tmp/pilotswarm-test-${suite}.log" | head -3 || echo "")
            if [ -n "$fail_detail" ]; then
                echo "$fail_detail" | sed 's/^/     /'
            fi
            RESULTS+=("❌ ${suite}")
            FAILED_SUITES+=("$suite")
        fi
    done
else
    echo "   Mode: sequential"
    echo ""

    for suite in "${SUITES[@]}"; do
        if [ -n "$SUITE_FILTER" ] && [[ "$suite" != *"$SUITE_FILTER"* ]]; then
            continue
        fi
        if ! run_suite "$suite"; then
            FAILED_SUITES+=("$suite")
        fi
    done
fi

# ─── Summary ──────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results:"
for r in "${RESULTS[@]}"; do
    echo "    $r"
done
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILED_SUITES[@]} -gt 0 ]; then
    echo ""
    echo "❌ ${#FAILED_SUITES[@]} suite(s) failed: ${FAILED_SUITES[*]}"
    echo "   Logs: /tmp/pilotswarm-test-<suite>.log"
    exit 1
else
    echo ""
    echo "✅ All suites passed!"
    exit 0
fi
