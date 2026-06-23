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
#   - For baseline / --all-providers: PostgreSQL and GITHUB_TOKEN in .env.
#   - For --with-horizondb: .env.horizondb (or HORIZONDB_ENV_FILE) as a
#     standalone config. It should duplicate any needed .env settings,
#     including the stock PostgreSQL DATABASE_URL for runtime storage.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SDK_DIR="packages/sdk"
ENV_FILE=".env"
HORIZONDB_ENV_FILE="${HORIZONDB_ENV_FILE:-.env.horizondb}"

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

if { [ "$WITH_HORIZONDB" != "1" ] || [ "$ALL_PROVIDERS" = "1" ]; } && [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Create it with DATABASE_URL and GITHUB_TOKEN."
    exit 1
fi

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
    ./scripts/run-tests.sh --with-horizondb embedder-outcomes
    ./scripts/run-tests.sh --suite=contracts --suite=durability --sequential

Notes:
- Suite filters may be positional names or --suite=<name>, and can be mixed.
- Suite filters are substring matches under packages/sdk/test/local. When
    --with-horizondb is active, they also match provider-level integration tests
    under packages/horizon-store/test/integration (for example embedder-outcomes).
- Unknown options fail fast.
- Every run prints a consolidated phase summary at the end (builds, optional
    node suites, and the SDK Vitest result with file/test counts) plus an
    Overall PASS/FAIL line, and exits non-zero if any phase failed. The
    --all-providers path additionally prints its own combined provider summary.
- Default runs load .env as the baseline/default provider config and then
    clear HORIZON_* provider vars, so a stale local .env cannot accidentally
    turn the default PgFactStore run into a HorizonDB run.
- --with-horizondb loads only a standalone HorizonDB config file. The default
    is .env.horizondb; override with HORIZONDB_ENV_FILE=/path/to/file. Duplicate
    any needed .env settings there, including the stock PostgreSQL DATABASE_URL
    for runtime CMS/duroxide storage. This mode fails fast if the file is
    missing or HORIZON_DATABASE_URL is unset.
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
    Set SKIP_HORIZON_STORE_TESTS=1 to skip that provider-level stage. Filtered
    provider-level runs inherit the already-loaded .env.horizondb; they do not
    load packages/horizon-store/.env or fall back to .env.
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
    if [ -f "$HORIZONDB_ENV_FILE" ]; then
        return 0
    fi
    return 1
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

# ─── Phase tracking for the single-run (non --all-providers) summary ─────────
# A normal run executes several phases (builds, optional node-based suites,
# then the SDK Vitest run). The script historically ended in `exec npx vitest`,
# so on success only Vitest's own summary printed and the earlier phases had no
# roll-up. Record each phase here and print a consolidated summary at the end.
RUN_PHASE_LABELS=()
RUN_PHASE_RESULTS=()
record_run_phase() {
    RUN_PHASE_LABELS+=("$1")
    RUN_PHASE_RESULTS+=("$2")
}

# Build
echo "🔨 Building TypeScript..."
(cd "$SDK_DIR" && npm run build) || { echo "❌ Build failed"; exit 1; }
record_run_phase "TypeScript build" "PASS"

# Build mcp-server (its tests import from packages/mcp-server/dist/...).
# Cheap incremental tsc — only rebuilds when sources changed.
(cd "$REPO_ROOT/packages/mcp-server" && npm run build) \
    || { echo "❌ mcp-server build failed"; exit 1; }
record_run_phase "mcp-server build" "PASS"

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
        record_run_phase "deploy-scripts tests" "SKIPPED"
        return 0
    fi
    echo "🧪 Running deploy-scripts tests (node --test)..."
    (cd "$REPO_ROOT" && npm run --silent test:deploy-scripts) \
        || { echo "❌ deploy-scripts tests failed"; exit 1; }
    record_run_phase "deploy-scripts tests" "PASS"
}

# Run the mcp-server unit suite when no SDK suite filter is in effect.
# The mcp-server has a small pure-mock unit test (no DB, no Copilot) plus
# LIVE integration smokes that are opt-in via test:mcp-server:integration.
# Mirrors the deploy-scripts pattern. Set SKIP_MCP_SERVER_TESTS=1 to skip.
run_mcp_server_tests() {
    if [ "${SKIP_MCP_SERVER_TESTS:-0}" = "1" ]; then
        echo "⏭  Skipping mcp-server tests (SKIP_MCP_SERVER_TESTS=1)."
        record_run_phase "mcp-server unit tests" "SKIPPED"
        return 0
    fi
    echo "🧪 Running mcp-server unit tests (node)..."
    (cd "$REPO_ROOT" && npm run --silent test:mcp-server) \
        || { echo "❌ mcp-server tests failed"; exit 1; }
    record_run_phase "mcp-server unit tests" "PASS"
}

