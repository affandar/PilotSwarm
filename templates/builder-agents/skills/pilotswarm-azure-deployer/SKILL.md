---
name: pilotswarm-azure-deployer
description: "Use when packaging and deploying a PilotSwarm-based app to Azure or AKS. Covers remote worker parity, environment/config wiring, manifests, and rollout/reset constraints."
---

# PilotSwarm Azure Deployer

Prepare PilotSwarm-based apps for Azure deployment, especially AKS worker deployments.

## Canonical References

- AKS deployment guide: `https://github.com/microsoft/pilotswarm/blob/main/docs/deploying-to-aks.md`
- Configuration guide: `https://github.com/microsoft/pilotswarm/blob/main/docs/configuration.md`
- Plugin architecture: `https://github.com/microsoft/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- DevOps sample: `https://github.com/microsoft/pilotswarm/tree/main/examples/devops-command-center`

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
4. Write manifests and rollout instructions that match the actual app layout.
5. Call out reset/versioning constraints when orchestration behavior changes.

## Guardrails

- Do not assume local plugin directories magically exist in deployed workers.
- Prefer explicit packaging and env configuration over vague operational guidance.
- Call out orchestration determinism and database reset requirements when relevant.
- Keep deployment docs aligned with the user's actual folder structure and commands.