---
name: pilotswarm-azure-deployer
description: "Use when packaging and deploying a PilotSwarm-based app to Azure or AKS. Covers remote worker parity, environment/config wiring, manifests, and rollout constraints."
---

# PilotSwarm Azure Deployer

Prepare PilotSwarm-based apps for Azure deployment, especially AKS worker and browser-portal deployments.

## Canonical References

- Starter Docker quickstart: `https://github.com/affandar/pilotswarm/blob/main/docs/getting-started-docker-appliance.md`
- AKS deployment guide: `https://github.com/affandar/pilotswarm/blob/main/docs/deploying-to-aks.md`
- Configuration guide: `https://github.com/affandar/pilotswarm/blob/main/docs/configuration.md`
- Plugin architecture: `https://github.com/affandar/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- DevOps sample: `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Preferred Outputs

```text
deploy/
├── Dockerfile.worker
├── Dockerfile.portal
├── k8s/
│   ├── namespace.yaml
│   ├── worker-deployment.yaml
│   ├── portal-deployment.yaml
│   └── configmaps-secrets.md
└── README.md
```

## Workflow

1. Confirm the app's worker entrypoint, portal entrypoint, plugin paths, and required env vars.
2. Ensure remote workers package the same plugin files and worker code used locally.
3. Ensure remote portal images package the app plugin metadata needed for branding, agent creation, and session policy.
4. Configure database and blob storage explicitly.
5. Write manifests, model-catalog/env guidance, and rollout instructions that match the actual app layout.
6. Call out reset/versioning constraints when orchestration behavior changes.

## Environment And Azure Resource Checklist

When the app targets AKS, prefer a checked-in `.env.example` plus a local,
gitignored `.env` copy. Document at least:

- checked-in `.model_providers.example.json` when the app uses a custom model catalog
- local gitignored `.model_providers.json` created from that example for the real runtime catalog
- `GITHUB_TOKEN`
- `DATABASE_URL`
- app-specific schema names if the shared PostgreSQL server hosts other PilotSwarm apps
- Azure subscription, tenant, resource group, and region
- control-cluster name, namespace, and worker pod label
- workload-cluster name and namespace
- storage account/container for session dehydration or artifacts
- container registry and image names/tags
- workload identity client ID, service account name/namespace, and federated credential name
- portal ingress host, auth provider, and redirect URI inputs when the browser portal is deployed

Model/provider guidance:

- `.model_providers.example.json` is the checked-in shareable template.
- The real `.model_providers.json` should stay local and gitignored because it may contain user-specific endpoint URLs even when keys remain env-backed.
- Provider keys belong in `.env`, `.env.remote`, or Kubernetes secrets, not inside the model catalog.
- For AKS deployments, keep the live Kubernetes secret exactly in sync with local `.env.remote` for worker-facing vars: not more, not less. If a key is present locally, it should be present in AKS; if it is absent locally, it should be absent in AKS.
- Removing a provider key from AKS only changes selectors after the secret is refreshed and the workers restart.
- For Kubernetes secret creation, prefer `kubectl create secret generic ... --from-env-file=.env.remote` when values contain semicolons or other shell-significant characters, especially `AZURE_STORAGE_CONNECTION_STRING`.
- If documentation uses shell exports or `source .env.remote`, require explicit quoting for semicolon-bearing values before recommending `--from-literal`.

Also call out the Azure resources the user must provision:

- Azure Database for PostgreSQL
- control AKS cluster
- user-assigned managed identity for control-plane pods
- federated identity credential
- Azure Storage account
- Azure Container Registry
- public ingress / DNS path for the browser portal when it is exposed
- worker AKS cluster + namespace (three-tier only — see `pilotswarm-three-tier` skill)

## Portal Deployment Guidance

When the app includes the shipped browser portal:

