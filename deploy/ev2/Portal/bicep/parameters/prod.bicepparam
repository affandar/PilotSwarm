using '../main.bicep'

// Values filled in by EV2 scope binding at rollout time. The placeholder
// values here exist only so `az bicep build-params` validates the shape
// locally. Real values are injected via EV2 parameter substitution.

param resourceName = 'pilotswarmprod1'
param region = 'westus3'
param sslCertificateDomainSuffix = 'pilotswarm.azure.com'

param applicationGatewayName = 'PLACEHOLDER_APPGW_NAME'
param privateLinkConfigurationName = 'privateLinkConfig'
param approvalManagedIdentityId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/PLACEHOLDER/providers/Microsoft.ManagedIdentity/userAssignedIdentities/PLACEHOLDER'

param frontDoorProfileName = 'pilotswarm-afd'
param frontDoorProfileResourceGroup = 'pilotswarm-global-prod'
param frontDoorEndpointName = 'pilotswarm-afd-endpoint'
