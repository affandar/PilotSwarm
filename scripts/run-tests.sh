#!/bin/bash
# Run the full PilotSwarm local integration test suite using vitest.
#
# Usage:
#   ./scripts/test-local.sh                  # run all suites in parallel (default)
#   ./scripts/test-local.sh --parallel       # run suites in parallel explicitly
#   ./scripts/test-local.sh --suite=smoke    # run only matching suite(s)
#   ./scripts/test-local.sh smoke            # same as --suite=smoke
#   ./scripts/test-local.sh --sequential     # force suites one at a time
#   ./scripts/test-local.sh --all-providers  # run baseline, then each configured provider overlay
#   ./scripts/test-local.sh --with-horizondb # run one pass with HorizonDB provider overlay
#
# Prerequisites:
#   - PostgreSQL running with DATABASE_URL in .env
#   - GITHUB_TOKEN in .env (for Copilot SDK)
#   - Optional: .env.horizondb (or HORIZONDB_ENV_FILE) to run the live
#     HorizonDB provider tests via --with-horizondb / --all-providers.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SDK_DIR="packages/sdk"
ENV_FILE=".env"
HORIZONDB_ENV_FILE="${HORIZONDB_ENV_FILE:-.env.horizondb}"
HORIZONDB_FALLBACK_ENV_FILE="packages/horizon-store/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Create it with DATABASE_URL and GITHUB_TOKEN."
    exit 1
fi

WITH_HORIZONDB=0
ALL_PROVIDERS=0
SCRIPT_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --help|-h)
            SCRIPT_ARGS+=("$arg")
            ;;
        --with-horizondb)
            WITH_HORIZONDB=1
            ;;
        --with-horizon)
            echo "ERROR: --with-horizon was renamed to --with-horizondb."
            exit 1
            ;;
        --all-providers)
            ALL_PROVIDERS=1
            ;;
        *)
            SCRIPT_ARGS+=("$arg")
            ;;
    esac
done

