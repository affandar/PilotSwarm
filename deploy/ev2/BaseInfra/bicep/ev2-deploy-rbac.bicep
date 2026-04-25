// ==============================================================================
// PilotSwarm BaseInfra — RBAC for the EV2 deploy UAMI.
//
// Grants the user-assigned managed identity attached to Ev2 shell-extension
// containers (UploadContainer.sh / DeployApplicationManifest.sh) the minimum
// permissions needed to run the rollout:
//   - AcrPush on the per-region ACR           (oras cp → push image)
//   - Storage Blob Data Contributor on the SA (az storage blob upload-batch)
//
// The ACI sandbox that EV2 spins up uses this identity via the
// `identity.userAssignedIdentities` stanza on each shell-extension rollout
// parameter file. A user-assigned identity is required (not system-assigned)
// because the ephemeral container's system identity cannot be pre-granted
// roles before the container exists.
// ==============================================================================

@description('Name of the per-region ACR.')
param acrName string

@description('Name of the per-region storage account (manifest containers live here).')
param storageAccountName string

@description('Principal ID of the EV2 deploy UAMI.')
param ev2DeployPrincipalId string

// Built-in role IDs.
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource acrPushRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: acr
  name: acrPushRoleId
}

resource blobDataContributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: storageAccount
  name: blobDataContributorRoleId
}

resource assignAcrPushToEv2Deploy 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, ev2DeployPrincipalId, acrPushRoleId)
  scope: acr
  properties: {
    principalId: ev2DeployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPushRoleDef.id
  }
}

resource assignBlobContributorToEv2Deploy 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, ev2DeployPrincipalId, blobDataContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: ev2DeployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleDef.id
  }
}
