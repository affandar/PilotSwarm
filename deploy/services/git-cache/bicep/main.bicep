// ==============================================================================
// PilotSwarm git-cache — instance-isolated manifest container + Flux config.
// ==============================================================================

targetScope = 'resourceGroup'

@description('Timestamp for unique nested deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name used by Flux.')
param storageAccountName string

@description('BaseInfra AKS cluster name.')
param aksClusterName string

@description('BaseInfra resource prefix used to locate the CSI workload identity.')
param baseInfraResourceNamePrefix string

@description('DNS-safe repository instance name supplied by the composition repository.')
@minLength(1)
@maxLength(40)
param deployInstance string

@description('AKS agent-pool name for this cache instance. The pool itself is declared and reconciled by base-infra (additionalAgentPools); git-cache no longer creates it. Kept here only to echo the pool name in outputs and to validate naming consistency with the DaemonSet placement.')
@minLength(1)
@maxLength(12)
param nodePoolName string

@description('Operating system for the cache agent pool.')
@allowed([
  'linux'
  'windows'
])
param gitCacheOs string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' existing = {
  name: aksClusterName
}

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseInfraResourceNamePrefix}-csi-mid'
}

resource gitCacheFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: csiIdentity
  name: 'git-cache-${deployInstance}-fedcred'
  properties: {
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:pilotswarm:pilotswarm-git-cache-${deployInstance}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

var configName = 'git-cache-${deployInstance}'
var containerName = '${configName}-manifests'

resource manifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

module GitCacheFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: '${configName}-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: configName
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: manifestsContainer.name
    kustomizationPath: 'overlays/${gitCacheOs}'
  }
}

output manifestsContainerName string = manifestsContainer.name
output fluxConfigName string = GitCacheFluxConfig.outputs.fluxConfigName
output csiIdentityClientId string = csiIdentity.properties.clientId
output cacheNodePoolName string = nodePoolName
