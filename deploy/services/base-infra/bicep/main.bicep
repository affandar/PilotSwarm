// ==============================================================================
// PilotSwarm BaseInfra — per-region composition.
//
// Composes every per-region resource (AKS, ACR, Storage, PG Flex, AKV, UAMIs,
// VNet, AppGW with PL config, Flux configs for worker + portal) inside a
// single resource group. Deployed per region under the enterprise path; the fleet-wide AFD
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

@description('Suffix for the TLS certificate domain (e.g. "pilotswarm.contoso.net"). Consumed by Phase 4; surfaced here as an output so the enterprise path can thread it through.')
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

@description('Log Analytics workspace retention in days. Up to 30 is included free; longer is billed. Workspace receives AKS Container Insights telemetry (pods/nodes/events/ContainerLogV2 stream).')
@minValue(30)
@maxValue(730)
param logAnalyticsRetentionDays int = 30

@description('Edge topology mode. afd = Front Door + Private Link to AppGw private FE (default; current enterprise + OSS public path). private = no AppGw, no AGIC, no AFD; AKS web-app-routing addon (NGINX) on an internal LoadBalancer instead. Caller is responsible for arranging in-VNet / VPN / Bastion access and DNS resolution (Portal bicep provisions a Private DNS Zone for this).')
@allowed([
  'afd'
  'private'
])
param edgeMode string = 'afd'

@description('Optional principal ID (AAD object ID) for the local-deploy identity to receive Storage Blob Data Contributor on the deployment storage account. Defaults to empty for the enterprise production path. Local `npm run deploy` populates this with the signed-in AAD user.')
param localDeploymentPrincipalId string = ''

