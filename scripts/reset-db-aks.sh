#!/bin/bash
# DESTRUCTIVE: wipe the pilotswarm database behind an AKS deployment.
#
# Drops and recreates BOTH the duroxide and CMS schemas — every session,
# orchestration, artifact reference, and fact is permanently deleted.
#
# This is deliberately NOT part of any deploy script. Deploys never reset
# data. Run this ONLY when the user has explicitly asked for a data reset,
# and never against an environment whose data must survive (for agents: if
# the request did not literally ask for a wipe, do not run this).
#
# Usage:
#   ./scripts/reset-db-aks.sh --i-understand-this-deletes-all-data
#
# Flow: scales workers to 0 → waits for full termination → resets the DB →
# scales workers back to their previous replica count.
#
# Prerequisites: same as deploy-aks.sh (.env.remote with DATABASE_URL,
# kubectl configured for the target cluster).

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIRMED=false
for arg in "$@"; do
    case "$arg" in
        --i-understand-this-deletes-all-data) CONFIRMED=true ;;
    esac
done

if [ "$CONFIRMED" != true ]; then
    echo "❌ Refusing to reset: this permanently deletes ALL sessions, orchestrations, and facts."
    echo "   If (and only if) that is truly intended, re-run with:"
    echo "   ./scripts/reset-db-aks.sh --i-understand-this-deletes-all-data"
    exit 1
fi

# ─── Load env (same safe parser as deploy-aks.sh) ─────────────────

ENV_FILE=""
if [ -f .env.remote ]; then
    ENV_FILE=".env.remote"
elif [ -f .env ]; then
    ENV_FILE=".env"
fi

if [ -n "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        export "$line"
    done < "$ENV_FILE"
fi

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL not set. Create .env.remote or .env with DATABASE_URL."
    exit 1
fi
if [ -z "$ENV_FILE" ]; then
    echo "ERROR: no .env.remote or .env file found (db-reset.js needs --env-file)."
    exit 1
fi

NAMESPACE="${K8S_NAMESPACE:-${NAMESPACE:-copilot-runtime}}"
K8S_CONTEXT="${K8S_CONTEXT:-}"

KUBECTL=(kubectl)
if [ -n "$K8S_CONTEXT" ]; then
    KUBECTL+=(--context "$K8S_CONTEXT")
fi

wait_for_worker_scale_down() {
    local timeout_seconds="${1:-180}"
    local deployment="copilot-runtime-worker"
    local selector="app.kubernetes.io/component=worker"
    local deadline=$((SECONDS + timeout_seconds))

    "${KUBECTL[@]}" rollout status deployment/"$deployment" -n "$NAMESPACE" --timeout="${timeout_seconds}s" >/dev/null 2>&1 || true

    while [ "$SECONDS" -lt "$deadline" ]; do
        local remaining_pods
        remaining_pods="$("${KUBECTL[@]}" get pods -n "$NAMESPACE" -l "$selector" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
        if [ "${remaining_pods:-0}" = "0" ]; then
            echo "   ✅ Workers fully terminated"
            return 0
        fi
        sleep 2
    done

    echo "   ❌ Timed out waiting for workers to terminate before DB reset."
    "${KUBECTL[@]}" get pods -n "$NAMESPACE" -l "$selector" || true
    return 1
}

echo "🗑️  DESTRUCTIVE RESET of namespace '$NAMESPACE' (${K8S_CONTEXT:-current kubectl context})"

PREV_REPLICAS="$("${KUBECTL[@]}" get deployment copilot-runtime-worker -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
PREV_REPLICAS="${PREV_REPLICAS:-1}"

echo "   Scaling workers to 0 (was $PREV_REPLICAS)..."
"${KUBECTL[@]}" scale deployment copilot-runtime-worker -n "$NAMESPACE" --replicas=0 2>/dev/null || true
wait_for_worker_scale_down 180

echo "   Resetting database (duroxide + CMS schemas)..."
NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file="$ENV_FILE" scripts/db-reset.js --yes

echo "   Scaling workers back to $PREV_REPLICAS..."
"${KUBECTL[@]}" scale deployment copilot-runtime-worker -n "$NAMESPACE" --replicas="$PREV_REPLICAS"

echo ""
echo "✅ Database reset complete. Workers restored to $PREV_REPLICAS replicas."
