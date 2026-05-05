// ==============================================================================
// PilotSwarm BaseInfra — Approver UAMI RBAC.
//
// Grants the approver UAMI two roles needed across the lifecycle:
//
//   1. Reader on the parent RG — so `check-appgw-exists.bicep` can call
//      `az network application-gateway show` BEFORE the AppGw exists (first
//      deploy) and distinguish "ResourceNotFound" from "Forbidden".
//      Tighter than fleet-manager's pattern (which grants Subscription Owner).
//
//   2. Contributor on the Application Gateway — so per-service deployments
//      can push KV-referenced TLS certs onto the AppGw via
//      `Common/bicep/appgw-add-ssl-certificate.bicep` (FM pattern).
//      The role assignment is conditional on `applicationGatewayName` being
//      set so this module can run before the AppGw exists.
// ==============================================================================

@description('Principal (object) ID of the approver UAMI that runs check-appgw-exists and cert-push scripts.')
param approverPrincipalId string

@description('Optional name of the Application Gateway. When set, grants Contributor to the approver UAMI on the AppGw resource. Empty on the very first deploy (before AppGw exists).')
param applicationGatewayName string = ''

@description('Optional name of the App Gateway UAMI. When set together with applicationGatewayName, grants Managed Identity Operator to the approver UAMI on the AppGw UAMI so that ARM accepts implicit re-assertion of the assigned identity during applicationGateways/write calls (e.g. ssl-cert create).')
param appGatewayManagedIdentityName string = ''

@description('Optional name of the VNet that holds the AppGw subnet. When set with appGatewaySubnetName, grants Network Contributor to the approver UAMI on the subnet so applicationGateways/write can re-assert the subnet join during ssl-cert push.')
param vnetName string = ''

@description('Optional name of the AppGw subnet within vnetName.')
param appGatewaySubnetName string = ''

// Built-in role: Reader.
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

// Built-in role: Contributor.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

// Built-in role: Managed Identity Operator.
var managedIdentityOperatorRoleId = 'f1a07417-d97a-45cb-824c-7a7467783830'

// Built-in role: Network Contributor.
var networkContributorRoleId = '4d97b98b-1d4f-4787-a291-c67834d212e7'

resource readerRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: readerRoleId
}

resource contributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: contributorRoleId
}

resource managedIdentityOperatorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: managedIdentityOperatorRoleId
}

resource networkContributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: networkContributorRoleId
}

resource approverRgReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, approverPrincipalId, readerRoleId)
  scope: resourceGroup()
  properties: {
    principalId: approverPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleDef.id
  }
}

resource applicationGateway 'Microsoft.Network/applicationGateways@2024-01-01' existing = if (!empty(applicationGatewayName)) {
  name: applicationGatewayName
}

resource approverAppGwContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(applicationGatewayName)) {
  name: guid(resourceGroup().id, approverPrincipalId, contributorRoleId, 'appgw')
  scope: applicationGateway
  properties: {
    principalId: approverPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleDef.id
  }
}

resource appGatewayManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!empty(appGatewayManagedIdentityName)) {
  name: appGatewayManagedIdentityName
}

resource approverAppGwMidOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(appGatewayManagedIdentityName)) {
  name: guid(resourceGroup().id, approverPrincipalId, managedIdentityOperatorRoleId, 'appgw-mid')
  scope: appGatewayManagedIdentity
  properties: {
    principalId: approverPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: managedIdentityOperatorRoleDef.id
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' existing = if (!empty(vnetName) && !empty(appGatewaySubnetName)) {
  name: vnetName

  resource appGwSubnet 'subnets' existing = {
    name: appGatewaySubnetName
  }
}

resource approverAppGwSubnetNetContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(vnetName) && !empty(appGatewaySubnetName)) {
  name: guid(resourceGroup().id, approverPrincipalId, networkContributorRoleId, 'appgw-subnet')
  scope: vnet::appGwSubnet
  properties: {
    principalId: approverPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: networkContributorRoleDef.id
  }
}
