// ==============================================================================
// PilotSwarm Portal - Front Door Origin + Route + Private Endpoint Approval
//                   + Portal manifest container + Flux configuration
// ==============================================================================
// Scope: resource group (deploys the approve-pe deploymentScript into the
// BaseInfra RG, and cross-RG-scopes the AFD origin/route into the GlobalInfra
// RG).
//
// This module does NOT provision the portal Kubernetes workload — that is
// reconciled by FLUX from the portal manifest blob container which IS owned
// by this bicep (per the postgresql-fleet-manager playgroundservice pattern:
// each service provisions its own Flux source in its own bicep).
//
// What this module does:
//   1. Creates the `portal-manifests` blob container in the BaseInfra
//      storage account.
//   2. Configures Flux on the BaseInfra AKS cluster to reconcile from that
//      container.
//   3. Computes the portal's certificate subject (hostname).
//   4. Computes the documented Application Gateway PLS service id string.
//   5. Creates the Front Door origin group, private-link origin, and route
//      in the GlobalInfra RG (via the verbatim shared module).
//   6. Auto-approves the pending PLS connection on the AppGW side.
//
// Surfaces BackendHostName as an output so EV2 scope binding can fan it
// into overlay/.env as PORTAL_HOSTNAME (Spec FR-014).
// ==============================================================================

targetScope = 'resourceGroup'

// -----------------------------------------------------------------------------
// Naming parameters
// -----------------------------------------------------------------------------

@description('Short resource-name root, e.g. pilotswarmprod1. Must match the value used by BaseInfra so the AppGW hostname aligns.')
param resourceName string

@description('BaseInfra `resourceNamePrefix` value used to look up the CSI Secrets Provider UAMI by convention name. May differ from `resourceName` in OSS direct deploys, where Portal has its own logical name (`<prefix>-<region>-portal`) while BaseInfra resources use a shorter prefix. Downstream callers that wrap this module may pass any prefix shaped per their own environment-region-stamp convention.')
param baseInfraResourceNamePrefix string

@description('Azure region (lowercased). Used in the certificate subject to disambiguate multi-region deployments.')
param region string

@description('DNS suffix for the portal cert, e.g. pilotswarm.azure.com. Required in EDGE_MODE=afd + TLS_SOURCE=akv (used to derive resourceName.suffix as cert subject + AFD origin host). Ignored when EDGE_MODE=afd + TLS_SOURCE=letsencrypt (cert subject derives from the AppGw cloudapp.azure.com label) or when EDGE_MODE=private (caller supplies portalHostnameOverride).')
param sslCertificateDomainSuffix string

@description('Edge topology mode. afd = Front Door + Private Link to AppGw private FE (default; covers OSS via the AppGw cloudapp.azure.com DNS label and EV2 via a custom domain). private = AppGw private IP listener only, no AFD; caller must supply portalHostnameOverride and arrange DNS resolution to APP_GATEWAY_PRIVATE_IP.')
@allowed([
  'afd'
  'private'
])
param edgeMode string = 'afd'

@description('TLS cert source. letsencrypt = cert-manager + LE prod (cert lands in a K8s Secret managed by cert-manager; bicep skips the AKV cert deployment script). akv = AKV-registered issuer + bicep cert script (current EV2 / enterprise path; default preserves EV2 behavior when the param is not supplied). akv-selfsigned = AKV `Self` issuer + bicep cert script (OSS / dev convenience for private mode; produces a self-signed cert in AKV, no CA registration required, NOT trusted by browsers without manual trust).')
@allowed([
  'letsencrypt'
  'akv'
  'akv-selfsigned'
])
param tlsSource string = 'akv'

@description('Caller-supplied portal hostname (short label, no domain). Required in EDGE_MODE=private; ignored in afd (bicep derives from the AppGw DNS label for letsencrypt and from resourceName+sslCertificateDomainSuffix for akv). In private mode the FQDN is composed as <portalHostnameOverride>.<privateDnsZoneName>.')
param portalHostnameOverride string = ''

