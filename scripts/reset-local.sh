#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# reset-local.sh — Full reset for PilotSwarm
#
# Drops duroxide + CMS schemas, deletes .tmp/ session state,
# and optionally cleans blob storage. For local Postgres resets, the
# script also terminates other backends connected to the same database
# before dropping schemas to avoid DDL deadlocks with still-running workers.
#
# Usage:
#   ./scripts/reset-local.sh           # local reset (interactive)
#   ./scripts/reset-local.sh --yes     # local reset (skip confirmation)
#   ./scripts/reset-local.sh remote    # remote DB + blob reset
#   ./scripts/reset-local.sh remote --yes
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse args
MODE="local"
SKIP_CONFIRM=false
for arg in "$@"; do
    case "$arg" in
        remote)    MODE="remote" ;;
        --yes|-y)  SKIP_CONFIRM=true ;;
    esac
done

# Load env file based on mode
if [[ "$MODE" == "remote" ]]; then
    ENV_FILE="${REPO_ROOT}/.env.remote"
else
    ENV_FILE="${REPO_ROOT}/.env"
fi
if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
fi

# Local runs may use either the Copilot SDK defaults under ~/.copilot or the
# legacy repo-local .tmp layout from older PilotSwarm builds.
LOCAL_TMP="${REPO_ROOT}/.tmp"
SESSION_STATE_DIR="${SESSION_STATE_DIR:-${LOCAL_TMP}/session-state}"
SESSION_STORE_DIR="${SESSION_STORE_DIR:-${LOCAL_TMP}/session-store}"
ARTIFACT_DIR="${ARTIFACT_DIR:-${LOCAL_TMP}/artifacts}"
DUROXIDE_SCHEMA="${DUROXIDE_SCHEMA:-duroxide}"
CMS_SCHEMA="${CMS_SCHEMA:-copilot_sessions}"
FACTS_SCHEMA="${FACTS_SCHEMA:-pilotswarm_facts}"

# ── Query CMS for summary counts ─────────────────────────────────
SESSION_IDS_FILE=$(mktemp)
trap 'rm -f "$SESSION_IDS_FILE"' EXIT

