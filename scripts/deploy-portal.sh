#!/bin/bash
# Deploy PilotSwarm web portal to AKS.
#
# Usage:
#   ./scripts/deploy-portal.sh                # full deploy (build + cert + push + apply)
#   ./scripts/deploy-portal.sh --skip-build   # skip Docker build (re-use existing image)
#
# Prerequisites:
#   - .env.remote with DATABASE_URL, ENTRA_TENANT_ID, ENTRA_CLIENT_ID
#   - az CLI logged in, ACR accessible
#   - kubectl configured for your AKS cluster

set -euo pipefail
cd "$(dirname "$0")/.."

# ─── Configuration ────────────────────────────────────────────────

ACR_NAME="${ACR_NAME:-toygresaksacr}"
IMAGE_NAME="pilotswarm-portal"
NAMESPACE="${NAMESPACE:-copilot-runtime}"
CERT_DIR="deploy/.portal-tls"

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
if [ -z "${ENTRA_TENANT_ID:-}" ] || [ -z "${ENTRA_CLIENT_ID:-}" ]; then
    echo "ERROR: ENTRA_TENANT_ID and ENTRA_CLIENT_ID must be set in $ENV_FILE."
    exit 1
fi

# ─── Step 1: Build TypeScript ─────────────────────────────────────

echo ""
echo "🔨 Building TypeScript..."
npm run build -w packages/sdk

# ─── Step 2: Update K8s secrets ───────────────────────────────────

echo ""
echo "🔑 Updating K8s secrets (including Entra vars)..."

GH_TOKEN="${GITHUB_TOKEN:-}"

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
    --from-literal=ENTRA_TENANT_ID="$ENTRA_TENANT_ID" \
    --from-literal=ENTRA_CLIENT_ID="$ENTRA_CLIENT_ID" \
    --dry-run=client -o yaml | kubectl apply -f -

echo "🔐 Refreshing ACR pull secret..."
ACR_SERVER="${ACR_NAME}.azurecr.io"
ACR_REFRESH_TOKEN="$(az acr login --name "$ACR_NAME" --expose-token --output tsv --query accessToken)"
kubectl create secret docker-registry acr-pull \
    -n "$NAMESPACE" \
    --docker-server="$ACR_SERVER" \
    --docker-username="00000000-0000-0000-0000-000000000000" \
    --docker-password="$ACR_REFRESH_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -

# ─── Step 3: Generate self-signed TLS cert ────────────────────────

echo ""
echo "🔒 Generating self-signed TLS certificate..."
mkdir -p "$CERT_DIR"

# We'll use "pilotswarm.internal" as the CN.
# After deploy we'll also add the LB IP as a SAN via /etc/hosts.
CERT_CN="pilotswarm.internal"

# Generate cert with IP SAN placeholder — will be usable via /etc/hosts or nip.io
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$CERT_DIR/tls.key" \
    -out "$CERT_DIR/tls.crt" \
    -subj "/CN=$CERT_CN" \
    -addext "subjectAltName=DNS:$CERT_CN,DNS:*.nip.io,DNS:*.sslip.io" \
    2>/dev/null

echo "   ✅ Cert generated: $CERT_CN"

# Create K8s TLS secret
kubectl create secret tls portal-tls \
    -n "$NAMESPACE" \
    --cert="$CERT_DIR/tls.crt" \
    --key="$CERT_DIR/tls.key" \
    --dry-run=client -o yaml | kubectl apply -f -

echo "   ✅ TLS secret created"

# ─── Step 4: Build and push Docker image ─────────────────────────

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

# ─── Step 5: Deploy to AKS ───────────────────────────────────────

echo ""
echo "🚀 Deploying portal to AKS..."

# Ensure namespace exists
kubectl apply -f deploy/k8s/namespace.yaml

# Apply portal deployment + service
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g" deploy/k8s/portal-deployment.yaml | kubectl apply -f -

# Rollout restart to pick up new image
kubectl rollout restart deployment/pilotswarm-portal -n "$NAMESPACE" 2>/dev/null || true

echo ""
echo "⏳ Waiting for rollout..."
kubectl rollout status deployment/pilotswarm-portal -n "$NAMESPACE" --timeout=180s

# ─── Step 6: Get the LB IP ───────────────────────────────────────

echo ""
echo "⏳ Waiting for LoadBalancer IP..."
LB_IP=""
for i in $(seq 1 60); do
    LB_IP="$(kubectl get svc pilotswarm-portal -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    if [ -n "$LB_IP" ]; then
        break
    fi
    sleep 3
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo ""
if [ -n "$LB_IP" ]; then
    echo "  ✅ PilotSwarm Portal deployed!"
    echo ""
    echo "  Internal LB IP:  $LB_IP"
    echo "  URL (nip.io):    https://pilotswarm.$LB_IP.nip.io"
    echo "  URL (hosts):     https://pilotswarm.internal"
    echo ""
    echo "  To use pilotswarm.internal, add to /etc/hosts:"
    echo "    $LB_IP  pilotswarm.internal"
    echo ""
    echo "  Entra ID redirect URIs to register:"
    echo "    https://pilotswarm.$LB_IP.nip.io"
    echo "    https://pilotswarm.internal"
    echo ""
    echo "  (Self-signed cert — accept the browser warning)"
else
    echo "  ⚠️  Portal deployed but LB IP not yet assigned."
    echo "  Check with: kubectl get svc pilotswarm-portal -n $NAMESPACE"
fi
echo ""
echo "══════════════════════════════════════════════════════════════"