@description('Principal type for localDeploymentPrincipalId.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param localDeploymentPrincipalType string = 'User'

@description('Kubernetes namespace hosting the worker + portal service accounts. MUST match the NAMESPACE env-var that drives the Kustomize overlay (deploy/envs/local/<env>/env). Used to build federated identity credential subjects.')
param serviceAccountNamespace string = 'pilotswarm'

@description('Whether to provision an Azure AI Foundry (Cognitive Services AIServices) account in this stamp. When true, foundry.bicep + auto-secrets.bicep run; the Foundry primary key lands in KV as `azure-oai-key` and FOUNDRY_ENDPOINT is emitted as a deployment output. When false, no Foundry resource is provisioned and the worker catalog substitutes `__FOUNDRY_ENDPOINT__` to empty (Foundry providers in the catalog become non-loadable; non-Foundry providers — github-copilot, anthropic — keep working).')
param foundryEnabled bool = false

@description('SKU for the Foundry account. S0 is the only generally-available paid SKU. Ignored when foundryEnabled=false.')
@allowed([
  'S0'
])
param foundrySku string = 'S0'

@description('Array of Foundry model deployments to provision. Each entry: { name, model: { format, name, version }, sku: { name, capacity } }. Threaded by the deploy orchestrator from a per-stamp JSON file (deploy/envs/local/<env>/foundry-deployments.json) via `--parameters foundryDeployments=@<file>`. Empty array → account is provisioned with no deployments, useful for incremental opt-in. Ignored when foundryEnabled=false.')
param foundryDeployments array = []

@description('When true, provisions the OBO KEK in the stamp Key Vault (RSA-2048, wrapKey/unwrapKey, 365-day rotation) and grants `Key Vault Crypto User` to the shared CSI UAMI principal. Required for the User OBO Propagation feature (portal→worker per-RPC envelope encryption of user access tokens). Defaults to false; opt-in by setting OBO_ENABLED=true in the per-env .env.')
param oboEnabled bool = false

// ----- VPN P2S ingress (additive, optional) ---------------------------------
// All defaults preserve byte-equivalent param shape for non-VPN stamps.

@description('Whether to provision the Azure VPN Gateway (P2S, AAD-authenticated) as an additive ingress alongside AFD. False by default.')
param vpnGatewayEnabled bool = false

@description('VPN Gateway SKU. See vpn-gateway.bicep for allowed values; only AZ variants on Generation2 are supported (VpnGw1AZ is Generation1-only and has been observed to silently drop OpenVPN+AAD control-channel handshakes on new deployments). Basic is excluded (no OpenVPN/AAD support).')
param vpnGatewaySku string = 'VpnGw2AZ'

@description('VPN client address pool (must not overlap the VNet or any reachable on-prem range).')
param vpnClientAddressPool string = '172.16.200.0/24'

@description('AAD application audience for VPN client tokens. Default is the public Azure VPN client app ID; override only if you have registered a custom Azure VPN app.')
param vpnAadAudience string = 'c632b3df-fb67-4d84-bdcf-b95ad541b5c8'

@description('Operator-supplied AppGw WAF custom rules (priority >= 100). Threaded by deploy-bicep.mjs from APPGW_WAF_CUSTOM_RULES_FILE; empty by default. The auto-seeded AFD/VPN guard rules at priorities 90-92 are added by application-gateway.bicep when vpnGatewayEnabled=true.')
param appgwWafCustomRules array = []

@description('AFD frontDoorId GUID emitted by global-infra/bicep/main.bicep, threaded as FRONT_DOOR_ID via the deploy-bicep.mjs aliasFor() pipeline. Used by the AllowAfd WAF guard rule when VPN ingress is enabled.')
param frontDoorId string = ''

@description('Microsoft Entra (AAD) tenant ID threaded from the deploy-time AZURE_TENANT_ID env var via the base-infra params template. Currently consumed only by the VPN gateway module; the keyvault/postgres modules keep their own subscription().tenantId defaults. Empty default keeps non-VPN stamps byte-equivalent at the param layer.')
param tenantId string = ''

@description('Portal short hostname (e.g. pschkrawvpn-wus3-portal), threaded from the deploy-time PORTAL_RESOURCE_NAME env var. Used as the A-record label in the VPN-mode private DNS zone so VPN clients resolve the SAME hostname the AppGw listener serves (matching the AKV cert subject portalResourceName.sslCertificateDomainSuffix set in portal/bicep/main.bicep). Empty default keeps non-VPN stamps byte-equivalent.')
param portalResourceName string = ''

// ==============================================================================
// Derived names
// ==============================================================================

var location = toLower(region)

// Resource naming conventions.
//
// All resources are named deterministically from `resourceNamePrefix`, which
// the caller is expected to encode with whatever uniqueness their scope needs
// (e.g. `<env><regionShortName><stamp>`, like `pilotswarmdevwus31`). Several
// of the resources below — ACR, Storage Account, Key Vault, and the Postgres
// server's public DNS name — live in **globally unique** Azure namespaces, so
// the caller is responsible for choosing a `resourceNamePrefix` that does not
// collide with any other tenant's resources of the same type. The `npm run
// deploy:new-env` scaffolder enforces this in practice by deriving prefixes
// from a per-developer env name (`ps<envname>`), and higher-level orchestrators
// compose `<env><regionShort><stamp>` which is unique by construction. No
// random hashes are added here so that external tooling (e.g. higher-level
// deployment orchestrators that wrap this module) can compose resource names
// by convention without runtime lookups against the deployment outputs.
//
// Length / charset constraints to keep in mind when picking the prefix:
//   * Storage Account, Key Vault: 3–24 chars, lowercase alphanumeric only
//     (the `alphaPrefix` strip below handles dashes/underscores; the length
//     budget is split between prefix + the `sa`/`kv` suffix below).
//   * ACR: 5–50 chars, lowercase alphanumeric only.
//   * Postgres flexible-server: 3–63 chars, lowercase alphanumeric and dashes.
//
// `alphaPrefix` strips dashes/underscores to satisfy the alphanumeric naming
// constraints of ACR / Storage / Key Vault. When the caller already supplies a
// dashless `resourceNamePrefix`, this is a no-op and `alphaPrefix ==
// resourceNamePrefix`.
var alphaPrefix = toLower(replace(replace(resourceNamePrefix, '-', ''), '_', ''))

var aksClusterName = '${resourceNamePrefix}-aks'
var acrName = '${alphaPrefix}acr'
var storageAccountName = '${alphaPrefix}sa'
var postgresServerName = '${resourceNamePrefix}-pg'
var keyVaultName = '${alphaPrefix}kv'
var applicationGatewayName = '${resourceNamePrefix}-appgw'
var logAnalyticsName = '${resourceNamePrefix}-log'
var foundryAccountName = '${resourceNamePrefix}-aif'

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
    vpnGatewayEnabled: vpnGatewayEnabled
    // When VPN ingress is enabled, advertise the Private DNS Resolver inbound
    // endpoint static IP via the VNet's dhcpOptions. P2S clients connecting
    // through the VPN gateway inherit this DNS server list (the classic
    // Microsoft.Network/virtualNetworkGateways resource has no DNS-push field
    // of its own — see vpn-gateway.bicep). The IP is the static address
    // hardcoded in dns-resolver.bicep `inboundIpAddress` default (10.20.19.4)
    // and is reachable from P2S clients via the tunnel.
    dnsServers: vpnGatewayEnabled ? [
      '10.20.19.4'
    ] : []
  }
}