# Run the @pilotswarm/horizon-store LIVE integration suite (the provider-level
# graph / ACL / crawl / harvester / embedder scenarios the SDK gating tests
# stub out) only when a provider overlay is explicitly enabled. OPT-IN: skipped
# cleanly in the default-provider run or when SKIP_HORIZON_STORE_TESTS=1.
run_horizon_store_tests() {
    local targets=("$@")
    if [ "${SKIP_HORIZON_STORE_TESTS:-0}" = "1" ]; then
        echo "⏭  Skipping horizon-store integration tests (SKIP_HORIZON_STORE_TESTS=1)."
        record_run_phase "horizon-store integration" "SKIPPED"
        return 0
    fi
    if [ "$WITH_HORIZONDB" != "1" ] && [ "$ALL_PROVIDERS" != "1" ]; then
        echo "⏭  Skipping horizon-store integration tests (provider overlay not enabled)."
        record_run_phase "horizon-store integration" "SKIPPED"
        return 0
    fi
    if [ -z "${HORIZON_DATABASE_URL:-}" ]; then
        echo "⏭  Skipping horizon-store integration tests (HORIZON_DATABASE_URL not set)."
        record_run_phase "horizon-store integration" "SKIPPED"
        return 0
    fi
    local display="all integration tests"
    if [ "${#targets[@]}" -gt 0 ]; then
        display="${targets[*]}"
    else
        targets=(test/integration)
    fi
    echo "🧪 Running @pilotswarm/horizon-store integration tests (live HorizonDB): $display"
    (cd "$REPO_ROOT/packages/horizon-store" && npm run --silent build && node ../../node_modules/vitest/vitest.mjs run "${targets[@]}") \
        || { echo "❌ horizon-store integration tests failed"; exit 1; }
    record_run_phase "horizon-store integration" "PASS"
}

