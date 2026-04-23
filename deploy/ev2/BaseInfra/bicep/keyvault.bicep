// ==============================================================================
// PilotSwarm BaseInfra — Azure Key Vault.
//
// Stores the 14 worker + 10 portal secrets populated out-of-band by
// `scripts/deploy-aks.sh` (or by the EV2 shell extension in production).
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

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