// ==============================================================================
// Approver UAMI gets Reader on the parent RG up-front, so the
// `check-appgw-exists` deployment script (next module) can probe a
// non-existent AppGw with a clean 404 instead of a 403.
// ==============================================================================

module ApproverRgReaderRbac './approver-rg-reader-rbac.bicep' = {
  name: '${resourceNamePrefix}-approver-rg-reader-${dTime}'
  params: {
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
  }
}

// ==============================================================================
// Probe whether the AppGw already exists in the RG. Drives the AGIC config
// preservation flag in `application-gateway.bicep`. Skipped in private
// mode — there is no AppGw.
// ==============================================================================

module ApplicationGatewayExistsCheck './check-appgw-exists.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-check-appgw-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    userAssignedIdentityId: Uami.outputs.approverIdentityResourceId
  }
  dependsOn: [
    ApproverRgReaderRbac
  ]
}

// ==============================================================================
// App Gateway (AGIC addon on AKS requires the AppGW to exist first).
// Skipped in private mode — the portal uses the AKS web-app-routing addon
// (NGINX) on an internal LoadBalancer; no AppGw is provisioned.
// ==============================================================================

module AppGateway './application-gateway.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-appgw-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    subnetId: Vnet.outputs.appGatewaySubnetId
    privateLinkSubnetId: Vnet.outputs.appGatewayPrivateLinkSubnetId
    privateIpAddress: appGatewayPrivateIpAddress
    wafMode: wafMode
    availabilityZones: availabilityZones
    userAssignedIdentityId: Uami.outputs.appGwIdentityResourceId
    appGwExists: ApplicationGatewayExistsCheck!.outputs.exists
    logAnalyticsWorkspaceResourceId: LogAnalytics.outputs.workspaceId
    appgwWafCustomRules: appgwWafCustomRules
    vpnGatewayEnabled: vpnGatewayEnabled
    vpnClientAddressPool: vpnClientAddressPool
    frontDoorId: frontDoorId
  }
}

// Second call to the approver RBAC module — this time scoped post-AppGw to
// grant Contributor on the AppGw resource (used by per-service deploys that
// push KV-referenced TLS certs onto the AppGw via
// `Common/bicep/appgw-add-ssl-certificate.bicep`). The Reader-on-RG grant
// is idempotent (same role-assignment guid). Skipped in private mode.
module ApproverAppGwRbac './approver-rg-reader-rbac.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-approver-appgw-rbac-${dTime}'
  params: {
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
    applicationGatewayName: AppGateway!.outputs.applicationGatewayName
    appGatewayManagedIdentityName: Uami.outputs.appGwIdentityName
    vnetName: Vnet.outputs.vnetName
    appGatewaySubnetName: Vnet.outputs.appGatewaySubnetName
  }
}

// ==============================================================================
// AKS
// ==============================================================================

// Grant the control-plane UAMI Network Contributor on the AKS subnet and
// Contributor on the AppGW BEFORE creating the cluster — required for
// UserAssigned identity (SystemAssigned would auto-grant these).
module AksControlPlaneRbac './aks-controlplane-rbac.bicep' = {
  name: '${resourceNamePrefix}-aks-cp-rbac-${dTime}'
  params: {
    controlPlaneIdentityPrincipalId: Uami.outputs.aksControlPlaneIdentityPrincipalId
    vnetId: Vnet.outputs.vnetId
    aksSubnetName: Vnet.outputs.aksSubnetName
  }
}

// ==============================================================================
// Log Analytics workspace. Provisioned before AKS so the cluster's
// omsAgent addon can be wired with the workspace resource ID at create
// time. Single workspace per stamp (per-region RG).
// ==============================================================================

module LogAnalytics '../../common/bicep/log-analytics.bicep' = {
  name: '${resourceNamePrefix}-log-${dTime}'
  params: {
    location: location
    workspaceName: logAnalyticsName
    retentionInDays: logAnalyticsRetentionDays
  }
}

