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

var vnetName = '${resourceNamePrefix}-vnet'
var aksSubnetName = 'aks-subnet'
var appGatewaySubnetName = 'appgw-subnet'
var appGatewayPrivateLinkSubnetName = 'appgw-pls-subnet'
// Azure requirement: VPN Gateway only attaches to a subnet named exactly
// "GatewaySubnet". Do not parameterise this name.
var gatewaySubnetName = 'GatewaySubnet'

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

var allSubnets = vpnGatewayEnabled ? concat(baseSubnets, gatewaySubnetEntry) : baseSubnets

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressSpace
      ]
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
