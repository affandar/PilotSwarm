FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY packages/job-generator-provider/package.json packages/job-generator-provider/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
RUN npm ci

COPY packages/job-generator-provider/tsconfig.json ./tsconfig.json
COPY packages/job-generator-provider/src ./src
RUN npm run build

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "dist/cli.js"]
