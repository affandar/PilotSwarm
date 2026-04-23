// ==============================================================================
// PilotSwarm Portal - Front Door Origin + Route + Private Endpoint Approval
// ==============================================================================
// Scope: resource group (deploys the approve-pe deploymentScript into the
// BaseInfra RG, and cross-RG-scopes the AFD origin/route into the GlobalInfra
// RG).
//
// This module does NOT provision the portal Kubernetes workload — that is
// reconciled by FLUX from the portal manifest blob container (see
// deploy/ev2/BaseInfra/bicep/flux-config.bicep and
// deploy/gitops/portal/).
//
// What this module does:
//   1. Computes the portal's certificate subject (hostname).
//   2. Computes the documented Application Gateway PLS service id string.
//   3. Creates the Front Door origin group, private-link origin, and route
//      in the GlobalInfra RG (via the verbatim shared module).
//   4. Auto-approves the pending PLS connection on the AppGW side.
//
// Surfaces BackendHostName as an output so EV2 scope binding can fan it
// into overlay/.env as PORTAL_HOSTNAME (Spec FR-014).
// ==============================================================================

targetScope = 'resourceGroup'

// -----------------------------------------------------------------------------
// Naming parameters
// -----------------------------------------------------------------------------

@description('Short resource-name root, e.g. pilotswarmprod1. Must match the value used by BaseInfra so the AppGW hostname aligns.')
param resourceName string

@description('Azure region (lowercased). Used in the certificate subject to disambiguate multi-region deployments.')
param region string

@description('DNS suffix for the portal cert, e.g. pilotswarm.azure.com.')
param sslCertificateDomainSuffix string

// -----------------------------------------------------------------------------
// BaseInfra references (per-region)
// -----------------------------------------------------------------------------

@description('Application Gateway name (from BaseInfra output).')
param applicationGatewayName string

@description('Application Gateway Private Link configuration name (from BaseInfra output).')
param privateLinkConfigurationName string

@description('UAMI resource id used by the approve-private-endpoint deployment script. Must have Network Contributor on the AppGW.')
param approvalManagedIdentityId string

// -----------------------------------------------------------------------------
// GlobalInfra references
// -----------------------------------------------------------------------------

@description('Azure Front Door profile name (from GlobalInfra output).')
param frontDoorProfileName string

@description('Resource group that contains the Front Door profile.')
param frontDoorProfileResourceGroup string

@description('Azure Front Door endpoint name (from GlobalInfra output).')
param frontDoorEndpointName string

// -----------------------------------------------------------------------------
// Derived values
// -----------------------------------------------------------------------------

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

var location = toLower(region)

// Portal certificate subject / AFD backend hostname.
// Matches the AppGW listener hostname and the portal Ingress spec.rules[0].host.
var certificateSubject = '${resourceName}-${region}.${sslCertificateDomainSuffix}'

// PLS service id string format (per Microsoft docs):
//   /subscriptions/{sub}/resourceGroups/{appGwRg}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_{applicationGatewayName}_{privateLinkConfigurationName}
// This is the format that Front Door uses to establish the shared PL
// connection to an App Gateway. Not consumed directly by the origin module
// (which rebuilds the same string internally), but surfaced as an output for
// audit/diagnostic scope bindings.
var privateLinkServiceId = '/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_${applicationGatewayName}_${privateLinkConfigurationName}'

// -----------------------------------------------------------------------------
// Existing references (for pulling AppGW location - must match privateLinkLocation)
// -----------------------------------------------------------------------------

resource applicationGateway 'Microsoft.Network/applicationGateways@2024-01-01' existing = {
  name: applicationGatewayName
}

// -----------------------------------------------------------------------------
// Front Door origin + route (cross-RG scope into GlobalInfra RG)
// -----------------------------------------------------------------------------

module afdOrigin '../../Common/bicep/frontdoor-origin-route.bicep' = {
  name: 'portal-afd-${dTime}'
  scope: az.resourceGroup(frontDoorProfileResourceGroup)
  params: {
    frontDoorProfileName: frontDoorProfileName
    frontDoorEndpointName: frontDoorEndpointName
    originGroupName: '${frontDoorProfileName}-portal-og'
    originName: '${resourceName}-portal-origin'
    routeName: '${frontDoorProfileName}-portal-route'
    applicationGatewayName: applicationGatewayName
    applicationGatewayResourceGroup: resourceGroup().name
    applicationGatewayPrivateLinkConfigName: privateLinkConfigurationName
    privateLinkLocation: applicationGateway.location
    originHostName: certificateSubject
    healthProbePath: '/healthz'
    patternToMatch: '/*'
  }
}

// -----------------------------------------------------------------------------
// Auto-approve pending PLS connection on the AppGW side
// -----------------------------------------------------------------------------

module plApprove '../../Common/bicep/approve-private-endpoint.bicep' = {
  name: 'portal-approve-pe-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    applicationGatewayResourceGroup: resourceGroup().name
    managedIdentityId: approvalManagedIdentityId
    dTime: dTime
    requestMessageFilter: 'Front Door Private Link request for the service'
  }
  dependsOn: [
    afdOrigin
  ]
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

@description('AFD backend hostname / AppGW listener host / Portal Ingress host. EV2 scope-binds this into overlay/.env as PORTAL_HOSTNAME.')
output BackendHostName string = certificateSubject

@description('Computed PLS service id string (audit/diagnostic).')
output PrivateLinkServiceId string = privateLinkServiceId

@description('Front Door route name created for the portal.')
output RouteName string = afdOrigin.outputs.routeName

@description('Count of PLS connections auto-approved in this deployment.')
output ApprovedPrivateEndpointCount int = plApprove.outputs.approvedCount