- package the same app plugin into the portal image that the worker uses for prompts, agent metadata, and session policy
- set `PLUGIN_DIRS` in the portal deployment so the web process can resolve `plugin.json.portal`, `plugin.json.tui`, and user-creatable agents
- keep portal branding in `plugin.json.portal`, using `plugin.json.tui` only as a fallback or shared source when that matches the user's intent
- treat portal auth as an optional provider add-on rather than a built-in Entra requirement
- document `PORTAL_AUTH_PROVIDER=none|entra|<custom>` explicitly
- if Entra is selected, document:
  - `PORTAL_AUTH_PROVIDER=entra`
  - `PORTAL_AUTH_ENTRA_TENANT_ID`
  - `PORTAL_AUTH_ENTRA_CLIENT_ID`
  - `PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` as comma-delimited email allowlists when admission gating is enabled
  - SPA redirect URI registration for the portal ingress URL
- update `copilot-runtime-secrets` with the canonical `PORTAL_AUTH_*` and `PORTAL_AUTHZ_*` keys; do not rely on legacy `ENTRA_*` aliases
- if another provider such as AWS IAM is requested, keep the deployment contract separate from Entra-specific steps and call out which browser-side login flow and server-side validation hooks must be supplied

## Portal Validation Guidance

- verify the portal pod can start with the app plugin mounted or copied into the image
- verify the portal service resolves live endpoints before declaring the rollout healthy
- verify `GET /api/health` and `GET /api/portal-config` against the live ingress URL
- if the rollout briefly returns `502` or `503`, confirm whether the new pod is still registering or whether the container is crashlooping before calling it healthy
- when the portal still shows default PilotSwarm branding after rollout, inspect `PLUGIN_DIRS`, packaged plugin contents, and `plugin.json.portal` before assuming the UI code is wrong

## Worker Observability

PilotSwarm's TUI Node Map and Sequence Diagram views depend on two things:

### 1. Worker Node ID

The worker entrypoint must pass `workerNodeId` to `PilotSwarmWorker` so CMS
events are tagged with the node that processed them. Without this, the TUI
Node Map shows all sessions under `(unknown)`.

In AKS, use the pod hostname:

```js
import os from "node:os";

const worker = new PilotSwarmWorker({
    store: STORE,
    workerNodeId: os.hostname(),
    // ... other options
});
```

`os.hostname()` returns the pod name in Kubernetes (e.g.
`myapp-worker-749f4fb8b8-5nh7h`). The TUI truncates this to the last 5
characters for the column header.

### 2. RUST_LOG level

Orchestration log lines (`[orch]`, `[turn N]`, `[activity]`, `[runTurn]`)
are emitted by the duroxide runtime at `INFO` level via `ctx.traceInfo()`.

**If `RUST_LOG` is not set, duroxide defaults to `warn`, and these logs
are silently dropped.** The TUI will show empty node columns and sessions
stuck in the "(unknown)" column.

Always set `RUST_LOG` in the worker deployment manifest:

```yaml
env:
  - name: RUST_LOG
    value: "duroxide=info,duroxide_pg=info,warn"
```

This enables info-level logs from the duroxide runtime and Postgres provider
while keeping everything else at warn. The TUI's `parseSeqEvent` function
matches these patterns to populate the Node Map, Sequence Diagram, and
per-orchestration log views.

Without this, `kubectl logs` will only show Rust-level `WARN` entries
(e.g., "Dropping orphan queue messages") but none of the SDK-level
orchestration lifecycle events the TUI needs.

## Guardrails

- Do not assume local plugin directories magically exist in deployed workers.
- Do not assume local plugin directories magically exist in deployed portal pods.
- Prefer explicit packaging and env configuration over vague operational guidance.
- Call out orchestration determinism and database reset requirements when relevant.
- Call out that clean AKS restarts will immediately recreate built-in system sessions, so a truly empty session list is transient.
- Keep deployment docs aligned with the user's actual folder structure and commands.
- If cluster access crosses AKS boundaries, consult the `pilotswarm-aks-identity` skill.
- **Never reuse or modify existing Azure resources without explicit user approval.**
