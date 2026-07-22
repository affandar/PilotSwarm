# Web API — deployment-change notes

> Scratch notes from deploying `feature/web-api-control-plane` to the
> `pilotswarm` AKS cluster on 2026-07-02. **Skills/agents intentionally NOT
> edited yet** — this records what to change in them once the system is
> validated, so the update is mechanical later.

## What was deployed (and how)

- Cluster: context `pilotswarm-aks`, namespace `copilot-runtime`, ACR
  `pilotswarmacr` (subscription `043a8e55-…`, RG `pilotswarm-rg`), config from
  `.env.remote`. Portal DNS `pilotswarm-portal.westus3.cloudapp.azure.com`.
- Path used: the legacy shell scripts (this cluster is NOT GitOps/Flux).
  - Portal: `./scripts/deploy-portal.sh` (build + push + roll; refreshes the
    `copilot-runtime-secrets` K8s secret from `.env.remote`; no data touched).
  - Worker: `./scripts/deploy-aks.sh --skip-tests` (build + push +
    roll; **data preserved** — verified: workers reused persisted system
    sessions `22013ffb`/`bdad2272`).
- Both scripts honor `K8S_CONTEXT=pilotswarm-aks` from `.env.remote`, so the
  global kube context does not need switching. `az account set --subscription
  043a8e55-…` IS required first (pilotswarmacr is not in the default sub).
- Verified live: `/api/v1/health` → `apiVersion:1`; `/api/v1/auth/config` →
  entra client config; protected `/api/v1/*` → 401 without a token; 8/8 workers
  Running, 0 restarts, no api-client import errors.

## Already handled in this branch (no action needed)

- `deploy/Dockerfile.portal`, `Dockerfile.worker`, `Dockerfile.starter` now
  COPY the new `packages/api-client` workspace package; the portal Dockerfile
  also COPYs `packages/portal/api/`. (Committed.)
- `packages/portal` `files` includes `api/**/*`; portal prepack bundles
  api-client. (Committed.)
- `.github/workflows/publish-npm.yml` publishes `pilotswarm-api-client` before
  `pilotswarm-sdk` (sdk depends on it from the registry). (Committed.)
- `.github/skills/pilotswarm-release/SKILL.md` package surface updated for
  api-client. (Committed — this is the *release* skill, not an AKS-deploy skill.)

## Skill/doc updates to make LATER (after validation)

Target: `.github/skills/pilotswarm-aks-deploy/SKILL.md` (and its agent).

1. **Full release = portal + worker.** The skill's default workflow is
   worker-centric (`deploy-aks.sh`). Add that a complete rollout of app changes
   now also runs `scripts/deploy-portal.sh`, since the portal hosts the Web API.
   Order is not load-bearing (legacy `/api/rpc` + `/portal-ws` stay mounted; the
   new browser bundle talks `/api/v1` to the new portal — self-consistent).
2. **Portal Canonical Files list** — add `packages/portal/api/` (router + ws)
   and note `packages/api-client` is a workspace package baked into both images.
3. **No ingress change.** Explicitly state `/api/v1` + `/api/v1/ws` need no new
   ingress rules — the existing `/`-prefix rule and 3600s WS timeout cover them;
   readiness stays `/api/health`. (Verified in this deploy.)
4. **ACR subscription gotcha.** Note that `pilotswarmacr` is in subscription
   `043a8e55-…`; run `az account set` before `deploy-*.sh` or `az acr login`
   fails with "registry could not be found in subscription".
5. **Operator TUI over the API** (`pilotswarm-tui` skill / docs): operators can
   now connect with `pilotswarm remote --api-url
   https://pilotswarm-portal.westus3.cloudapp.azure.com` + `pilotswarm auth
   login` (entra device code) instead of `--store $DATABASE_URL`. No DB
   credentials needed. Requires the portal app registration to allow public
   client flows (device-code grant) — see `pilotswarm-portal-app-reg` skill;
   confirm/set that before advertising the TUI API path to users.

## Manual-build caveat (for anyone bypassing the scripts)

If building images by hand instead of via `deploy-*.sh`, the api-client COPY
steps and `packages/portal/api/` COPY are required — a plain build that predates
this branch will fail (`Cannot find module 'pilotswarm-api-client'` at worker
import, or a missing `./api/router.js` at portal start). The scripts already use
the updated Dockerfiles, so the automated path is fine.
