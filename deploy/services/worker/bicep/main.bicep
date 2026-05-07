// ==============================================================================
// PilotSwarm Worker — manifest container + Flux configuration.
// ==============================================================================
// Scope: resource group (BaseInfra RG — same RG that owns the storage account
// and AKS cluster).
//
// This module does NOT provision the worker Kubernetes workload — that is
// reconciled by FLUX from the worker manifest blob container which IS owned
// by this bicep (per the reference deployment pattern:
// each service provisions its own Flux source in its own bicep).
//
// What this module does:
//   1. Creates the `worker-manifests` blob container in the BaseInfra
//      storage account.
//   2. Configures Flux on the BaseInfra AKS cluster to reconcile from that
//      container (kustomizationPath = `overlays/<environment>`).
//
// Pre-requisites (delivered by BaseInfra):
//   - Storage account exists.
//   - AKS cluster exists with the `microsoft.flux` extension installed and
//     `useKubeletIdentity: 'true'`.
//   - The AKS kubelet UAMI has `Storage Blob Data Reader` on the storage
//     account (account-scope grant in storage.bicep).
// ==============================================================================

targetScope = 'resourceGroup'

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

@description('BaseInfra `resourceNamePrefix` value used to look up the CSI Secrets Provider UAMI by convention name. Downstream callers that wrap this module may pass any prefix shaped per their own environment-region-stamp convention.')
param baseInfraResourceNamePrefix string

@description('BaseInfra storage account name (Flux source for worker-manifests container).')
param storageAccountName string

@description('BaseInfra AKS cluster name (parent of the Flux extension).')
param aksClusterName string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

// CSI Secrets Provider UAMI (created by BaseInfra's `uami.bicep`). Looked up
// by convention name so its clientId can be exposed as a Worker own-package
// output. This makes the value reachable by downstream callers (e.g.
// higher-level deployment orchestrators that compose this bicep across
// independent deployment boundaries and can only see each package's own
// outputs) for Workload Identity federation in the AKS app deploy step.
resource csiUami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseInfraResourceNamePrefix}-csi-mid'
}

resource workerManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'worker-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module WorkerFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'worker-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'worker'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: workerManifestsContainer.name
    kustomizationPath: 'overlays/default'
  }
}

@description('Worker manifest container name (consumed by OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = workerManifestsContainer.name

@description('Client ID of the CSI Secrets Provider UAMI (looked up by convention name from this RG). Consumed by the AKS app-deploy step (and by downstream callers that wrap this bicep) to federate Workload Identity.')
output csiIdentityClientId string = csiUami.properties.clientId
