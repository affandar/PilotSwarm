targetScope = 'resourceGroup'

@description('Timestamp for unique nested deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name used by Flux.')
param storageAccountName string

@description('BaseInfra AKS cluster name.')
param aksClusterName string

@description('DNS-safe repository instance name supplied by the composition repository.')
@minLength(1)
@maxLength(40)
param deployInstance string

@description('Operating system selected for this repository worker.')
@allowed([
  'linux'
  'windows'
])
param workerOs string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

var configName = 'git-repo-worker-${deployInstance}'
// Azure limits `<configuration-name>-<kustomization-key>` to 62 characters.
// Preserve the descriptive key for short instances and use a stable short key
// only when the repeated configuration name would exceed that limit.
var kustomizationName = length(configName) * 2 + 1 <= 62 ? configName : 'rw'
var containerName = 'repo-worker-${deployInstance}-manifests'

resource manifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

module GitRepoWorkerFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'repo-worker-flux-${uniqueString(deployInstance)}-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: configName
    kustomizationName: kustomizationName
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: manifestsContainer.name
    kustomizationPath: 'overlays/${workerOs}'
  }
}

output manifestsContainerName string = manifestsContainer.name
output fluxConfigName string = GitRepoWorkerFluxConfig.outputs.fluxConfigName
