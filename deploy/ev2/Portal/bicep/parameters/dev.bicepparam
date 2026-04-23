using '../main.bicep'

// Values filled in by EV2 scope binding at rollout time. The placeholder
// values here exist only so `az bicep build-params` validates the shape
// locally. Real values are injected via EV2 parameter substitution.

param resourceName = 'pilotswarmdev1'
param region = 'westus3'
param sslCertificateDomainSuffix = 'dev.pilotswarm.azure.com'

param applicationGatewayName = 'PLACEHOLDER_APPGW_NAME'
param privateLinkConfigurationName = 'privateLinkConfig'
param approvalManagedIdentityId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/PLACEHOLDER/providers/Microsoft.ManagedIdentity/userAssignedIdentities/PLACEHOLDER'

param frontDoorProfileName = 'pilotswarmdev-afd'
param frontDoorProfileResourceGroup = 'pilotswarm-global-dev'
param frontDoorEndpointName = 'pilotswarmdev-afd-endpoint'
