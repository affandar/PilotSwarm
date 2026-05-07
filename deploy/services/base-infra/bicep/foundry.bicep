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
// Phase 1 scope: API-key auth (`disableLocalAuth: false`). Future
// proposals: Entra-mode (workload-identity → AAD token; see
// docs/proposals/foundry-entra-mode-auth.md) and Foundry-hosted Claude
// (see docs/proposals/foundry-hosted-claude.md).
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
    // Phase 1: key-auth flow. The Entra-mode proposal flips this to true
    // once the SDK has a token-provider codepath
    // (docs/proposals/foundry-entra-mode-auth.md).
    disableLocalAuth: false
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
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource azureOaiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-oai-key'
  properties: {
    value: account.listKeys().key1
    contentType: 'text/plain'
  }
}

output accountName string = account.name
output accountId string = account.id
// Canonical AI Foundry endpoint. The per-API path prefix (`/openai/v1`,
// `/anthropic/v1`, etc.) is appended at catalog-substitution time inside
// the worker base `model_providers.json`.
output endpoint string = account.properties.endpoint