CMS_COUNT=0
FACT_COUNT=0
if [[ -n "${DATABASE_URL:-}" ]]; then
    node --env-file="$ENV_FILE" -e "
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
const quoteIdent = (value) => '\"' + String(value).replace(/\"/g, '\"\"') + '\"';
const ssl = ['require','prefer','verify-ca','verify-full'].includes(url.searchParams.get('sslmode') ?? '');
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
try {
    const cmsSchema = process.env.CMS_SCHEMA || 'copilot_sessions';
    const { rows } = await pool.query('SELECT session_id FROM ' + quoteIdent(cmsSchema) + '.sessions');
    for (const r of rows) console.log(r.session_id);
} catch {}
await pool.end();
" > "$SESSION_IDS_FILE" 2>/dev/null || true
    CMS_COUNT=$(wc -l < "$SESSION_IDS_FILE" | tr -d ' ')

    FACT_COUNT=$(node --env-file="$ENV_FILE" -e "
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
const quoteIdent = (value) => '\"' + String(value).replace(/\"/g, '\"\"') + '\"';
const ssl = ['require','prefer','verify-ca','verify-full'].includes(url.searchParams.get('sslmode') ?? '');
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
try {
    const factsSchema = process.env.FACTS_SCHEMA || 'pilotswarm_facts';
    const { rows } = await pool.query('SELECT COUNT(*)::text AS count FROM ' + quoteIdent(factsSchema) + '.facts');
    process.stdout.write(rows[0]?.count ?? '0');
} catch {
    process.stdout.write('0');
}
await pool.end();
" 2>/dev/null || echo "0")
fi

# ── Summary ──────────────────────────────────────────────────
STEP=1
echo ""
if [[ "$MODE" == "remote" ]]; then
    echo "🔄 PilotSwarm Remote Reset (env: .env.remote)"
else
    echo "🔄 PilotSwarm Local Reset"
fi
echo ""
echo "   This will:"
echo "     ${STEP}. DROP database schemas: ${DUROXIDE_SCHEMA}, ${CMS_SCHEMA}, ${FACTS_SCHEMA}"
STEP=$((STEP + 1))
echo "     ${STEP}. Delete ${FACT_COUNT} fact row(s) from ${FACTS_SCHEMA}.facts"
if [[ "$MODE" != "remote" ]]; then
    STEP=$((STEP + 1))
    echo "     ${STEP}. Delete local session files under ${SESSION_STATE_DIR}, ${SESSION_STORE_DIR}, ${ARTIFACT_DIR} for ${CMS_COUNT} known session(s)"
    STEP=$((STEP + 1))
    echo "     ${STEP}. Delete legacy .tmp/ (session-state, session-store, artifacts)"
fi
if [[ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]]; then
    STEP=$((STEP + 1))
    echo "     ${STEP}. Purge blob storage container: ${AZURE_STORAGE_CONTAINER:-copilot-sessions}"
fi
echo ""

# ── Confirmation ─────────────────────────────────────────────
if [[ "$SKIP_CONFIRM" != "true" ]]; then
    printf "   Are you sure? [y/N] "
    read -r answer
    if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
        echo "   Aborted."
        exit 0
    fi
fi

echo ""

# ── 1. Drop database schemas ─────────────────────────────────
if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "   ⚠️  DATABASE_URL not set — skipping database reset & targeted cleanup"
else
    # Drop schemas
    echo "   Dropping database schemas..."
    node --env-file="$ENV_FILE" -e "
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
const quoteIdent = (value) => '\"' + String(value).replace(/\"/g, '\"\"') + '\"';
const ssl = ['require','prefer','verify-ca','verify-full'].includes(url.searchParams.get('sslmode') ?? '');
url.searchParams.delete('sslmode');
const client = new pg.Client({ connectionString: url.toString(), ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
const duroxideSchema = process.env.DUROXIDE_SCHEMA || 'duroxide';
const cmsSchema = process.env.CMS_SCHEMA || 'copilot_sessions';
const factsSchema = process.env.FACTS_SCHEMA || 'pilotswarm_facts';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function terminateOtherBackends() {
    const { rows } = await client.query(
        'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()'
    );
    if (!rows.length) return 0;

    await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()'
    );
    return rows.length;
}

async function dropSchema(schemaName) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await client.query('DROP SCHEMA IF EXISTS ' + quoteIdent(schemaName) + ' CASCADE');
            console.log('   ✅ ' + schemaName + ' schema dropped');
            return;
        } catch (err) {
            const retriable = err?.code === '40P01' || err?.code === '55P03';
            if (!retriable || attempt === 3) throw err;

            const terminated = await terminateOtherBackends();
            console.log(
                '   ⚠️  Retrying ' + schemaName + ' schema drop after ' + err.code +
                ' (' + terminated + ' backend(s) terminated)'
            );
            await sleep(250 * attempt);
        }
    }
}

await client.connect();
const terminated = await terminateOtherBackends();
if (terminated > 0) {
    console.log('   ✅ Terminated ' + terminated + ' other PostgreSQL backend(s) on current database');
}
await dropSchema(duroxideSchema);
await dropSchema(cmsSchema);
await dropSchema(factsSchema);
await client.end();
"
fi

# ── 2. Delete local session state ───────────────────────────
if [[ "$MODE" == "remote" ]]; then
    echo "   (skipping local filesystem cleanup — remote mode)"
else
SESSION_FILE_CLEAN_COUNT=0
if [[ -s "$SESSION_IDS_FILE" ]]; then
    while IFS= read -r session_id; do
        [[ -z "$session_id" ]] && continue

        rm -rf "${SESSION_STATE_DIR}/${session_id}"
        rm -f "${SESSION_STORE_DIR}/${session_id}.tar.gz"
        rm -f "${SESSION_STORE_DIR}/${session_id}.meta.json"
        rm -rf "${ARTIFACT_DIR}/${session_id}"
        SESSION_FILE_CLEAN_COUNT=$((SESSION_FILE_CLEAN_COUNT + 1))
    done < "$SESSION_IDS_FILE"
fi

if [[ "$SESSION_FILE_CLEAN_COUNT" -gt 0 ]]; then
    echo "   ✅ Deleted local session files for ${SESSION_FILE_CLEAN_COUNT} known session(s)"
else
    echo "   ✅ No local session files matched known session IDs"
fi

if [[ -d "$LOCAL_TMP" ]]; then
    rm -rf "${LOCAL_TMP:?}"
    echo "   ✅ Deleted legacy .tmp/ (session-state, session-store, artifacts)"
else
    echo "   ✅ No legacy .tmp/ directory to clean"
fi

# end local-only cleanup
fi

# ── 3. Blob storage purge (if configured) ───────────────────
if [[ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]]; then
    echo "   Purging blob storage..."
    node --env-file="$ENV_FILE" -e "
import { BlobServiceClient } from '@azure/storage-blob';
const container = process.env.AZURE_STORAGE_CONTAINER || 'copilot-sessions';
const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const ctr = svc.getContainerClient(container);
let count = 0;
for await (const blob of ctr.listBlobsFlat()) { await ctr.deleteBlob(blob.name); count++; }
console.log(count > 0 ? '   ✅ Purged ' + count + ' blob(s)' : '   ✅ Blob container already empty');
" 2>/dev/null || echo "   ⚠️  Blob purge failed (container may not exist)"
fi

echo ""
echo "   Done. Everything is clean — schemas will be recreated on next start."

# ── 7. Rebuild and redeploy AKS workers (remote mode only) ──
if [[ "$MODE" == "remote" ]]; then
    K8S_CTX="${K8S_CONTEXT:-toygres-aks}"
    K8S_NS="${K8S_NAMESPACE:-copilot-runtime}"
    echo ""
    echo "   Rebuilding and redeploying AKS workers..."
    echo "   (context: ${K8S_CTX}, namespace: ${K8S_NS})"
    echo ""

    # Build TypeScript
    echo "   Building TypeScript..."
    npm run build -w packages/sdk 2>/dev/null || { echo "   ⚠️  TypeScript build failed"; }

    # Build and push Docker image
    REGISTRY="${ACR_REGISTRY:-toygresaksacr.azurecr.io}"
    IMAGE="${REGISTRY}/copilot-runtime-worker:latest"
    echo "   Building and pushing Docker image..."
    az acr login --name "${REGISTRY%%.*}" 2>/dev/null
    docker buildx build --platform linux/amd64 -t "$IMAGE" -f deploy/Dockerfile.worker --push . 2>/dev/null \
        && echo "   ✅ Image pushed: ${IMAGE}" \
        || { echo "   ⚠️  Docker build/push failed — falling back to pod restart only"; }

    # Apply k8s manifests and restart
    kubectl --context "$K8S_CTX" apply -f deploy/k8s/namespace.yaml 2>/dev/null
    kubectl --context "$K8S_CTX" apply -f deploy/k8s/worker-deployment.yaml 2>/dev/null
    kubectl --context "$K8S_CTX" -n "$K8S_NS" rollout restart deployment/copilot-runtime-worker 2>/dev/null

    echo "   Waiting for rollout..."
    if kubectl --context "$K8S_CTX" -n "$K8S_NS" rollout status deployment/copilot-runtime-worker --timeout=90s 2>/dev/null; then
        echo "   ✅ Workers redeployed"
    else
        echo "   ⚠️  Rollout timed out — check with: kubectl --context $K8S_CTX -n $K8S_NS get pods"
    fi
fi

echo ""
