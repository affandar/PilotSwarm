---
name: pilotswarm-azure-deployer
description: "Use when packaging and deploying a PilotSwarm-based app to Azure or AKS. Covers remote worker parity, environment/config wiring, manifests, and rollout/reset constraints."
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
4. Write manifests and rollout instructions that match the actual app layout.
5. Call out reset/versioning constraints when orchestration behavior changes.

## Environment And Azure Resource Checklist

When the app targets AKS, prefer a checked-in `.env.example` plus a local,
gitignored `.env` copy. Document at least:

- `GITHUB_TOKEN`
- `DATABASE_URL`
- app-specific schema names if the shared PostgreSQL server hosts other PilotSwarm apps
- Azure subscription, tenant, resource group, and region
- control-cluster name, namespace, and worker pod label
- workload-cluster name and namespace
- storage account/container for session dehydration or artifacts
- container registry and image names/tags
- workload identity client ID, service account name/namespace, and federated credential name

Also call out the Azure resources the user must provision:

- Azure Database for PostgreSQL
- control AKS cluster
- workload AKS cluster
- user-assigned managed identity for control-plane pods
- federated identity credential
- Azure Storage account
- Azure Container Registry

## Cross-Cluster AKS Access Pattern

If workers run in a control AKS cluster and must manage a second AKS cluster, prefer
Azure Workload Identity on the control cluster instead of relying on node identity.

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

3. fetch target-cluster kubeconfig with explicit subscription/resource-group/name:

```bash
az aks get-credentials \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$WORKLOAD_CLUSTER_NAME" \
  --file /tmp/workload-kubeconfig \
  --overwrite-existing
```

4. use that kubeconfig to verify:
   - `kubectl auth can-i create pods`
   - a short-lived probe pod can be created and deleted

## `kubectl` Guidance

- from a workstation or CI host, always keep commands explicit with `kubectl --context <cluster-context>`
- from inside a control-plane pod, prefer a temporary kubeconfig file created by `az aks get-credentials`
- keep control-cluster and workload-cluster operations separate in docs, env vars, and manifests
- prefer explicit namespaces and label selectors for log collection and rollout status checks
- prefer `kubectl create secret generic ... --from-env-file=...` when documenting worker env injection

## Guardrails

- Do not assume local plugin directories magically exist in deployed workers.
- Prefer explicit packaging and env configuration over vague operational guidance.
- Call out orchestration determinism and database reset requirements when relevant.
- Keep deployment docs aligned with the user's actual folder structure and commands.
- If cluster access crosses AKS boundaries, make the identity and kubeconfig flow explicit instead of assuming `kubectl` already works.
- **Never reuse or modify existing Azure resources without explicit user approval.** When provisioning fails (region restrictions, quota limits, subscription policies) and an existing resource could be shared, always present the situation to the user and wait for confirmation before proceeding. This includes: creating databases on existing servers, reusing storage accounts, sharing AKS clusters, or any action that touches resources not created in the current session.

## Lessons Learned

### RBAC with Corporate Conditional Access

In Microsoft corporate tenants, `az role assignment create` may fail with
`AADSTS530084` because the command calls the Graph API to resolve principal/role
IDs, and conditional access policies block that call.

**Workaround**: Use `az rest` to call the ARM RBAC API directly,
bypassing Graph entirely:

```bash
ASSIGNMENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
az rest --method PUT \
  --url "https://management.azure.com<SCOPE>/providers/Microsoft.Authorization/roleAssignments/${ASSIGNMENT_ID}?api-version=2022-04-01" \
  --body "{
    \"properties\": {
      \"roleDefinitionId\": \"<SUBSCRIPTION_SCOPE>/providers/Microsoft.Authorization/roleDefinitions/<ROLE_GUID>\",
      \"principalId\": \"<PRINCIPAL_OBJECT_ID>\",
      \"principalType\": \"ServicePrincipal\"
    }
  }"
```

Common role definition GUIDs:
- Key Vault Secrets User: `4633458b-17de-408a-b874-0445c86b69e6`
- Key Vault Secrets Officer: `b86a8fe4-44ce-4948-aee5-eccb2c155cd7`
- Storage Blob Data Contributor: `ba92f5b4-2d11-453d-a403-e96b0029c9fe`

Note: `az role assignment create` may report an error even when the assignment
actually succeeds. A subsequent attempt returning `RoleAssignmentExists` confirms it worked.

### PostgreSQL Flexible Server Region Restrictions

Some Azure subscriptions restrict PostgreSQL Flexible Server provisioning to
specific regions (or disallow new provisioning entirely). When this happens:
- Check for existing servers: `az postgres flexible-server list --output table`
- Create a database on an existing server instead of provisioning a new one
- Document the actual server/resource-group in the env config

### Azure Key Vault with Secrets Store CSI Driver

When using AKV + Secrets Store CSI in AKS:
- Create the vault with `--enable-rbac-authorization true`
- Assign `Key Vault Secrets Officer` to yourself (the operator) for storing secrets
- Assign `Key Vault Secrets User` to the workload identity managed identity for reading secrets
- Use a `SecretProviderClass` manifest with `objectType: secret` entries
- Mount secrets as env vars via `secretObjects` in the SecretProviderClass
- The CSI driver requires a volume mount even if you only use env vars