// ==============================================================================
// VPN P2S Gateway (optional, additive ingress). Provisioned after VNet +
// LogAnalytics so the GatewaySubnet exists and diagnostic logs have a sink.
// Skipped entirely when vpnGatewayEnabled=false (default).
// ==============================================================================

// Private DNS Resolver — provisioned in lockstep with the VPN gateway so P2S
// clients have a reachable DNS server (the Resolver inbound IP) pushed via
// vpnClientConfiguration.customDnsServers. Without this, P2S clients cannot
// resolve Private DNS Zone records (e.g. portal hostname) through the tunnel
// because 168.63.129.16 is only reachable from inside Azure VMs.
module DnsResolver './dns-resolver.bicep' = if (vpnGatewayEnabled) {
  name: '${resourceNamePrefix}-dns-resolver-${dTime}'
  params: {
    location: location
    resourceName: resourceNamePrefix
    vnetId: Vnet.outputs.vnetId
    inboundSubnetId: Vnet.outputs.dnsResolverInboundSubnetId
  }
}

module VpnGateway './vpn-gateway.bicep' = if (vpnGatewayEnabled) {
  name: '${resourceNamePrefix}-vpngw-${dTime}'
  params: {
    location: location
    resourceName: resourceNamePrefix
    gatewaySubnetId: Vnet.outputs.gatewaySubnetId
    vpnGatewaySku: vpnGatewaySku
    vpnClientAddressPool: vpnClientAddressPool
    // tenantId is threaded from AZURE_TENANT_ID via the base-infra params
    // template (deploy-bicep.mjs render pipeline). This aligns the VPN
    // gateway's Entra ID authentication with the rest of the stamp's tenant
    // assumption. The keyvault/postgres modules continue to default to
    // subscription().tenantId — same value today, but their bicep contract
    // is unchanged.
    tenantId: tenantId
    vpnAadAudience: vpnAadAudience
    logAnalyticsWorkspaceId: LogAnalytics.outputs.workspaceId
  }
}

// ==============================================================================
// Private DNS zone for portal resolution over the VPN tunnel (managed-only).
// Provisioned after AppGw so the AppGw private FE IP is available.
// Skipped when vpnGatewayEnabled=false or edgeMode != 'afd' (no AppGw to point to).
// ==============================================================================

module PortalPrivateDns './private-dns-portal.bicep' = if (vpnGatewayEnabled && edgeMode == 'afd') {
  name: '${resourceNamePrefix}-portal-pdns-${dTime}'
  params: {
    vpnGatewayEnabled: vpnGatewayEnabled
    dnsZoneName: sslCertificateDomainSuffix
    // Must match the AppGw HTTPS listener hostname (= portal AKV cert
    // subject), composed in portal/bicep/main.bicep as
    // `${resourceName}.${sslCertificateDomainSuffix}` where `resourceName`
    // is the portal short name (`<env>-<regionShort>-portal`). Threaded
    // here as PORTAL_RESOURCE_NAME from the deploy env. Fallback to bare
    // resourceNamePrefix is intentionally preserved for older stamps that
    // pre-date this thread (cert/DNS would mismatch, but build won't break).
    recordName: empty(portalResourceName) ? resourceNamePrefix : portalResourceName
    appGatewayPrivateIp: appGatewayPrivateIpAddress
    vnetId: Vnet.outputs.vnetId
  }
}

module Aks './aks.bicep' = {
  name: '${resourceNamePrefix}-aks-${dTime}'
  params: {
    location: location
    clusterName: aksClusterName
    aksSubnetId: Vnet.outputs.aksSubnetId
    edgeMode: edgeMode
    applicationGatewayId: edgeMode == 'afd' ? AppGateway!.outputs.applicationGatewayId : ''
    kubeletIdentityResourceId: Uami.outputs.kubeletIdentityResourceId
    kubeletIdentityClientId: Uami.outputs.kubeletIdentityClientId
    kubeletIdentityPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
    aksControlPlaneIdentityResourceId: Uami.outputs.aksControlPlaneIdentityResourceId
    aksControlPlaneIdentityPrincipalId: Uami.outputs.aksControlPlaneIdentityPrincipalId
    availabilityZones: availabilityZones
    logAnalyticsWorkspaceResourceId: LogAnalytics.outputs.workspaceId
  }
  dependsOn: [
    AksControlPlaneRbac
  ]
}