print_help() {
        cat <<'EOF'
Usage:
    ./scripts/run-tests.sh                    Run all suites in parallel (default)
    ./scripts/run-tests.sh --parallel         Run all suites in parallel explicitly
    ./scripts/run-tests.sh --sequential       Run all suites sequentially
    ./scripts/run-tests.sh --all-providers    Run baseline, then each configured provider overlay
    ./scripts/run-tests.sh --with-horizondb   Run one pass with HorizonDB provider overlay
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
    ./scripts/run-tests.sh --all-providers
    ./scripts/run-tests.sh --with-horizondb composition-tiers
    ./scripts/run-tests.sh --suite=contracts --suite=durability --sequential

Notes:
- Suite filters may be positional names or --suite=<name>, and can be mixed.
- Suite filters are substring matches under packages/sdk/test/local.
- Unknown options fail fast.
- Default runs load .env as the baseline/default provider config and then
    clear HORIZON_* provider vars, so a stale local .env cannot accidentally
    turn the default PgFactStore run into a HorizonDB run.
- --with-horizondb loads a HorizonDB provider overlay after .env. The default
    overlay is .env.horizondb; override with HORIZONDB_ENV_FILE=/path/to/file.
    For migration convenience, packages/horizon-store/.env is used when
    .env.horizondb is absent. This mode fails fast if no HorizonDB URL is
    configured after loading the overlay.
- --all-providers runs provider passes one by one. Today that means a baseline
    PgFactStore pass first, then a HorizonDB provider pass if configured. This
    intentionally duplicates the suite so provider interactions cannot mask
    baseline behavior. Unless PS_TEST_MAX_WORKERS is already set, each provider
    pass uses PS_TEST_MAX_WORKERS=8 unless the caller overrides it.
    The wrapper prints explicit phase banners while leaving Vitest's default
    terminal reporter untouched. It also asks Vitest for per-phase JSON result
    files and prints a combined summary with mode-specific rerun commands.
- A full run (no suite filter) also runs the deploy-scripts tests
    (node --test against deploy/scripts/test/*.test.mjs) and the
    mcp-server unit tests (node) before the SDK suites. Set
    SKIP_DEPLOY_SCRIPTS_TESTS=1 or SKIP_MCP_SERVER_TESTS=1 to skip.
    The mcp-server LIVE integration suite is opt-in via
    `npm run test:mcp-server:integration` (or :all).
- Provider-level HorizonDB tests run only when --with-horizondb or
    --all-providers loads a HorizonDB config and HORIZON_DATABASE_URL is set.
    Set SKIP_HORIZON_STORE_TESTS=1 to skip that provider-level stage.
EOF
}

if [ "${#SCRIPT_ARGS[@]}" -gt 0 ]; then
    for arg in "${SCRIPT_ARGS[@]}"; do
        case "$arg" in
            --help|-h)
                print_help
                exit 0
                ;;
        esac
    done
fi

horizondb_provider_configured() {
    if [ -f "$HORIZONDB_ENV_FILE" ] || [ -f "$HORIZONDB_FALLBACK_ENV_FILE" ]; then
        return 0
    fi
    # Migration convenience: if a maintainer still has HORIZON_DATABASE_URL in
    # root .env, treat it as configured for --all-providers. The baseline pass
    # still clears HORIZON_* before running.
    (
        set -a
        # shellcheck disable=SC1090
        source "$ENV_FILE"
        set +a
        [ -n "${HORIZON_DATABASE_URL:-}" ]
    )
}

ALL_PROVIDER_PHASE_NAMES=()
ALL_PROVIDER_PHASE_LABELS=()
ALL_PROVIDER_PHASE_JSONS=()
ALL_PROVIDER_PHASE_CODES=()

append_all_provider_result() {
    ALL_PROVIDER_PHASE_NAMES+=("$1")
    ALL_PROVIDER_PHASE_LABELS+=("$2")
    ALL_PROVIDER_PHASE_JSONS+=("$3")
    ALL_PROVIDER_PHASE_CODES+=("$4")
}

run_all_provider_phase() {
    local phase_no="$1"
    local phase_total="$2"
    local phase_key="$3"
    local phase_label="$4"
    shift 4

    local json_file="$ALL_PROVIDERS_RESULT_DIR/${phase_key}.sdk.json"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Provider phase $phase_no/$phase_total [$phase_key]: $phase_label"
    echo "Started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "SDK result JSON: $json_file"
    if [ "$#" -gt 0 ]; then
        echo "Command: $0 $* ${SCRIPT_ARGS[*]:-}"
    elif [ "${#SCRIPT_ARGS[@]}" -gt 0 ]; then
        echo "Command: $0 ${SCRIPT_ARGS[*]}"
    else
        echo "Command: $0"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    set +e
    if [ "$#" -gt 0 ]; then
        if [ "${#SCRIPT_ARGS[@]}" -gt 0 ]; then
            env \
                PILOTSWARM_TEST_PHASE="$phase_key" \
                PILOTSWARM_TEST_PHASE_LABEL="$phase_label" \
                VITEST_JSON_OUTPUT_FILE="$json_file" \
                "$0" "$@" "${SCRIPT_ARGS[@]}"
        else
            env \
                PILOTSWARM_TEST_PHASE="$phase_key" \
                PILOTSWARM_TEST_PHASE_LABEL="$phase_label" \
                VITEST_JSON_OUTPUT_FILE="$json_file" \
                "$0" "$@"
        fi
    else
        if [ "${#SCRIPT_ARGS[@]}" -gt 0 ]; then
            env \
                PILOTSWARM_TEST_PHASE="$phase_key" \
                PILOTSWARM_TEST_PHASE_LABEL="$phase_label" \
                VITEST_JSON_OUTPUT_FILE="$json_file" \
                "$0" "${SCRIPT_ARGS[@]}"
        else
            env \
                PILOTSWARM_TEST_PHASE="$phase_key" \
                PILOTSWARM_TEST_PHASE_LABEL="$phase_label" \
                VITEST_JSON_OUTPUT_FILE="$json_file" \
                "$0"
        fi
    fi
    local exit_code="$?"
    set -e

    append_all_provider_result "$phase_key" "$phase_label" "$json_file" "$exit_code"

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ "$exit_code" = "0" ]; then
        echo "Provider phase $phase_no/$phase_total [$phase_key]: PASS"
    else
        echo "Provider phase $phase_no/$phase_total [$phase_key]: FAIL (exit $exit_code)"
    fi
    echo "Finished: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

print_phase_json_summary() {
    local phase_key="$1"
    local json_file="$2"
    if [ ! -s "$json_file" ]; then
        echo "    SDK result JSON: not written (phase failed before SDK Vitest completed or was interrupted)"
        return 0
    fi

    node - "$phase_key" "$json_file" <<'NODE'
const fs = require("fs");
const path = require("path");

const [phaseKey, jsonFile] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
const suites = report.testResults ?? [];
const totalFiles = suites.length;
const failedFiles = suites.filter((suite) => {
    const assertions = suite.assertionResults ?? [];
    return suite.status === "failed" || assertions.some((item) => item.status === "failed");
}).length;
const skippedFiles = suites.filter((suite) => {
    const assertions = suite.assertionResults ?? [];
    return assertions.length > 0 && assertions.every((item) => item.status === "pending" || item.status === "skipped");
}).length;
const passedFiles = Math.max(0, totalFiles - failedFiles - skippedFiles);
const totalTests = report.numTotalTests ?? 0;
const passedTests = report.numPassedTests ?? 0;
const failedTests = report.numFailedTests ?? 0;
const skippedTests = report.numPendingTests ?? 0;
const todoTests = report.numTodoTests ?? 0;

console.log(`    SDK files: ${passedFiles} passed, ${failedFiles} failed, ${skippedFiles} skipped (${totalFiles} total)`);
console.log(`    SDK tests: ${passedTests} passed, ${failedTests} failed, ${skippedTests} skipped, ${todoTests} todo (${totalTests} total)`);

const failedSuites = [];
const failedEntries = [];
for (const suite of suites) {
  const suiteName = suite.name || suite.file || "(unknown suite)";
  const rel = path.relative(process.cwd(), suiteName).replaceAll(path.sep, "/");
  const display = rel.startsWith("..") ? suiteName : rel;
  const assertions = suite.assertionResults ?? [];
  const suiteFailed = assertions.some((item) => item.status === "failed") || suite.status === "failed";
  if (suiteFailed) failedSuites.push(display);
  for (const item of assertions) {
    if (item.status !== "failed") continue;
    failedEntries.push({ file: display, name: item.fullName || item.title || "(unknown test)" });
  }
}

if (failedEntries.length === 0) {
  console.log("    Failed tests: none");
    process.exit(0);
}

console.log("    Failed tests:");
for (const entry of failedEntries) {
  console.log(`      FAIL ${entry.file} > ${entry.name}`);
}

const filters = [...new Set(failedSuites
  .filter((file) => file.startsWith("test/local/") || file.includes("/test/local/"))
  .map((file) => file.replace(/^.*test\/local\//, "").replace(/\.test\.js$/, "").split("/").pop())
)].sort();

if (filters.length > 0) {
  const mode = phaseKey === "horizondb" ? " --with-horizondb" : "";
  console.log(`    SDK rerun: ./scripts/run-tests.sh${mode} ${filters.join(" ")}`);
}
NODE
}

print_all_providers_summary() {
    local final_exit=0
    local passed_phases=0
    local failed_phases=0
    local failed_tests=0
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Combined provider summary"
    echo "Result files: $ALL_PROVIDERS_RESULT_DIR"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local idx
    for ((idx = 0; idx < ${#ALL_PROVIDER_PHASE_NAMES[@]}; idx++)); do
        local phase_key="${ALL_PROVIDER_PHASE_NAMES[$idx]}"
        local phase_label="${ALL_PROVIDER_PHASE_LABELS[$idx]}"
        local json_file="${ALL_PROVIDER_PHASE_JSONS[$idx]}"
        local exit_code="${ALL_PROVIDER_PHASE_CODES[$idx]}"
        local status="PASS"
        if [ "$exit_code" != "0" ]; then
            status="FAIL"
            final_exit=1
            failed_phases=$((failed_phases + 1))
        else
            passed_phases=$((passed_phases + 1))
        fi

        local phase_failed_tests=0
        if [ -s "$json_file" ]; then
            phase_failed_tests="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(r.numFailedTests || 0)' "$json_file")"
        fi
        failed_tests=$((failed_tests + phase_failed_tests))

        echo "[$phase_key] $phase_label: $status (exit $exit_code)"
        echo "    sdk-json: $json_file"
        print_phase_json_summary "$phase_key" "$json_file"
    done

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Provider phases: ${passed_phases} passed, ${failed_phases} failed, ${failed_tests} failed test entry/entries across all phases."
    if [ "$final_exit" = "0" ]; then
        echo "Combined provider result: PASS"
    else
        echo "Combined provider result: FAIL"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    return "$final_exit"
}

if [ "$ALL_PROVIDERS" = "1" ]; then
    if [ -z "${PS_TEST_MAX_WORKERS:-}" ]; then
        export PS_TEST_MAX_WORKERS=8
        echo "🧪 --all-providers: defaulting PS_TEST_MAX_WORKERS=8 for each provider pass."
    fi

    ALL_PROVIDERS_RESULT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pilotswarm-run-tests-all-providers.XXXXXX")"
    HORIZONDB_PHASE_CONFIGURED=0
    if horizondb_provider_configured; then
        HORIZONDB_PHASE_CONFIGURED=1
    fi
    PHASE_TOTAL=1
    if [ "$HORIZONDB_PHASE_CONFIGURED" = "1" ]; then
        PHASE_TOTAL=2
    fi

    run_all_provider_phase 1 "$PHASE_TOTAL" "base" "baseline default provider (PgFactStore)"

    if [ "$HORIZONDB_PHASE_CONFIGURED" = "1" ]; then
        run_all_provider_phase 2 "$PHASE_TOTAL" "horizondb" "HorizonDB provider overlay" --with-horizondb
    else
        echo "⏭  No HorizonDB provider config found; --all-providers completed baseline only."
    fi

    print_all_providers_summary
    exit "$?"
fi

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

# Run the @pilotswarm/horizon-store LIVE integration suite (the provider-level
# graph / ACL / crawl / harvester / embedder scenarios the SDK gating tests
# stub out) only when a provider overlay is explicitly enabled. OPT-IN: skipped
# cleanly in the default-provider run or when SKIP_HORIZON_STORE_TESTS=1.
run_horizon_store_tests() {
    if [ "${SKIP_HORIZON_STORE_TESTS:-0}" = "1" ]; then
        echo "⏭  Skipping horizon-store integration tests (SKIP_HORIZON_STORE_TESTS=1)."
        return 0
    fi
    if [ "$WITH_HORIZONDB" != "1" ] && [ "$ALL_PROVIDERS" != "1" ]; then
        echo "⏭  Skipping horizon-store integration tests (provider overlay not enabled)."
        return 0
    fi
    if [ -z "${HORIZON_DATABASE_URL:-}" ]; then
        echo "⏭  Skipping horizon-store integration tests (HORIZON_DATABASE_URL not set)."
        return 0
    fi
    echo "🧪 Running @pilotswarm/horizon-store integration tests (live HorizonDB)..."
    (cd "$REPO_ROOT" && npm run --silent test:integration --workspace=@pilotswarm/horizon-store) \
        || { echo "❌ horizon-store integration tests failed"; exit 1; }
}

HORIZONDB_ENV_KEYS=(
    HORIZON_DATABASE_URL
    HORIZON_FACTS_SCHEMA
    HORIZON_GRAPH_DATABASE_URL
    HORIZON_GRAPH_SCHEMA
    HORIZON_EMBED_URL
    HORIZON_EMBED_MODEL
    HORIZON_EMBED_DIM
    HORIZON_EMBED_API_KEY
    HORIZON_EMBED_API_KEY_HEADER
    HORIZON_EMBED_BEARER
)

clear_horizondb_env() {
    local key
    for key in "${HORIZONDB_ENV_KEYS[@]}"; do
        unset "$key"
    done
}

load_env_file() {
    local file="$1"
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
}

configure_provider_env() {
    if [ "$WITH_HORIZONDB" = "1" ] || [ "$ALL_PROVIDERS" = "1" ]; then
        if [ -f "$HORIZONDB_ENV_FILE" ]; then
            echo "🌅 Loading HorizonDB provider config from $HORIZONDB_ENV_FILE"
            load_env_file "$HORIZONDB_ENV_FILE"
        elif [ -f "$HORIZONDB_FALLBACK_ENV_FILE" ]; then
            echo "🌅 Loading HorizonDB provider config from $HORIZONDB_FALLBACK_ENV_FILE"
            load_env_file "$HORIZONDB_FALLBACK_ENV_FILE"
        elif [ -n "${HORIZON_DATABASE_URL:-}" ]; then
            echo "🌅 Using HorizonDB provider config from the existing environment"
        elif [ "$WITH_HORIZONDB" = "1" ]; then
            echo "ERROR: --with-horizondb requires HORIZON_DATABASE_URL via $HORIZONDB_ENV_FILE, $HORIZONDB_FALLBACK_ENV_FILE, or the environment."
            exit 1
        else
            echo "⏭  No HorizonDB provider config found for --all-providers; running baseline provider only."
            clear_horizondb_env
            return 0
        fi

        if [ -n "${HORIZON_DATABASE_URL:-}" ]; then
            echo "🌅 HorizonDB provider tests enabled."
        elif [ "$WITH_HORIZONDB" = "1" ]; then
            echo "ERROR: --with-horizondb loaded provider config, but HORIZON_DATABASE_URL is still unset."
            exit 1
        else
            echo "⏭  HorizonDB provider config loaded without HORIZON_DATABASE_URL; running baseline provider only."
            clear_horizondb_env
        fi
    else
        clear_horizondb_env
        echo "🧪 Provider mode: baseline default fact store (HorizonDB provider vars cleared)."
    fi
}

# Suppress duroxide Rust WARN logs in tests (AKS workers use INFO via their own env)
export RUST_LOG="${RUST_LOG:-error}"

# Load .env for baseline config, then opt into provider overlays explicitly.
load_env_file "$ENV_FILE"
configure_provider_env

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
if [ "${#SCRIPT_ARGS[@]}" -gt 0 ]; then
    for arg in "${SCRIPT_ARGS[@]}"; do
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
fi

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
    if [ -n "${PILOTSWARM_TEST_PHASE:-}" ]; then
        echo "🧪 SDK Vitest phase [$PILOTSWARM_TEST_PHASE]: ${PILOTSWARM_TEST_PHASE_LABEL:-provider pass}"
    fi
    if [ -n "${VITEST_JSON_OUTPUT_FILE:-}" ]; then
        mkdir -p "$(dirname "$VITEST_JSON_OUTPUT_FILE")"
        VITEST_ARGS+=(--reporter=default --reporter=json "--outputFile=$VITEST_JSON_OUTPUT_FILE")
    fi
    exec npx vitest "${VITEST_ARGS[@]}" "${TARGET_FILES[@]}"
else
    run_deploy_scripts_tests
    run_mcp_server_tests
    run_horizon_store_tests
    if [ -n "${PILOTSWARM_TEST_PHASE:-}" ]; then
        echo "🧪 SDK Vitest phase [$PILOTSWARM_TEST_PHASE]: ${PILOTSWARM_TEST_PHASE_LABEL:-provider pass}"
    fi
    if [ -n "${VITEST_JSON_OUTPUT_FILE:-}" ]; then
        mkdir -p "$(dirname "$VITEST_JSON_OUTPUT_FILE")"
        VITEST_ARGS+=(--reporter=default --reporter=json "--outputFile=$VITEST_JSON_OUTPUT_FILE")
    fi
    exec npx vitest "${VITEST_ARGS[@]}"
fi
