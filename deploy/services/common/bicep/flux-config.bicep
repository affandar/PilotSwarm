// ==============================================================================
// PilotSwarm BaseInfra — Flux configuration for one deployable.
//
// Invoked once per deployable (worker, portal). Each invocation creates a
// `Microsoft.KubernetesConfiguration/fluxConfigurations` resource scoped to
// the AKS cluster with an `azureBlob` source pointing at the deployable's
// manifest container in the Phase-3 storage account.
//
// Reconciliation interval is 120s (Spec SC-003).
// Authentication: managed identity — the AKS kubelet UAMI is granted
// `Storage Blob Data Reader` on the account in `storage.bicep` and the
// `microsoft.flux` extension is configured with `useKubeletIdentity: 'true'`
// in `aks.bicep`, so the Flux source controller pulls manifests under the
// kubelet identity.
// ==============================================================================

@description('AKS cluster name (parent of the extension resource).')
param aksClusterName string

@description('Logical name for this Flux configuration (e.g. "worker", "portal").')
param configName string

@description('Blob container endpoint URL (e.g. https://<account>.blob.core.windows.net).')
param blobContainerEndpoint string

@description('Manifest container name (e.g. worker-manifests).')
param containerName string

@description('Kustomization path within the container (relative to container root).')
param kustomizationPath string = './'

@description('Reconciliation interval in seconds (Spec SC-003).')
param syncIntervalSeconds int = 120

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' existing = {
  name: aksClusterName
}

resource fluxConfig 'Microsoft.KubernetesConfiguration/fluxConfigurations@2024-11-01' = {
  scope: aks
  name: configName
  properties: {
    scope: 'cluster'
    namespace: 'flux-system'
    sourceKind: 'AzureBlob'
    suspend: false
    azureBlob: {
      url: blobContainerEndpoint
      containerName: containerName
      syncIntervalInSeconds: syncIntervalSeconds
      timeoutInSeconds: 600
    }
    kustomizations: {
      '${configName}': {
        path: kustomizationPath
        dependsOn: []
        timeoutInSeconds: 600
        syncIntervalInSeconds: syncIntervalSeconds
        retryIntervalInSeconds: 60
        prune: true
        force: false
      }
    }
  }
}

output fluxConfigId string = fluxConfig.id
output fluxConfigName string = fluxConfig.name
