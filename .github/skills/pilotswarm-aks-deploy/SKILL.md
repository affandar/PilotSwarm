---
name: pilotswarm-aks-deploy
description: Deploy PilotSwarm to AKS using the repo's canonical scripts and checks. Use when refreshing secrets, building/pushing the worker image, rolling out to AKS, or verifying provider/model changes in the live cluster.
---

# PilotSwarm AKS Deploy

Use this skill when the user wants to deploy PilotSwarm to AKS, refresh AKS env/secret state, or verify the live cluster after a rollout.

Keep the workflow repo-specific and explicit. Prefer the repo-owned scripts, and treat secret/env changes as part of the deploy surface, not as an afterthought.

## Canonical Targets

- Kubernetes context: `toygres-aks`
- Namespace: `copilot-runtime`
- Deployment: `copilot-runtime-worker`
- Image: `toygresaksacr.azurecr.io/copilot-runtime-worker:latest`
- ACR: `toygresaksacr`

## Canonical Files

- Deploy script: `scripts/deploy-aks.sh`
- Remote reset script: `scripts/db-reset.js`
- Worker manifest: `deploy/k8s/worker-deployment.yaml`
- Namespace manifest: `deploy/k8s/namespace.yaml`
- AKS guide: `docs/deploying-to-aks.md`
- Model catalog template: `.model_providers.example.json`
- Real runtime catalog: `.model_providers.json`

## Core Learnings

- Use `docker buildx build --platform linux/amd64` for AKS images. Do not use a plain `docker build` from Apple Silicon for cluster deploys.
- The deploy target is the AKS cluster, not the local namespace. Use `copilot-runtime`, not the local `pilotswarm` namespace.
- The deploy script prefers `.env.remote`, then `.env`, and pushes env-backed provider keys into the Kubernetes secret.
- `.model_providers.example.json` is the checked-in shareable model-catalog template. The real `.model_providers.json` is local and gitignored so personal service URLs can stay out of source control.
- Provider visibility is still controlled by env-backed keys at worker startup, not by which providers appear in the template.
- Secret updates matter for model selectors. Workers load provider availability at startup, so removed keys do not take effect until the secret is refreshed and the pods restart.
- The AKS rollout needs a valid `acr-pull` registry secret wired into the worker deployment. Refresh that pull secret as part of deployment, not only the env secret.
- During destructive resets, do not drop the `duroxide` schema immediately after scaling the deployment to `0`. Wait until the worker pods are actually gone, or old prepared statements can trip Postgres errors like `cached plan must not change result type`.
- When the active default model is an Azure OpenAI deployment, the Kubernetes secret must include the matching Azure OpenAI key. A missing `AZURE_OAI_KEY` can leave workers booting with an invalid default model.
- If `ANTHROPIC_API_KEY` is intentionally removed from the deploy env, refresh the Kubernetes secret and restart workers, then verify Anthropic models disappeared from selectors or `list_available_models`.
- Old worker pods in another namespace can still poll the same database and cause nondeterminism. Check all namespaces if behavior looks impossible.
- After a destructive reset, healthy workers will immediately recreate the built-in system sessions. Verify the fresh root `PilotSwarm Agent` instead of expecting the catalog to stay empty.

## Default Deploy Workflow

1. Inspect the deploy surface.
   - Run `git status --short`.
   - Review `.model_providers.example.json`, the real `.model_providers.json` when the user has asked for local config changes, `scripts/deploy-aks.sh`, and `deploy/k8s/worker-deployment.yaml` if model/env/deploy behavior changed.

2. Verify the target env and cluster assumptions.
   - Prefer `.env.remote` for AKS deploys.
   - Confirm the current context/namespace before changing remote state.
   - If the change removes a provider key, plan to verify the live model surface after rollout.

3. Use the canonical deploy script unless there is a concrete reason not to.
   - Full deploy:
     ```bash
     ./scripts/deploy-aks.sh
     ```
   - Reuse existing image:
     ```bash
     ./scripts/deploy-aks.sh --skip-build
     ```
   - Keep existing sessions/state:
     ```bash
     ./scripts/deploy-aks.sh --skip-reset
     ```
   - Skip the local test gate only when the user explicitly accepts the risk:
     ```bash
     ./scripts/deploy-aks.sh --skip-tests
     ```

4. If a manual deploy is needed, follow the same order as the script.
   - Refresh the Kubernetes secret from the current env.
   - Refresh the `acr-pull` image-pull secret from ACR credentials/token.
   - Run the local test gate unless explicitly skipped.
   - If doing a destructive reset, scale workers to `0` and wait for the pods to be fully terminated before dropping schemas.
   - Build the SDK:
     ```bash
     npm run build -w packages/sdk
     ```
   - Login to ACR:
     ```bash
     az acr login --name toygresaksacr
     ```
   - Build and push the image:
     ```bash
     docker buildx build \
         --platform linux/amd64 \
         -f deploy/Dockerfile.worker \
         -t toygresaksacr.azurecr.io/copilot-runtime-worker:latest \
         --push .
     ```
   - Apply namespace/deployment manifests and restart the deployment.

5. Verify the rollout.
   - Check rollout status:
     ```bash
     kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=120s
     ```
   - Check pod readiness:
     ```bash
     kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker
     ```
   - Check recent logs:
     ```bash
     kubectl logs -n copilot-runtime -l app.kubernetes.io/component=worker --prefix --tail=50
     ```
   - If image correctness matters, inspect the running image IDs from the pods.
   - If the rollout stalls in `ErrImagePull` or `ImagePullBackOff`, inspect the pod events first; a stale `acr-pull` secret is a likely cause.

6. Verify model-surface changes when env keys changed.
   - If a provider key was added or removed, do not stop at "pods are Running".
   - Verify the live selector surface in the TUI or through `list_available_models`.
   - For Anthropic removal specifically, confirm Anthropic entries no longer appear after the restart.

7. If the deploy followed a destructive reset, verify the rebuilt system baseline.
   - Confirm the recreated `PilotSwarm Agent` is present and not failed.
   - Confirm the expected system children (`Sweeper Agent`, `Resource Manager Agent`, `Facts Manager`) were respawned.

## Secret Hygiene Rules

- Treat secret refresh as part of deployment, not a separate optional step.
- The deploy script already pushes:
  - `DATABASE_URL`
  - `GITHUB_TOKEN` when present
  - `AZURE_STORAGE_*` when present
  - `AZURE_FW_GLM5_KEY`
  - `AZURE_KIMI_K25_KEY`
  - `AZURE_OAI_KEY`
  - `AZURE_GPT51_KEY`
  - `AZURE_MODEL_ROUTER_KEY`
  - `ANTHROPIC_API_KEY`
- If a provider should disappear from selectors, make sure the corresponding env var is absent in the deploy env and then verify the restarted cluster reflects it.

## Verification Fallbacks

- If `kubectl` or `kubelogin` is flaky locally, use `az aks command invoke` for cluster-side verification instead of assuming rollout state.
- If local admin credentials are disabled, prefer the same cluster-side verification path rather than trying to force `--admin`.

## Extra Checks For Weird Behavior

- Check for old worker pods across all namespaces:
  ```bash
  kubectl get pods --all-namespaces -l app.kubernetes.io/component=worker --no-headers
  ```
- If the cluster looks healthy but behavior is stale, confirm the running pods are actually on the expected image and secret revision.

## Rules

- Never deploy without explicit user permission.
- Never skip the reset warning when orchestration behavior changed.
- Never assume a missing local env var means the live cluster already dropped that provider.
- Prefer repo scripts over handcrafted one-off deploy sequences.
