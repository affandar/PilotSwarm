// ==============================================================================
// PilotSwarm CertManagerIssuers — manifest container + Flux configuration.
// ==============================================================================
// Ships ClusterIssuer manifests (Let's Encrypt prod, plus optional DNS-01
// solver) that depend on the cert-manager CRDs being installed first. The
// CRDs come from the cert-manager service's HelmRelease; cert-manager-issuers
// is a separate FluxConfiguration so the two reconcile independently. Flux
// retries on missing CRDs, so explicit dependsOn between the two
// FluxConfigurations is not required — issuers reconcile within seconds of
// the CRDs landing.
//
// Conditional on the OSS Let's Encrypt path (orchestrator gate, same as
// the cert-manager service module).
// ==============================================================================

targetScope = 'resourceGroup'

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name (Flux source for cert-manager-issuers-manifests container).')
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

resource certManagerIssuersManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'cert-manager-issuers-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module CertManagerIssuersFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'cert-manager-issuers-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'cert-manager-issuers'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: certManagerIssuersManifestsContainer.name
    kustomizationPath: 'overlays/default'
  }
}

@description('cert-manager-issuers manifest container name (consumed by the OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = certManagerIssuersManifestsContainer.name
