// ==============================================================================
// PilotSwarm BaseInfra — per-region composition.
//
// Composes every per-region resource (AKS, ACR, Storage, PG Flex, AKV, UAMIs,
// VNet, AppGW with PL config, Flux configs for worker + portal) inside a
// single resource group. Deployed per region under EV2; the fleet-wide AFD
// profile lives in GlobalInfra and is referenced by name/RG only (Phase 4
// wires AFD origin + route to the AppGW private frontend).
// ==============================================================================

targetScope = 'resourceGroup'

// ==============================================================================
// Parameters
// ==============================================================================

@description('Azure region. Must match the resource group region.')
param region string

@description('Naming prefix applied to every resource (e.g. "pilotswarmdev", "pilotswarmprod").')
param resourceNamePrefix string

@description('Name of the fleet-wide Front Door Premium profile provisioned by GlobalInfra. Used by Phase 4 to attach per-region origins; referenced here only as an output for downstream modules.')
param frontDoorProfileName string

@description('Resource group that holds the fleet-wide Front Door profile.')
param frontDoorProfileResourceGroup string

@description('Suffix for the TLS certificate domain (e.g. "pilotswarm.contoso.net"). Consumed by Phase 4; surfaced here as an output so EV2 can thread it through.')
param sslCertificateDomainSuffix string

@description('ACR SKU (Basic/Standard/Premium). Dev uses Basic; prod uses Premium.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param acrSku string = 'Basic'

@description('WAF mode on the App Gateway. Dev uses Detection; prod uses Prevention.')
@allowed([
  'Detection'
  'Prevention'
])
param wafMode string = 'Prevention'

@description('Static private IP for the App Gateway private frontend. Must sit within the App Gateway subnet range.')
param appGatewayPrivateIpAddress string = '10.20.16.10'

@description('Availability zones. Empty array disables zone placement (useful for dev in regions without 3 zones).')
param availabilityZones array = []

@description('Unique suffix appended to nested module names so repeated deployments do not collide.')
param dTime string = utcNow()

@description('Deployment environment (e.g. "dev", "prod"). Drives the Flux kustomization overlay path.')
@allowed([
  'dev'
  'prod'
])
param environment string = 'dev'

// ==============================================================================
// Derived names
// ==============================================================================

var location = toLower(region)

// Names that must be globally unique and alphanumeric-only use
// `uniqueString(resourceGroup().id)` as a suffix to keep them short and stable
// per-RG.
var uniqueSuffix = substring(uniqueString(resourceGroup().id), 0, 6)
var alphaPrefix = toLower(replace(replace(resourceNamePrefix, '-', ''), '_', ''))

var aksClusterName = '${resourceNamePrefix}-aks'
var acrName = '${alphaPrefix}acr${uniqueSuffix}'
var storageAccountName = '${alphaPrefix}sa${uniqueSuffix}'
var postgresServerName = '${resourceNamePrefix}-pg-${uniqueSuffix}'
var keyVaultName = '${alphaPrefix}kv${uniqueSuffix}'
var applicationGatewayName = '${resourceNamePrefix}-appgw'

// ==============================================================================
// UAMIs (must exist before AKS so kubelet identity can be bound).
// ==============================================================================

module Uami './uami.bicep' = {
  name: '${resourceNamePrefix}-uami-${dTime}'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
  }
}

// ==============================================================================
// VNet
// ==============================================================================

module Vnet './vnet.bicep' = {
  name: '${resourceNamePrefix}-vnet-${dTime}'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    availabilityZones: availabilityZones
  }
}

// ==============================================================================
// App Gateway (AGIC addon on AKS requires the AppGW to exist first).
// ==============================================================================

module AppGateway './application-gateway.bicep' = {
  name: '${resourceNamePrefix}-appgw-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    subnetId: Vnet.outputs.appGatewaySubnetId
    privateLinkSubnetId: Vnet.outputs.appGatewayPrivateLinkSubnetId
    privateIpAddress: appGatewayPrivateIpAddress
    wafMode: wafMode
    availabilityZones: availabilityZones
  }
}

// ==============================================================================
// AKS
// ==============================================================================

module Aks './aks.bicep' = {
  name: '${resourceNamePrefix}-aks-${dTime}'
  params: {
    location: location
    clusterName: aksClusterName
    aksSubnetId: Vnet.outputs.aksSubnetId
    applicationGatewayId: AppGateway.outputs.applicationGatewayId
    kubeletIdentityResourceId: Uami.outputs.kubeletIdentityResourceId
    kubeletIdentityClientId: Uami.outputs.kubeletIdentityClientId
    kubeletIdentityPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
    availabilityZones: availabilityZones
  }
}

