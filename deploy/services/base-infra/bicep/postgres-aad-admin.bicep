// ==============================================================================
// PilotSwarm BaseInfra — PostgreSQL Microsoft Entra administrators.
//
// Strict-private deployments run this module after the PostgreSQL private
// endpoint and DNS zone exist. This avoids relying on a public firewall rule
// merely to sequence administrator creation.
// ==============================================================================

@description('Existing PostgreSQL Flexible Server name.')
param serverName string

@description('Microsoft Entra tenant ID.')
param tenantId string = subscription().tenantId

@description('Primary Microsoft Entra administrator object ID.')
param primaryPrincipalId string

@description('Primary Microsoft Entra administrator display name.')
param primaryPrincipalName string

@description('Primary Microsoft Entra administrator principal type.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param primaryPrincipalType string = 'ServicePrincipal'

@description('Optional secondary Microsoft Entra administrator object ID.')
param secondaryPrincipalId string = ''

@description('Optional secondary Microsoft Entra administrator display name.')
param secondaryPrincipalName string = ''

@description('Optional secondary Microsoft Entra administrator principal type.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param secondaryPrincipalType string = 'User'

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' existing = {
  name: serverName
}

resource primaryAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = {
  parent: postgres
  name: primaryPrincipalId
  properties: {
    principalType: primaryPrincipalType
    principalName: primaryPrincipalName
    tenantId: tenantId
  }
}

resource secondaryAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (!empty(secondaryPrincipalId)) {
  parent: postgres
  name: secondaryPrincipalId
  properties: {
    principalType: secondaryPrincipalType
    principalName: secondaryPrincipalName
    tenantId: tenantId
  }
  dependsOn: [
    primaryAdmin
  ]
}

output primaryPrincipalName string = primaryPrincipalName
