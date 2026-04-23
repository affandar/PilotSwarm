// PilotSwarm GlobalInfra — dev environment parameters.
// WAF in Detection mode so bring-up traffic is never blocked by false
// positives. Prod flips this to Prevention via prod.bicepparam.
using '../main.bicep'

param region = 'westus3'
param resourceGroupName = 'pilotswarm-global-dev'
param resourcePrefix = 'pilotswarmdev'
param wafMode = 'Detection'
