// ==============================================================================
// PilotSwarm CertManager — manifest container + Flux configuration.
// ==============================================================================
// Scope: resource group (BaseInfra RG — same RG that owns the storage account
// and AKS cluster).
//
// Deploys cert-manager v1.20.2 (exact-pinned in deploy/gitops/cert-manager/
// base/helm-release.yaml) into the BaseInfra cluster via Flux. Conditional on
// the orchestrator deciding the OSS Let's Encrypt path is in use — the
// orchestrator (deploy/scripts/deploy.mjs) skips the entire `cert-manager`
// service entry when TLS_SOURCE != letsencrypt, so this module is never
// invoked on the enterprise / akv path. We don't gate inside the bicep itself
// because the `services` framework already provides the gate cleanly.
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

@description('BaseInfra storage account name (Flux source for cert-manager-manifests container).')
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

resource certManagerManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'cert-manager-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module CertManagerFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'cert-manager-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'cert-manager'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: certManagerManifestsContainer.name
    kustomizationPath: 'overlays/default'
  }
}

@description('cert-manager manifest container name (consumed by the OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = certManagerManifestsContainer.name
