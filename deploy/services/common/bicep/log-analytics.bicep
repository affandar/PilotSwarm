// ==============================================================================
// PilotSwarm shared — Log Analytics workspace.
//
// Single, generic workspace module reused across services:
//   - base-infra/main.bicep — per-stamp workspace (AKS Container Insights via
//     omsAgent addon + DCR; Application Gateway access/firewall logs;
//     PostgreSQL diagnostics).
//   - global-infra/main.bicep — global workspace (Front Door profile +
//     Front Door WAF policy diagnostic logs). Kept separate from any single
//     stamp so AFD telemetry isn't coupled to a specific region's lifecycle.
//
// Pattern adopted from reference deployment
// (src/Deploy/BaseInfra/bicep/application-insights.bicep), simplified: no
// AppInsights component yet — PilotSwarm Node services don't emit
// AppInsights telemetry today. Workspace alone is sufficient for the
// resource-level diagnostic logs we ship today.
// ==============================================================================

@description('Azure region.')
param location string

@description('Log Analytics workspace name.')
param workspaceName string

@description('Retention in days. Up to 30 is included free; longer is billed.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output customerId string = workspace.properties.customerId
