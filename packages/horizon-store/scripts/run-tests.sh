#!/usr/bin/env bash
# Single entry point for the horizon-facts validation run (06-provider-test-plan).
# Runs under VITEST — the same framework as the rest of PilotSwarm (invoked
# from the workspace root's node_modules, like packages/sdk does).
#
#   ./scripts/run-tests.sh                # build + unit + integration (sequential)
#   ./scripts/run-tests.sh --allow-skips  # don't fail the run on skipped suites
#
# Env (loaded from .env when present):
#   HORIZON_DATABASE_URL   the live HorizonDB           (integration suites)
#   HORIZON_EMBED_URL/_API_KEY/_MODEL/_DIM  real embeddings endpoint (embedder suites)
#   PLAIN_DATABASE_URL     plain Postgres for fail-fast negatives
#                          (auto-falls back to the repo root .env's DATABASE_URL)
#
# A FULL-VALIDATION pass is defined as zero failures AND zero skips (06 §1);
# by default this script exits non-zero on skips so an incomplete run can't
# read as green in CI.

set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW_SKIPS=0
[[ "${1:-}" == "--allow-skips" ]] && ALLOW_SKIPS=1

VITEST="../../node_modules/vitest/vitest.mjs"

echo "── build ──────────────────────────────────────────────────────────────"
npx tsc

echo "── unit (DB-less) ─────────────────────────────────────────────────────"
node "$VITEST" run test/graph-model.test.mjs test/query-builder.test.mjs

echo "── integration (live HorizonDB, sequential files per vitest.config) ───"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

set +e
node --env-file-if-exists=.env "$VITEST" run test/integration 2>&1 | tee "$OUT"
STATUS=${PIPESTATUS[0]}
set -e

# Vitest summary line:  "Tests  119 passed | 2 skipped (121)" — strip the
# ANSI color codes vitest wraps it in, and tolerate absent fields (grep no-match
# must not trip set -e).
SUMMARY=$(sed -E 's/\x1b\[[0-9;]*m//g' "$OUT" | grep -E "^[[:space:]]*Tests[[:space:]]" | tail -1 || true)
PASSED=$(echo "$SUMMARY" | grep -oE "[0-9]+ passed"  | awk '{print $1}' || true)
FAILED=$(echo "$SUMMARY" | grep -oE "[0-9]+ failed"  | awk '{print $1}' || true)
SKIPPED=$(echo "$SUMMARY" | grep -oE "[0-9]+ skipped" | awk '{print $1}' || true)

if [[ -z "$SUMMARY" ]]; then
    echo "RESULT: FAILED — could not find the vitest summary line (run aborted early?)"
    exit 1
fi

echo "── summary ────────────────────────────────────────────────────────────"
echo "pass=${PASSED:-0} fail=${FAILED:-0} skipped=${SKIPPED:-0}"

if [[ $STATUS -ne 0 || "${FAILED:-0}" != "0" ]]; then
    echo "RESULT: FAILED"
    exit 1
fi
if [[ "${SKIPPED:-0}" != "0" ]]; then
    echo "RESULT: INCOMPLETE — ${SKIPPED} test(s) skipped (missing env inputs)."
    echo "A full-validation pass requires zero skips (06-provider-test-plan §1)."
    [[ $ALLOW_SKIPS -eq 1 ]] && { echo "(--allow-skips: not failing the run)"; exit 0; }
    exit 2
fi
echo "RESULT: FULL VALIDATION PASS"
