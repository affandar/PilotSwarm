#!/usr/bin/env bash
# Single entry point for the horizon-facts validation run (06-provider-test-plan).
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

echo "── build ──────────────────────────────────────────────────────────────"
npx tsc

echo "── unit (DB-less) ─────────────────────────────────────────────────────"
node --test test/*.test.mjs

echo "── integration (live HorizonDB, sequential) ───────────────────────────"
ENV_ARGS=()
[[ -f .env ]] && ENV_ARGS=(--env-file=.env)

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# Sequential: the shared cluster's AGE/extension init races make parallel
# suites flaky (04 §7). Tee full output; summarize below.
set +e
node "${ENV_ARGS[@]}" --test --test-concurrency=1 test/integration/*.test.mjs 2>&1 | tee "$OUT"
STATUS=${PIPESTATUS[0]}
set -e

FAILED=$(grep -E "^ℹ fail "    "$OUT" | tail -1 | awk '{print $3}')
SKIPPED=$(grep -E "^ℹ skipped " "$OUT" | tail -1 | awk '{print $3}')
PASSED=$(grep -E "^ℹ pass "    "$OUT" | tail -1 | awk '{print $3}')

echo "── summary ────────────────────────────────────────────────────────────"
echo "pass=${PASSED:-?} fail=${FAILED:-?} skipped=${SKIPPED:-?}"

if [[ $STATUS -ne 0 || "${FAILED:-1}" != "0" ]]; then
    echo "RESULT: FAILED"
    exit 1
fi
if [[ "${SKIPPED:-0}" != "0" ]]; then
    echo "RESULT: INCOMPLETE — ${SKIPPED} suite(s) skipped (missing env inputs)."
    echo "A full-validation pass requires zero skips (06-provider-test-plan §1)."
    [[ $ALLOW_SKIPS -eq 1 ]] && { echo "(--allow-skips: not failing the run)"; exit 0; }
    exit 2
fi
echo "RESULT: FULL VALIDATION PASS"
