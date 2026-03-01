#!/bin/bash
# Deploy durable-copilot-runtime workers to AKS.
#
# Cleans up ALL existing orchestrations (duroxide + CMS) before deploying.
# This avoids orchestration versioning issues when changing parameters.
#
# Usage:
#   ./scripts/deploy-aks.sh                     # full deploy (reset + build + push + apply)
#   ./scripts/deploy-aks.sh --skip-build        # skip Docker build (re-use existing image)
#   ./scripts/deploy-aks.sh --skip-reset        # skip DB reset (keep existing sessions)
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
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --skip-reset) SKIP_RESET=true ;;
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

# ─── Refresh GitHub token ────────────────────────────────────────

if command -v gh &>/dev/null; then
    FRESH_TOKEN=$(gh auth token 2>/dev/null || true)
    if [ -n "$FRESH_TOKEN" ]; then
        echo "🔑 Refreshing GitHub token in K8s secret..."
        kubectl create secret generic copilot-runtime-secrets \
            -n "$NAMESPACE" \
            --from-literal=DATABASE_URL="$DATABASE_URL" \
            --from-literal=GITHUB_TOKEN="$FRESH_TOKEN" \
            ${AZURE_STORAGE_CONNECTION_STRING:+--from-literal=AZURE_STORAGE_CONNECTION_STRING="$AZURE_STORAGE_CONNECTION_STRING"} \
            ${AZURE_STORAGE_CONTAINER:+--from-literal=AZURE_STORAGE_CONTAINER="$AZURE_STORAGE_CONTAINER"} \
            --dry-run=client -o yaml | kubectl apply -f -
    fi
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
npm run build

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

# Ensure namespace exists
kubectl apply -f deploy/k8s/namespace.yaml

# Apply worker deployment (this also scales back up)
kubectl apply -f deploy/k8s/worker-deployment.yaml

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
