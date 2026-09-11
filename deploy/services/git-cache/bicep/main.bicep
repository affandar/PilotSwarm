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

@description('AKS agent-pool name for this cache instance.')
@minLength(1)
@maxLength(12)
param nodePoolName string

@description('Desired number of nodes in the cache agent pool.')
@minValue(0)
param nodeCount int

@description('VM SKU for the cache agent pool.')
param nodeVmSize string

@description('Operating system for the cache agent pool.')
@allowed([
  'linux'
  'windows'
])
param gitCacheOs string

@description('OS disk size in GB for the cache agent pool.')
@minValue(30)
param nodeOsDiskSizeGb int

@description('OS disk type for the cache agent pool.')
@allowed([
  'Managed'
  'Ephemeral'
])
param nodeOsDiskType string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' existing = {
  name: aksClusterName
}

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseInfraResourceNamePrefix}-csi-mid'
}

resource cacheNodePool 'Microsoft.ContainerService/managedClusters/agentPools@2024-05-01' = {
  parent: aks
  name: nodePoolName
  properties: {
    count: nodeCount
    vmSize: nodeVmSize
    osType: gitCacheOs == 'windows' ? 'Windows' : 'Linux'
    osSKU: gitCacheOs == 'windows' ? 'Windows2022' : 'AzureLinux'
    osDiskSizeGB: nodeOsDiskSizeGb
    osDiskType: nodeOsDiskType
    mode: 'User'
    type: 'VirtualMachineScaleSets'
    vnetSubnetID: aks.properties.agentPoolProfiles[0].vnetSubnetID
    enableAutoScaling: false
    scaleDownMode: 'Delete'
    orchestratorVersion: aks.properties.kubernetesVersion
    nodeLabels: {
      'pilotswarm.io/git-cache-repo': deployInstance
    }
    nodeTaints: gitCacheOs == 'windows'
      ? [
          cacheIsolationTaint
          'os=windows:NoSchedule'
        ]
      : [
          cacheIsolationTaint
        ]
  }
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
var cacheIsolationTaint = 'pilotswarm.io/cache-not-ready=true:NoSchedule'

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
output cacheNodePoolName string = cacheNodePool.name
