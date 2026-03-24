#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# reset-local.sh — Full reset for PilotSwarm
#
# Drops duroxide + CMS schemas, purges local session state
# (tar archives, copilot session dirs), and optionally
# cleans blob storage.
#
# Usage:
#   ./scripts/reset-local.sh           # local reset (interactive)
#   ./scripts/reset-local.sh --yes     # local reset (skip confirmation)
#   ./scripts/reset-local.sh remote    # remote DB + blob reset
#   ./scripts/reset-local.sh remote --yes
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_PLUGINS_DIR="$REPO_ROOT/packages/sdk/plugins"
export REPO_ROOT SDK_PLUGINS_DIR

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

SESSION_STATE_DIR="${SESSION_STATE_DIR:-$HOME/.copilot/session-state}"
SESSION_STORE_DIR="${SESSION_STORE_DIR:-$(dirname "$SESSION_STATE_DIR")/session-store}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(dirname "$SESSION_STATE_DIR")/artifacts}"
DEFAULT_SESSION_STORE_DIR="$HOME/.copilot/session-store"
DEFAULT_ARTIFACT_DIR="$HOME/.copilot/artifacts"
DUROXIDE_SCHEMA="${DUROXIDE_SCHEMA:-duroxide}"
CMS_SCHEMA="${CMS_SCHEMA:-copilot_sessions}"
FACTS_SCHEMA="${FACTS_SCHEMA:-pilotswarm_facts}"

# ── Query CMS session IDs early (for summary + targeted cleanup) ─
SESSION_IDS_FILE=$(mktemp)
STORE_ARCHIVE_PATHS_FILE=$(mktemp)
STORE_META_PATHS_FILE=$(mktemp)
trap 'rm -f "$SESSION_IDS_FILE" "$STORE_ARCHIVE_PATHS_FILE" "$STORE_META_PATHS_FILE"' EXIT

STORE_DIRS=()
add_store_dir() {
    local dir="$1"
    [[ -z "$dir" ]] && return
    for existing in "${STORE_DIRS[@]:-}"; do
        [[ "$existing" == "$dir" ]] && return
    done
    STORE_DIRS+=("$dir")
}

add_store_dir "$SESSION_STORE_DIR"
add_store_dir "$(dirname "$SESSION_STATE_DIR")/session-store"
add_store_dir "$DEFAULT_SESSION_STORE_DIR"

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

# Add deterministic system-agent IDs from built-in and configured plugins.
node --input-type=module - <<'EOF' >> "$SESSION_IDS_FILE" 2>/dev/null || true
import fs from 'node:fs';
import path from 'node:path';
import { loadAgentFiles, systemAgentUUID, systemChildAgentUUID } from '../packages/sdk/dist/agent-loader.js';

const repoRoot = process.env.REPO_ROOT;
const sdkPluginsDir = process.env.SDK_PLUGINS_DIR;
const pluginDirsEnv = process.env.PLUGIN_DIRS || '';

const candidatePluginDirs = [
    path.join(sdkPluginsDir, 'system'),
    path.join(sdkPluginsDir, 'mgmt'),
    ...pluginDirsEnv.split(path.delimiter).filter(Boolean).map(p => path.resolve(repoRoot, p)),
];

