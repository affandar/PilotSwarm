// ==============================================================================
// PilotSwarm BaseInfra — AGIC addon RBAC.
//
// The AKS AGIC addon creates its own user-assigned managed identity in the
// cluster's node resource group (deterministic name:
// `ingressapplicationgateway-<clusterName>`). The AGIC pod authenticates with
// THAT identity, not the AKS control-plane UAMI, so the addon identity needs
// explicit role grants to manage the BYO Application Gateway.
//
// Mirrors reference deployment patterns: `agic-vnet-rbac.bicep`
// combined into one module:
//   1. Contributor on the Application Gateway — required to mutate AppGw config
//      when Ingress objects change.
//   2. Managed Identity Operator on the AppGw's UAMI — required so AGIC can
//      `assignUserAssignedIdentity` on the AppGw resource (per AGIC docs).
//   3. Network Contributor on the AppGw subnet — required to manage subnet
//      resources (e.g. NSG associations, IP config).
// ==============================================================================

@description('Azure region.')
param location string

@description('Application Gateway name (must exist in the parent RG).')
param applicationGatewayName string

@description('AppGw user-assigned managed identity name (must exist in the parent RG).')
param appGatewayManagedIdentityName string

@description('Name of the AKS VNet (parent of the AppGw subnet).')
param virtualNetworkName string

@description('Name of the AppGw subnet inside the VNet.')
param appGatewaySubnetName string

@description('Name of the AGIC addon managed identity (auto-created by AKS in the node RG, e.g. ingressapplicationgateway-<aksName>).')
param agicAddonIdentityName string

@description('Resource group containing the AGIC addon managed identity (AKS node RG).')
param agicAddonIdentityResourceGroup string

resource agicIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: agicAddonIdentityName
  scope: resourceGroup(agicAddonIdentityResourceGroup)
}

resource applicationGateway 'Microsoft.Network/applicationGateways@2024-01-01' existing = {
  name: applicationGatewayName
}

resource appGatewayManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: appGatewayManagedIdentityName
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-01-01' existing = {
  name: virtualNetworkName
}

resource appGwSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' existing = {
  parent: virtualNetwork
  name: appGatewaySubnetName
}

// Built-in role definitions.
resource contributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
}

resource managedIdentityOperatorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'f1a07417-d97a-45cb-824c-7a7467783830'
}

resource networkContributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: '4d97b98b-1d4f-4787-a291-c67834d212e7'
}

resource readerRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}

// 1. Contributor on the AppGw → AGIC addon identity.
resource AssignContributorToAgic 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('agic-appgw-contributor-${location}', applicationGatewayName, agicAddonIdentityName)
  scope: applicationGateway
  properties: {
    principalId: agicIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleDef.id
  }
}

// 2. Managed Identity Operator on the AppGw's UAMI → AGIC addon identity.
resource AssignManagedIdentityOperatorToAgic 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('agic-appgw-mid-operator-${location}', appGatewayManagedIdentityName, agicAddonIdentityName)
  scope: appGatewayManagedIdentity
  properties: {
    principalId: agicIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: managedIdentityOperatorRoleDef.id
  }
}

// 3. Network Contributor on the AppGw subnet → AGIC addon identity.
resource AssignNetworkContributorToAgic 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('agic-subnet-network-contributor-${location}', virtualNetworkName, appGatewaySubnetName, agicAddonIdentityName)
  scope: appGwSubnet
  properties: {
    principalId: agicIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: networkContributorRoleDef.id
  }
}

// 4. Reader on the parent RG → AGIC addon identity.
// Required so AGIC's `mutate_aks` can GET the AppGw's Public IP Address
// (lives in the same RG); without this AGIC logs 403s on every reconcile.
resource AssignReaderOnRgToAgic 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('agic-rg-reader-${location}', resourceGroup().id, agicAddonIdentityName)
  scope: resourceGroup()
  properties: {
    principalId: agicIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleDef.id
  }
}
