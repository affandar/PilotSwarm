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
param skuName string = 'Standard_D2ads_v5'

@description('Flex Server tier.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string = 'GeneralPurpose'

@description('PostgreSQL major version.')
param postgresVersion string = '16'

@description('Storage size in GB.')
param storageSizeGB int = 128

@description('Tenant ID for Microsoft Entra (AAD) authentication. Required for the AAD administrator role assignment. Defaults to the deployment subscription tenant.')
param tenantId string = subscription().tenantId

@description('Optional Microsoft Entra principal (UAMI / SP / user) registered as a Postgres administrator. CMS + facts pools authenticate as this principal via AAD token in the bicep-deploy MI flow. Empty (the default) keeps the server password-only — used by the legacy `scripts/deploy-aks.sh` flow.')
param aadAdminPrincipalId string = ''

@description('Display name for the AAD principal (must match the UAMI / SP / user name as it appears in Entra). This becomes the Postgres role name that CMS + facts log in as.')
param aadAdminPrincipalName string = ''

@description('Principal type for aadAdminPrincipalId. UAMIs use ServicePrincipal.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param aadAdminPrincipalType string = 'ServicePrincipal'

@description('Optional second AAD administrator (typically the local-deploy human / SP). Same shape as aadAdminPrincipalId.')
param aadSecondaryAdminPrincipalId string = ''
param aadSecondaryAdminPrincipalName string = ''
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param aadSecondaryAdminPrincipalType string = 'User'

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
    // Hybrid auth: AAD enabled for CMS+facts pools (token callback);
    // password kept enabled because duroxide's PostgresProvider only
    // accepts a password URL — it has no token-callback hook. See
    // packages/sdk/src/pg-pool-factory.ts and the Chunk C plan.
    authConfig: {
      activeDirectoryAuth: empty(aadAdminPrincipalId) ? 'Disabled' : 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: empty(aadAdminPrincipalId) ? null : tenantId
    }
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

// Primary AAD administrator (e.g. the worker/portal CSI UAMI). Skipped on
// stamps where aadAdminPrincipalId is empty so the legacy
// `scripts/deploy-aks.sh` flow stays unaffected.
//
// We force a dependency on the `database` and `allowAzureServices`
// children so the AAD admin write fires only after the flexible server
// has accepted at least one data-plane and one control-plane child
// resource — a working proxy for "server is fully accessible". Without
// this, `flexibleServers/administrators` racy and intermittently fails
// with `AadAuthOperationCannotBePerformedWhenServerIsNotAccessible`.
resource aadPrimaryAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (!empty(aadAdminPrincipalId)) {
  parent: postgres
  name: aadAdminPrincipalId
  properties: {
    principalType: aadAdminPrincipalType
    principalName: aadAdminPrincipalName
    tenantId: tenantId
  }
  dependsOn: [
    database
    allowAzureServices
  ]
}

// Secondary AAD administrator (typically the local-deploy user) — useful
// for local Bicep runs so the operator can connect with `az login` creds
// without an extra grant step.
resource aadSecondaryAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (!empty(aadSecondaryAdminPrincipalId)) {
  parent: postgres
  name: aadSecondaryAdminPrincipalId
  properties: {
    principalType: aadSecondaryAdminPrincipalType
    principalName: aadSecondaryAdminPrincipalName
    tenantId: tenantId
  }
  dependsOn: [
    aadPrimaryAdmin
  ]
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
output aadAdminPrincipalName string = aadAdminPrincipalName
