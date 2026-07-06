#!/bin/bash
# Deploy the PilotSwarm MCP server (Web API mode, HTTP transport) to AKS.
#
# Runs from the portal image with a command override — build the image via
# this script (or deploy-portal.sh; same image) so packages/app/mcp/dist is
# current.
#
# Usage:
#   ./scripts/deploy-mcp.sh                # full deploy (build + push + apply)
#   ./scripts/deploy-mcp.sh --skip-build   # reuse the existing :latest image
#
# Prerequisites:
#   - .env.remote with K8S_CONTEXT (or current kubectl context targeting the cluster)
#   - az CLI logged in, ACR accessible, docker running (unless --skip-build)
#   - Outbound Entra credential: run once locally
#       pilotswarm auth login --api-url https://pilotswarm-portal.westus3.cloudapp.azure.com
#     The cached token file is pushed as the pilotswarm-mcp-auth secret. The
#     account you log in with is the identity the MCP server acts as — give it
#     the admin app role for the full god-mode surface.

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE_NAME="pilotswarm-portal"
PORTAL_ORIGIN="https://pilotswarm-portal.westus3.cloudapp.azure.com"
AUTH_CACHE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/pilotswarm/auth/https_pilotswarm-portal.westus3.cloudapp.azure.com.json"

SKIP_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done

# ─── Load env (K8S_CONTEXT etc.) ──────────────────────────────────
ENV_FILE=""
if [ -f .env.remote ]; then ENV_FILE=".env.remote"; elif [ -f .env ]; then ENV_FILE=".env"; fi
if [ -n "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        export "$line"
    done < "$ENV_FILE"
fi

ACR_NAME="${ACR_NAME:-pilotswarmacr}"
NAMESPACE="${K8S_NAMESPACE:-${NAMESPACE:-copilot-runtime}}"
K8S_CONTEXT="${K8S_CONTEXT:-}"
KUBECTL=(kubectl)
if [ -n "$K8S_CONTEXT" ]; then KUBECTL+=(--context "$K8S_CONTEXT"); fi

# ─── Preflight: outbound Entra credential ─────────────────────────
if [ ! -f "$AUTH_CACHE_FILE" ]; then
    echo "ERROR: no cached Entra credential at $AUTH_CACHE_FILE"
    echo "Run:   npx -p pilotswarm pilotswarm auth login --api-url $PORTAL_ORIGIN"
    echo "       (or the repo-local equivalent) and re-run this script."
    exit 1
fi

# ─── Build TypeScript + image ─────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
    echo "🔨 Building sdk + mcp dist..."
    npm run build -w packages/sdk
    (cd packages/app/mcp && ../../../node_modules/.bin/tsc)

    echo "🐳 Building and pushing image (includes mcp dist)..."
    az acr login --name "$ACR_NAME"
    docker buildx build \
        --platform linux/amd64 \
        -f deploy/Dockerfile.portal \
        -t "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest" \
        --push .
else
    echo "⏭️  Skipping build (--skip-build)"
fi

# ─── Secrets ──────────────────────────────────────────────────────
echo "🔑 Ensuring MCP secrets..."

# Inbound bearer key: preserve an existing key across redeploys; generate on
# first deploy.
EXISTING_KEY="$("${KUBECTL[@]}" get secret pilotswarm-mcp-secrets -n "$NAMESPACE" -o jsonpath='{.data.PILOTSWARM_MCP_KEY}' 2>/dev/null | base64 -d || true)"
MCP_KEY="${PILOTSWARM_MCP_KEY:-${EXISTING_KEY:-$(openssl rand -hex 32)}}"
"${KUBECTL[@]}" delete secret pilotswarm-mcp-secrets -n "$NAMESPACE" --ignore-not-found >/dev/null
"${KUBECTL[@]}" create secret generic pilotswarm-mcp-secrets \
    -n "$NAMESPACE" \
    --from-literal=PILOTSWARM_MCP_KEY="$MCP_KEY"

# Outbound Entra credential seed (MSAL token cache from local login).
"${KUBECTL[@]}" delete secret pilotswarm-mcp-auth -n "$NAMESPACE" --ignore-not-found >/dev/null
"${KUBECTL[@]}" create secret generic pilotswarm-mcp-auth \
    -n "$NAMESPACE" \
    --from-file="$(basename "$AUTH_CACHE_FILE")=$AUTH_CACHE_FILE"

# ─── Deploy ───────────────────────────────────────────────────────
echo "🚀 Deploying MCP server..."
sed "s/namespace: copilot-runtime/namespace: $NAMESPACE/g" deploy/k8s/mcp-deployment.yaml | "${KUBECTL[@]}" apply -f -
"${KUBECTL[@]}" rollout restart deployment/pilotswarm-mcp -n "$NAMESPACE" 2>/dev/null || true
"${KUBECTL[@]}" rollout status deployment/pilotswarm-mcp -n "$NAMESPACE" --timeout=180s

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✅ PilotSwarm MCP server deployed"
echo ""
echo "  Endpoint:  $PORTAL_ORIGIN/mcp"
echo "  Auth:      Authorization: Bearer \$PILOTSWARM_MCP_KEY"
echo "  Key:       (kubectl get secret pilotswarm-mcp-secrets -n $NAMESPACE -o jsonpath='{.data.PILOTSWARM_MCP_KEY}' | base64 -d)"
echo ""
echo "  Smoke:"
echo "    curl -sS -X POST $PORTAL_ORIGIN/mcp \\"
echo "      -H \"Authorization: Bearer \$MCP_KEY\" -H 'Content-Type: application/json' \\"
echo "      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"1.0\"}}}'"
echo "══════════════════════════════════════════════════════════════"
