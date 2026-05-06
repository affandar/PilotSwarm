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

@description('Resource ID of the user-assigned managed identity attached to the Application Gateway. Required so the AGIC addon can hold the "Managed Identity Operator" role on this UAMI (mirrors postgresql-fleet-manager pattern).')
param userAssignedIdentityId string

@description('Whether the Application Gateway already exists in this RG. When true, AGIC-managed arrays (pools, listeners, rules, probes, etc.) are read back from the existing resource and re-emitted unchanged so we do not clobber AGIC\'s runtime config. Driven by check-appgw-exists.bicep.')
param appGwExists bool = false

@description('Resource ID of the Log Analytics workspace that receives Application Gateway diagnostic logs (access + firewall) and metrics. Empty string disables the diagnostic setting.')
param logAnalyticsWorkspaceResourceId string = ''

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
      // Exclude attributes that carry opaque structured payloads (bearer JWTs,
      // MSAL state cookies, portal UI-state cookies) from WAF inspection. Their
      // base64 / JSON content routinely matches OWASP SQLi/XSS rules and produces
      // false-positive blocks. Token validation (issuer / audience / signature)
      // happens at the portal via JWKS — there is no security benefit to scanning
      // these. Per-cookie exclusions are required because WAF re-parses the
      // Cookie header into CookieValue:<name> match variables, so excluding the
      // Cookie header alone does not silence per-cookie matches.
      exclusions: [
        {
          matchVariable: 'RequestHeaderNames'
          selectorMatchOperator: 'Equals'
          selector: 'Authorization'
        }
        {
          matchVariable: 'RequestHeaderNames'
          selectorMatchOperator: 'Equals'
          selector: 'Cookie'
        }
        {
          matchVariable: 'RequestCookieNames'
          selectorMatchOperator: 'StartsWith'
          selector: 'msal'
        }
        {
          matchVariable: 'RequestCookieNames'
          selectorMatchOperator: 'Equals'
          selector: 'msal.interaction.status'
        }
        // Portal session-owner-filter cookie carries a JSON object (UI state).
        // TODO: portal should move this to localStorage so the WAF never sees it
        // (see docs/bugreports/portal-cookie-payloads-trigger-waf.md). Until then,
        // this exclusion is required to avoid SQLI-942200 false positives.
        {
          matchVariable: 'RequestCookieNames'
          selectorMatchOperator: 'Equals'
          selector: 'pilotswarm_session_owner_filter'
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
// AGIC config preservation (postgresql-fleet-manager pattern).
// ---------------------------------------------------------------------------
// AGIC dynamically manages backendAddressPools, httpListeners, requestRoutingRules,
// probes, urlPathMaps, redirectConfigurations, rewriteRuleSets, frontendPorts,
// and sslCertificates based on Kubernetes Ingress resources. On subsequent
// BaseInfra deploys we read those arrays back from the existing AppGw and
// re-emit them unchanged, instead of re-asserting the seed defaults. Without
// this, every redeploy briefly loses ingress and risks racing AGIC into a
// `Failed` provisioning state (e.g. ApplicationGatewayPrivateLinkDeleteError).
// ---------------------------------------------------------------------------
module existingAppGwConfig 'application-gateway-existing.bicep' = if (appGwExists) {
  name: '${applicationGatewayName}-read-existing'
  params: {
    applicationGatewayName: applicationGatewayName
  }
}

// ---------------------------------------------------------------------------
// Default frontend/backend/listener/rule configuration. These are the seed
// values; AGIC replaces/augments them once the cluster is ingressing.
// ---------------------------------------------------------------------------
var defaultFrontendPorts = [
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

var defaultBackendAddressPools = [
  {
    name: 'defaultBackendPool'
    properties: {
      backendAddresses: []
    }
  }
]

var defaultBackendHttpSettingsCollection = [
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

var defaultHttpListeners = [
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
]

var defaultRequestRoutingRules = [
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
]

// ---------------------------------------------------------------------------
// Private Link Service bootstrap entries.
//
// For Azure to materialise the hidden Private Link Service backing the
// AppGw privateLinkConfiguration (the `_<guid>_<appGwName>_<plcName>` PLS
// that Front Door's PE consumes), the AppGw must have at least one
// HTTP listener bound to the private frontend IP that references the
// privateLinkConfiguration. A privateLinkConfigurations block alone is
// not sufficient.
//
// AGIC reconciles AppGw config from K8s Ingress state and *removes*
// listeners/rules it does not own. Its naming scheme uses prefixes
// `fl-`/`rr-`/`bp-`/`bhs-`/`fp-`. The bootstrap entries below use a
// `psPls`-prefixed naming scheme that AGIC will not touch, and they are
// always concat'd into the effective arrays — including the existing
// AGIC-managed read-back path — so the private listener survives every
// re-deploy and the hidden PLS keeps existing.
// ---------------------------------------------------------------------------
var psPlsBootstrapPool = {
  name: 'psPlsBootstrapPool'
  properties: {
    backendAddresses: []
  }
}

var psPlsBootstrapSettings = {
  name: 'psPlsBootstrapSettings'
  properties: {
    port: 80
    protocol: 'Http'
    cookieBasedAffinity: 'Disabled'
    requestTimeout: 30
    pickHostNameFromBackendAddress: false
  }
}

var psPlsBootstrapListener = {
  name: 'psPlsBootstrapListener'
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

var psPlsBootstrapRule = {
  name: 'psPlsBootstrapRule'
  properties: {
    // High priority value (low precedence) within ARM's 1-20000 range to
    // avoid colliding with AGIC's ingress rules, which start at small
    // numbers.
    priority: 20000
    ruleType: 'Basic'
    httpListener: {
      id: resourceId(
        'Microsoft.Network/applicationGateways/httpListeners',
        applicationGatewayName,
        'psPlsBootstrapListener'
      )
    }
    backendAddressPool: {
      id: resourceId(
        'Microsoft.Network/applicationGateways/backendAddressPools',
        applicationGatewayName,
        'psPlsBootstrapPool'
      )
    }
    backendHttpSettings: {
      id: resourceId(
        'Microsoft.Network/applicationGateways/backendHttpSettingsCollection',
        applicationGatewayName,
        'psPlsBootstrapSettings'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Effective values: defaults on first deploy, AGIC-managed values on
// subsequent deploys. Behind appGwExists; bang-suffix tells Bicep the
// conditional module's outputs are non-null in this branch.
//
// PLS bootstrap entries (psPls*) are always concat'd onto the effective
// arrays — filtered first to keep the deployment idempotent — so the
// private-FE listener that materialises the hidden PLS survives every
// AGIC reconciliation.
// ---------------------------------------------------------------------------
var effectiveFrontendPorts = appGwExists ? existingAppGwConfig!.outputs.frontendPorts : defaultFrontendPorts
var effectiveBackendAddressPools = concat(
  filter(
    appGwExists ? existingAppGwConfig!.outputs.backendAddressPools : defaultBackendAddressPools,
    p => p.name != 'psPlsBootstrapPool'
  ),
  [psPlsBootstrapPool]
)
var effectiveBackendHttpSettingsCollection = concat(
  filter(
    appGwExists ? existingAppGwConfig!.outputs.backendHttpSettingsCollection : defaultBackendHttpSettingsCollection,
    s => s.name != 'psPlsBootstrapSettings'
  ),
  [psPlsBootstrapSettings]
)
var effectiveHttpListeners = concat(
  filter(
    appGwExists ? existingAppGwConfig!.outputs.httpListeners : defaultHttpListeners,
    l => l.name != 'psPlsBootstrapListener'
  ),
  [psPlsBootstrapListener]
)
var effectiveRequestRoutingRules = concat(
  filter(
    appGwExists ? existingAppGwConfig!.outputs.requestRoutingRules : defaultRequestRoutingRules,
    r => r.name != 'psPlsBootstrapRule'
  ),
  [psPlsBootstrapRule]
)
var effectiveSslCertificates = appGwExists ? existingAppGwConfig!.outputs.sslCertificates : []
var effectiveProbes = appGwExists ? existingAppGwConfig!.outputs.probes : []
var effectiveUrlPathMaps = appGwExists ? existingAppGwConfig!.outputs.urlPathMaps : []
var effectiveRedirectConfigurations = appGwExists ? existingAppGwConfig!.outputs.redirectConfigurations : []
var effectiveRewriteRuleSets = appGwExists ? existingAppGwConfig!.outputs.rewriteRuleSets : []
// Trusted root certs are seeded empty (BaseInfra has none in the static
// template) and rehydrated from the live AppGw on subsequent deploys, so
// `Portal/bicep` deployment-script-uploaded entries (E2E HTTPS to backend)
// survive a BaseInfra refresh.
var effectiveTrustedRootCertificates = appGwExists ? existingAppGwConfig!.outputs.trustedRootCertificates : []

// ---------------------------------------------------------------------------
// Application Gateway (WAF_v2).
// ---------------------------------------------------------------------------
resource applicationGateway 'Microsoft.Network/applicationGateways@2024-01-01' = {
  name: applicationGatewayName
  location: location
  zones: availabilityZones
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
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
    sslCertificates: effectiveSslCertificates
    trustedRootCertificates: effectiveTrustedRootCertificates
    frontendPorts: effectiveFrontendPorts
    backendAddressPools: effectiveBackendAddressPools
    backendHttpSettingsCollection: effectiveBackendHttpSettingsCollection
    httpListeners: effectiveHttpListeners
    requestRoutingRules: effectiveRequestRoutingRules
    probes: effectiveProbes
    urlPathMaps: effectiveUrlPathMaps
    redirectConfigurations: effectiveRedirectConfigurations
    rewriteRuleSets: effectiveRewriteRuleSets
  }
}

output applicationGatewayId string = applicationGateway.id
output applicationGatewayName string = applicationGateway.name
output wafPolicyId string = wafPolicy.id
output privateLinkConfigurationName string = 'privateLinkConfig'
output privateLinkConfigurationId string = '${applicationGateway.id}/privateLinkConfigurations/privateLinkConfig'
output publicFrontendIPConfigurationId string = '${applicationGateway.id}/frontendIPConfigurations/appGatewayFrontendIP'
output privateFrontendIPConfigurationId string = '${applicationGateway.id}/frontendIPConfigurations/appGatewayPrivateFrontendIP'

// ---------------------------------------------------------------------------
// Diagnostic settings
// ---------------------------------------------------------------------------
// Ship Application Gateway access + firewall logs and platform metrics to the
// stamp Log Analytics workspace so WAF blocks (rule IDs, request URIs, source
// IPs) and traffic patterns are queryable alongside the AKS pod logs in the
// same workspace.
resource appGwDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  name: 'appgw-diagnostics'
  scope: applicationGateway
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}
