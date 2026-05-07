// ==============================================================================
// PilotSwarm BaseInfra — Storage Account.
//
// Single shared blob container at the BaseInfra layer:
//   1. copilot-sessions   — dehydrated session snapshots. Name MUST match the
//                           default in `packages/sdk/src/blob-store.ts:86`.
//
// Per-deployable manifest containers (worker-manifests, portal-manifests) are
// owned by each service's own bicep (deploy/services/worker/bicep/main.bicep,
// deploy/services/portal/bicep/main.bicep) — matching the postgresql-fleet-manager
// playgroundservice pattern where each service provisions its own Flux source.
//
// The AKS kubelet UAMI is granted Storage Blob Data Reader on the **account**
// here (account-scope, not container-scope) so any future per-service
// container automatically inherits read access.
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

@description('Principal ID of the workload-identity UAMI that the worker / portal pods federate to (CSI SPC UAMI). Granted Storage Blob Data Contributor on this account so the worker can read+write session snapshots when running with PILOTSWARM_USE_MANAGED_IDENTITY=1. Optional for back-compat with stamps that have not been re-deployed since the role assignment was added.')
param workerWorkloadPrincipalId string = ''

@description('Optional principal ID for the human/local-deploy identity that should receive Storage Blob Data Contributor on this account. When empty (the EV2 production path), no extra role assignment is created. Local `npm run deploy` populates this with the signed-in AAD user so first-time stamps can run `az storage blob upload-batch` without a separate role grant.')
param localDeploymentPrincipalId string = ''

@description('Principal type for localDeploymentPrincipalId. Defaults to User; set to ServicePrincipal or Group to match the principal kind.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param localDeploymentPrincipalType string = 'User'

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

// Optional Storage Blob Data Contributor on the account for the local-deploy
// principal. Skipped when localDeploymentPrincipalId is empty (the EV2
// production path). When set, this gives the running user data-plane access
// at storage-account creation time so `az storage blob upload-batch` works
// on the very first run with no propagation race afterwards.
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource blobDataContributorDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: storageAccount
  name: blobDataContributorRoleId
}

resource assignBlobContributorToLocalDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(localDeploymentPrincipalId)) {
  name: guid(storageAccount.id, localDeploymentPrincipalId, blobDataContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: localDeploymentPrincipalId
    principalType: localDeploymentPrincipalType
    roleDefinitionId: blobDataContributorDef.id
  }
}

// Storage Blob Data Contributor for the worker/portal workload-identity UAMI.
// Required by the new bicep-deploy flow when the worker runs with
// PILOTSWARM_USE_MANAGED_IDENTITY=1 and `DefaultAzureCredential` exchanges
// the projected SA token for an AAD token bound to this UAMI. The worker
// needs read+write because it both downloads (hydrate) and uploads
// (dehydrate / artifacts) blobs in the `copilot-sessions` container.
//
// Skipped when `workerWorkloadPrincipalId` is empty — keeps the legacy
// `scripts/deploy-aks.sh` flow (connection-string auth, no MI flag) working
// on stamps that haven't re-deployed BaseInfra since this assignment was
// added.
resource assignBlobContributorToWorkerWorkload 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(workerWorkloadPrincipalId)) {
  name: guid(storageAccount.id, workerWorkloadPrincipalId, blobDataContributorRoleId, 'worker-workload')
  scope: storageAccount
  properties: {
    principalId: workerWorkloadPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorDef.id
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output blobContainerEndpoint string = storageAccount.properties.primaryEndpoints.blob
output sessionsContainerName string = sessionsContainer.name
