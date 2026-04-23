// ==============================================================================
// PilotSwarm BaseInfra — Storage Account.
//
// Three blob containers:
//   1. copilot-sessions   — dehydrated session snapshots. Name MUST match the
//                           default in `packages/sdk/src/blob-store.ts:86`.
//   2. worker-manifests   — Flux source for the worker deployable.
//   3. portal-manifests   — Flux source for the portal deployable.
//
// The AKS kubelet UAMI is granted Storage Blob Data Reader on the account so
// the `microsoft.flux` extension (running with `useKubeletIdentity: 'true'`)
// can enumerate the manifest containers.
// ==============================================================================

@description('Azure region.')
param location string

@description('Storage account name (globally unique, 3-24 lowercase alphanumeric).')
param storageAccountName string

@description('Storage account SKU.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_RAGRS'
])
param skuName string = 'Standard_LRS'

@description('Principal ID of the AKS kubelet UAMI that needs Blob Data Reader on manifest containers.')
param aksKubeletPrincipalId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource sessionsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'copilot-sessions'
  properties: {
    publicAccess: 'None'
  }
}

resource workerManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'worker-manifests'
  properties: {
    publicAccess: 'None'
  }
}

resource portalManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'portal-manifests'
  properties: {
    publicAccess: 'None'
  }
}

var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource blobDataReaderDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: storageAccount
  name: blobDataReaderRoleId
}

resource assignBlobReaderToKubelet 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, aksKubeletPrincipalId, blobDataReaderRoleId)
  scope: storageAccount
  properties: {
    principalId: aksKubeletPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataReaderDef.id
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output blobContainerEndpoint string = storageAccount.properties.primaryEndpoints.blob
output sessionsContainerName string = sessionsContainer.name
output workerManifestsContainerName string = workerManifestsContainer.name
output portalManifestsContainerName string = portalManifestsContainer.name
