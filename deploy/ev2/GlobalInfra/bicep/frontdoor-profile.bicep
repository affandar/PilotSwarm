// ==============================================================================
// Azure Front Door Premium profile + endpoint + security policy.
//
// Adapted from postgresql-fleet-manager/src/Deploy/GlobalInfra/bicep/
// frontdoor-profile.bicep. Per-region BaseInfra rollouts add custom domains
// and Private Link origins to the endpoint created here via EV2 shell
// extensions at rollout time.
// ==============================================================================

@description('Name of the Front Door Premium profile.')
param frontDoorProfileName string

@description('Resource ID of the WAF policy to bind via a securityPolicy.')
param wafPolicyId string

var frontDoorEndpointName = '${frontDoorProfileName}-endpoint'

// ==============================================================================
// Front Door Profile (Premium SKU — required for Private Link origins).
// ==============================================================================

resource frontDoorProfile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: frontDoorProfileName
  location: 'global'
  sku: {
    name: 'Premium_AzureFrontDoor'
  }
  properties: {
    originResponseTimeoutSeconds: 60
  }
  tags: {}
}

// ==============================================================================
// Endpoint (fleet-wide). BaseInfra rollouts create per-region
// `afdEndpoints/routes` + `afdOrigins` under this same endpoint.
// ==============================================================================

resource frontDoorEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: frontDoorProfile
  name: frontDoorEndpointName
  location: 'global'
  properties: {
    enabledState: 'Enabled'
  }
  tags: {}
}

// ==============================================================================
// Security policy binds the WAF policy to every path on the endpoint.
// BaseInfra does NOT redefine this; the binding is fleet-wide by design
// (Spec FR-016, SC-010).
// ==============================================================================

resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: frontDoorProfile
  name: '${frontDoorProfileName}-security-policy'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: {
        id: wafPolicyId
      }
      associations: [
        {
          domains: [
            {
              id: frontDoorEndpoint.id
            }
          ]
          patternsToMatch: [
            '/*'
          ]
        }
      ]
    }
  }
}

// ==============================================================================
// Outputs
// ==============================================================================

@description('Front Door profile name.')
output frontDoorProfileName string = frontDoorProfile.name

@description('Front Door profile resource ID.')
output frontDoorProfileId string = frontDoorProfile.id

@description('Default endpoint hostname.')
output frontDoorEndpointHostname string = frontDoorEndpoint.properties.hostName

@description('Front Door endpoint name.')
output frontDoorEndpointName string = frontDoorEndpoint.name

@description('Front Door endpoint resource ID.')
output frontDoorEndpointId string = frontDoorEndpoint.id
