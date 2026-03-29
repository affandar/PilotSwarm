---
name: pilotswarm-aks-reset
description: Reset remote PilotSwarm state for AKS safely. Use when wiping the PilotSwarm database/blob state, clearing stale orchestration history, or recovering from namespace drift and replay/nondeterminism issues.
---

# PilotSwarm AKS Reset

Use this skill when the user explicitly asks to wipe remote PilotSwarm state, reset AKS-backed databases, purge blob-backed session state, or recover from tainted orchestration history.

This is a destructive workflow. Be exact about what will be lost and use the repo-owned reset path.

## What The Reset Destroys

The canonical reset script drops the PilotSwarm schemas and may also purge blob-backed dehydrated session state:

- `duroxide` or `DUROXIDE_SCHEMA`
- `copilot_sessions` or `CMS_SCHEMA`
- `pilotswarm_facts` or `FACTS_SCHEMA`
- all blobs in the configured Azure container when `AZURE_STORAGE_CONNECTION_STRING` is present

That means:

- all in-flight orchestrations are lost
- all session rows/events are lost
- all durable facts are lost
- all dehydrated session archives/checkpoints in blob storage are lost

## Canonical Files

- Reset script: `scripts/db-reset.js`
- Deploy script: `scripts/deploy-aks.sh`
- Orchestration debugging skill/context: `.github/skills/debug-orchestration/SKILL.md`
- AKS guide: `docs/deploying-to-aks.md`

## When Reset Is The Right Call

- orchestration code changed and the user wants a clean AKS rollout
- stale history is causing replay or nondeterminism problems
- old pods from another namespace polluted the shared database
- the user explicitly wants to wipe remote sessions/facts before testing again

## Canonical Reset Workflow

1. Confirm the target.
   - For AKS, use `.env.remote` if present.
   - Be explicit that this is the remote environment, not the local test database.

2. Stop workers before wiping state.
   - Scale the deployment to zero so nothing repopulates state during reset:
     ```bash
     kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=0
     ```

3. Check for stray workers in other namespaces if the reset is related to nondeterminism.
   - Run:
     ```bash
     kubectl get pods --all-namespaces -l app.kubernetes.io/component=worker --no-headers
     ```
   - Delete unexpected old deployments before reintroducing new workers.

4. Run the canonical reset command.
   - Follow the deploy script's remote-safe pattern:
     ```bash
     NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.remote scripts/db-reset.js --yes
     ```
   - This handles Azure/Postgres SSL quirks and also purges blobs when blob storage is configured.

5. Redeploy or restart workers after the reset.
   - If new code or secrets need to ship, build and push the image while workers are still at zero replicas.
   - Apply manifest changes if any: `kubectl apply -f deploy/k8s/worker-deployment.yaml`
   - Scale back up: `kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=6`
   - **Do not use `kubectl rollout restart`** — it does a rolling replacement that mixes old and new pods, which can cause session-state-not-found failures when in-flight orchestrations cross the old/new boundary.
   - Wait for rollout completion: `kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=180s`

6. Verify the cluster is truly clean.
   - Pods should come back healthy.
   - The session list should not show stale pre-reset user sessions.
   - Expect the built-in system sessions to be recreated automatically as the workers boot.
   - If the reset was to remove a provider, verify that the live model surface also changed after restart.
   - If the reset was to reproduce a system-agent failure, verify whether the recreated root `PilotSwarm Agent` is healthy before starting new test sessions.

## Preferred Commands

- Full destructive redeploy:
  ```bash
  ./scripts/deploy-aks.sh
  ```
- Reset with image update (the safe order matters):
  ```bash
  # 1. Scale workers to zero — no pods should be running during reset
  kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=0
  kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=60s

  # 2. Wipe remote state (DB schemas + blob storage)
  NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.remote scripts/db-reset.js --yes

  # 3. Build and push new image (if code changed)
  az acr login --name toygresaksacr
  docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker \
    -t toygresaksacr.azurecr.io/copilot-runtime-worker:latest --push .

  # 4. Apply any manifest changes, then scale back up
  kubectl apply -f deploy/k8s/worker-deployment.yaml
  kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=6
  kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=180s
  ```
- Reset only (no image change, same code):
  ```bash
  kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=0
  kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=60s
  NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.remote scripts/db-reset.js --yes
  kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=6
  kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=180s
  ```

## Learnings To Preserve

- Reset first when orchestration behavior changed in a way that could alter replay history.
- Blob purge is part of the reset story. If blob storage is configured, wiping only PostgreSQL is not a full reset.
- Namespace drift is a real failure mode. Old workers in an old namespace can keep polling the same database and poison new deploys.
- Scaling workers to zero before reset is not optional if you want a clean wipe.
- **Never use `rollout restart` as a substitute for scale-down/scale-up.** A rolling restart replaces pods one at a time, meaning old pods with stale in-memory session state coexist with new pods pulling from a freshly-wiped database. This causes "expected resumable Copilot session state ... but none was found" failures when a session's `continueAsNew` execution lands on a new pod that has no local disk state from the old pod's checkpoint. Always: scale to 0 → reset DB → (push image if needed) → scale back up.
- An empty post-reset catalog is temporary. Healthy workers will immediately recreate the built-in system sessions.
- If local `kubectl` auth is unreliable, verify or operate through a cluster-side path instead of guessing whether the reset worked.

## Rules

- Never run a remote reset without explicit user permission.
- Never describe a reset as "just the DB" when it will also wipe facts and blob-backed session state.
- Never redeploy after a reset without verifying the worker rollout completed.