// ==============================================================================
// Container Insights Data Collection Rule (ContainerLogV2 schema). The
// in-cluster omsAgent (provisioned by aks.bicep addonProfiles) discovers
// the DCRA and uses it to route pod/node/event telemetry to the workspace.
// Legacy `ContainerLog` table retires 2026-09-30, so opt into V2 from
// day one.
// ==============================================================================

module ContainerInsightsDcr './aks-container-insights-dcr.bicep' = {
  name: '${resourceNamePrefix}-ci-dcr-${dTime}'
  params: {
    clusterName: aksClusterName
    location: location
    logAnalyticsWorkspaceResourceId: LogAnalytics.outputs.workspaceId
  }
  dependsOn: [
    Aks
  ]
}

// ==============================================================================
// Federated identity credentials (run after AKS so OIDC issuer is known).
// ==============================================================================

module UamiFederation './uami-federation.bicep' = {
  name: '${resourceNamePrefix}-uami-fed-${dTime}'
  params: {
    csiIdentityName: Uami.outputs.csiIdentityName
    oidcIssuerUrl: Aks.outputs.oidcIssuerUrl
    serviceAccountNamespace: serviceAccountNamespace
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
    workerWorkloadPrincipalId: Uami.outputs.csiIdentityPrincipalId
    localDeploymentPrincipalId: localDeploymentPrincipalId
    localDeploymentPrincipalType: localDeploymentPrincipalType
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
    aadAdminPrincipalId: Uami.outputs.csiIdentityPrincipalId
    aadAdminPrincipalName: Uami.outputs.csiIdentityName
    aadAdminPrincipalType: 'ServicePrincipal'
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
    appGwPrincipalId: Uami.outputs.appGwIdentityPrincipalId
    localDeploymentPrincipalId: localDeploymentPrincipalId
    localDeploymentPrincipalType: localDeploymentPrincipalType
  }
}

// ==============================================================================
// OBO KEK + Key Vault Crypto User role assignments — conditional, kept in
// a single-responsibility module so the AKV module stays focused on the
// vault + secret-tier RBAC. Instantiated only when oboEnabled=true.
//
// PilotSwarm reference deploy uses a single shared CSI UAMI federated to
// BOTH the worker and portal service accounts (uami-federation.bicep).
// Pass a 1-element array; the module's role-assignment loop expands to
// one Microsoft.Authorization/roleAssignments resource. Downstream
// consumers with a different UAMI topology (e.g. distinct portal vs
// worker UAMIs) override by passing an N-element array.
// ==============================================================================

module OboKek './obo-kek.bicep' = if (oboEnabled) {
  name: '${resourceNamePrefix}-obo-kek-${dTime}'
  params: {
    keyVaultName: KeyVault.outputs.keyVaultName
    oboKekUamiPrincipalIds: [Uami.outputs.csiIdentityPrincipalId]
  }
}

// ==============================================================================
// Azure AI Foundry — optional, gated by foundryEnabled.
// ==============================================================================
//
// Provisions a single Cognitive Services AIServices account plus N model
// deployments. The data-plane key flows into KV via auto-secrets.bicep
// below. The endpoint flows out via the `foundryEndpoint` output, which
// the OSS deploy orchestrator aliases to FOUNDRY_ENDPOINT and substitutes
// into the worker base `model_providers.json` at manifest-staging time.

module Foundry './foundry.bicep' = if (foundryEnabled) {
  name: '${resourceNamePrefix}-foundry-${dTime}'
  params: {
    location: location
    accountName: foundryAccountName
    sku: foundrySku
    deployments: foundryDeployments
    keyVaultName: KeyVault.outputs.keyVaultName
  }
}

// ==============================================================================
// Auto-populated Key Vault secrets.
// ==============================================================================
//
// Earlier revisions wrote `azure-storage-connection-string` here from
// `listKeys()` so the worker pod could mount it via CSI. With the storage
// managed-identity path (PILOTSWARM_USE_MANAGED_IDENTITY=1, worker UAMI
// granted Storage Blob Data Contributor on the account) the worker no
// longer needs a shared key — `DefaultAzureCredential` exchanges the
// projected SA token for an AAD token. The connection-string secret is
// dropped entirely from the bicep-deploy flow.
//
// What does run here: when foundryEnabled=false, write the
// SEED_SECRETS_UNSET_SENTINEL placeholder for `azure-oai-key` so the
// stamp-invariant worker SPC mount succeeds. When foundryEnabled=true,
// foundry.bicep itself writes the real key1 (co-located with the account
// resource), so this sentinel module is skipped.
//
// Human-provided secrets (github-token, anthropic-api-key) are still
// seeded into Key Vault by the `seed-secrets` step in deploy.mjs, sourced
// from the gitignored deploy/envs/local/<env>/env file populated by
// `npm run deploy:new-env`.
//
// The legacy `scripts/deploy-aks.sh` flow continues to use connection
// strings (no MI flag set) and is unaffected by this change.

