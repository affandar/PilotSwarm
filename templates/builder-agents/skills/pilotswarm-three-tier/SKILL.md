---
name: pilotswarm-three-tier
description: "Reference for adding a Tier 3 worker AKS cluster to a PilotSwarm deployment. Covers provisioning, identity, Dockerfile changes, entrypoint, manifests, and verification."
---

# PilotSwarm Three-Tier Architecture

Reference for extending a standard two-tier PilotSwarm AKS deployment (TUI → Control AKS) with a dedicated Tier 3 worker cluster for ephemeral work pods.

## When to Use Three-Tier

Three-tier is useful when agents need to dispatch long-running or resource-intensive processes that must survive agent dehydration. Examples:
- Stress tests (pgbench runs > 60s)
- ETL or workflow execution
- Azure resource provisioning via CLI
- Any work that benefits from independent pod lifecycle

Two-tier remains the default for lightweight, short-lived agent workloads.

## Architecture

```text
Tier 1 — Laptop (TUI)
  │  npx pilotswarm remote ...
  │  Pure UI, no agents, no tools
  ▼
Tier 2 — Control AKS Cluster
  │  PilotSwarm worker pods (agents live here)
  │  Tools dispatch work via kubectl to Tier 3
  │  Workload Identity → kubectl access to Tier 3
  ▼
Tier 3 — Worker AKS Cluster
     Namespace: <app>-jobs
     Ephemeral pods: pgbench, psql, az cli, custom images
     Created/destroyed by Tier 2 agents
     Connects to shared PostgreSQL
```

## Provisioning Steps

### 1. Create the Worker Cluster

```bash
az aks create \
  --name <APP>-workers \
  --resource-group <RG> \
  --location <REGION> \
  --node-count 2 \
  --node-vm-size Standard_DS2_v2 \
  --enable-oidc-issuer \
  --enable-workload-identity \
  --generate-ssh-keys
```

OIDC issuer and workload identity must be enabled even though this cluster doesn't run PilotSwarm — the entrypoint uses Workload Identity to fetch its kubeconfig.

### 2. Create the Worker Namespace

```bash
az aks get-credentials --name <APP>-workers --resource-group <RG> \
  --file /tmp/worker-kubeconfig --overwrite-existing

kubectl --kubeconfig /tmp/worker-kubeconfig create namespace <APP>-jobs
```

### 3. Grant Cross-Cluster Access

The control cluster's managed identity needs `Azure Kubernetes Service Cluster User Role` on the worker cluster.

Use `az rest` (not `az role assignment create`) to avoid conditional access blocks in corporate tenants:

```bash
WORKER_CLUSTER_ID=$(az aks show -n <APP>-workers -g <RG> --query id -o tsv)
PRINCIPAL_ID="<managed-identity-principal-id>"
AKS_USER_ROLE="4abbcc35-e782-43d8-92c5-2d3f1bd2253f"
ASSIGNMENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

az rest --method PUT \
  --url "https://management.azure.com${WORKER_CLUSTER_ID}/providers/Microsoft.Authorization/roleAssignments/${ASSIGNMENT_ID}?api-version=2022-04-01" \
  --body "{
    \"properties\": {
      \"roleDefinitionId\": \"<SUBSCRIPTION_SCOPE>/providers/Microsoft.Authorization/roleDefinitions/${AKS_USER_ROLE}\",
      \"principalId\": \"${PRINCIPAL_ID}\",
      \"principalType\": \"ServicePrincipal\"
    }
  }"
```

### 4. PostgreSQL Firewall

Ensure the `AllowAllAzureServicesAndResourcesWithinAzureIps` firewall rule is set (start/end IP both `0.0.0.0`) so Tier 3 pods can reach the shared PostgreSQL instance.

## Dockerfile Changes

The worker Docker image must include `kubectl` and `az` CLI so Tier 2 pods can dispatch work to Tier 3 and the entrypoint can fetch the worker kubeconfig.

Add before the `npm install` step:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg lsb-release apt-transport-https && \
    # kubectl
    curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl && \
    # Azure CLI
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor \
      -o /usr/share/keyrings/microsoft-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/azure-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends azure-cli && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
