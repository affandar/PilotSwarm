---
name: pilotswarm-aks-identity
description: "Use when setting up cross-cluster AKS access with Workload Identity, RBAC, and kubectl configuration for PilotSwarm workers."
---

# PilotSwarm AKS Identity & Cross-Cluster Access

How to wire Workload Identity, RBAC, and kubectl when PilotSwarm workers
in a control AKS cluster need to manage a second AKS cluster.

## Cross-Cluster AKS Access Pattern

Prefer Azure Workload Identity on the control cluster instead of relying
on node identity.

Required pieces:

1. control cluster with OIDC issuer enabled
2. control cluster with workload identity enabled
3. user-assigned managed identity
4. Kubernetes service account annotated with:
   - `azure.workload.identity/client-id: <client-id>`
5. worker pods labeled with:
   - `azure.workload.identity/use: "true"`
6. federated credential for:
   - control-cluster OIDC issuer
   - subject `system:serviceaccount:<namespace>:<service-account>`
   - audience `api://AzureADTokenExchange`

Minimum Azure RBAC usually needed:

- `Azure Kubernetes Service Cluster User Role` on the workload AKS cluster
- `Storage Blob Data Contributor` on the storage account

## Validation Pattern

When documenting or implementing this flow, include validation from inside a
control-plane pod:

1. confirm `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_FEDERATED_TOKEN_FILE`, and `AZURE_AUTHORITY_HOST`
2. log in with:

```bash
az login \
  --service-principal \
  -u "$AZURE_CLIENT_ID" \
  -t "$AZURE_TENANT_ID" \
  --federated-token "$(cat "$AZURE_FEDERATED_TOKEN_FILE")" \
  --allow-no-subscriptions
```

3. fetch target-cluster kubeconfig:

```bash
az aks get-credentials \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$WORKLOAD_CLUSTER_NAME" \
  --file /tmp/workload-kubeconfig \
  --overwrite-existing
```

4. verify with that kubeconfig:
   - `kubectl auth can-i create pods`
   - a short-lived probe pod can be created and deleted

## `kubectl` Guidance

- from a workstation or CI host, use `kubectl --context <cluster-context>`
- from inside a control-plane pod, use a temporary kubeconfig file
- keep control-cluster and workload-cluster operations separate in docs and env vars
- prefer explicit namespaces and label selectors for log collection
- prefer `kubectl create secret generic ... --from-env-file=...` for worker env injection