module AutoSecretsSentinel './auto-secrets-sentinel.bicep' = if (!foundryEnabled) {
  name: '${resourceNamePrefix}-auto-secrets-sentinel-${dTime}'
  params: {
    keyVaultName: KeyVault.outputs.keyVaultName
  }
}

// AppGW Private Link approver UAMI needs Network Contributor on the AppGW
// so the Portal deployment script can approve the Front Door PE connection.
// Skipped in private mode — no AppGw, no PE.
module AppGwPeApprovalRbac './appgw-pe-approval-rbac.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-pe-approver-rbac-${dTime}'
  params: {
    applicationGatewayName: AppGateway!.outputs.applicationGatewayName
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
  }
}

// AGIC addon RBAC. The AGIC addon creates its own UAMI in the AKS node RG;
// that identity (NOT the AKS control-plane UAMI) is what the AGIC pod uses,
// so it needs explicit role grants on the AppGw + AppGw subnet + AppGw UAMI.
// Mirrors reference deployment patterns: `agic-vnet-rbac`.
// Skipped in private mode — AGIC addon is not enabled (web-app-routing is).
module AgicRbac './agic-rbac.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-agic-rbac-${dTime}'
  params: {
    location: location
    applicationGatewayName: AppGateway!.outputs.applicationGatewayName
    appGatewayManagedIdentityName: Uami.outputs.appGwIdentityName
    virtualNetworkName: Vnet.outputs.vnetName
    appGatewaySubnetName: Vnet.outputs.appGatewaySubnetName
    agicAddonIdentityName: Aks.outputs.agicAddonIdentityName
    agicAddonIdentityResourceGroup: Aks.outputs.nodeResourceGroup
  }
}

// Same approver UAMI also runs the AKV cert-creation deployment script
// (Portal/akv-ssl-certificate.bicep) so it needs Key Vault Certificates
// Officer on the BaseInfra AKV. Reusing one deployment-script identity
// keeps role-grant churn low and matches the reference deployment
// `infraDeployManagedIdName` pattern.
module KvCertOfficerRbac './kv-cert-officer-rbac.bicep' = {
  name: '${resourceNamePrefix}-kv-certofficer-rbac-${dTime}'
  params: {
    keyVaultName: KeyVault.outputs.keyVaultName
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
  }
}

// ==============================================================================
// FluxConfigs — owned per-service.
// ==============================================================================
//
// Per-deployable Flux configurations (worker, portal) are now owned by each
// service's own bicep (deploy/services/worker/bicep/main.bicep,
// deploy/services/portal/bicep/main.bicep) — matching the
// reference deployment pattern. BaseInfra installs the
// `microsoft.flux` extension via aks.bicep but does not configure any
// per-service `fluxConfigurations` resources.
//
// The shared module deploy/services/common/bicep/flux-config.bicep is consumed by
// the Worker and Portal bicep main.bicep files.

// ==============================================================================
// Outputs (consumed by Phase 4 / enterprise / OSS deploy scripts).
// ==============================================================================

