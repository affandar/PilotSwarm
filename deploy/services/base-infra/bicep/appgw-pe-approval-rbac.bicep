// ==============================================================================
// PilotSwarm BaseInfra — RBAC for the AppGW Private Link approver UAMI.
//
// The Portal Bicep runs `approve-private-endpoint.bicep` as a deployment
// script that auto-approves the Front Door → AppGW Private Link connection.
// That script needs a UAMI with permission to mutate the AppGW's
// `privateEndpointConnections` collection. We grant the built-in
// `Network Contributor` role on the AppGW resource — the narrowest built-in
// role that includes `Microsoft.Network/applicationGateways/*`.
//
// Lives in BaseInfra (not Portal) because the AppGW is created here, and
// the role assignment must exist before Portal's deployment script runs.
// ==============================================================================

@description('Name of the per-region App Gateway.')
param applicationGatewayName string

@description('Principal ID of the approver UAMI (BaseInfra Uami.outputs.approverIdentityPrincipalId).')
param approverPrincipalId string

// Built-in role: Network Contributor.
var networkContributorRoleId = '4d97b98b-1d4f-4787-a291-c67834d212e7'

resource applicationGateway 'Microsoft.Network/applicationGateways@2023-05-01' existing = {
  name: applicationGatewayName
}

resource networkContributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: applicationGateway
  name: networkContributorRoleId
}

resource assignNetworkContributorToApprover 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationGateway.id, approverPrincipalId, networkContributorRoleId)
  scope: applicationGateway
  properties: {
    principalId: approverPrincipalId
    roleDefinitionId: networkContributorRoleDef.id
    principalType: 'ServicePrincipal'
  }
}
