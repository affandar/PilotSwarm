// ==============================================================================
// PilotSwarm BaseInfra — Azure Container Registry.
//
// Hosts the worker + portal images. The AKS kubelet UAMI is granted AcrPull
// here so pods can pull images without an imagePullSecret under GitOps.
// ==============================================================================

@description('Azure region.')
param location string

@description('ACR name (globally unique, alphanumeric only).')
param registryName string

@description('ACR SKU. Basic is fine for dev; Premium unlocks geo-replication and private endpoints for prod.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param skuName string = 'Basic'

@description('Principal ID of the AKS kubelet UAMI that needs AcrPull.')
param aksKubeletPrincipalId string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPullRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: acr
  name: acrPullRoleId
}

resource assignAcrPullToKubelet 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, aksKubeletPrincipalId, acrPullRoleId)
  scope: acr
  properties: {
    principalId: aksKubeletPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDef.id
  }
}

output registryId string = acr.id
output registryName string = acr.name
output loginServer string = acr.properties.loginServer
