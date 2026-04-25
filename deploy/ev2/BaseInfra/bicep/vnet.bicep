// ==============================================================================
// PilotSwarm BaseInfra — VNet.
//
// Four subnets:
//   1. AKS subnet — node pool networking (Azure CNI).
//   2. App Gateway subnet — hosts the WAF_v2 Standard_v2 ingress.
//   3. App Gateway Private Link subnet — dedicated subnet for the Private
//      Link Service backing the AppGW private frontend. MUST have
//      `privateLinkServiceNetworkPolicies: 'Disabled'` (Spec FR-001 /
//      CodeResearch §1).
//   4. ACI (Ev2 shell-extensions) subnet — delegated to
//      `Microsoft.ContainerInstance/containerGroups` and routed through a
//      NAT gateway (required by Ev2 for SNAT as of March 31, 2025). This is
//      the subnet Ev2 injects the ACI sandbox into when running
//      UploadContainer.sh / DeployApplicationManifest.sh. Each rollout
//      parameter JSON references it via `subnetIds[0].id`.
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

@description('ACI subnet prefix for Ev2 shell-extension sandboxes. /28 matches fleet-manager.')
param aciSubnetPrefix string = '10.20.18.0/28'

@description('Availability zones for the NAT gateway public IP. Empty array disables zone placement.')
param availabilityZones array = []

var vnetName = '${resourceNamePrefix}-vnet'
var aksSubnetName = 'aks-subnet'
var appGatewaySubnetName = 'appgw-subnet'
var appGatewayPrivateLinkSubnetName = 'appgw-pls-subnet'
var aciSubnetName = 'aci-subnet'

// --------------------------------------------------------------------------
// NAT gateway + public IP — gives the ACI subnet a predictable egress path.
// Required by Ev2 as of 2025-03-31; before that Ev2 fell back to subnet SNAT.
// --------------------------------------------------------------------------

resource natGatewayPublicIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: '${vnetName}-nat-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
  zones: availabilityZones
}

resource natGateway 'Microsoft.Network/natGateways@2024-01-01' = {
  name: '${vnetName}-nat'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIpAddresses: [
      {
        id: natGatewayPublicIp.id
      }
    ]
    idleTimeoutInMinutes: 4
  }
}

// --------------------------------------------------------------------------
// NSG for the ACI subnet — minimum egress needed by Ev2 shell extensions:
//   - HTTPS (Azure control plane / managed identity / ACR / storage / AAD)
//   - HTTP  (package managers used inside the container: tdnf, wget)
//   - DNS   (name resolution for all of the above)
// --------------------------------------------------------------------------

resource aciNsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: '${vnetName}-aci-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'Allow-HTTPS-Outbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
          description: 'HTTPS for Azure services, managed identity, ACR, storage, AAD'
        }
      }
      {
        name: 'Allow-HTTP-Internet-Outbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '80'
          description: 'HTTP for package repositories (tdnf, wget) used by the shell scripts'
        }
      }
      {
        name: 'Allow-DNS-Outbound'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '53'
          description: 'DNS resolution'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressSpace
      ]
    }
    subnets: [
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
      {
        name: aciSubnetName
        properties: {
          addressPrefix: aciSubnetPrefix
          delegations: [
            {
              name: 'Microsoft.ContainerInstance.containerGroups'
              properties: {
                serviceName: 'Microsoft.ContainerInstance/containerGroups'
              }
            }
          ]
          natGateway: {
            id: natGateway.id
          }
          networkSecurityGroup: {
            id: aciNsg.id
          }
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output aksSubnetId string = vnet.properties.subnets[0].id
output appGatewaySubnetId string = vnet.properties.subnets[1].id
output appGatewayPrivateLinkSubnetId string = vnet.properties.subnets[2].id
output aciSubnetId string = vnet.properties.subnets[3].id
