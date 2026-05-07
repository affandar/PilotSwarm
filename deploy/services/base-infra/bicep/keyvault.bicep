// ==============================================================================
// PilotSwarm BaseInfra — Azure Key Vault.
//
// Stores the 14 worker + 10 portal secrets populated out-of-band by
// `scripts/deploy-aks.sh` (or by the a separate enterprise orchestration step in production).
// The CSI SPC UAMI is granted `Key Vault Secrets User` so the AKV CSI
// provider addon can project those secrets into pods.
// ==============================================================================

@description('Azure region.')
param location string

@description('Key Vault name (globally unique, 3-24 chars).')
param keyVaultName string

@description('AAD tenant ID for the vault.')
param tenantId string = subscription().tenantId

@description('Principal ID of the CSI SPC UAMI that needs Key Vault Secrets User.')
param csiPrincipalId string

@description('Optional principal ID of the App Gateway UAMI. When set, granted Key Vault Secrets User so the AppGw control plane can pull TLS certs (KV-referenced sslCertificates).')
param appGwPrincipalId string = ''

@description('Optional principal ID for the human/local-deploy identity that should receive Key Vault Secrets Officer on this vault. When empty (the enterprise production path), no extra role assignment is created. Local `npm run deploy` populates this with the signed-in AAD user so the new `seed-secrets` step can `az keyvault secret set` without a separate manual role grant.')
param localDeploymentPrincipalId string = ''

@description('Principal type for localDeploymentPrincipalId. Defaults to User; set to ServicePrincipal or Group to match the principal kind.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param localDeploymentPrincipalType string = 'User'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvSecretsUserDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: keyVault
  name: kvSecretsUserRoleId
}

resource assignKvSecretsUserToCsi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, csiPrincipalId, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: csiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: kvSecretsUserDef.id
  }
}

// Grant the App Gateway UAMI Key Vault Secrets User so AppGw control plane
// can pull the TLS cert when an sslCertificate references a KV secret URI
// (FM `appgw-add-ssl-certificate.bicep` pattern).
resource assignKvSecretsUserToAppGw 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(appGwPrincipalId)) {
  name: guid(keyVault.id, appGwPrincipalId, kvSecretsUserRoleId, 'appgw')
  scope: keyVault
  properties: {
    principalId: appGwPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: kvSecretsUserDef.id
  }
}

// Optional Key Vault Secrets Officer on the vault for the local-deploy
// principal. Skipped when localDeploymentPrincipalId is empty (the enterprise path
// production path). When set, this gives the running user data-plane
// write access to the vault at creation time so the new `seed-secrets`
// step in deploy.mjs can populate the human-only secrets (github-token,
// anthropic-api-key, etc.) without a separate manual role grant.
//
// Mirrors the storage.bicep `localDeploymentPrincipalId` pattern.
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource kvSecretsOfficerDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: keyVault
  name: kvSecretsOfficerRoleId
}

resource assignKvSecretsOfficerToLocalDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(localDeploymentPrincipalId)) {
  name: guid(keyVault.id, localDeploymentPrincipalId, kvSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    principalId: localDeploymentPrincipalId
    principalType: localDeploymentPrincipalType
    roleDefinitionId: kvSecretsOfficerDef.id
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