// ==============================================================================
// Federated identity credentials (run after AKS so OIDC issuer is known).
// ==============================================================================

module UamiFederation './uami-federation.bicep' = {
  name: '${resourceNamePrefix}-uami-fed-${dTime}'
  params: {
    csiIdentityName: Uami.outputs.csiIdentityName
    oidcIssuerUrl: Aks.outputs.oidcIssuerUrl
  }
}

// ==============================================================================
// ACR + AcrPull role assignment on kubelet UAMI.
// ==============================================================================

module Acr './acr.bicep' = {
  name: '${resourceNamePrefix}-acr-${dTime}'
  params: {
    location: location
    registryName: acrName
    skuName: acrSku
    aksKubeletPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
  }
}

// ==============================================================================
// Storage (session + manifest containers) + Blob Data Reader for kubelet.
// ==============================================================================

module Storage './storage.bicep' = {
  name: '${resourceNamePrefix}-sa-${dTime}'
  params: {
    location: location
    storageAccountName: storageAccountName
    aksKubeletPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
  }
}

// ==============================================================================
// PostgreSQL Flexible Server (worker runs its own migrations).
// ==============================================================================

module Postgres './postgres.bicep' = {
  name: '${resourceNamePrefix}-pg-${dTime}'
  params: {
    location: location
    serverName: postgresServerName
  }
}

// ==============================================================================
// Key Vault + KV Secrets User for CSI SPC UAMI.
// ==============================================================================

module KeyVault './keyvault.bicep' = {
  name: '${resourceNamePrefix}-akv-${dTime}'
  params: {
    location: location
    keyVaultName: keyVaultName
    csiPrincipalId: Uami.outputs.csiIdentityPrincipalId
  }
}

// ==============================================================================
// EV2 deploy UAMI RBAC — AcrPush + Storage Blob Data Contributor on the
// per-region ACR + storage account. Consumed by the ACI sandbox that EV2
// spins up for UploadContainer / DeployApplicationManifest.
// ==============================================================================

module Ev2DeployRbac './ev2-deploy-rbac.bicep' = {
  name: '${resourceNamePrefix}-ev2deploy-rbac-${dTime}'
  params: {
    acrName: acrName
    storageAccountName: storageAccountName
    ev2DeployPrincipalId: Uami.outputs.ev2DeployIdentityPrincipalId
  }
  dependsOn: [
    Acr
    Storage
  ]
}

// ==============================================================================
// FluxConfigs — one per deployable.
// ==============================================================================

module WorkerFluxConfig './flux-config.bicep' = {
  name: '${resourceNamePrefix}-flux-worker-${dTime}'
  params: {
    aksClusterName: Aks.outputs.aksClusterName
    configName: 'worker'
    blobContainerEndpoint: Storage.outputs.blobContainerEndpoint
    containerName: Storage.outputs.workerManifestsContainerName
    kustomizationPath: 'overlays/${environment}'
  }
}

module PortalFluxConfig './flux-config.bicep' = {
  name: '${resourceNamePrefix}-flux-portal-${dTime}'
  params: {
    aksClusterName: Aks.outputs.aksClusterName
    configName: 'portal'
    blobContainerEndpoint: Storage.outputs.blobContainerEndpoint
    containerName: Storage.outputs.portalManifestsContainerName
    kustomizationPath: 'overlays/${environment}'
  }
}

// ==============================================================================
// Outputs (consumed by Phase 4 / EV2 / deploy scripts).
// ==============================================================================

output applicationGatewayName string = AppGateway.outputs.applicationGatewayName
output privateLinkConfigurationName string = AppGateway.outputs.privateLinkConfigurationName
output privateLinkConfigurationId string = AppGateway.outputs.privateLinkConfigurationId
output acrLoginServer string = Acr.outputs.loginServer
output acrName string = acrName
output keyVaultName string = KeyVault.outputs.keyVaultName
output blobContainerEndpoint string = Storage.outputs.blobContainerEndpoint
output aksClusterName string = Aks.outputs.aksClusterName
output postgresFqdn string = Postgres.outputs.fullyQualifiedDomainName
output frontDoorProfileName string = frontDoorProfileName
output frontDoorProfileResourceGroup string = frontDoorProfileResourceGroup
output sslCertificateDomainSuffix string = sslCertificateDomainSuffix
output aciSubnetId string = Vnet.outputs.aciSubnetId
output ev2DeployIdentityResourceId string = Uami.outputs.ev2DeployIdentityResourceId
output ev2DeployIdentityClientId string = Uami.outputs.ev2DeployIdentityClientId
