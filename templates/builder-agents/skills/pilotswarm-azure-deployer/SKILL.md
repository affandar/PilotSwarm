---
name: pilotswarm-azure-deployer
description: "Use when packaging and deploying a PilotSwarm-based app to Azure or AKS. Covers remote worker parity, environment/config wiring, manifests, and rollout constraints."
---

# PilotSwarm Azure Deployer

Prepare PilotSwarm-based apps for Azure deployment, especially AKS worker deployments.

## Canonical References

- AKS deployment guide: `https://github.com/affandar/pilotswarm/blob/main/docs/deploying-to-aks.md`
- Configuration guide: `https://github.com/affandar/pilotswarm/blob/main/docs/configuration.md`
- Plugin architecture: `https://github.com/affandar/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- DevOps sample: `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Preferred Outputs

```text
deploy/
├── Dockerfile.worker
├── k8s/
│   ├── namespace.yaml
│   ├── worker-deployment.yaml
│   └── configmaps-secrets.md
└── README.md
```

## Workflow

1. Confirm the app's worker entrypoint, plugin paths, and required env vars.
2. Ensure remote workers package the same plugin files and worker code used locally.
3. Configure database and blob storage explicitly.
4. Write manifests, model-catalog/env guidance, and rollout instructions that match the actual app layout.
5. Call out reset/versioning constraints when orchestration behavior changes.

## Environment And Azure Resource Checklist

When the app targets AKS, prefer a checked-in `.env.example` plus a local,
gitignored `.env` copy. Document at least:

- checked-in `.model_providers.json` when the app uses a custom model catalog
- `GITHUB_TOKEN`
- `DATABASE_URL`
- app-specific schema names if the shared PostgreSQL server hosts other PilotSwarm apps
- Azure subscription, tenant, resource group, and region
- control-cluster name, namespace, and worker pod label
- workload-cluster name and namespace
- storage account/container for session dehydration or artifacts
- container registry and image names/tags
- workload identity client ID, service account name/namespace, and federated credential name

Model/provider guidance:

- `.model_providers.json` can be checked in because it references env vars rather than storing raw secrets.
- Provider keys belong in `.env`, `.env.remote`, or Kubernetes secrets, not inside the model catalog.
- Removing a provider key from AKS only changes selectors after the secret is refreshed and the workers restart.

Also call out the Azure resources the user must provision:

- Azure Database for PostgreSQL
- control AKS cluster
- user-assigned managed identity for control-plane pods
- federated identity credential
- Azure Storage account
- Azure Container Registry
- worker AKS cluster + namespace (three-tier only — see `pilotswarm-three-tier` skill)

## Worker Observability

PilotSwarm's TUI Node Map and Sequence Diagram views depend on parsing
orchestration log lines (`[orch]`, `[turn N]`, `[activity]`, `[runTurn]`)
emitted by the duroxide runtime at `INFO` level via `ctx.traceInfo()`.

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
- Prefer explicit packaging and env configuration over vague operational guidance.
- Call out orchestration determinism and database reset requirements when relevant.
- Call out that clean AKS restarts will immediately recreate built-in system sessions, so a truly empty session list is transient.
- Keep deployment docs aligned with the user's actual folder structure and commands.
- If cluster access crosses AKS boundaries, consult the `pilotswarm-aks-identity` skill.
- **Never reuse or modify existing Azure resources without explicit user approval.**
