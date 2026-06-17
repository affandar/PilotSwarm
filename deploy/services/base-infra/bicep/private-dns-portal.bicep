// ==============================================================================
// PilotSwarm BaseInfra — Private DNS zone for portal resolution over the
// P2S VPN tunnel (managed-only).
//
// When VPN ingress is enabled, off-network employees resolve the portal
// hostname (`<recordName>.<dnsZoneName>`) to the AppGw private frontend IP
// over the VPN tunnel. The zone is created in the BaseInfra RG and linked to
// the BaseInfra VNet; the VPN Gateway pushes the VNet's resolver (168.63.129.16)
// to clients, so clients then resolve via the linked private zone.
//
// Cross-reference: deploy/services/portal/bicep/main.bicep:239-261 hosts a
// similar private-DNS pattern, but that module is `edgeMode='private'`-only
// and lives in the portal service (not reused here — different lifecycle,
// different RG semantics, different trigger condition).
//
// "Managed-only" — BYO Private DNS path was dropped during planning. If a
// future requirement to support customer-supplied zones surfaces, gate this
// module behind a `vpnPrivateDnsMode` discriminator in main.bicep rather than
// expanding this module.
// ==============================================================================

@description('Whether to provision the private DNS zone + VNet link + A record. False emits no resources (output is empty string).')
param vpnGatewayEnabled bool

@description('Private DNS zone name to provision (= SSL_CERT_DOMAIN_SUFFIX so the portal cert SAN resolves over the tunnel).')
param dnsZoneName string

@description('Hostname label for the portal A record (= base-infra resourceNamePrefix, matching the AFD endpoint host shape).')
param recordName string

@description('AppGw private frontend IP address that VPN clients should resolve the portal hostname to.')
param appGatewayPrivateIp string

@description('Resource ID of the BaseInfra VNet to link the private zone to (so VPN clients resolving via 168.63.129.16 hit this zone).')
param vnetId string

@description('Resource tags to apply.')
param tags object = {}

// Private DNS zones are global resources; their location must be 'global'.
resource portalVpnPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (vpnGatewayEnabled) {
  name: dnsZoneName
  location: 'global'
  tags: tags
}

resource portalVpnPrivateDnsZoneVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (vpnGatewayEnabled) {
  parent: portalVpnPrivateDnsZone
  name: 'baseinfra-vnet-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource portalVpnPrivateDnsARecord 'Microsoft.Network/privateDnsZones/A@2024-06-01' = if (vpnGatewayEnabled) {
  parent: portalVpnPrivateDnsZone
  name: recordName
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: appGatewayPrivateIp
      }
    ]
  }
}

// Empty string when disabled keeps the output shape stable for the parent
// module so existing stamps remain byte-equivalent at the output level.
output dnsZoneId string = vpnGatewayEnabled ? portalVpnPrivateDnsZone.id : ''
output dnsZoneName string = vpnGatewayEnabled ? portalVpnPrivateDnsZone.name : ''
