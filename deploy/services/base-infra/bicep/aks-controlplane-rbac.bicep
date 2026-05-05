// ==============================================================================
// PilotSwarm BaseInfra — AKS control-plane UAMI RBAC.
//
// When the AKS cluster identity is UserAssigned (required because the cluster
// uses a custom kubelet UAMI), Azure does NOT auto-assign the roles the cluster
// needs to operate. We must grant them explicitly:
//
//   1. Network Contributor on the AKS subnet — Azure CNI manages NICs/LB rules.
//
// NOTE: AGIC addon RBAC is NOT done here. The AGIC addon creates its OWN
// managed identity in the cluster's node RG (`ingressapplicationgateway-<aksName>`)
// and that identity — not the AKS control-plane UAMI — is what the AGIC pod
// uses to mutate the AppGw. AGIC role grants live in `agic-rbac.bicep`.
// ==============================================================================

@description('Principal (object) ID of the AKS control-plane UAMI.')
param controlPlaneIdentityPrincipalId string

@description('Resource ID of the VNet the AKS subnet lives in.')
param vnetId string

@description('Name of the AKS subnet inside that VNet.')
param aksSubnetName string

// Built-in role: Network Contributor.
var networkContributorRoleId = '4d97b98b-1d4f-4787-a291-c67834d212e7'

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: last(split(vnetId, '/'))
}

resource aksSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: aksSubnetName
}

resource networkContributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: networkContributorRoleId
}

resource subnetNetworkContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aksSubnet.id, controlPlaneIdentityPrincipalId, networkContributorRoleId)
  scope: aksSubnet
  properties: {
    principalId: controlPlaneIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: networkContributorRoleDef.id
  }
}
