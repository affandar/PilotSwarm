#!/bin/bash
# Deploy PilotSwarm web portal to AKS.
#
# Usage:
#   ./scripts/deploy-portal.sh                # full deploy (build + push + apply)
#   ./scripts/deploy-portal.sh --skip-build   # skip Docker build (re-use existing image)
#
# Prerequisites:
#   - .env.remote with DATABASE_URL, PORTAL_AUTH_PROVIDER, PORTAL_AUTH_ENTRA_TENANT_ID,
#     PORTAL_AUTH_ENTRA_CLIENT_ID, K8S_CONTEXT
#   - az CLI logged in, ACR accessible
#   - kubectl configured for your AKS cluster

set -euo pipefail
cd "$(dirname "$0")/.."

# ─── Configuration ────────────────────────────────────────────────

IMAGE_NAME="pilotswarm-portal"

SKIP_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done

# ─── Load env ─────────────────────────────────────────────────────

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
    echo "ERROR: DATABASE_URL not set."
    exit 1
fi

ACR_NAME="${ACR_NAME:-pilotswarmacr}"
NAMESPACE="${K8S_NAMESPACE:-${NAMESPACE:-copilot-runtime}}"
K8S_CONTEXT="${K8S_CONTEXT:-}"
PORTAL_AUTH_PROVIDER="${PORTAL_AUTH_PROVIDER:-none}"

if [ "$PORTAL_AUTH_PROVIDER" = "entra" ]; then
    if [ -z "${PORTAL_AUTH_ENTRA_TENANT_ID:-}" ] || [ -z "${PORTAL_AUTH_ENTRA_CLIENT_ID:-}" ]; then
        echo "ERROR: PORTAL_AUTH_ENTRA_TENANT_ID and PORTAL_AUTH_ENTRA_CLIENT_ID must be set in $ENV_FILE when PORTAL_AUTH_PROVIDER=entra."
        exit 1
    fi
fi

KUBECTL=(kubectl)
if [ -n "$K8S_CONTEXT" ]; then
    KUBECTL+=(--context "$K8S_CONTEXT")
fi

# ─── Step 1: Build TypeScript ─────────────────────────────────────

echo ""
echo "🔨 Building TypeScript..."
npm run build -w packages/sdk

# ─── Step 2: Update K8s secrets ───────────────────────────────────

echo ""
echo ""
echo "🔑 Updating K8s secrets (including portal auth vars)..."

GH_TOKEN="${GITHUB_TOKEN:-}"

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
    ${PORTAL_AUTH_PROVIDER:+--from-literal=PORTAL_AUTH_PROVIDER="$PORTAL_AUTH_PROVIDER"} \
    ${PORTAL_AUTH_ENTRA_TENANT_ID:+--from-literal=PORTAL_AUTH_ENTRA_TENANT_ID="$PORTAL_AUTH_ENTRA_TENANT_ID"} \
    ${PORTAL_AUTH_ENTRA_CLIENT_ID:+--from-literal=PORTAL_AUTH_ENTRA_CLIENT_ID="$PORTAL_AUTH_ENTRA_CLIENT_ID"} \
    ${PORTAL_AUTHZ_DEFAULT_ROLE:+--from-literal=PORTAL_AUTHZ_DEFAULT_ROLE="$PORTAL_AUTHZ_DEFAULT_ROLE"} \
    ${PORTAL_AUTHZ_ADMIN_GROUPS:+--from-literal=PORTAL_AUTHZ_ADMIN_GROUPS="$PORTAL_AUTHZ_ADMIN_GROUPS"} \
    ${PORTAL_AUTHZ_USER_GROUPS:+--from-literal=PORTAL_AUTHZ_USER_GROUPS="$PORTAL_AUTHZ_USER_GROUPS"} \
    ${PORTAL_AUTH_ALLOW_UNAUTHENTICATED:+--from-literal=PORTAL_AUTH_ALLOW_UNAUTHENTICATED="$PORTAL_AUTH_ALLOW_UNAUTHENTICATED"} \
    ${PORTAL_AUTH_ENTRA_ADMIN_GROUPS:+--from-literal=PORTAL_AUTH_ENTRA_ADMIN_GROUPS="$PORTAL_AUTH_ENTRA_ADMIN_GROUPS"} \
    ${PORTAL_AUTH_ENTRA_USER_GROUPS:+--from-literal=PORTAL_AUTH_ENTRA_USER_GROUPS="$PORTAL_AUTH_ENTRA_USER_GROUPS"} \
    ${K8S_CONTEXT:+--from-literal=K8S_CONTEXT="$K8S_CONTEXT"}

echo "🔐 Refreshing ACR pull secret..."
ACR_SERVER="${ACR_NAME}.azurecr.io"
ACR_REFRESH_TOKEN="$(az acr login --name "$ACR_NAME" --expose-token --output tsv --query accessToken)"
"${KUBECTL[@]}" delete secret acr-pull -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
"${KUBECTL[@]}" create secret docker-registry acr-pull \
    -n "$NAMESPACE" \
    --docker-server="$ACR_SERVER" \
    --docker-username="00000000-0000-0000-0000-000000000000" \
    --docker-password="$ACR_REFRESH_TOKEN"

# ─── Step 3: Build and push Docker image ─────────────────────────

if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo "🐳 Building and pushing portal Docker image..."
    az acr login --name "$ACR_NAME"
    docker buildx build \
        --platform linux/amd64 \
        -f deploy/Dockerfile.portal \
        -t "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest" \
        --push .
    echo "   ✅ Image pushed: ${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest"
else
    echo "⏭️  Skipping Docker build (--skip-build)"
fi

# ─── Step 4: Deploy to AKS ───────────────────────────────────────

echo ""
echo "🚀 Deploying portal to AKS..."

# Ensure namespace exists
"${KUBECTL[@]}" apply -f deploy/k8s/namespace.yaml

# Apply portal deployment + service + canonical ingress
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g" deploy/k8s/portal-deployment.yaml | "${KUBECTL[@]}" apply -f -
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g" deploy/k8s/portal-ingress.yaml | "${KUBECTL[@]}" apply -f -

# Rollout restart to pick up new image
"${KUBECTL[@]}" rollout restart deployment/pilotswarm-portal -n "$NAMESPACE" 2>/dev/null || true

echo ""
echo "⏳ Waiting for rollout..."
"${KUBECTL[@]}" rollout status deployment/pilotswarm-portal -n "$NAMESPACE" --timeout=180s

# ─── Step 5: Verify ingress-facing portal resources ──────────────

HEALTH_URL="https://pilotswarm-portal.westus3.cloudapp.azure.com/api/health"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "  ✅ PilotSwarm Portal deployed!"
echo ""
echo "  Portal URL:      $HEALTH_URL"
echo "  Ingress:         pilotswarm-portal-ingress"
echo "  TLS secret:      keyvault-pilotswarm-portal-tls"
echo ""
echo "  Verify:"
echo "    ${KUBECTL[*]} get pods -n $NAMESPACE -l app.kubernetes.io/component=portal"
echo "    ${KUBECTL[*]} get ingress pilotswarm-portal-ingress -n $NAMESPACE"
echo "    ${KUBECTL[*]} get certificate keyvault-pilotswarm-portal-tls -n $NAMESPACE"
echo "    curl -sS $HEALTH_URL"
echo ""
echo "══════════════════════════════════════════════════════════════"
