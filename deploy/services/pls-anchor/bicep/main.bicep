// ==============================================================================
// PilotSwarm pls-anchor — manifest container + Flux configuration.
// ==============================================================================
// Scope: resource group (BaseInfra RG — same RG that owns the storage account
// and AKS cluster).
//
// Ships the tiny `pls-anchor` namespace + empty Service + private-FE Ingress
// (deploy/gitops/pls-anchor/base/) into the BaseInfra cluster via Flux. The
// Ingress carries the `appgw.ingress.kubernetes.io/use-private-ip: "true"`
// annotation which tells AGIC to create — and own — an httpListener on the
// AppGw private frontend IP. That listener is what causes Azure to materialise
// the hidden Private Link Service backing the AppGw `privateLinkConfiguration`,
// and because AGIC owns it, AGIC's reconcile keeps it alive forever. Front
// Door's Private Endpoint then has a stable PLS to attach to.
//
// Conditional on the orchestrator deciding the AFD edge mode is in use — the
// orchestrator (deploy/scripts/deploy.mjs) skips the entire `pls-anchor` service
// entry when EDGE_MODE != afd (no Front Door, no PE, nothing to anchor). We
// don't gate inside the bicep itself because the `services` framework already
// provides the gate cleanly.
//
// Pre-requisites (delivered by BaseInfra):
//   - Storage account exists.
//   - AKS cluster exists with the `microsoft.flux` extension installed and
//     `useKubeletIdentity: 'true'`.
//   - The AKS kubelet UAMI has `Storage Blob Data Reader` on the storage
//     account (account-scope grant in storage.bicep).
//   - AppGw with `privateLinkConfigurations` + `appGatewayPrivateFrontendIP`
//     referencing it (application-gateway.bicep).
//   - AGIC add-on enabled on AKS (aks.bicep).
//
// Adapted from an internal reference deployment, which bundles the anchor
// inside a larger observability-manifests kustomization. PilotSwarm packages
// it as its own infra service for clean separation.
// ==============================================================================

targetScope = 'resourceGroup'

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name (Flux source for pls-anchor-manifests container).')
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

resource plsAnchorManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'pls-anchor-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module PlsAnchorFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'pls-anchor-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'pls-anchor'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: plsAnchorManifestsContainer.name
    kustomizationPath: 'overlays/default'
  }
}

@description('pls-anchor manifest container name (consumed by the OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = plsAnchorManifestsContainer.name
