// ==============================================================================
// PilotSwarm BaseInfra — Azure AI Foundry (Cognitive Services account).
//
// Optional, gated by `foundryEnabled` in main.bicep. Provisions a single
// `Microsoft.CognitiveServices/accounts` (kind=AIServices) plus N model
// deployments under it, all sharing one endpoint, one key, one auth surface.
//
// The data-plane key is read out of band by `auto-secrets.bicep` via
// `listKeys()` and stamped into Key Vault as `azure-oai-key`. The worker
// pod consumes it via the SPC + worker-deployment envFrom mount.
//
// Per-region: a single Foundry account lives in this RG with a custom
// subdomain matching the resource name. All deployments are siblings; the
// base `model_providers.json` is rewritten at manifest-staging time to
// point each catalog provider at this one endpoint via the
// `__FOUNDRY_ENDPOINT__` placeholder.
//
// Deployments are operator-controlled: the deploy.mjs orchestrator threads
// a per-stamp JSON file (deploy/envs/local/<env>/foundry-deployments.json)
// in via `--parameters foundryDeployments=@<file>`. An empty array is
// valid (provisions an account with no deployments) so a stamp can opt
// into Foundry incrementally.
//
// Auth modes (`authMode` param): `entra` (default) runs the account with
// `disableLocalAuth: true`, grants the worker workload identity the
// Cognitive Services data-plane role, and writes a sentinel to
// `azure-oai-key`; the worker then mints an AAD bearer token (provider
// type `foundry-wif`). AAD token auth is not policy-gated, so entra works
// on every subscription and is required where the governing management
// group bans local/key auth (SFI Safe Secrets). `key` is the explicit
// opt-out for legacy stamps whose subscription permits key auth: it writes
// the account primary key to KV as `azure-oai-key` (back-compat with the
// existing pss* siblings). See docs/proposals/foundry-entra-mode-auth.md.
// Future: Foundry-hosted Claude (see docs/proposals/foundry-hosted-claude.md).
// ==============================================================================

@description('Azure region. Foundry resources are zonal-ish (data-plane lands in this region).')
param location string

@description('Foundry account name. Globally unique within Cognitive Services. Drives the customSubdomainName so the data-plane URL is `https://<name>.openai.azure.com` / `https://<name>.cognitiveservices.azure.com`.')
param accountName string

@description('SKU name. S0 is the only generally-available SKU for AIServices accounts; F0 is preview/free-tier and not supported for paid model deployments.')
@allowed([
  'S0'
])
param sku string = 'S0'

@description('Array of model deployments to provision under this account. Each entry: { name: <deployment-name>, model: { format: <vendor>, name: <model>, version: <version> }, sku: { name: <sku>, capacity: <int> } }. Loaded from a per-stamp JSON file by the deploy orchestrator. Empty array → no deployments (account-only provisioning).')
param deployments array = []

@description('Key Vault name. The Foundry account primary key is written here as `azure-oai-key`. Co-located with the account resource so listKeys() runs in the same template scope (avoids BCP422 / BCP426 around conditional secure-output indirection).')
param keyVaultName string

@description('Data-plane auth mode. `entra` (default) runs the account with `disableLocalAuth: true`, grants the worker workload identity the Cognitive Services data-plane role, and writes a sentinel placeholder to `azure-oai-key` so the stamp-invariant worker SPC mount still succeeds; the worker mints an AAD bearer token from its federated identity (provider type `foundry-wif`) instead of reading a key. AAD token auth is not policy-gated, so entra works on every subscription and is required where the governing management group bans local/key auth (e.g. SFI Safe Secrets). `key` is the explicit opt-out for legacy stamps whose subscription permits key auth: it writes the account primary key to KV as `azure-oai-key` (back-compat with the existing pss* siblings). See docs/proposals/foundry-entra-mode-auth.md.')
@allowed([
  'key'
  'entra'
])
param authMode string = 'entra'

@description('Principal (object) id of the worker workload identity (the CSI/federated UAMI). Granted `Cognitive Services OpenAI User` on this account in `entra` mode so the worker can call the data plane with an AAD token. Ignored in `key` mode; may be empty there.')
param workloadIdentityPrincipalId string = ''

// Cognitive Services OpenAI User — data-plane role that permits calling the
// inference endpoints (chat/completions) without reading account keys. Built-in
// role id, constant across tenants.
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

// KV sentinel placeholder for `azure-oai-key` in entra mode — the worker's
// sentinel-strip drops the env var at startup so the (now key-less) Foundry
// catalog provider is treated as unset on the key path. Kept in lock-step with
// deploy/scripts/lib/seed-secrets.mjs::SEED_SECRETS_UNSET_SENTINEL and
// auto-secrets-sentinel.bicep.
var keyVaultUnsetSentinel = '__PS_UNSET__'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: sku
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
    }
    // key mode → local/key auth on (Phase 1, back-compat). entra mode → off,
    // the account only accepts AAD bearer tokens (workload identity). The
    // governing management group denies accounts created with this false, so
    // entra mode is mandatory under SFI Safe Secrets.
    disableLocalAuth: authMode == 'entra'
  }
}

// One deployment per entry in `deployments`. Foundry-side concurrency-control
// for sibling deployments is handled by Azure (each deployment is a child
// resource). Keeping `dependsOn` implicit via the `parent` reference is
// sufficient.
@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for d in deployments: {
  parent: account
  name: d.name
  sku: {
    name: d.sku.name
    capacity: d.sku.capacity
  }
  properties: {
    model: {
      format: d.model.format
      name: d.model.name
      version: d.model.version
    }
  }
}]

// Foundry primary key → KV `azure-oai-key`. Written here (rather than in a
// downstream auto-secrets module) so listKeys() lives in the same scope
// as the resource declaration. Re-running this module after a portal-side
// rotation re-syncs the KV value.
//
// In entra mode the account has no usable local key (disableLocalAuth) and
// reading it would be pointless — so we write the `__PS_UNSET__` sentinel
// instead. The secret must still exist because the worker SPC mount is
// stamp-invariant and mounts `azure-oai-key` unconditionally. ARM's `if()`
// short-circuits, so `listKeys()` is never evaluated in entra mode.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource azureOaiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-oai-key'
  properties: {
    value: authMode == 'entra' ? keyVaultUnsetSentinel : account.listKeys().key1
    contentType: 'text/plain'
  }
}

// Grant the worker workload identity the data-plane role so it can call the
// inference endpoints with an AAD bearer token. Only in entra mode, and only
// when a principal id was supplied. The role assignment name is a stable GUID
// derived from (account, principal, role) so re-deploys are idempotent.
resource foundryDataPlaneRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (authMode == 'entra' && !empty(workloadIdentityPrincipalId)) {
  name: guid(account.id, workloadIdentityPrincipalId, cognitiveServicesOpenAiUserRoleId)
  scope: account
  properties: {
    principalId: workloadIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
    principalType: 'ServicePrincipal'
  }
}

output accountName string = account.name
output accountId string = account.id
// Canonical AI Foundry endpoint. The per-API path prefix (`/openai/v1`,
// `/anthropic/v1`, etc.) is appended at catalog-substitution time inside
// the worker base `model_providers.json`.
output endpoint string = account.properties.endpoint
