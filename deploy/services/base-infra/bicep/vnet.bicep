// ==============================================================================
// PilotSwarm BaseInfra — VNet.
//
// Three subnets:
//   1. AKS subnet — node pool networking (Azure CNI).
//   2. App Gateway subnet — hosts the WAF_v2 Standard_v2 ingress.
//   3. App Gateway Private Link subnet — dedicated subnet for the Private
//      Link Service backing the AppGW private frontend. MUST have
//      `privateLinkServiceNetworkPolicies: 'Disabled'`.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix (VNet and subnet names derive from this).')
param resourceNamePrefix string

@description('VNet address space.')
param addressSpace string = '10.20.0.0/16'

@description('AKS node subnet prefix.')
param aksSubnetPrefix string = '10.20.0.0/20'

@description('Application Gateway subnet prefix.')
param appGatewaySubnetPrefix string = '10.20.16.0/24'

@description('Application Gateway Private Link subnet prefix (must be distinct from the App Gateway subnet).')
param appGatewayPrivateLinkSubnetPrefix string = '10.20.17.0/24'

@description('Whether to provision a GatewaySubnet (required for the Azure VPN Gateway). False by default — VPN is an additive, optional ingress.')
param vpnGatewayEnabled bool = false

@description('GatewaySubnet prefix. Azure requires this subnet to be literally named "GatewaySubnet"; the name is fixed and not configurable. /27 minimum for VpnGw1+ (RouteBased).')
param gatewaySubnetPrefix string = '10.20.18.0/27'

@description('Azure Private DNS Resolver inbound endpoint subnet prefix. Co-provisioned with the VPN gateway: P2S clients are pushed the resolver inbound IP via `customDnsServers` so they can resolve Private DNS Zones (e.g. dev.pilotswarm.azure.com) through the tunnel. /28 minimum per Microsoft.Network/dnsResolvers contract. Subnet is dedicated and delegated to Microsoft.Network/dnsResolvers — no other resource may live in it.')
param dnsResolverInboundSubnetPrefix string = '10.20.19.0/28'

@description('DNS server IPs to advertise via the VNet `dhcpOptions.dnsServers` block. P2S VPN clients connecting through the gateway inherit these (this is the supported mechanism — the classic `virtualNetworkGateways` resource has no DNS push field of its own). Leave empty for non-VPN stamps so the VNet uses Azure-provided DNS. When VPN is enabled, main.bicep passes the Private DNS Resolver inbound endpoint static IP so clients can resolve Private DNS Zone records through the tunnel.')
param dnsServers array = []

var vnetName = '${resourceNamePrefix}-vnet'
var aksSubnetName = 'aks-subnet'
var appGatewaySubnetName = 'appgw-subnet'
var appGatewayPrivateLinkSubnetName = 'appgw-pls-subnet'
// Azure requirement: VPN Gateway only attaches to a subnet named exactly
// "GatewaySubnet". Do not parameterise this name.
var gatewaySubnetName = 'GatewaySubnet'
var dnsResolverInboundSubnetName = 'dns-resolver-inbound-subnet'

var baseSubnets = [
  {
    name: aksSubnetName
    properties: {
      addressPrefix: aksSubnetPrefix
    }
  }
  {
    name: appGatewaySubnetName
    properties: {
      addressPrefix: appGatewaySubnetPrefix
    }
  }
  {
    name: appGatewayPrivateLinkSubnetName
    properties: {
      addressPrefix: appGatewayPrivateLinkSubnetPrefix
      privateLinkServiceNetworkPolicies: 'Disabled'
    }
  }
]

var gatewaySubnetEntry = [
  {
    name: gatewaySubnetName
    properties: {
      addressPrefix: gatewaySubnetPrefix
    }
  }
]

// Private DNS Resolver inbound endpoint subnet. Co-provisioned with the VPN
// gateway because P2S clients cannot reach the Azure-magic DNS IP
// (168.63.129.16) through the tunnel — that IP is only reachable from inside
// Azure VMs. The Resolver inbound endpoint sits on a regular VNet IP that IS
// reachable from P2S clients, and resolves Private DNS Zone records on their
// behalf.
//
// `delegations` is required: Microsoft.Network/dnsResolvers takes exclusive
// ownership of the subnet. No NSG should be applied (the resolver service
// manages its own ingress on UDP/53 + TCP/53).
var dnsResolverInboundSubnetEntry = [
  {
    name: dnsResolverInboundSubnetName
    properties: {
      addressPrefix: dnsResolverInboundSubnetPrefix
      delegations: [
        {
          name: 'Microsoft.Network.dnsResolvers'
          properties: {
            serviceName: 'Microsoft.Network/dnsResolvers'
          }
        }
      ]
    }
  }
]

var allSubnets = vpnGatewayEnabled ? concat(baseSubnets, gatewaySubnetEntry, dnsResolverInboundSubnetEntry) : baseSubnets

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressSpace
      ]
    }
    // dhcpOptions only emitted when DNS servers are supplied. Empty array
    // would set "no DNS" on the VNet, which is different from "use Azure
    // default" — preserving omission keeps non-VPN stamps unchanged.
    dhcpOptions: empty(dnsServers) ? null : {
      dnsServers: dnsServers
    }
    subnets: allSubnets
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output aksSubnetId string = vnet.properties.subnets[0].id
output aksSubnetName string = aksSubnetName
output appGatewaySubnetId string = vnet.properties.subnets[1].id
output appGatewaySubnetName string = appGatewaySubnetName
output appGatewayPrivateLinkSubnetId string = vnet.properties.subnets[2].id
// GatewaySubnet ID only when VPN ingress is enabled — empty string keeps the
// output shape stable for non-VPN stamps.
output gatewaySubnetId string = vpnGatewayEnabled ? vnet.properties.subnets[3].id : ''
// DNS Resolver inbound subnet — only present when VPN is enabled (the
// resolver is exclusively here to give P2S clients a reachable DNS server).
output dnsResolverInboundSubnetId string = vpnGatewayEnabled ? vnet.properties.subnets[4].id : ''
output dnsResolverInboundSubnetName string = dnsResolverInboundSubnetName
