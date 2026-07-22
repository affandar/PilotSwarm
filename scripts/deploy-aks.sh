#!/bin/bash
# Deploy pilotswarm workers to AKS.
#
# This script NEVER touches data. Deploys are always non-destructive:
# existing sessions, orchestrations, and facts survive every deploy.
# A database reset is a separate, deliberate operation — see
# scripts/reset-db-aks.sh, which must be invoked explicitly and only
# when the user has explicitly asked for a data reset.
#
# Usage:
#   ./scripts/deploy-aks.sh                     # full deploy (test + build + push + apply)
#   ./scripts/deploy-aks.sh --skip-build        # skip Docker build (re-use existing image)
#   ./scripts/deploy-aks.sh --skip-tests        # skip local integration tests
#
# Prerequisites:
#   - .env.remote with DATABASE_URL
#   - az CLI logged in, ACR accessible
#   - kubectl configured for your AKS cluster

set -euo pipefail
cd "$(dirname "$0")/.."

# Parse flags
SKIP_BUILD=false
SKIP_TESTS=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --skip-tests) SKIP_TESTS=true ;;
        --skip-reset)
            # Legacy flag from when deploys reset the DB by default. Deploys
            # no longer reset anything, so this is a harmless no-op.
            echo "ℹ️  --skip-reset is obsolete: deploys never reset the database." ;;
        --reset|--db-reset)
            echo "❌ Deploys do not reset data. Run scripts/reset-db-aks.sh explicitly if a wipe is truly intended."
            exit 1 ;;
    esac
done

# ─── Load env ─────────────────────────────────────────────────────
# .env files may contain special chars (!, %, &) in URLs.
# Use a safe line-by-line parser instead of `source`.

ENV_FILE=""
if [ -f .env.remote ]; then
    ENV_FILE=".env.remote"
elif [ -f .env ]; then
    ENV_FILE=".env"
fi

