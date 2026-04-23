targetScope = 'subscription'

// ==============================================================================
// PilotSwarm GlobalInfra — fleet-wide Azure Front Door Premium + WAF.
//
// Adapted from postgresql-fleet-manager/src/Deploy/GlobalInfra/bicep/main.bicep.
// Creates a single global AFD Premium profile shared by every region, with a
// WAF policy whose mode is environment-parameterized (Detection for dev so
// false positives never block traffic during bring-up; Prevention for prod).
// BaseInfra (Phase 3) attaches per-region custom domains + Private Link
// origins to this profile at rollout time.
// ==============================================================================

// ==============================================================================
// Parameters
// ==============================================================================

@description('Azure region used for the control-plane resource group. AFD itself is a global resource; this only anchors the RG.')
param region string = 'westus3'

@description('Resource group name that will hold the AFD profile, endpoint, and WAF policy.')
param resourceGroupName string

@description('Naming prefix. Applied to every resource so fleet-wide resources stay correlated in Azure Portal searches.')
param resourcePrefix string = 'pilotswarm'

@description('WAF mode. Detection logs only; Prevention blocks. Set per-environment via bicepparam.')
@allowed([
  'Detection'
  'Prevention'
])
param wafMode string = 'Prevention'

@description('Unique deployment identifier used only for module name uniqueness across re-runs.')
param dTime string = utcNow()

// ==============================================================================
// Variables
// ==============================================================================

var location = toLower(region)
var frontDoorProfileName = '${resourcePrefix}-afd'
var wafPolicyName = '${resourcePrefix}afdwafpolicy'

// ==============================================================================
// Resource Group
// ==============================================================================

resource resourceGroup 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: resourceGroupName
  location: location
  tags: {
    'pilotswarm:role': 'global-infra'
  }
}

// ==============================================================================
// WAF Policy (must exist before the profile so the security-policy module can
// reference its ID).
// ==============================================================================

module wafPolicy './frontdoor-waf-policy.bicep' = {
  name: '${resourcePrefix}-waf-${dTime}'
  scope: resourceGroup
  params: {
    wafPolicyName: wafPolicyName
    wafMode: wafMode
    location: 'global'
  }
}

// ==============================================================================
// Front Door Premium Profile + endpoint + security policy binding.
// Premium SKU is required for Private Link origins (see BaseInfra AppGW).
// ==============================================================================

module frontDoorProfile './frontdoor-profile.bicep' = {
  name: '${resourcePrefix}-afd-${dTime}'
  scope: resourceGroup
  params: {
    frontDoorProfileName: frontDoorProfileName
    wafPolicyId: wafPolicy.outputs.wafPolicyId
  }
}

// ==============================================================================
// Outputs (consumed by BaseInfra per-region rollouts and by EV2 shell
// extensions that bind per-region origins to this global endpoint).
// ==============================================================================

@description('Resource group name where the AFD profile, endpoint, and WAF policy live.')
output frontDoorProfileResourceGroup string = resourceGroup.name

@description('Front Door Premium profile name.')
output frontDoorProfileName string = frontDoorProfile.outputs.frontDoorProfileName

@description('Front Door profile resource ID.')
output frontDoorProfileId string = frontDoorProfile.outputs.frontDoorProfileId

@description('Front Door endpoint name (fleet-wide; per-region origins attach to this endpoint).')
output frontDoorEndpointName string = frontDoorProfile.outputs.frontDoorEndpointName

@description('Front Door endpoint resource ID.')
output frontDoorEndpointId string = frontDoorProfile.outputs.frontDoorEndpointId

@description('Default AFD endpoint hostname (e.g. pilotswarm-afd-endpoint-<hash>.z01.azurefd.net). Per-region custom domains replace this for user-facing traffic.')
output frontDoorEndpointHostName string = frontDoorProfile.outputs.frontDoorEndpointHostname

@description('WAF policy resource ID.')
output wafPolicyId string = wafPolicy.outputs.wafPolicyId