```

## Entrypoint Script

Create `deploy/entrypoint.sh` — runs before the PilotSwarm worker, fetches the worker cluster kubeconfig using Workload Identity:

```bash
#!/bin/sh
set -e

if [ -n "$WORKER_CLUSTER_NAME" ] && [ -n "$AZURE_FEDERATED_TOKEN_FILE" ]; then
    az login --service-principal \
        -u "$AZURE_CLIENT_ID" \
        -t "$AZURE_TENANT_ID" \
        --federated-token "$(cat "$AZURE_FEDERATED_TOKEN_FILE")" \
        --allow-no-subscriptions > /dev/null 2>&1

    az aks get-credentials \
        --subscription "$AZURE_SUBSCRIPTION_ID" \
        --resource-group "${WORKER_CLUSTER_RG}" \
        --name "$WORKER_CLUSTER_NAME" \
        --file /tmp/worker-kubeconfig \
        --overwrite-existing > /dev/null 2>&1
fi

exec "$@"
```

Add to Dockerfile:

```dockerfile
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "worker-remote.js"]
```

## Deployment Manifest Env Vars

Add these to the worker deployment alongside existing env vars:

```yaml
env:
  - name: WORKER_CLUSTER_NAME
    value: "<APP>-workers"
  - name: WORKER_CLUSTER_RG
    value: "<RG>"
  - name: WORKER_NAMESPACE
    value: "<APP>-jobs"
  - name: AZURE_SUBSCRIPTION_ID
    value: "<SUBSCRIPTION_ID>"
```

These are read by the entrypoint and by the app's tool handlers that dispatch work pods.

## Resource Provisioning RBAC

If agents need to provision Azure resources (e.g., database instances), the managed identity needs **Contributor** at the resource group scope:

```bash
CONTRIBUTOR_ROLE="b24988ac-6180-42a0-ab88-20f7382dd24c"
ASSIGNMENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

az rest --method PUT \
  --url "https://management.azure.com/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Authorization/roleAssignments/${ASSIGNMENT_ID}?api-version=2022-04-01" \
  --body "{
    \"properties\": {
      \"roleDefinitionId\": \"/subscriptions/<SUB>/providers/Microsoft.Authorization/roleDefinitions/${CONTRIBUTOR_ROLE}\",
      \"principalId\": \"<PRINCIPAL_ID>\",
      \"principalType\": \"ServicePrincipal\"
    }
  }"
```

Only add this if the app's agents need to create/delete Azure resources. It is not required for basic three-tier pod dispatch.

## Verification

From your laptop, exec into a Tier 2 pod and verify end-to-end:

```bash
# 1. Workload Identity env vars are injected
kubectl -n <NS> exec <POD> -- printenv AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_FEDERATED_TOKEN_FILE

# 2. Worker kubeconfig was fetched at startup
kubectl -n <NS> exec <POD> -- ls -la /tmp/worker-kubeconfig

# 3. Cross-cluster kubectl works
kubectl -n <NS> exec <POD> -- kubectl --kubeconfig /tmp/worker-kubeconfig get nodes

# 4. Smoke test: create a pod in Tier 3, verify it runs, collect output
kubectl -n <NS> exec <POD> -- kubectl --kubeconfig /tmp/worker-kubeconfig \
  run smoke-test -n <APP>-jobs --image=postgres:16 --restart=Never \
  --env="PGPASSWORD=..." --command -- psql -h <PG_HOST> -U <USER> -d <DB> \
  -c "SELECT 'smoke-ok';"

# 5. Check result and clean up
kubectl -n <NS> exec <POD> -- kubectl --kubeconfig /tmp/worker-kubeconfig \
  logs smoke-test -n <APP>-jobs
kubectl -n <NS> exec <POD> -- kubectl --kubeconfig /tmp/worker-kubeconfig \
  delete pod smoke-test -n <APP>-jobs
```

## Summary of Azure Resources (Three-Tier Adds)

| Resource | Purpose |
|----------|---------|
| Worker AKS cluster | Runs ephemeral work pods |
| Worker namespace | Isolates work pods |
| AKS Cluster User role assignment | Cross-cluster kubectl from Tier 2 |
| Contributor role assignment (optional) | Resource provisioning from agents |
| PostgreSQL firewall rule | Azure-to-Azure connectivity for Tier 3 pods |
