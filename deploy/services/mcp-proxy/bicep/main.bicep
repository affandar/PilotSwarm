targetScope = 'resourceGroup'

@description('Timestamp for unique nested deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name used by Flux.')
param storageAccountName string

@description('BaseInfra AKS cluster name.')
param aksClusterName string

@description('DNS-safe MCP proxy instance name supplied by the composition repository.')
@minLength(1)
@maxLength(40)
param deployInstance string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

var configName = 'mcp-proxy-${deployInstance}'
var containerName = 'mcp-proxy-${deployInstance}-manifests'

resource manifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

module McpProxyFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'mcp-proxy-flux-${uniqueString(deployInstance)}-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: configName
    kustomizationName: 'proxy'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: manifestsContainer.name
    kustomizationPath: 'overlays/default'
  }
}

output manifestsContainerName string = manifestsContainer.name
output fluxConfigName string = McpProxyFluxConfig.outputs.fluxConfigName
