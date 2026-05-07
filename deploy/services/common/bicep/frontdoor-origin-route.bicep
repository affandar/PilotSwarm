// ==============================================================================
// Front Door Origin and Route for Services
// Creates private link origin and route for the Service API
// ==============================================================================

@description('Front Door profile name')
param frontDoorProfileName string

@description('Front Door endpoint name')
param frontDoorEndpointName string

@description('Origin group name for service')
param originGroupName string

@description('Origin name of service, Must be unique for each region/stamp')
param originName string

@description('Front Door Route name for service, Must be same for same services')
param routeName string

@description('Application Gateway name from BaseInfra')
param applicationGatewayName string

@description('Application Gateway resource group name')
param applicationGatewayResourceGroup string

@description('Application Gateway Private Link configuration name')
param applicationGatewayPrivateLinkConfigName string = 'privateLinkConfig'

@description('Azure region where Application Gateway is deployed')
param privateLinkLocation string

@description('Host name of the origin')
param originHostName string

@description('Health probe path of the service')
param healthProbePath string

@description('Routing pattern for the service')
param patternToMatch string

@description('AFD-side cert validation for the origin. Must be `true` when the origin uses Private Link (Azure refuses BadRequest "EnforceCertificateNameCheck must be enabled for Private Link" otherwise). That means an AFD+PL+HTTPS origin requires a publicly-trusted CA cert on the AppGw listener — self-signed will not work over this topology. For self-signed dev stamps, switch the route to HTTP-to-origin instead (out of scope of this param).')
param enforceCertificateNameCheck bool = true

// ==============================================================================
// Existing Resources References
// ==============================================================================

resource frontDoorProfile 'Microsoft.Cdn/profiles@2024-02-01' existing = {
  name: frontDoorProfileName
}

resource frontDoorEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' existing = {
  parent: frontDoorProfile
  name: frontDoorEndpointName
}

// ==============================================================================
// Origin Group for Service
// ==============================================================================

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: frontDoorProfile
  name: originGroupName
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: healthProbePath
      probeRequestType: 'HEAD'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 100
    }
    sessionAffinityState: 'Disabled'
  }
}

// ==============================================================================
// Private Link Origin
// ==============================================================================

// Private Link Service ID for Application Gateway
// Per Microsoft Portal documentation: Use the format /subscriptions/{subscription-id}/resourceGroups/{resource-group-name}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_{applicationGatewayName}_{privateLinkConfigName}
// Reference: https://learn.microsoft.com/en-us/azure/frontdoor/how-to-enable-private-link-application-gateway
var privateLinkServiceId = '/subscriptions/${subscription().subscriptionId}/resourceGroups/${applicationGatewayResourceGroup}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_${applicationGatewayName}_${applicationGatewayPrivateLinkConfigName}'

resource serviceOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: originGroup
  name: originName
  properties: {
    hostName: originHostName // Domain name matching the certificate
    httpPort: 80
    httpsPort: 443
    originHostHeader: originHostName // Must match the listener hostname
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    // See param doc — false when AppGw listener uses a self-signed cert.
    enforceCertificateNameCheck: enforceCertificateNameCheck
    // Private Link configuration using Private Link Service ID
    // Azure creates the internal PLS automatically when App Gateway has Private Link configured
    sharedPrivateLinkResource: {
      privateLink: {
        id: privateLinkServiceId
      }
      privateLinkLocation: privateLinkLocation
      requestMessage: 'Front Door Private Link request for the service'
    }
  }
}

// ==============================================================================
// Front Door Route
// ==============================================================================

resource serviceRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: frontDoorEndpoint
  name: routeName
  properties: {
    customDomains: []
    originGroup: {
      id: originGroup.id
    }
    ruleSets: []
    supportedProtocols: [
      'Https'
    ]
    patternsToMatch: [
      patternToMatch
    ]
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
    enabledState: 'Enabled'
  }
  dependsOn: [
    serviceOrigin
  ]
}

// ==============================================================================
// Outputs
// ==============================================================================

@description('Origin name')
output originName string = serviceOrigin.name

@description('Origin resource ID')
output originId string = serviceOrigin.id

@description('Route name')
output routeName string = serviceRoute.name

@description('Route resource ID')
output routeId string = serviceRoute.id
