---
name: pilotswarm-azure-lessons
description: "Workarounds for common Azure issues: RBAC with Conditional Access, PostgreSQL region restrictions, Key Vault + CSI Driver setup."
---

# PilotSwarm Azure Lessons Learned

Verified workarounds for Azure issues encountered during PilotSwarm deployments.

## RBAC with Corporate Conditional Access

In enterprise tenants with conditional access policies, `az role assignment create` may fail with
`AADSTS530084` because the command calls the Graph API to resolve principal/role
IDs, and conditional access token protection policies block that call.

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

## PostgreSQL Flexible Server Region Restrictions

Some Azure subscriptions restrict PostgreSQL Flexible Server provisioning to
specific regions (or disallow new provisioning entirely). When this happens:
- Check for existing servers: `az postgres flexible-server list --output table`
- Create a database on an existing server instead of provisioning a new one
- Document the actual server/resource-group in the env config
- Always confirm with the user before reusing an existing server

## Azure Key Vault with Secrets Store CSI Driver

When using AKV + Secrets Store CSI in AKS:
- Create the vault with `--enable-rbac-authorization true`
- Assign `Key Vault Secrets Officer` to yourself (the operator) for storing secrets
- Assign `Key Vault Secrets User` to the workload identity managed identity for reading secrets
- Use a `SecretProviderClass` manifest with `objectType: secret` entries
- Mount secrets as env vars via `secretObjects` in the SecretProviderClass
- The CSI driver requires a volume mount even if you only use env vars

## Docker Image Platform Mismatch

Building Docker images on macOS (Apple Silicon) produces ARM64 images by default.
AKS nodes run linux/amd64. Always use `--platform linux/amd64` when building:

```bash
docker build --platform linux/amd64 -f deploy/Dockerfile.worker -t <tag> .
```

Without this, pods will fail with `no match for platform in manifest` on image pull.

## Local Package Parity in Docker Builds

When `package.json` uses `file:` links to a peer package (e.g., `"pilotswarm-sdk": "file:../pilotswarm/packages/sdk"`),
the Docker build context cannot follow symlinks outside the build root.

If `package.docker.json` references `"^0.1.6"` (npm), the deployed image gets the
**published** version — which may be behind the local source.

**Fix:** Copy the peer packages into the build context and use `file:` references in `package.docker.json`:

```bash
# Before docker build
cp -r ../pilotswarm/packages/sdk pilotswarm-sdk-local
cp -r ../pilotswarm/packages/cli pilotswarm-cli-local
```

```json
"pilotswarm-sdk": "file:pilotswarm-sdk-local",
"pilotswarm-cli": "file:pilotswarm-cli-local"
```

Add the local copies to `.gitignore`.
