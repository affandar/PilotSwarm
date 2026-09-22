// ==============================================================================
// PilotSwarm BaseInfra — Azure Database for PostgreSQL Flexible Server.
//
// No schema creation happens here. The worker runs its own migrations at
// startup (FR-012). This module only provisions the server + one database
// and, for the legacy public posture, wires an "allow Azure services"
// firewall rule. Strict-private stamps use AAD-only authentication and create
// their administrator after Private Link is ready from main.bicep.
// ==============================================================================

@description('Azure region.')
param location string

@description('PostgreSQL Flexible Server name.')
param serverName string

@description('Database name created on the server.')
param databaseName string = 'pilotswarm'

@description('Admin login name.')
param administratorLogin string = 'pilotswarm'

@description('Whether to create an AAD-only server with no public endpoint or password administrator.')
param strictPrivate bool = false

// The deterministic placeholder remains only for the legacy non-private
// posture, which still needs password bootstrap compatibility. Strict-private
// deployments omit both administrator fields entirely and disable password
// auth. The legacy worker reads this password from Key Vault via the AKV CSI
// Secrets Store provider — the same value must be seeded into KV under
// `postgres-admin-password`.
//
// DO NOT use this password for anything reachable from outside the VNet.
var administratorPassword = 'PilotSwarmDev_BootstrapOnly!9876'

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

@description('Backup retention in days.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@description('Log Analytics workspace resource ID for PostgreSQL metrics and logs. Empty disables diagnostic settings.')
param logAnalyticsWorkspaceId string = ''

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
  properties: union({
    version: postgresVersion
    authConfig: {
      activeDirectoryAuth: (strictPrivate || !empty(aadAdminPrincipalId)) ? 'Enabled' : 'Disabled'
      passwordAuth: strictPrivate ? 'Disabled' : 'Enabled'
      tenantId: (strictPrivate || !empty(aadAdminPrincipalId)) ? tenantId : null
    }
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: strictPrivate ? 'Disabled' : 'Enabled'
    }
  }, strictPrivate ? {} : {
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
  })
}

// Primary AAD administrator (e.g. the worker/portal CSI UAMI). This inline
// path is legacy/public only. Strict-private administrator creation is moved
// to postgres-aad-admin.bicep and sequenced after the private endpoint.
//
// We force a dependency on the `database` and `allowAzureServices`
// children so the AAD admin write fires only after the flexible server
// has accepted at least one data-plane and one control-plane child
// resource — a working proxy for "server is fully accessible". Without
// this, `flexibleServers/administrators` racy and intermittently fails
// with `AadAuthOperationCannotBePerformedWhenServerIsNotAccessible`.
resource aadPrimaryAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (!strictPrivate && !empty(aadAdminPrincipalId)) {
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
resource aadSecondaryAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (!strictPrivate && !empty(aadSecondaryAdminPrincipalId)) {
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

resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = if (!strictPrivate) {
  parent: postgres
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${serverName}-diagnostics'
  scope: postgres
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

output serverId string = postgres.id
output serverName string = postgres.name
output fullyQualifiedDomainName string = postgres.properties.fullyQualifiedDomainName
output databaseName string = database.name
output aadAdminPrincipalName string = aadAdminPrincipalName
