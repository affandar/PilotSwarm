// ==============================================================================
// PilotSwarm BaseInfra — Application Gateway (Standard_v2 / WAF_v2) with a
// Private Link configuration suitable for Azure Front Door Premium origin.
//
// The `privateLinkConfigurations` block and the private frontend IP binding
// are adapted verbatim from
//   postgresql-fleet-manager/src/Deploy/BaseInfra/bicep/application-gateway.bicep:270-309
// The rest of the module is simplified: no AGIC preservation of existing
// pools/listeners/rules (PilotSwarm rolls out from a clean state per region
// under GitOps; AGIC repopulates these after the FluxConfig reconciles).
// ==============================================================================

@description('Azure region.')
param location string

@description('Application Gateway name.')
param applicationGatewayName string

@description('App Gateway subnet ID.')
param subnetId string

@description('App Gateway Private Link subnet ID (must differ from subnetId).')
param privateLinkSubnetId string

@description('Static private IP address for the App Gateway private frontend. Must live within the App Gateway subnet range.')
param privateIpAddress string

@description('WAF mode.')
@allowed([
  'Detection'
  'Prevention'
])
param wafMode string = 'Prevention'

@description('Availability zones for the App Gateway. Empty array disables zone placement.')
param availabilityZones array = []

// ---------------------------------------------------------------------------
// WAF policy
// ---------------------------------------------------------------------------
resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2024-01-01' = {
  name: '${applicationGatewayName}-waf-policy'
  location: location
  properties: {
    policySettings: {
      state: 'Enabled'
      mode: wafMode
      requestBodyCheck: true
      maxRequestBodySizeInKb: 128
      fileUploadLimitInMb: 100
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'OWASP'
          ruleSetVersion: '3.2'
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.0'
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Public IP (required by WAF_v2 even though the Front Door origin consumes
// the private frontend over Private Link).
// ---------------------------------------------------------------------------
resource publicIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: '${applicationGatewayName}-pip'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: toLower(applicationGatewayName)
    }
  }
  zones: availabilityZones
}

// ---------------------------------------------------------------------------
// Default frontend/backend/listener/rule configuration. These are the seed
// values; AGIC replaces/augments them once the cluster is ingressing.
// ---------------------------------------------------------------------------
var frontendPorts = [
  {
    name: 'httpPort'
    properties: {
      port: 80
    }
  }
  {
    name: 'httpsPort'
    properties: {
      port: 443
    }
  }
]

var backendAddressPools = [
  {
    name: 'defaultBackendPool'
    properties: {
      backendAddresses: []
    }
  }
]

var backendHttpSettingsCollection = [
  {
    name: 'defaultBackendHttpSettings'
    properties: {
      port: 80
      protocol: 'Http'
      cookieBasedAffinity: 'Disabled'
      requestTimeout: 30
      pickHostNameFromBackendAddress: false
    }
  }
]

var httpListeners = [
  {
    name: 'defaultHttpListener'
    properties: {
      frontendIPConfiguration: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/frontendIPConfigurations',
          applicationGatewayName,
          'appGatewayFrontendIP'
        )
      }
      frontendPort: {
        id: resourceId('Microsoft.Network/applicationGateways/frontendPorts', applicationGatewayName, 'httpPort')
      }
      protocol: 'Http'
    }
  }
  // Private frontend listener — required for Azure to materialise the
  // Private Link Service backing the privateLinkConfiguration below.
  {
    name: 'privateHttpListener'
    properties: {
      frontendIPConfiguration: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/frontendIPConfigurations',
          applicationGatewayName,
          'appGatewayPrivateFrontendIP'
        )
      }
      frontendPort: {
        id: resourceId('Microsoft.Network/applicationGateways/frontendPorts', applicationGatewayName, 'httpPort')
      }
      protocol: 'Http'
    }
  }
]

var requestRoutingRules = [
  {
    name: 'defaultRoutingRule'
    properties: {
      priority: 100
      ruleType: 'Basic'
      httpListener: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/httpListeners',
          applicationGatewayName,
          'defaultHttpListener'
        )
      }
      backendAddressPool: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/backendAddressPools',
          applicationGatewayName,
          'defaultBackendPool'
        )
      }
      backendHttpSettings: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/backendHttpSettingsCollection',
          applicationGatewayName,
          'defaultBackendHttpSettings'
        )
      }
    }
  }
  {
    name: 'privateRoutingRule'
    properties: {
      priority: 200
      ruleType: 'Basic'
      httpListener: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/httpListeners',
          applicationGatewayName,
          'privateHttpListener'
        )
      }
      backendAddressPool: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/backendAddressPools',
          applicationGatewayName,
          'defaultBackendPool'
        )
      }
      backendHttpSettings: {
        id: resourceId(
          'Microsoft.Network/applicationGateways/backendHttpSettingsCollection',
          applicationGatewayName,
          'defaultBackendHttpSettings'
        )
      }
    }
  }
]

// ---------------------------------------------------------------------------
// Application Gateway (WAF_v2).
// ---------------------------------------------------------------------------
resource applicationGateway 'Microsoft.Network/applicationGateways@2024-01-01' = {
  name: applicationGatewayName
  location: location
  zones: availabilityZones
  properties: {
    sku: {
      name: 'WAF_v2'
      tier: 'WAF_v2'
    }
    autoscaleConfiguration: {
      minCapacity: 1
      maxCapacity: 10
    }
    enableHttp2: true
    firewallPolicy: {
      id: wafPolicy.id
    }
    gatewayIPConfigurations: [
      {
        name: 'appGatewayIpConfig'
        properties: {
          subnet: {
            id: subnetId
          }
        }
      }
    ]
    // Private Link configuration for Front Door connectivity — must be
    // defined before frontendIPConfigurations. Adapted verbatim from
    // postgresql-fleet-manager application-gateway.bicep:270-309.
    privateLinkConfigurations: [
      {
        name: 'privateLinkConfig'
        properties: {
          ipConfigurations: [
            {
              name: 'privateLinkIpConfig'
              properties: {
                privateIPAllocationMethod: 'Dynamic'
                subnet: {
                  id: privateLinkSubnetId
                }
                primary: true
              }
            }
          ]
        }
      }
    ]
    frontendIPConfigurations: [
      {
        name: 'appGatewayFrontendIP'
        properties: {
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
      {
        name: 'appGatewayPrivateFrontendIP'
        properties: {
          privateIPAllocationMethod: 'Static'
          privateIPAddress: privateIpAddress
          subnet: {
            id: subnetId
          }
          privateLinkConfiguration: {
            id: '${resourceId('Microsoft.Network/applicationGateways', applicationGatewayName)}/privateLinkConfigurations/privateLinkConfig'
          }
        }
      }
    ]
    frontendPorts: frontendPorts
    backendAddressPools: backendAddressPools
    backendHttpSettingsCollection: backendHttpSettingsCollection
    httpListeners: httpListeners
    requestRoutingRules: requestRoutingRules
  }
}

output applicationGatewayId string = applicationGateway.id
output applicationGatewayName string = applicationGateway.name
output wafPolicyId string = wafPolicy.id
output privateLinkConfigurationName string = 'privateLinkConfig'
output privateLinkConfigurationId string = '${applicationGateway.id}/privateLinkConfigurations/privateLinkConfig'
output publicFrontendIPConfigurationId string = '${applicationGateway.id}/frontendIPConfigurations/appGatewayFrontendIP'
output privateFrontendIPConfigurationId string = '${applicationGateway.id}/frontendIPConfigurations/appGatewayPrivateFrontendIP'
