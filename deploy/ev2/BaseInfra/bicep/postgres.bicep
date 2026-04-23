// ==============================================================================
// PilotSwarm BaseInfra — Azure Database for PostgreSQL Flexible Server.
//
// No schema creation happens here. The worker runs its own migrations at
// startup (FR-012). This module only provisions the server + one database
// and wires an "allow Azure services" firewall rule so AKS pods can reach
// it over the public endpoint.
// ==============================================================================

@description('Azure region.')
param location string

@description('PostgreSQL Flexible Server name.')
param serverName string

@description('Database name created on the server.')
param databaseName string = 'pilotswarm'

@description('Admin login name.')
param administratorLogin string = 'pilotswarm'

@secure()
@description('Admin password. Supplied via pipeline / EV2 parameter; never checked in.')
param administratorPassword string

@description('Flex Server SKU name.')
param skuName string = 'Standard_B1ms'

@description('Flex Server tier.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string = 'Burstable'

@description('PostgreSQL major version.')
param postgresVersion string = '16'

@description('Storage size in GB.')
param storageSizeGB int = 32

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgres
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output serverId string = postgres.id
output serverName string = postgres.name
output fullyQualifiedDomainName string = postgres.properties.fullyQualifiedDomainName
output databaseName string = database.name
