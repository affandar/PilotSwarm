// PilotSwarm BaseInfra — dev environment parameters.
// Smaller SKUs; WAF in Detection mode (matches GlobalInfra dev); Basic ACR.
using '../main.bicep'

param region = 'westus3'
param resourceNamePrefix = 'pilotswarmdev'
param frontDoorProfileName = 'pilotswarmdev-afd'
param frontDoorProfileResourceGroup = 'pilotswarm-global-dev'
param sslCertificateDomainSuffix = 'dev.pilotswarm.local'
param acrSku = 'Basic'
param wafMode = 'Detection'
param appGatewayPrivateIpAddress = '10.20.16.10'
param availabilityZones = []

// Supplied by pipeline / EV2 secret parameter; placeholder kept for
// `az bicep build-params` validation only. Do not commit a real value.
param postgresAdminPassword = 'REPLACE_AT_DEPLOY_TIME'