@description('Azure Private DNS Zone name for private mode (e.g. pilotswarm.private). Required when edgeMode=private; ignored otherwise. Bicep provisions the zone in this resource group and links it to the AKS VNet so in-VNet / VPN / Bastion clients resolve the portal hostname. The post-deploy A record (host -> ingress ILB IP) is written by deploy.mjs.')
param privateDnsZoneName string = ''

@description('Resource id of the AKS VNet (from BaseInfra output). Used to link the Private DNS Zone in private mode. Empty / unused in afd mode.')
param aksVnetId string = ''

// -----------------------------------------------------------------------------
// BaseInfra references (per-region)
// -----------------------------------------------------------------------------

@description('Application Gateway name (from BaseInfra output).')
param applicationGatewayName string

@description('Application Gateway Private Link configuration name (from BaseInfra output).')
param privateLinkConfigurationName string

@description('UAMI resource id used by the approve-private-endpoint deployment script. Must have Network Contributor on the AppGW.')
param approvalManagedIdentityId string

// -----------------------------------------------------------------------------
// GlobalInfra references
// -----------------------------------------------------------------------------

@description('Azure Front Door profile name (from GlobalInfra output). Empty / unused when edgeMode is not afd.')
param frontDoorProfileName string = ''

@description('Resource group that contains the Front Door profile. Empty / unused when edgeMode is not afd.')
param frontDoorProfileResourceGroup string = ''

@description('Azure Front Door endpoint name (from GlobalInfra output). Empty / unused when edgeMode is not afd.')
param frontDoorEndpointName string = ''

// -----------------------------------------------------------------------------
// BaseInfra references — storage + AKS (per-region)
// -----------------------------------------------------------------------------

@description('BaseInfra storage account name (Flux source for portal-manifests container).')
param storageAccountName string

@description('BaseInfra AKS cluster name (parent of the Flux extension).')
param aksClusterName string

@description('BaseInfra Key Vault name (target for the auto-provisioned portal TLS cert).')
param keyVaultName string

@description('Resource id of the UAMI used to run the AKV cert-creation deployment script (BaseInfra Uami.outputs.approverIdentityResourceId — already granted Key Vault Certificates Officer in BaseInfra).')
param certScriptIdentityResourceId string

@description('Name of the cert in AKV. Must match the SPC objectName/secretName used by the portal TLS volume (deploy/gitops/portal/base/secret-provider-class.yaml). Only consumed when tlsSource is akv.')
param portalTlsCertName string = 'pilotswarm-portal-tls'

@description('AKV issuer name (registered via akv-certificate-issuer.bicep) for tlsSource=akv. When empty (default), bicep registers and uses OneCertV2-PublicCA (afd) or OneCertV2-PrivateCA (private) per the fleet-manager pattern. Ignored when tlsSource is akv-selfsigned (uses the built-in `Self` issuer) or letsencrypt (cert-manager owns the cert).')
param portalTlsIssuerName string = ''

// -----------------------------------------------------------------------------
// Derived values
// -----------------------------------------------------------------------------

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

var location = toLower(region)

// -----------------------------------------------------------------------------
// Hostname derivation. The resolved value drives:
//   • AKV cert subject (akv path) / cert-manager Certificate dnsName (LE path)
//   • AppGw listener host (via AGIC ingress)
//   • Portal Ingress `spec.rules.0.host` (via overlay env substitution)
//   • AFD origin hostname (afd mode only)
//
// afd + letsencrypt: `${appGwName}.${region}.cloudapp.azure.com` — Azure DNS
//                    label on the AppGw public IP. LE issues via HTTP-01 on
//                    the same hostname; AFD endpoint at `*.z01.azurefd.net`
//                    is the user-facing URL. Zero DNS prerequisite for OSS.
// afd + akv:         `${resourceName}.${sslCertificateDomainSuffix}` — caller
//                    owns DNS for the suffix; cert subject + AFD origin host
//                    align via the AKV-registered issuer.
// private:           caller-supplied via `portalHostnameOverride`. The user
//                    arranges DNS to APP_GATEWAY_PRIVATE_IP. Both letsencrypt
//                    (DNS-01 against an Azure DNS zone) and akv work.
// -----------------------------------------------------------------------------
var publicAppGwFqdn = '${toLower(applicationGatewayName)}.${location}.cloudapp.azure.com'
var privateFqdn = '${portalHostnameOverride}.${privateDnsZoneName}'
var certificateSubject = edgeMode == 'private'
  ? privateFqdn
  : (tlsSource == 'letsencrypt' ? publicAppGwFqdn : '${resourceName}.${sslCertificateDomainSuffix}')

