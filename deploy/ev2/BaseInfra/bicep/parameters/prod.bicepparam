// PilotSwarm BaseInfra — prod environment parameters.
// Premium ACR, WAF in Prevention mode, zones 1/2/3 for AZ redundancy.
using '../main.bicep'

param region = 'westus3'
param resourceNamePrefix = 'pilotswarmprod'
param frontDoorProfileName = 'pilotswarm-afd'
param frontDoorProfileResourceGroup = 'pilotswarm-global-prod'
param sslCertificateDomainSuffix = 'pilotswarm.contoso.net'
param acrSku = 'Premium'
param wafMode = 'Prevention'
param appGatewayPrivateIpAddress = '10.20.16.10'
param availabilityZones = [
  '1'
  '2'
  '3'
]

// Supplied by pipeline / EV2 secret parameter; placeholder kept for
// `az bicep build-params` validation only. Do not commit a real value.
param postgresAdminPassword = 'REPLACE_AT_DEPLOY_TIME'
