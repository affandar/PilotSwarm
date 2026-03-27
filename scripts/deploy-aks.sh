#!/bin/bash
# Deploy pilotswarm workers to AKS.
#
# Cleans up ALL existing orchestrations (duroxide + CMS) before deploying.
# This avoids orchestration versioning issues when changing parameters.
#
# Usage:
#   ./scripts/deploy-aks.sh                     # full deploy (test + reset + build + push + apply)
#   ./scripts/deploy-aks.sh --skip-build        # skip Docker build (re-use existing image)
#   ./scripts/deploy-aks.sh --skip-reset        # skip DB reset (keep existing sessions)
#   ./scripts/deploy-aks.sh --skip-tests        # skip local integration tests
#
# Prerequisites:
#   - .env.remote with DATABASE_URL
#   - az CLI logged in, ACR accessible
#   - kubectl configured for your AKS cluster

set -euo pipefail
cd "$(dirname "$0")/.."

# ─── Configuration ────────────────────────────────────────────────

ACR_NAME="${ACR_NAME:-toygresaksacr}"
IMAGE_NAME="${IMAGE_NAME:-copilot-runtime-worker}"
NAMESPACE="${NAMESPACE:-copilot-runtime}"

# Parse flags
SKIP_BUILD=false
SKIP_RESET=false
SKIP_TESTS=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --skip-reset) SKIP_RESET=true ;;
        --skip-tests) SKIP_TESTS=true ;;
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

# ─── Update K8s secret ────────────────────────────────────────────

# GitHub token is optional — only include if explicitly set in env.
# BYOK providers (Azure AI, etc.) work without it.
GH_TOKEN="${GITHUB_TOKEN:-}"

echo "🔑 Updating K8s secret..."
kubectl create secret generic copilot-runtime-secrets \
    -n "$NAMESPACE" \
    --from-literal=DATABASE_URL="$DATABASE_URL" \
    ${GH_TOKEN:+--from-literal=GITHUB_TOKEN="$GH_TOKEN"} \
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
    --dry-run=client -o yaml | kubectl apply -f -

# ─── Step 0: Run local integration tests ─────────────────────────

if [ "$SKIP_TESTS" = false ]; then
    echo ""
    echo "🧪 Running local integration tests (gate)..."
    if ! ./scripts/run-tests.sh; then
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

# ─── Step 1: Cancel + delete all orchestrations ──────────────────

if [ "$SKIP_RESET" = false ]; then
    echo ""
    echo "🗑️  Cleaning up existing orchestrations..."

    # Scale down workers first so nothing picks up work
    echo "   Scaling workers to 0..."
    kubectl scale deployment copilot-runtime-worker -n "$NAMESPACE" --replicas=0 2>/dev/null || true
    sleep 3

    # Reset both duroxide and CMS schemas
    echo "   Resetting database (duroxide + CMS schemas)..."
    NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file="$ENV_FILE" scripts/db-reset.js --yes

    echo "   ✅ Database cleaned"
else
    echo "⏭️  Skipping DB reset (--skip-reset)"
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
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g; s/name: copilot-runtime$/name: $NAMESPACE/" deploy/k8s/namespace.yaml | kubectl apply -f -

# Apply worker deployment (substitute NAMESPACE into the template)
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g" deploy/k8s/worker-deployment.yaml | kubectl apply -f -

# Rollout restart to pick up the new image
kubectl rollout restart deployment/copilot-runtime-worker -n "$NAMESPACE"

echo ""
echo "⏳ Waiting for rollout..."
kubectl rollout status deployment/copilot-runtime-worker -n "$NAMESPACE" --timeout=120s

echo ""
echo "✅ Deploy complete!"
echo ""
kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=worker
echo ""