// OneCertV2 issuer to register on the AKV when tlsSource=akv. afd lands on
// the public CA so Front Door / browsers trust the chain; private lands on
// the private CA (e.g. AME) for in-VNet clients.
var defaultOneCertIssuer = edgeMode == 'afd' ? 'OneCertV2-PublicCA' : 'OneCertV2-PrivateCA'
var resolvedAkvIssuerName = empty(portalTlsIssuerName) ? defaultOneCertIssuer : portalTlsIssuerName
// Issuer name handed to akv-ssl-certificate. akv-selfsigned uses the
// built-in `Self` issuer (no CA registration). akv uses the registered
// OneCertV2 issuer (or the override).
var portalCertIssuerForModule = tlsSource == 'akv-selfsigned' ? 'Self' : resolvedAkvIssuerName


// PLS service id string format (per Microsoft docs):
//   /subscriptions/{sub}/resourceGroups/{appGwRg}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_{applicationGatewayName}_{privateLinkConfigurationName}
// This is the format that Front Door uses to establish the shared PL
// connection to an App Gateway. Not consumed directly by the origin module
// (which rebuilds the same string internally), but surfaced as an output for
// audit/diagnostic scope bindings.
var privateLinkServiceId = '/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_${applicationGatewayName}_${privateLinkConfigurationName}'

// -----------------------------------------------------------------------------
// Existing references (for pulling AppGW location - must match privateLinkLocation)
// -----------------------------------------------------------------------------

// Only resolved in afd mode — private mode skips AppGw entirely (BaseInfra
// does not deploy one), and resolving an `existing` reference for a
// missing resource would fail.
resource applicationGateway 'Microsoft.Network/applicationGateways@2024-01-01' existing = if (edgeMode == 'afd') {
  name: applicationGatewayName
}

// -----------------------------------------------------------------------------
// Portal manifest container + Flux source (owned by Portal per fleet-manager
// playgroundservice pattern).
// -----------------------------------------------------------------------------

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

// CSI Secrets Provider UAMI (created by BaseInfra's `uami.bicep` module). The
// UAMI is named `${baseInfraResourceNamePrefix}-csi-mid` by convention; we
// look it up here so its clientId can be exposed as a Portal own-package
// output. This makes the value reachable by downstream callers (e.g.
// higher-level deployment orchestrators that compose this bicep across
// independent deployment boundaries and can only see each package's own
// outputs) for Workload Identity federation in the AKS app deploy step.
// When OSS deploys directly, `deploy-bicep.mjs` already wires
// `csiIdentityClientId` into manifest substitution via the
// `WORKLOAD_IDENTITY_CLIENT_ID` env alias, so this output is purely additive.
resource csiUami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseInfraResourceNamePrefix}-csi-mid'
}

resource portalManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'portal-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module PortalFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'portal-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'portal'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: portalManifestsContainer.name
    // Overlay path = `${edgeMode}-${tlsKustomizeVariant}`. The kustomize
    // layer treats `akv` and `akv-selfsigned` identically (the divergence
    // is purely the AKV cert-policy issuer name owned by Bicep), so map
    // both to the `akv` overlay. `private + letsencrypt` is blocked by
    // deploy.mjs / new-env validation and never reaches this expression.
    kustomizationPath: 'overlays/${edgeMode}-${tlsSource == 'akv-selfsigned' ? 'akv' : tlsSource}'
  }
}

