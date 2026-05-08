// ==============================================================================
// PilotSwarm BaseInfra — AKS Container Insights Data Collection Rule.
//
// Routes container/kube telemetry to Log Analytics using the modern
// ContainerLogV2 schema. The legacy `ContainerLog` table is deprecated
// (retiring 2026-09-30), so new clusters should opt into ContainerLogV2
// from day one.
//
// Ported from reference deployment
// (src/Deploy/BaseInfra/bicep/aks-container-insights-dcr.bicep). No
// PilotSwarm-specific changes — the fleet pattern is already minimal.
//
// Two resources:
//   - Microsoft.Insights/dataCollectionRules — defines the streams +
//     Log Analytics destination.
//   - Microsoft.Insights/dataCollectionRuleAssociations — binds the DCR
//     to the AKS cluster (scope = the cluster) so the in-cluster
//     omsAgent picks it up.
// ==============================================================================

@description('Name of the existing AKS cluster (DCRA scope).')
param clusterName string

@description('Azure region. Must match the AKS cluster region.')
param location string

@description('Resource ID of the Log Analytics workspace destination.')
param logAnalyticsWorkspaceResourceId string

@description('Enable ContainerLogV2 schema (recommended). Legacy ContainerLog table retires 2026-09-30.')
param enableContainerLogV2 bool = true

@description('Data collection interval (1m–30m).')
param dataCollectionInterval string = '1m'

@description('Namespace filtering mode: Include, Exclude, or Off.')
@allowed([
  'Include'
  'Exclude'
  'Off'
])
param namespaceFilteringMode string = 'Off'

@description('Namespaces for filtering. Only used when namespaceFilteringMode is Include or Exclude.')
param namespaces array = [
  'kube-system'
  'gatekeeper-system'
  'azure-arc'
]

var dcrName = '${clusterName}-dcr'
var dcraName = '${clusterName}-dcra'

var containerLogStream = enableContainerLogV2 ? 'Microsoft-ContainerLogV2' : 'Microsoft-ContainerLog'

var baseDataCollectionSettings = {
  interval: dataCollectionInterval
  enableContainerLogV2: enableContainerLogV2
  namespaceFilteringMode: namespaceFilteringMode
}

var namespaceSettings = namespaceFilteringMode != 'Off' ? {
  namespaces: namespaces
} : {}

var dataCollectionSettings = union(baseDataCollectionSettings, namespaceSettings)

resource aks 'Microsoft.ContainerService/managedClusters@2023-09-01' existing = {
  name: clusterName
}

resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
  name: dcrName
  location: location
  kind: 'Linux'
  properties: {
    dataSources: {
      extensions: [
        {
          name: 'ContainerInsightsExtension'
          extensionName: 'ContainerInsights'
          streams: [
            containerLogStream
            'Microsoft-KubeEvents'
            'Microsoft-KubePodInventory'
            'Microsoft-KubeNodeInventory'
            'Microsoft-KubeServices'
            'Microsoft-KubeMonAgentEvents'
            'Microsoft-InsightsMetrics'
            'Microsoft-ContainerInventory'
            'Microsoft-ContainerNodeInventory'
            'Microsoft-Perf'
          ]
          extensionSettings: {
            dataCollectionSettings: dataCollectionSettings
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'ciworkspace'
          workspaceResourceId: logAnalyticsWorkspaceResourceId
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          containerLogStream
          'Microsoft-KubeEvents'
          'Microsoft-KubePodInventory'
          'Microsoft-KubeNodeInventory'
          'Microsoft-KubeServices'
          'Microsoft-KubeMonAgentEvents'
          'Microsoft-InsightsMetrics'
          'Microsoft-ContainerInventory'
          'Microsoft-ContainerNodeInventory'
          'Microsoft-Perf'
        ]
        destinations: [
          'ciworkspace'
        ]
      }
    ]
  }
}

resource dataCollectionRuleAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2022-06-01' = {
  name: dcraName
  scope: aks
  properties: {
    dataCollectionRuleId: dataCollectionRule.id
    description: 'Container Insights DCR for ${clusterName}'
  }
}

output dcrId string = dataCollectionRule.id
output dcrName string = dataCollectionRule.name
