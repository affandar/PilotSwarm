targetScope = 'resourceGroup'

@description('Azure region for the shared nonproduction management hub.')
param location string = resourceGroup().location

@description('Stable resource prefix, for example dbmig-nonprod-mgmt.')
param resourceNamePrefix string

@description('SSH public key used only for break-glass local administration. Password authentication is disabled.')
param adminSshPublicKey string
param adminUsername string = 'localadmin'

@description('Existing Log Analytics workspace resource ID for Bastion and VM diagnostics.')
param logAnalyticsWorkspaceId string

@description('Optional existing data collection rule resource ID for the management VM.')
param dataCollectionRuleId string = ''

@description('PilotSwarm spoke VNets. The template creates bidirectional peering without gateway transit or forwarded traffic.')
param spokes array = []

@description('Private DNS zones to link to the management VNet. Each item has subscriptionId, resourceGroup, and name.')
param privateDnsZones array = []

param vnetAddressPrefix string = '10.30.0.0/16'
param bastionSubnetPrefix string = '10.30.0.0/26'
param managementSubnetPrefix string = '10.30.1.0/24'
param vmSize string = 'Standard_D2as_v5'

var vnetName = '${resourceNamePrefix}-vnet'
var vmName = '${resourceNamePrefix}-vm'

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${resourceNamePrefix}-vm-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowSshFromBastionSubnet'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: bastionSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: managementSubnetPrefix
          destinationPortRange: '22'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        name: 'AzureBastionSubnet'
        properties: {
          addressPrefix: bastionSubnetPrefix
        }
      }
      {
        name: 'management'
        properties: {
          addressPrefix: managementSubnetPrefix
          networkSecurityGroup: {
            id: nsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource bastionPublicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${resourceNamePrefix}-bastion-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource bastion 'Microsoft.Network/bastionHosts@2024-05-01' = {
  name: '${resourceNamePrefix}-bastion'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    enableTunneling: true
    enableIpConnect: true
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'AzureBastionSubnet')
          }
          publicIPAddress: {
            id: bastionPublicIp.id
          }
        }
      }
    ]
  }
}

resource bastionDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${resourceNamePrefix}-bastion-diagnostics'
  scope: bastion
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

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'management')
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: take(replace(vmName, '-', ''), 15)
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

resource entraSsh 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = {
  parent: vm
  name: 'AADSSHLoginForLinux'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.ActiveDirectory'
    type: 'AADSSHLoginForLinux'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
  }
}

resource azureMonitorAgent 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = if (!empty(dataCollectionRuleId)) {
  parent: vm
  name: 'AzureMonitorLinuxAgent'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Monitor'
    type: 'AzureMonitorLinuxAgent'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
  }
}

resource vmDcrAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2023-03-11' = if (!empty(dataCollectionRuleId)) {
  name: '${vmName}-dcr'
  scope: vm
  properties: {
    dataCollectionRuleId: dataCollectionRuleId
  }
}

resource spokeVnets 'Microsoft.Network/virtualNetworks@2024-05-01' existing = [for spoke in spokes: {
  name: spoke.vnetName
  scope: resourceGroup(spoke.subscriptionId, spoke.resourceGroup)
}]

resource hubToSpoke 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = [for (spoke, i) in spokes: {
  parent: vnet
  name: 'to-${spoke.name}'
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: {
      id: spokeVnets[i].id
    }
  }
}]

module spokeToHub './spoke-peering.bicep' = [for spoke in spokes: {
  name: '${resourceNamePrefix}-from-${spoke.name}'
  scope: resourceGroup(spoke.subscriptionId, spoke.resourceGroup)
  params: {
    spokeVnetName: spoke.vnetName
    hubVnetId: vnet.id
    peeringName: 'to-${resourceNamePrefix}'
  }
}]

module dnsLinks './private-dns-link.bicep' = [for zone in privateDnsZones: {
  name: '${resourceNamePrefix}-${uniqueString(zone.subscriptionId, zone.resourceGroup, zone.name)}-dns-link'
  scope: resourceGroup(zone.subscriptionId, zone.resourceGroup)
  params: {
    zoneName: zone.name
    vnetId: vnet.id
    linkName: '${resourceNamePrefix}-link'
  }
}]

output managementVnetId string = vnet.id
output managementVmId string = vm.id
output managementVmPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output bastionId string = bastion.id
