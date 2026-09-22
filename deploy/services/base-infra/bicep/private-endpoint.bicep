// ==============================================================================
// PilotSwarm BaseInfra — private endpoint + private DNS.
//
// Generic module used by strict-private stamps for Azure services whose
// private-link contract is a target resource ID, group ID, and DNS zone.
// ==============================================================================

@description('Azure region.')
param location string

@description('Stable name prefix for the private endpoint and DNS link.')
param resourceName string

@description('Dedicated private-endpoint subnet resource ID.')
param subnetId string

@description('Resource ID exposed through the private endpoint.')
param privateLinkServiceId string

@description('Private Link group ID for the target service.')
param groupId string

@description('Azure Private DNS zone name for the target service.')
param privateDnsZoneName string

@description('VNet resource ID linked to the private DNS zone.')
param vnetId string

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

resource vnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: '${resourceName}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: '${resourceName}-pe'
  location: location
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${resourceName}-connection'
        properties: {
          privateLinkServiceId: privateLinkServiceId
          groupIds: [
            groupId
          ]
        }
      }
    ]
  }
}

resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'default'
        properties: {
          privateDnsZoneId: privateDnsZone.id
        }
      }
    ]
  }
}

output privateEndpointId string = privateEndpoint.id
output privateDnsZoneId string = privateDnsZone.id
output privateDnsZoneLinkId string = vnetLink.id