output applicationGatewayName string = edgeMode == 'afd' ? AppGateway!.outputs.applicationGatewayName : ''
output privateLinkConfigurationName string = edgeMode == 'afd' ? AppGateway!.outputs.privateLinkConfigurationName : ''
output privateLinkConfigurationId string = edgeMode == 'afd' ? AppGateway!.outputs.privateLinkConfigurationId : ''
output acrLoginServer string = Acr.outputs.loginServer
output acrName string = acrName
output keyVaultName string = KeyVault.outputs.keyVaultName
output blobContainerEndpoint string = Storage.outputs.blobContainerEndpoint
output aksClusterName string = Aks.outputs.aksClusterName
output oidcIssuerUrl string = Aks.outputs.oidcIssuerUrl
output postgresFqdn string = Postgres.outputs.fullyQualifiedDomainName
output postgresAadAdminPrincipalName string = Postgres.outputs.aadAdminPrincipalName
output frontDoorProfileName string = frontDoorProfileName
output frontDoorProfileResourceGroup string = frontDoorProfileResourceGroup
output sslCertificateDomainSuffix string = sslCertificateDomainSuffix
// Shared `csiIdentity` UAMI clientId — worker and portal both federate
// against this identity (uami-federation.bicep). Captured by the OSS
// deploy script (deploy-bicep.mjs OUTPUT_ALIAS) into env key
// WORKLOAD_IDENTITY_CLIENT_ID for downstream overlay `.env` substitution.
output csiIdentityClientId string = Uami.outputs.csiIdentityClientId
// Storage account name (consumed by Worker/Portal bicep + OSS deploy script
// FR-022 alias map). Per-service container names are emitted by each
// service's own bicep, not BaseInfra.
output deploymentStorageAccountName string = Storage.outputs.storageAccountName

// AppGW PE approver UAMI resource ID — consumed by Portal Bicep
// (`approvalManagedIdentityId` param). Captured by the OSS deploy script
// (deploy-bicep.mjs OUTPUT_ALIAS) into env key APPROVAL_MANAGED_IDENTITY_ID.
output approverIdentityResourceId string = Uami.outputs.approverIdentityResourceId

// OBO KEK un-versioned key URL (User OBO Propagation). Emits the
// substitute-env sentinel `__PS_UNSET__` when `oboEnabled=false` so the
// overlay `.env` substitution stays satisfied without the operator
// needing to set OBO_KEK_KID by hand (worker / portal runtime strips
// the sentinel from process.env at startup, so the application sees
// the key as truly unset and the existing principal-only envelope path
// engages). When `oboEnabled=true`, the un-versioned URL is captured
// by the OSS deploy script (deploy-bicep.mjs OUTPUT_ALIAS) into env
// key OBO_KEK_KID and projected into the worker + portal pods via the
// overlay-generated ConfigMaps. The worker `AkvEnvelopeCrypto`
// (packages/sdk/src/envelope-crypto.ts) decrypts per-RPC user access
// tokens against this key; the portal uses the same key (`wrapKey`)
// when encrypting outbound envelopes.
output oboKekKid string = oboEnabled ? OboKek!.outputs.oboKekKid : '__PS_UNSET__'

// AKS VNet resource id — consumed by Portal Bicep in private mode for
// the Private DNS Zone vnet link (`aksVnetId` param). Always emitted.
output aksVnetId string = Vnet.outputs.vnetId

// Edge topology mode — echoed back so the orchestrator (deploy.mjs / the enterprise path)
// can fan it into per-service params + skip AFD origin wiring in private.
output edgeMode string = edgeMode

// Log Analytics workspace — consumed by the OSS deploy script (output
// alias map) and operators running KQL queries against ContainerLogV2.
output logAnalyticsWorkspaceId string = LogAnalytics.outputs.workspaceId
output logAnalyticsWorkspaceName string = LogAnalytics.outputs.workspaceName

// Foundry account endpoint. Empty when foundryEnabled=false, otherwise the
// account's data-plane URL (e.g. `https://psdev-aif.cognitiveservices.azure.com/`).
// Aliased into FOUNDRY_ENDPOINT by deploy/scripts/lib/deploy-bicep.mjs and
// substituted into deploy/gitops/worker/base/model_providers.json at
// manifest-staging time (placeholder `__FOUNDRY_ENDPOINT__`).
output foundryEndpoint string = foundryEnabled ? Foundry!.outputs.endpoint : ''
output foundryAccountName string = foundryEnabled ? Foundry!.outputs.accountName : ''

// ----- VPN P2S ingress outputs (empty strings when disabled) ---------------
output vpnGatewayId string = vpnGatewayEnabled ? VpnGateway!.outputs.vpnGatewayId : ''
output vpnGatewayPublicIp string = vpnGatewayEnabled ? VpnGateway!.outputs.vpnGatewayPublicIp : ''
output vpnClientAddressPool string = vpnGatewayEnabled ? vpnClientAddressPool : ''
output vpnPrivateDnsZoneId string = (vpnGatewayEnabled && edgeMode == 'afd') ? PortalPrivateDns!.outputs.dnsZoneId : ''