// -----------------------------------------------------------------------------
// Private DNS Zone (private mode only). Bicep provisions the zone in the
// BaseInfra RG and links it to the AKS VNet so in-VNet / VPN / Bastion
// clients can resolve `${portalHostnameOverride}.${privateDnsZoneName}`.
// The A record itself is written by deploy.mjs after Flux exposes the
// ingress controller's internal LB IP — that value isn't known at bicep
// time and would chicken-and-egg the deployment.
// -----------------------------------------------------------------------------
resource portalPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (edgeMode == 'private') {
  name: privateDnsZoneName
  location: 'global'
}

resource portalPrivateDnsZoneVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (edgeMode == 'private') {
  parent: portalPrivateDnsZone
  name: 'aks-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: aksVnetId
    }
  }
}

// -----------------------------------------------------------------------------
// AKV issuer registration (idempotent). Registers the OneCertV2 CA on the
// BaseInfra Key Vault so akv-ssl-certificate.bicep can issue against it
// instead of `Self`. Skipped for tlsSource=akv-selfsigned (uses built-in
// Self issuer) and for tlsSource=letsencrypt (cert-manager owns the cert,
// AKV is not in the path).
//
// Pattern matches postgresql-fleet-manager: afd lands on the public CA,
// private lands on the private CA (e.g. AME OneCertV2-PrivateCA registered
// for the AKV by EV2 / OneCert onboarding).
// -----------------------------------------------------------------------------
module PortalAkvIssuer '../../common/bicep/akv-certificate-issuer.bicep' = if (tlsSource == 'akv') {
  name: 'portal-akv-issuer-${dTime}'
  params: {
    location: location
    akvName: keyVaultName
    issuerName: resolvedAkvIssuerName
    provider: resolvedAkvIssuerName
    scriptIdentityResourceId: certScriptIdentityResourceId
  }
}

// -----------------------------------------------------------------------------
// AKV-managed TLS certificate for the portal (idempotent). Provisioned for
// both `akv` (issued by the registered OneCertV2 CA) and `akv-selfsigned`
// (issued by the built-in AKV `Self` issuer — OSS / dev convenience for
// private mode where browser trust isn't a hard requirement). Skipped for
// `letsencrypt` — cert-manager owns cert lifecycle and the cert lands
// directly in a K8s Secret consumed by the portal Ingress.
// -----------------------------------------------------------------------------
module PortalSslCertificate '../../common/bicep/akv-ssl-certificate.bicep' = if (tlsSource == 'akv' || tlsSource == 'akv-selfsigned') {
  name: '${portalTlsCertName}-${dTime}'
  params: {
    location: location
    akvName: keyVaultName
    certificateName: portalTlsCertName
    certificateSubject: certificateSubject
    issuerName: portalCertIssuerForModule
    scriptIdentityResourceId: certScriptIdentityResourceId
  }
  dependsOn: [
    PortalAkvIssuer
  ]
}

// Push the just-created KV cert onto the Application Gateway's
// `sslCertificates[]` array. AGIC binds it to the portal listener via the
// `appgw.ingress.kubernetes.io/appgw-ssl-certificate` annotation. Skipped
// for letsencrypt (cert-manager Secret is read directly via tls.secretName)
// and for private mode (no AppGw at all — NGINX reads the K8s Secret
// projected by the Secrets Store CSI driver).
module AddSslCertToAppGw '../../common/bicep/appgw-add-ssl-certificate.bicep' = if (tlsSource == 'akv' && edgeMode == 'afd') {
  name: '${portalTlsCertName}-appgw-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    applicationGatewayResourceGroup: resourceGroup().name
    certificateName: portalTlsCertName
    keyVaultSecretId: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${portalTlsCertName}'
    managedIdentityId: certScriptIdentityResourceId
    deploymentTimestamp: dTime
  }
  dependsOn: [
    PortalSslCertificate
  ]
}

