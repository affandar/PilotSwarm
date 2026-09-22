targetScope = 'resourceGroup'

param location string
param resourceNamePrefix string
param logAnalyticsWorkspaceId string
param alertEmail string
param serviceNamespace string

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${resourceNamePrefix}-oncall'
  location: 'global'
  properties: {
    groupShortName: take(replace(resourceNamePrefix, '-', ''), 12)
    enabled: true
    emailReceivers: [
      {
        name: 'PilotSwarmOnCall'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var alerts = [
  {
    name: 'aks-unavailable'
    description: 'AKS nodes or pods report unavailable states.'
    query: '''
KubeNodeInventory
| where TimeGenerated > ago(10m)
| summarize Unhealthy=countif(Status !~ "Ready")
| where Unhealthy > 0
'''
  }
  {
    name: 'flux-reconciliation'
    description: 'Flux controllers logged reconciliation failures.'
    query: '''
ContainerLogV2
| where TimeGenerated > ago(10m)
| where PodNamespace == "flux-system"
| where LogMessage has_any ("reconciliation failed", "HealthCheckFailed", "artifact failed")
'''
  }
  {
    name: 'postgres-capacity'
    description: 'PostgreSQL CPU or storage percentage exceeded the nonproduction threshold.'
    query: '''
AzureMetrics
| where TimeGenerated > ago(15m)
| where ResourceProvider =~ "MICROSOFT.DBFORPOSTGRESQL"
| where MetricName in~ ("cpu_percent", "storage_percent")
| summarize Peak=max(Average) by MetricName
| where Peak >= 85
'''
  }
  {
    name: 'certificate-health'
    description: 'Portal or certificate components logged certificate expiry or issuance failures.'
    query: '''
ContainerLogV2
| where TimeGenerated > ago(15m)
| where LogMessage has_any ("certificate expired", "certificate expiry", "certificate issuance failed", "SecretProviderClass")
'''
  }
  {
    name: 'model-provider-policy'
    description: 'Workers logged provider failures, budget exhaustion, or Azure AI policy rejection.'
    query: format('''
ContainerLogV2
| where TimeGenerated > ago(10m)
| where PodNamespace == "{0}"
| where LogMessage has_any ("ResponsibleAIPolicyViolation", "content_filter", "budget exhausted", "provider unavailable")
''', serviceNamespace)
  }
]

resource scheduledAlerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for alert in alerts: {
  name: '${resourceNamePrefix}-${alert.name}'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'PilotSwarm ${alert.name}'
    description: alert.description
    severity: 2
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    autoMitigate: true
    criteria: {
      allOf: [
        {
          query: alert.query
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}]

output actionGroupId string = actionGroup.id