# Print a consolidated phase roll-up for a single (non --all-providers) run.
# $1 = SDK Vitest JSON result file (may be empty/missing), $2 = Vitest exit code.
print_run_summary() {
    local sdk_json="$1"
    local sdk_code="$2"
    local sdk_label="${3-SDK vitest}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Local test run summary"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    local idx
    for ((idx = 0; idx < ${#RUN_PHASE_LABELS[@]}; idx++)); do
        printf '  %-32s %s\n' "${RUN_PHASE_LABELS[$idx]}" "${RUN_PHASE_RESULTS[$idx]}"
    done

    if [ -n "$sdk_label" ]; then
        local sdk_status="PASS"
        if [ "$sdk_code" != "0" ]; then
            sdk_status="FAIL (exit $sdk_code)"
        fi
        printf '  %-32s %s\n' "$sdk_label" "$sdk_status"
    fi

    # Detailed file/test breakdown and, on failure, the exact failing tests plus
    # a ready-to-paste rerun command — parsed from the Vitest JSON report.
    if [ -n "$sdk_label" ] && [ -s "$sdk_json" ]; then
        node - "$sdk_json" <<'NODE'
const fs = require("fs");
const path = require("path");
const jsonFile = process.argv[2];
let report;
try { report = JSON.parse(fs.readFileSync(jsonFile, "utf8")); } catch { process.exit(0); }
const suites = report.testResults ?? [];
const failedFiles = new Set();
const failedEntries = [];
for (const suite of suites) {
    const suiteName = suite.name || suite.file || "";
    const rel = path.relative(process.cwd(), suiteName).split(path.sep).join("/");
    const display = rel.startsWith("..") ? suiteName : rel;
    const assertions = suite.assertionResults ?? [];
    const suiteFailed = suite.status === "failed" || assertions.some((a) => a.status === "failed");
    if (suiteFailed) failedFiles.add(display);
    for (const a of assertions) {
        if (a.status === "failed") failedEntries.push({ file: display, name: a.fullName || a.title || "(unknown test)" });
    }
}
const totalFiles = suites.length;
const failedFileCount = failedFiles.size;
const passedFileCount = Math.max(0, totalFiles - failedFileCount);
const tPass = report.numPassedTests ?? 0;
const tFail = report.numFailedTests ?? 0;
const tSkip = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
const tTotal = report.numTotalTests ?? 0;
console.log(`    files: ${passedFileCount} passed, ${failedFileCount} failed (${totalFiles} total)`);
console.log(`    tests: ${tPass} passed, ${tFail} failed, ${tSkip} skipped (${tTotal} total)`);
if (failedEntries.length > 0) {
    console.log(`    failed tests:`);
    for (const e of failedEntries) console.log(`      FAIL ${e.file} > ${e.name}`);
}
const filters = [...new Set([...failedFiles]
    .filter((f) => f.includes("test/local/"))
    .map((f) => f.replace(/^.*test\/local\//, "").replace(/\.test\.js$/, "").split("/").pop()))]
    .sort();
if (filters.length > 0) {
    console.log(`    re-run failed suite(s):`);
    console.log(`      ./scripts/run-tests.sh ${filters.join(" ")}`);
}
NODE
        if [ "$sdk_code" != "0" ]; then
            printf '    full json: %s\n' "$sdk_json"
        fi
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ "$sdk_code" = "0" ]; then
        echo "Overall: PASS"
    else
        echo "Overall: FAIL"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Run the SDK Vitest pass and print the phase summary afterwards.
# Child invocations from --all-providers set VITEST_JSON_OUTPUT_FILE and rely on
# the parent to print the combined provider summary, so preserve the historical
# exec behavior there (the parent reads the JSON we write). For a normal single
# run we capture Vitest's result instead of exec-ing, so we can print a roll-up.
run_sdk_vitest_and_summarize() {
    if [ -n "${VITEST_JSON_OUTPUT_FILE:-}" ]; then
        mkdir -p "$(dirname "$VITEST_JSON_OUTPUT_FILE")"
        VITEST_ARGS+=(--reporter=default --reporter=json "--outputFile=$VITEST_JSON_OUTPUT_FILE")
        exec npx vitest "${VITEST_ARGS[@]}" "$@"
    fi

    local sdk_json
    sdk_json="$(mktemp "${TMPDIR:-/tmp}/pilotswarm-run-tests-sdk.XXXXXX")"
    VITEST_ARGS+=(--reporter=default --reporter=json "--outputFile=$sdk_json")

    set +e
    npx vitest "${VITEST_ARGS[@]}" "$@"
    local sdk_code=$?
    set -e

    # On failure, retain the JSON report at a stable path so the failing tests
    # can be re-inspected without re-running the whole suite.
    local report_path="$sdk_json"
    if [ "$sdk_code" != "0" ]; then
        report_path="${TMPDIR:-/tmp}/pilotswarm-last-sdk-failures.json"
        mv -f "$sdk_json" "$report_path" 2>/dev/null || report_path="$sdk_json"
    fi

    print_run_summary "$report_path" "$sdk_code"

    if [ "$sdk_code" = "0" ]; then
        rm -f "$report_path"
    fi
    exit "$sdk_code"
}

HORIZONDB_ENV_KEYS=(
    HORIZON_DATABASE_URL
    HORIZON_FACTS_SCHEMA
    HORIZON_GRAPH_DATABASE_URL
    HORIZON_GRAPH_SCHEMA
    HORIZON_GRAPH_REGISTRY_SCHEMA
    HORIZON_NAMESPACE_CACHE_TTL_MS
    HORIZON_EMBED_URL
    HORIZON_EMBED_MODEL
    HORIZON_EMBED_DIM
    HORIZON_EMBED_API_KEY
    HORIZON_EMBED_API_KEY_HEADER
    HORIZON_EMBED_BEARER
)

HORIZONDB_STANDALONE_ENV_KEYS=(
    DATABASE_URL
    TEST_DATABASE_URL
    PS_TEST_DATABASE_URL
    GITHUB_TOKEN
    PILOTSWARM_RUNTIME_PROVIDER
    PILOTSWARM_RUNTIME_URL
    PILOTSWARM_SESSION_CATALOG_URL
    PILOTSWARM_RUNTIME_SESSION_CATALOG_URL
    PILOTSWARM_DUROXIDE_URL
    PILOTSWARM_FACTSTORE_URL
    PILOTSWARM_FACTS_SCHEMA
    PILOTSWARM_GRAPH_URL
    PILOTSWARM_GRAPH_SCHEMA
)

clear_horizondb_env() {
    local key
    for key in "${HORIZONDB_ENV_KEYS[@]}"; do
        unset "$key"
    done
}

clear_standalone_horizondb_env() {
    clear_horizondb_env
    local key
    for key in "${HORIZONDB_STANDALONE_ENV_KEYS[@]}"; do
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
    if [ "$WITH_HORIZONDB" = "1" ]; then
        if [ -f "$HORIZONDB_ENV_FILE" ]; then
            echo "🌅 Loading standalone HorizonDB test config from $HORIZONDB_ENV_FILE"
            clear_standalone_horizondb_env
            load_env_file "$HORIZONDB_ENV_FILE"
        else
            echo "ERROR: --with-horizondb requires a standalone HorizonDB config file at $HORIZONDB_ENV_FILE."
            echo "       Copy .env.horizondb.example and duplicate required .env settings there."
            exit 1
        fi

        if [ -z "${HORIZON_DATABASE_URL:-}" ]; then
            echo "ERROR: --with-horizondb loaded $HORIZONDB_ENV_FILE, but HORIZON_DATABASE_URL is unset."
            echo "       This file must enable the HorizonDB enhanced fact store."
            exit 1
        fi
        if [ -z "${DATABASE_URL:-}" ]; then
            echo "ERROR: --with-horizondb requires DATABASE_URL in $HORIZONDB_ENV_FILE for stock PostgreSQL runtime storage."
            exit 1
        fi
        if [ -z "${GITHUB_TOKEN:-}" ]; then
            echo "ERROR: --with-horizondb requires GITHUB_TOKEN in $HORIZONDB_ENV_FILE (Copilot SDK)."
            exit 1
        fi
        if [ "${DATABASE_URL}" = "${HORIZON_DATABASE_URL}" ]; then
            echo "ERROR: DATABASE_URL must be stock PostgreSQL, distinct from HORIZON_DATABASE_URL."
            echo "       Runtime CMS/duroxide storage stays on PostgreSQL; only enhanced facts + graph use HorizonDB."
            exit 1
        fi
        # No remapping needed: the SDK derives the hybrid from these vars.
        # HORIZON_DATABASE_URL selects the horizondb runtime provider, whose
        # CMS/duroxide stay on DATABASE_URL (stock PostgreSQL) while enhanced
        # facts + graph use the HorizonDB URLs and schemas.
        echo "🌅 Hybrid mode: runtime storage on stock PostgreSQL (DATABASE_URL); enhanced facts + graph on HorizonDB."
    else
        clear_horizondb_env
        echo "🧪 Provider mode: baseline default fact store (HorizonDB provider vars cleared)."
    fi
}

# Suppress duroxide Rust WARN logs in tests (AKS workers use INFO via their own env)
export RUST_LOG="${RUST_LOG:-error}"

# Baseline runs load .env. HorizonDB runs load only .env.horizondb so missing
# standalone settings fail loudly instead of being borrowed from .env.
if [ "$WITH_HORIZONDB" != "1" ]; then
    load_env_file "$ENV_FILE"
fi
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
HORIZON_TARGET_FILES=()
if [ ${#SUITE_FILTERS[@]} -gt 0 ]; then
    for filter in "${SUITE_FILTERS[@]}"; do
        while IFS= read -r file; do
            TARGET_FILES+=("$file")
        done < <(find test/local -type f -name "*${filter}*.test.js" | sort)
        if [ "$WITH_HORIZONDB" = "1" ]; then
            while IFS= read -r file; do
                HORIZON_TARGET_FILES+=("${file#$REPO_ROOT/packages/horizon-store/}")
            done < <(find "$REPO_ROOT/packages/horizon-store/test/integration" -type f -name "*${filter}*.test.mjs" | sort)
        fi
    done

    if [ ${#TARGET_FILES[@]} -eq 0 ] && [ ${#HORIZON_TARGET_FILES[@]} -eq 0 ]; then
        echo "ERROR: no test files matched suite filter(s): ${SUITE_FILTERS[*]}"
        if [ "$WITH_HORIZONDB" != "1" ]; then
            echo "       Provider-level HorizonDB tests are matched only with --with-horizondb."
        fi
        exit 1
    fi
fi

if [ ${#HORIZON_TARGET_FILES[@]} -gt 0 ]; then
    run_horizon_store_tests "${HORIZON_TARGET_FILES[@]}"
fi

if [ ${#TARGET_FILES[@]} -gt 0 ]; then
    if [ -n "${PILOTSWARM_TEST_PHASE:-}" ]; then
        echo "🧪 SDK Vitest phase [$PILOTSWARM_TEST_PHASE]: ${PILOTSWARM_TEST_PHASE_LABEL:-provider pass}"
    fi
    run_sdk_vitest_and_summarize "${TARGET_FILES[@]}"
elif [ ${#HORIZON_TARGET_FILES[@]} -gt 0 ]; then
    print_run_summary "" 0 ""
    exit 0
else
    run_deploy_scripts_tests
    run_mcp_server_tests
    run_horizon_store_tests
    if [ -n "${PILOTSWARM_TEST_PHASE:-}" ]; then
        echo "🧪 SDK Vitest phase [$PILOTSWARM_TEST_PHASE]: ${PILOTSWARM_TEST_PHASE_LABEL:-provider pass}"
    fi
    run_sdk_vitest_and_summarize
fi
