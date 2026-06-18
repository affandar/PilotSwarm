// ==============================================================================
// PilotSwarm BaseInfra — Azure Private DNS Resolver (inbound endpoint only).
//
// Co-provisioned with the VPN P2S gateway. Solves the "P2S clients can reach
// the VNet but can't resolve Private DNS Zone records" gap:
//
//   1. P2S clients receive an address from `vpnClientAddressPool` and can
//      route to the VNet — but cannot query 168.63.129.16 (that magic IP is
//      only reachable from inside Azure VMs).
//   2. The classic Microsoft.Network/virtualNetworkGateways resource has no
//      DNS-push field of its own (verified against the live ARM schema for
//      api-version 2024-01-01 through 2025-07-01). The supported path for
//      advertising DNS servers to P2S clients is the parent VNet's
//      `dhcpOptions.dnsServers` block, which the gateway pushes at connect
//      time.
//   3. Therefore vnet.bicep's `dhcpOptions.dnsServers` MUST point at a DNS
//      server that (a) sits on a regular VNet IP P2S clients can reach via
//      the tunnel and (b) can answer Private DNS Zone queries (e.g.
//      `dev.pilotswarm.azure.com`).
//   4. The Private DNS Resolver inbound endpoint is the supported, managed
//      service for exactly this. It exposes a single VNet IP that, on
//      receiving a DNS query, consults all Private DNS Zones linked to the
//      VNet and falls back to internet resolution otherwise.
//
// Not deployed when VPN is disabled — there is nothing reaching for it.
//
// Cost: roughly $170/mo per inbound endpoint (two ENIs at ~$0.24/hr). Cost
// is fully gated behind the same `vpnGatewayEnabled` flag that gates the VPN
// gateway itself; default stamps incur zero cost.
// ==============================================================================

@description('Azure region. Must match the parent VNet region.')
param location string

@description('Naming prefix (resolver + inbound endpoint names derive from this).')
param resourceName string

@description('Resource ID of the BaseInfra VNet this resolver attaches to. The resolver answers from every Private DNS Zone linked to this VNet.')
param vnetId string

@description('Resource ID of the dedicated dns-resolver-inbound subnet (must be delegated to Microsoft.Network/dnsResolvers).')
param inboundSubnetId string

@description('Static private IP for the inbound endpoint within the inbound subnet. Static (not Dynamic) so the VNet `dhcpOptions.dnsServers` value (set in main.bicep) is deterministic across redeploys and does not require a dependent reference cycle. Must sit in the inbound subnet range and not collide with Azure-reserved IPs (.0/.1/.2/.3/last).')
param inboundIpAddress string = '10.20.19.4'

@description('Resource tags to apply.')
param tags object = {}

// The resolver itself is a per-VNet anchor object — no compute, no cost on
// its own. The cost lives in the inbound endpoint (ENIs).
resource dnsResolver 'Microsoft.Network/dnsResolvers@2022-07-01' = {
  name: '${resourceName}-dns-resolver'
  location: location
  tags: tags
  properties: {
    virtualNetwork: {
      id: vnetId
    }
  }
}

// Single inbound endpoint with one IP config. Static allocation so the IP is
// known at bicep-eval time (we set the same value on the VPN gateway). One
// endpoint is enough for the VPN P2S client population; horizontal scale-out
// would be a future-day concern for thousands of concurrent clients.
resource inboundEndpoint 'Microsoft.Network/dnsResolvers/inboundEndpoints@2022-07-01' = {
  parent: dnsResolver
  name: 'inbound'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        subnet: {
          id: inboundSubnetId
        }
        privateIpAllocationMethod: 'Static'
        privateIpAddress: inboundIpAddress
      }
    ]
  }
}

output dnsResolverId string = dnsResolver.id
output inboundEndpointId string = inboundEndpoint.id
output inboundIpAddress string = inboundIpAddress
