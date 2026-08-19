# pilotswarm-mcp-proxy image — the in-cluster Kusto MCP auth proxy.
#
# Build context is the REPO ROOT (needs the root lockfile + the workspace
# package.jsons), e.g. from Q:\src\PilotSwarm:
#   docker buildx build --platform linux/amd64 \
#     -f packages/mcp-proxy/deploy/Dockerfile -t <acr>/pilotswarm-mcp-proxy:<tag> .
#
# The proxy holds NO Azure identity: the image ships no credentials and the
# Deployment attaches no workload identity. It only forwards each caller's
# delegated bearer to Kusto.

# ---- build stage: install workspace deps and compile sdk + mcp-proxy ----
FROM node:24-trixie-slim AS build
WORKDIR /app

# Root workspace manifests + EVERY workspace package.json. `npm ci` with
# `workspaces:["packages/*"]` reconstructs the whole workspace tree from the
# root lockfile, so every workspace's package.json must be present even though
# this image only builds sdk + mcp-proxy. (Matches deploy/Dockerfile.worker.)
COPY package.json package-lock.json ./
COPY scripts/postinstall.js ./scripts/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/app/package.json ./packages/app/
COPY packages/horizon-store/package.json ./packages/horizon-store/
COPY packages/mcp-proxy/package.json ./packages/mcp-proxy/

ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
# Full workspace install (devDeps included — tsc runs in-image).
RUN npm ci --force

# Sources
COPY packages/sdk/ ./packages/sdk/
COPY packages/mcp-proxy/ ./packages/mcp-proxy/

RUN npm run build -w pilotswarm-sdk \
    && npm run build -w pilotswarm-mcp-proxy

# ---- runtime stage: prod deps + compiled output only ----
FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY scripts/postinstall.js ./scripts/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/app/package.json ./packages/app/
COPY packages/horizon-store/package.json ./packages/horizon-store/
COPY packages/mcp-proxy/package.json ./packages/mcp-proxy/

ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
RUN npm ci --omit=dev --force

# Compiled JS from the build stage. The proxy imports ONLY the SDK's
# dependency-free `mcp-auth-discovery` subpath (no barrel), so sdk/dist alone is
# enough — no api/, plugins/, or heavy SDK runtime files are loaded.
COPY --from=build /app/packages/sdk/dist/ ./packages/sdk/dist/
COPY --from=build /app/packages/mcp-proxy/dist/ ./packages/mcp-proxy/dist/

EXPOSE 8080
USER node
ENTRYPOINT ["node", "packages/mcp-proxy/dist/index.js"]
