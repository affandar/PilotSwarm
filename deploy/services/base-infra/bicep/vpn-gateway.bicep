// ==============================================================================
// PilotSwarm BaseInfra — Azure VPN Gateway (Point-to-Site, Microsoft Entra ID
// authentication, OpenVPN protocol).
//
// Provisioned conditionally from `main.bicep` when `vpnGatewayEnabled=true`.
// Coexists with the AFD edge mode as an additive, optional ingress — the
// "trusted-bypass" pattern for authenticated tenant users who hold a valid
// Entra ID token but are blocked at the public edge by operator-defined
// AFD WAF allow-lists (e.g. service-tag, IP-range, or header-based rules
// that gate AFD to a known managed-network population).
//
// Note: this module emits the gateway + its public IP + a diagnostic-settings
// sink. The orchestrator does NOT render a vpn-postdeploy hook; client-profile
// distribution to operators is documented out-of-band.
// ==============================================================================

@description('Azure region. Must match the parent VNet region.')
param location string

@description('Naming prefix for the gateway + its public IP (e.g. the BaseInfra resourceNamePrefix).')
param resourceName string

@description('Resource ID of the GatewaySubnet inside the BaseInfra VNet (vnet.bicep emits this only when vpnGatewayEnabled=true).')
param gatewaySubnetId string

@description('VPN Gateway SKU. VpnGw1 is the smallest RouteBased SKU that supports AAD authentication + OpenVPN; AZ variants are zone-redundant. Basic SKU is intentionally excluded — it does not support OpenVPN or AAD.')
@allowed([
  'VpnGw1'
  'VpnGw2'
  'VpnGw3'
  'VpnGw1AZ'
  'VpnGw2AZ'
  'VpnGw3AZ'
])
param vpnGatewaySku string = 'VpnGw1'

@description('CIDR block from which VPN clients receive addresses once connected. Must not overlap the VNet address space or any on-prem range reachable via the VPN. /24 gives ~250 concurrent clients.')
param vpnClientAddressPool string = '172.16.200.0/24'

@description('Microsoft Entra (AAD) tenant ID used for VPN client authentication. Threaded from the deploy-time AZURE_TENANT_ID by main.bicep.')
param tenantId string

@description('AAD application audience (clientId) the VPN clients request a token for. Default is the public Azure VPN client app ID (c632b3df-...) which is the universally available choice and avoids per-tenant app-registration plumbing. Override only if you have registered a custom Azure VPN app (e.g. legacy a21fb3a6-... / 41b23e61-... values for older client builds).')
param vpnAadAudience string = 'c632b3df-fb67-4d84-bdcf-b95ad541b5c8'

@description('Resource ID of the stamp Log Analytics workspace that receives gateway tunnel + RouteDiagnostic logs and metrics. Empty string disables the diagnostic setting.')
param logAnalyticsWorkspaceId string = ''

@description('Resource tags to apply to gateway resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Public IP for the gateway frontend (Standard SKU + Static is required for
// VpnGw1+ — Basic PIPs are no longer supported on RouteBased gateways).
// ---------------------------------------------------------------------------
resource vpnGatewayPip 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: '${resourceName}-vpngw-pip'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

// ---------------------------------------------------------------------------
// Azure VPN Gateway (RouteBased, AAD-authenticated, OpenVPN).
//
// Key choices baked in here (do not parameterise without revisiting Spec):
//   - gatewayType=Vpn, vpnType=RouteBased — AAD auth requires RouteBased.
//   - activeActive=false, enableBgp=false — P2S-only deployment.
//   - vpnClientProtocols=['OpenVPN'] — only protocol that supports AAD auth.
//   - vpnAuthenticationTypes=['AAD'] — no certificate/RADIUS fallback.
//   - aadTenant / aadIssuer use the standard v1 issuer format; switching to
//     v2 (https://login.microsoftonline.com/${tenantId}/v2.0) requires the
//     audience to also be migrated — current default audience is v1.
// ---------------------------------------------------------------------------
resource vpnGateway 'Microsoft.Network/virtualNetworkGateways@2024-01-01' = {
  name: '${resourceName}-vpngw'
  location: location
  tags: tags
  properties: {
    gatewayType: 'Vpn'
    vpnType: 'RouteBased'
    activeActive: false
    enableBgp: false
    sku: {
      name: vpnGatewaySku
      tier: vpnGatewaySku
    }
    ipConfigurations: [
      {
        name: 'vnetGatewayConfig'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: gatewaySubnetId
          }
          publicIPAddress: {
            id: vpnGatewayPip.id
          }
        }
      }
    ]
    vpnClientConfiguration: {
      vpnClientAddressPool: {
        addressPrefixes: [
          vpnClientAddressPool
        ]
      }
      vpnClientProtocols: [
        'OpenVPN'
      ]
      vpnAuthenticationTypes: [
        'AAD'
      ]
      // Public-cloud AAD endpoints. The default vpnAadAudience GUID
      // (c632b3df-...) is registered against the public-cloud Azure VPN client
      // app and is paired with login.microsoftonline.com + sts.windows.net.
      // Sovereign clouds require a different audience GUID and different
      // endpoint hosts; switching to environment().authentication.loginEndpoint
      // here without also re-deriving the audience would break authentication.
      // If sovereign-cloud support is needed, parameterise the full
      // (audience, tenantUri, issuerUri) tuple together rather than fan out
      // these strings to environment().
      #disable-next-line no-hardcoded-env-urls
      aadTenant: 'https://login.microsoftonline.com/${tenantId}/'
      aadAudience: vpnAadAudience
      #disable-next-line no-hardcoded-env-urls
      aadIssuer: 'https://sts.windows.net/${tenantId}/'
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostic settings — ship gateway tunnel + IKE + RouteDiagnostic logs and
// platform metrics to the stamp Log Analytics workspace. Mirrors the AppGw
// diagnostic-settings pattern in application-gateway.bicep:440-458.
// ---------------------------------------------------------------------------
resource vpnGatewayDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: 'vpngw-diagnostics'
  scope: vpnGateway
  properties: {
    workspaceId: logAnalyticsWorkspaceId
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

// ---------------------------------------------------------------------------
// Outputs — emitted for anyone scripting around the gateway. The orchestrator
// does not render a postdeploy block, but `vpnGatewayPublicIp` and
// `vpnGatewayId` are useful for ad-hoc verification / client-profile fetch.
// ---------------------------------------------------------------------------
output vpnGatewayId string = vpnGateway.id
output vpnGatewayName string = vpnGateway.name
output vpnGatewayPublicIp string = vpnGatewayPip.properties.ipAddress
output vpnGatewayPublicIpId string = vpnGatewayPip.id