if [ -n "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip comments and blank lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        # Export key=value (preserving special chars in value)
        export "$line"
    done < "$ENV_FILE"
fi

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL not set. Create .env.remote or .env with DATABASE_URL."
    exit 1
fi

# ─── Configuration ────────────────────────────────────────────────

ACR_NAME="${ACR_NAME:-pilotswarmacr}"
IMAGE_NAME="${IMAGE_NAME:-copilot-runtime-worker}"
NAMESPACE="${K8S_NAMESPACE:-${NAMESPACE:-copilot-runtime}}"
K8S_CONTEXT="${K8S_CONTEXT:-}"

KUBECTL=(kubectl)
if [ -n "$K8S_CONTEXT" ]; then
    KUBECTL+=(--context "$K8S_CONTEXT")
fi

# ─── Update K8s secret ────────────────────────────────────────────

# GitHub token is optional — only include if explicitly set in env.
# BYOK providers (Azure AI, etc.) work without it.
GH_TOKEN="${GITHUB_TOKEN:-}"

echo "🔑 Replacing K8s secret..."
"${KUBECTL[@]}" delete secret copilot-runtime-secrets -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
"${KUBECTL[@]}" create secret generic copilot-runtime-secrets \
    -n "$NAMESPACE" \
    --from-literal=DATABASE_URL="$DATABASE_URL" \
    ${GH_TOKEN:+--from-literal=GITHUB_TOKEN="$GH_TOKEN"} \
    ${DUROXIDE_PG_POOL_MAX:+--from-literal=DUROXIDE_PG_POOL_MAX="$DUROXIDE_PG_POOL_MAX"} \
    ${PILOTSWARM_CMS_PG_POOL_MAX:+--from-literal=PILOTSWARM_CMS_PG_POOL_MAX="$PILOTSWARM_CMS_PG_POOL_MAX"} \
    ${PILOTSWARM_FACTS_PG_POOL_MAX:+--from-literal=PILOTSWARM_FACTS_PG_POOL_MAX="$PILOTSWARM_FACTS_PG_POOL_MAX"} \
    ${PILOTSWARM_ORCHESTRATION_CONCURRENCY:+--from-literal=PILOTSWARM_ORCHESTRATION_CONCURRENCY="$PILOTSWARM_ORCHESTRATION_CONCURRENCY"} \
    ${PILOTSWARM_WORKER_CONCURRENCY:+--from-literal=PILOTSWARM_WORKER_CONCURRENCY="$PILOTSWARM_WORKER_CONCURRENCY"} \
    ${PILOTSWARM_DUROXIDE_SCHEMA:+--from-literal=PILOTSWARM_DUROXIDE_SCHEMA="$PILOTSWARM_DUROXIDE_SCHEMA"} \
    ${AZURE_STORAGE_CONNECTION_STRING:+--from-literal=AZURE_STORAGE_CONNECTION_STRING="$AZURE_STORAGE_CONNECTION_STRING"} \
    ${AZURE_STORAGE_CONTAINER:+--from-literal=AZURE_STORAGE_CONTAINER="$AZURE_STORAGE_CONTAINER"} \
    ${LLM_ENDPOINT:+--from-literal=LLM_ENDPOINT="$LLM_ENDPOINT"} \
    ${LLM_API_KEY:+--from-literal=LLM_API_KEY="$LLM_API_KEY"} \
    ${LLM_PROVIDER_TYPE:+--from-literal=LLM_PROVIDER_TYPE="$LLM_PROVIDER_TYPE"} \
    ${LLM_API_VERSION:+--from-literal=LLM_API_VERSION="$LLM_API_VERSION"} \
    ${AZURE_FW_GLM5_KEY:+--from-literal=AZURE_FW_GLM5_KEY="$AZURE_FW_GLM5_KEY"} \
    ${AZURE_KIMI_K25_KEY:+--from-literal=AZURE_KIMI_K25_KEY="$AZURE_KIMI_K25_KEY"} \
    ${AZURE_OAI_KEY:+--from-literal=AZURE_OAI_KEY="$AZURE_OAI_KEY"} \
    ${AZURE_GPT51_KEY:+--from-literal=AZURE_GPT51_KEY="$AZURE_GPT51_KEY"} \
    ${AZURE_MODEL_ROUTER_KEY:+--from-literal=AZURE_MODEL_ROUTER_KEY="$AZURE_MODEL_ROUTER_KEY"} \
    ${ANTHROPIC_API_KEY:+--from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
    ${HORIZON_DATABASE_URL:+--from-literal=HORIZON_DATABASE_URL="$HORIZON_DATABASE_URL"} \
    ${HORIZON_FACTS_SCHEMA:+--from-literal=HORIZON_FACTS_SCHEMA="$HORIZON_FACTS_SCHEMA"} \
    ${HORIZON_GRAPH_DATABASE_URL:+--from-literal=HORIZON_GRAPH_DATABASE_URL="$HORIZON_GRAPH_DATABASE_URL"} \
    ${HORIZON_GRAPH_SCHEMA:+--from-literal=HORIZON_GRAPH_SCHEMA="$HORIZON_GRAPH_SCHEMA"} \
    ${HORIZON_EMBED_URL:+--from-literal=HORIZON_EMBED_URL="$HORIZON_EMBED_URL"} \
    ${HORIZON_EMBED_MODEL:+--from-literal=HORIZON_EMBED_MODEL="$HORIZON_EMBED_MODEL"} \
    ${HORIZON_EMBED_DIM:+--from-literal=HORIZON_EMBED_DIM="$HORIZON_EMBED_DIM"} \
    ${HORIZON_EMBED_API_KEY:+--from-literal=HORIZON_EMBED_API_KEY="$HORIZON_EMBED_API_KEY"} \
    ${HORIZON_EMBED_API_KEY_HEADER:+--from-literal=HORIZON_EMBED_API_KEY_HEADER="$HORIZON_EMBED_API_KEY_HEADER"} \
    ${HORIZON_EMBED_BEARER:+--from-literal=HORIZON_EMBED_BEARER="$HORIZON_EMBED_BEARER"} \
    ${PORTAL_AUTH_PROVIDER:+--from-literal=PORTAL_AUTH_PROVIDER="$PORTAL_AUTH_PROVIDER"} \
    ${PORTAL_AUTH_ENTRA_TENANT_ID:+--from-literal=PORTAL_AUTH_ENTRA_TENANT_ID="$PORTAL_AUTH_ENTRA_TENANT_ID"} \
    ${PORTAL_AUTH_ENTRA_CLIENT_ID:+--from-literal=PORTAL_AUTH_ENTRA_CLIENT_ID="$PORTAL_AUTH_ENTRA_CLIENT_ID"} \
    ${PORTAL_AUTHZ_DEFAULT_ROLE:+--from-literal=PORTAL_AUTHZ_DEFAULT_ROLE="$PORTAL_AUTHZ_DEFAULT_ROLE"} \
    ${PORTAL_AUTHZ_ADMIN_GROUPS:+--from-literal=PORTAL_AUTHZ_ADMIN_GROUPS="$PORTAL_AUTHZ_ADMIN_GROUPS"} \
    ${PORTAL_AUTHZ_USER_GROUPS:+--from-literal=PORTAL_AUTHZ_USER_GROUPS="$PORTAL_AUTHZ_USER_GROUPS"} \
    ${PORTAL_AUTH_ALLOW_UNAUTHENTICATED:+--from-literal=PORTAL_AUTH_ALLOW_UNAUTHENTICATED="$PORTAL_AUTH_ALLOW_UNAUTHENTICATED"} \
    ${PORTAL_AUTH_ENTRA_ADMIN_GROUPS:+--from-literal=PORTAL_AUTH_ENTRA_ADMIN_GROUPS="$PORTAL_AUTH_ENTRA_ADMIN_GROUPS"} \
    ${PORTAL_AUTH_ENTRA_USER_GROUPS:+--from-literal=PORTAL_AUTH_ENTRA_USER_GROUPS="$PORTAL_AUTH_ENTRA_USER_GROUPS"} \
    ${AUTHZ_ENFORCE_OWNERSHIP:+--from-literal=AUTHZ_ENFORCE_OWNERSHIP="$AUTHZ_ENFORCE_OWNERSHIP"} \
    ${SESSIONS_DEFAULT_VISIBILITY:+--from-literal=SESSIONS_DEFAULT_VISIBILITY="$SESSIONS_DEFAULT_VISIBILITY"} \
    ${SESSIONS_SYSTEM_VISIBILITY:+--from-literal=SESSIONS_SYSTEM_VISIBILITY="$SESSIONS_SYSTEM_VISIBILITY"} \
    ${K8S_CONTEXT:+--from-literal=K8S_CONTEXT="$K8S_CONTEXT"}

# ─── Step 0: Run local integration tests ─────────────────────────

if [ "$SKIP_TESTS" = false ]; then
    echo ""
    echo "🧪 Running local integration tests (gate)..."
    if ! ./scripts/run-tests.sh --all-providers; then
        echo ""
        echo "❌ Tests failed — aborting deploy."
        echo "   Fix failing tests before deploying to AKS."
        echo "   To skip: ./scripts/deploy-aks.sh --skip-tests"
        exit 1
    fi
    echo ""
else
    echo "⏭️  Skipping tests (--skip-tests)"
fi

# ─── Step 2: Build TypeScript ─────────────────────────────────────

echo ""
echo "🔨 Building TypeScript..."
npm run build -w packages/sdk

# ─── Step 3: Build and push Docker image ─────────────────────────

if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo "🐳 Building and pushing Docker image..."
    az acr login --name "$ACR_NAME"
    docker buildx build \
        --platform linux/amd64 \
        -f deploy/Dockerfile.worker \
        -t "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest" \
        --push .
    echo "   ✅ Image pushed: ${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest"
else
    echo "⏭️  Skipping Docker build (--skip-build)"
fi

# ─── Step 4: Deploy to AKS ───────────────────────────────────────

echo ""
echo "🚀 Deploying to AKS..."

# Ensure namespace exists (substitute NAMESPACE into the template)
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g; s/name: copilot-runtime$/name: $NAMESPACE/" deploy/k8s/namespace.yaml | "${KUBECTL[@]}" apply -f -

# Apply worker deployment (substitute NAMESPACE into the template)
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g" deploy/k8s/worker-deployment.yaml | "${KUBECTL[@]}" apply -f -

# Rollout restart to pick up the new image
"${KUBECTL[@]}" rollout restart deployment/copilot-runtime-worker -n "$NAMESPACE"

echo ""
echo "⏳ Waiting for rollout..."
"${KUBECTL[@]}" rollout status deployment/copilot-runtime-worker -n "$NAMESPACE" --timeout=120s

echo ""
echo "✅ Deploy complete!"
echo ""
"${KUBECTL[@]}" get pods -n "$NAMESPACE" -l app.kubernetes.io/component=worker
echo ""