const allAgents = [];
for (const dir of candidatePluginDirs) {
    const agentsDir = path.join(dir, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    try {
        allAgents.push(...loadAgentFiles(agentsDir).filter(a => a.system));
    } catch {}
}

const byId = new Map(allAgents.filter(a => a.id).map(a => [a.id, a]));

function emitAgent(id, parentSessionId = null, seen = new Set()) {
    const key = `${parentSessionId || 'root'}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);

    const sessionId = parentSessionId ? systemChildAgentUUID(parentSessionId, id) : systemAgentUUID(id);
    console.log(sessionId);

    for (const agent of allAgents) {
        if (agent.parent === id && agent.id) {
            emitAgent(agent.id, sessionId, seen);
        }
    }
}

for (const agent of allAgents) {
    if (agent.id && !agent.parent) emitAgent(agent.id);
}
EOF

# Deduplicate the collected session IDs.
if [[ -s "$SESSION_IDS_FILE" ]]; then
        sort -u "$SESSION_IDS_FILE" -o "$SESSION_IDS_FILE"
fi

# Count how many CMS sessions have a matching local dir
LOCAL_MATCH_COUNT=0
if [[ -d "$SESSION_STATE_DIR" && -s "$SESSION_IDS_FILE" ]]; then
    while IFS= read -r sid; do
        [[ -d "${SESSION_STATE_DIR}/${sid}" ]] && LOCAL_MATCH_COUNT=$((LOCAL_MATCH_COUNT + 1))
    done < "$SESSION_IDS_FILE"
fi

# Count matching filesystem session-store archives/meta across relevant local dirs
STORE_MATCH_COUNT=0
STORE_META_MATCH_COUNT=0
if [[ -s "$SESSION_IDS_FILE" ]]; then
    for store_dir in "${STORE_DIRS[@]}"; do
        [[ -d "$store_dir" ]] || continue
        while IFS= read -r sid; do
            [[ -f "${store_dir}/${sid}.tar.gz" ]] && echo "${store_dir}/${sid}.tar.gz" >> "$STORE_ARCHIVE_PATHS_FILE"
            [[ -f "${store_dir}/${sid}.meta.json" ]] && echo "${store_dir}/${sid}.meta.json" >> "$STORE_META_PATHS_FILE"
        done < "$SESSION_IDS_FILE"
    done
fi

if [[ -s "$STORE_ARCHIVE_PATHS_FILE" ]]; then
    sort -u "$STORE_ARCHIVE_PATHS_FILE" -o "$STORE_ARCHIVE_PATHS_FILE"
    STORE_MATCH_COUNT=$(wc -l < "$STORE_ARCHIVE_PATHS_FILE" | tr -d ' ')
fi
if [[ -s "$STORE_META_PATHS_FILE" ]]; then
    sort -u "$STORE_META_PATHS_FILE" -o "$STORE_META_PATHS_FILE"
    STORE_META_MATCH_COUNT=$(wc -l < "$STORE_META_PATHS_FILE" | tr -d ' ')
fi

# Count matching local artifact dirs
ARTIFACT_DIRS=()
add_artifact_dir() {
    local dir="$1"
    [[ -z "$dir" ]] && return
    for existing in "${ARTIFACT_DIRS[@]:-}"; do
        [[ "$existing" == "$dir" ]] && return
    done
    ARTIFACT_DIRS+=("$dir")
}
add_artifact_dir "$ARTIFACT_DIR"
add_artifact_dir "$DEFAULT_ARTIFACT_DIR"

ARTIFACT_MATCH_COUNT=0
if [[ -s "$SESSION_IDS_FILE" ]]; then
    for art_dir in "${ARTIFACT_DIRS[@]}"; do
        [[ -d "$art_dir" ]] || continue
        while IFS= read -r sid; do
            [[ -d "${art_dir}/${sid}" ]] && ARTIFACT_MATCH_COUNT=$((ARTIFACT_MATCH_COUNT + 1))
        done < "$SESSION_IDS_FILE"
    done
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
    echo "     ${STEP}. Delete ${LOCAL_MATCH_COUNT} local session dir(s) matching ${CMS_COUNT} CMS session(s)"
    echo "        (other Copilot sessions in ${SESSION_STATE_DIR} are kept)"
    STEP=$((STEP + 1))
    echo "     ${STEP}. Delete ${STORE_MATCH_COUNT} matching filesystem session-store archive(s)"
    if [[ "$STORE_MATCH_COUNT" -gt 0 || "$STORE_META_MATCH_COUNT" -gt 0 ]]; then
        echo "        and ${STORE_META_MATCH_COUNT} matching metadata file(s) from local session-store dirs"
    else
        echo "        from local session-store dirs (none currently matched)"
    fi
    STEP=$((STEP + 1))
    echo "     ${STEP}. Delete ${ARTIFACT_MATCH_COUNT} local artifact dir(s) for cleaned-up sessions"
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
const pool = new pg.Pool({ connectionString: url.toString(), ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
const duroxideSchema = process.env.DUROXIDE_SCHEMA || 'duroxide';
const cmsSchema = process.env.CMS_SCHEMA || 'copilot_sessions';
const factsSchema = process.env.FACTS_SCHEMA || 'pilotswarm_facts';
await pool.query('DROP SCHEMA IF EXISTS ' + quoteIdent(duroxideSchema) + ' CASCADE');
console.log('   ✅ ' + duroxideSchema + ' schema dropped');
await pool.query('DROP SCHEMA IF EXISTS ' + quoteIdent(cmsSchema) + ' CASCADE');
console.log('   ✅ ' + cmsSchema + ' schema dropped');
await pool.query('DROP SCHEMA IF EXISTS ' + quoteIdent(factsSchema) + ' CASCADE');
console.log('   ✅ ' + factsSchema + ' schema dropped');
await pool.end();
"
fi

# ── 2. Delete only local session dirs that were in the CMS ──
if [[ "$MODE" == "remote" ]]; then
    echo "   (skipping local filesystem cleanup — remote mode)"
else
if [[ -d "$SESSION_STATE_DIR" && -s "$SESSION_IDS_FILE" ]]; then
    DELETED=0
    while IFS= read -r sid; do
        if [[ -d "${SESSION_STATE_DIR}/${sid}" ]]; then
            rm -rf "${SESSION_STATE_DIR:?}/${sid}"
            DELETED=$((DELETED + 1))
        fi
    done < "$SESSION_IDS_FILE"
    echo "   ✅ Deleted ${DELETED} local session dir(s) (kept non-PilotSwarm sessions)"
elif [[ ! -s "$SESSION_IDS_FILE" ]]; then
    echo "   ✅ No CMS sessions found — local session state untouched"
else
    echo "   ✅ No local session state dir to clean"
fi

# ── 3. Delete matching local session-store archives ─────────
if [[ -s "$STORE_ARCHIVE_PATHS_FILE" || -s "$STORE_META_PATHS_FILE" ]]; then
    DELETED_STORE=0
    DELETED_STORE_META=0
    if [[ -s "$STORE_ARCHIVE_PATHS_FILE" ]]; then
        while IFS= read -r archive_path; do
            rm -f "$archive_path"
            DELETED_STORE=$((DELETED_STORE + 1))
        done < "$STORE_ARCHIVE_PATHS_FILE"
    fi
    if [[ -s "$STORE_META_PATHS_FILE" ]]; then
        while IFS= read -r meta_path; do
            rm -f "$meta_path"
            DELETED_STORE_META=$((DELETED_STORE_META + 1))
        done < "$STORE_META_PATHS_FILE"
    fi
    echo "   ✅ Deleted ${DELETED_STORE} local session-store archive(s) and ${DELETED_STORE_META} metadata file(s)"
else
    echo "   ✅ No matching local session-store archives to clean"
fi

# ── 4. Delete local artifact dirs matching CMS sessions ─────
if [[ -s "$SESSION_IDS_FILE" ]]; then
    DELETED_ARTIFACTS=0
    for art_dir in "${ARTIFACT_DIRS[@]}"; do
        [[ -d "$art_dir" ]] || continue
        while IFS= read -r sid; do
            if [[ -d "${art_dir}/${sid}" ]]; then
                rm -rf "${art_dir:?}/${sid}"
                DELETED_ARTIFACTS=$((DELETED_ARTIFACTS + 1))
            fi
        done < "$SESSION_IDS_FILE"
    done
    echo "   ✅ Deleted ${DELETED_ARTIFACTS} local artifact dir(s)"
else
    echo "   ✅ No artifact dirs to clean"
fi

# ── 5. Clean up any stray .tar files ────────────────────────
TAR_COUNT=$(find "$REPO_ROOT" -maxdepth 3 -name "*.tar" -o -name "*.tar.gz" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$TAR_COUNT" -gt 0 ]]; then
    echo "   Removing ${TAR_COUNT} tar file(s) under repo root..."
    find "$REPO_ROOT" -maxdepth 3 \( -name "*.tar" -o -name "*.tar.gz" \) -delete
    echo "   ✅ Tar files removed"
fi
# end local-only cleanup
fi

# ── 6. Blob storage purge (if configured) ───────────────────
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
    docker build -t "$IMAGE" -f deploy/Dockerfile.worker --push . 2>/dev/null \
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
