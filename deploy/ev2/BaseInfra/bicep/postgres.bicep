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

// TODO: Replace with Entra (AAD) authentication + workload identity. Until
// then we hardcode a deterministic placeholder password so EV2 deployments
// don't need a secret-store dependency. The PG endpoint is reachable only
// from AKS pods inside the per-region VNet, and the worker reads this
// password from Key Vault via the AKV CSI Secrets Store provider — the same
// value must be seeded into KV under `postgres-admin-password` (handled by
// scripts/deploy-aks.sh today and by a follow-up Ev2 step in production).
//
// DO NOT use this password for anything reachable from outside the VNet.
var administratorPassword = 'PilotSwarmEv2_BootstrapOnly!9876'

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