// Trusted-root upload was previously used to make AppGw trust a self-signed
// portal pod cert during E2E HTTPS validation. Self-signed is no longer
// supported on the deploy path — both letsencrypt and akv produce a chain
// the AppGw trusts via its built-in root store — so this module is
// removed. The corresponding ingress annotation `appgw-trusted-root-
// certificate` is harmless when AGIC sees no matching root cert and is
// dropped from the ingress overlay in the same change.

// -----------------------------------------------------------------------------
// Front Door origin + route (cross-RG scope into GlobalInfra RG).
// Provisioned only in EDGE_MODE=afd. In `private` mode this module is
// module is skipped — there is no AFD profile to attach an origin to (the
// orchestrator skips the GlobalInfra service entirely in those modes).
// -----------------------------------------------------------------------------

module afdOrigin '../../common/bicep/frontdoor-origin-route.bicep' = if (edgeMode == 'afd') {
  name: 'portal-afd-${dTime}'
  scope: az.resourceGroup(frontDoorProfileResourceGroup)
  params: {
    frontDoorProfileName: frontDoorProfileName
    frontDoorEndpointName: frontDoorEndpointName
    originGroupName: '${frontDoorProfileName}-portal-og'
    originName: '${resourceName}-portal-origin'
    routeName: '${frontDoorProfileName}-portal-route'
    applicationGatewayName: applicationGatewayName
    applicationGatewayResourceGroup: resourceGroup().name
    applicationGatewayPrivateLinkConfigName: privateLinkConfigurationName
    // applicationGateway is a conditional `existing` reference (only
    // resolved when edgeMode=='afd'). This module is itself afd-gated, so
    // the null-forgiving `!` is safe here.
    privateLinkLocation: applicationGateway!.location
    originHostName: certificateSubject
    // AFD origin-group health probe. Must match a path that the portal pod
    // serves (the portal exposes `/api/health` — see the ingress
    // `health-probe-path` annotation). `/healthz` returns 404 and AFD then
    // marks the origin Unhealthy → 502 from the AFD endpoint.
    healthProbePath: '/api/health'
    patternToMatch: '/*'
  }
}

// -----------------------------------------------------------------------------
// Auto-approve pending PLS connection on the AppGW side. Only meaningful when
// AFD owns the Private Endpoint (afd mode). In private mode there's no
// no AFD-side PE to approve.
// -----------------------------------------------------------------------------

module plApprove '../../common/bicep/approve-private-endpoint.bicep' = if (edgeMode == 'afd') {
  name: 'portal-approve-pe-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    applicationGatewayResourceGroup: resourceGroup().name
    managedIdentityId: approvalManagedIdentityId
    dTime: dTime
    requestMessageFilter: 'Front Door Private Link request for the service'
  }
  dependsOn: [
    afdOrigin
  ]
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

@description('AFD backend hostname / AppGW listener host / Portal Ingress host. EV2 scope-binds this into overlay/.env as PORTAL_HOSTNAME.')
output BackendHostName string = certificateSubject

@description('Computed PLS service id string (audit/diagnostic).')
output PrivateLinkServiceId string = privateLinkServiceId

@description('Front Door route name created for the portal. Empty when edgeMode is not afd.')
#disable-next-line BCP318
output RouteName string = edgeMode == 'afd' ? afdOrigin.outputs.routeName : ''

@description('Count of PLS connections auto-approved in this deployment. Zero when edgeMode is not afd.')
#disable-next-line BCP318
output ApprovedPrivateEndpointCount int = edgeMode == 'afd' ? plApprove.outputs.approvedCount : 0

@description('Portal manifest container name (consumed by OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = portalManifestsContainer.name

@description('Client ID of the CSI Secrets Provider UAMI (looked up by convention name from this RG). Consumed by the AKS app-deploy step (and by downstream callers that wrap this bicep) to federate Workload Identity.')
output csiIdentityClientId string = csiUami.properties.clientId
