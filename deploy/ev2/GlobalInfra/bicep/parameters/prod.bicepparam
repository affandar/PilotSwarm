// PilotSwarm GlobalInfra — prod environment parameters.
// WAF in Prevention mode so matched threats are blocked, not only logged.
using '../main.bicep'

param region = 'westus3'
param resourceGroupName = 'pilotswarm-global-prod'
param resourcePrefix = 'pilotswarm'
param wafMode = 'Prevention'
