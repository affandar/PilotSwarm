// ==============================================================================
// PilotSwarm BaseInfra — Azure Key Vault.
//
// Stores the 14 worker + 10 portal secrets populated out-of-band by
// `scripts/deploy-aks.sh` (or by a separate enterprise orchestration step in production).
// The CSI SPC UAMI is granted `Key Vault Secrets User` so the AKV CSI
// provider addon can project those secrets into pods.
// ==============================================================================

@description('Azure region.')
param location string

@description('Key Vault name (globally unique, 3-24 chars).')
param keyVaultName string

@description('AAD tenant ID for the vault.')
param tenantId string = subscription().tenantId

@description('Principal ID of the CSI SPC UAMI that needs Key Vault Secrets User.')
param csiPrincipalId string

@description('Optional principal ID of the App Gateway UAMI. When set, granted Key Vault Secrets User so the AppGw control plane can pull TLS certs (KV-referenced sslCertificates).')
param appGwPrincipalId string = ''

@description('Optional principal ID for the human/local-deploy identity that should receive Key Vault Secrets Officer on this vault. When empty (the enterprise production path), no extra role assignment is created. Local `npm run deploy` populates this with the signed-in AAD user so the new `seed-secrets` step can `az keyvault secret set` without a separate manual role grant.')
param localDeploymentPrincipalId string = ''

@description('Principal type for localDeploymentPrincipalId. Defaults to User; set to ServicePrincipal or Group to match the principal kind.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param localDeploymentPrincipalType string = 'User'

@description('When true, provision an additional AKV key used as the OBO Key Encryption Key (KEK) for envelope-encrypting per-RPC user access tokens carried portal→worker (User OBO Propagation feature). Defaults to false; opt-in per environment via the OBO_ENABLED env var → base-infra params template. When false, no key is created and no crypto role assignments are made — strictly backwards-compatible for environments not using user OBO.')
param oboEnabled bool = false

@description('Name of the OBO KEK to provision when oboEnabled=true. Default matches the canonical name agreed with downstream consumers (microsoft/waldemort): `obo-user-token-kek`.')
param oboKekName string = 'obo-user-token-kek'

@description('Array of AAD principal IDs (UAMI principalIds) that need wrapKey/unwrapKey on the OBO KEK. PilotSwarm reference deploy passes the single shared CSI UAMI principalId (both worker and portal pods federate against it). Downstream consumers that use a different UAMI topology can pass an array of distinct principalIds — one role assignment is emitted per element. Ignored when oboEnabled=false.')
param oboKekUamiPrincipalIds array = []

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvSecretsUserDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: keyVault
  name: kvSecretsUserRoleId
}

resource assignKvSecretsUserToCsi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, csiPrincipalId, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: csiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: kvSecretsUserDef.id
  }
}

// Grant the App Gateway UAMI Key Vault Secrets User so AppGw control plane
// can pull the TLS cert when an sslCertificate references a KV secret URI
// (FM `appgw-add-ssl-certificate.bicep` pattern).
resource assignKvSecretsUserToAppGw 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(appGwPrincipalId)) {
  name: guid(keyVault.id, appGwPrincipalId, kvSecretsUserRoleId, 'appgw')
  scope: keyVault
  properties: {
    principalId: appGwPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: kvSecretsUserDef.id
  }
}

// Optional Key Vault Secrets Officer on the vault for the local-deploy
// principal. Skipped when localDeploymentPrincipalId is empty (the enterprise path
// production path). When set, this gives the running user data-plane
// write access to the vault at creation time so the new `seed-secrets`
// step in deploy.mjs can populate the human-only secrets (github-token,
// anthropic-api-key, etc.) without a separate manual role grant.
//
// Mirrors the storage.bicep `localDeploymentPrincipalId` pattern.
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource kvSecretsOfficerDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: keyVault
  name: kvSecretsOfficerRoleId
}

resource assignKvSecretsOfficerToLocalDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(localDeploymentPrincipalId)) {
  name: guid(keyVault.id, localDeploymentPrincipalId, kvSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    principalId: localDeploymentPrincipalId
    principalType: localDeploymentPrincipalType
    roleDefinitionId: kvSecretsOfficerDef.id
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri

// ==============================================================================
// OBO KEK (User OBO Propagation, conditional on oboEnabled).
//
// Provisions the AKV key used by the worker's `AkvEnvelopeCrypto`
// (packages/sdk/src/envelope-crypto.ts) to envelope-decrypt per-RPC user
// access tokens forwarded by the portal. RSA-2048, wrapKey + unwrapKey
// ops only (no sign/verify/encrypt/decrypt). 365-day automatic rotation
// with prior versions retained so any in-flight ciphertext referencing an
// older version remains decryptable across rotation events.
//
// One Microsoft.Authorization/roleAssignments resource is emitted per
// principalId in `oboKekUamiPrincipalIds`. PilotSwarm reference deploy
// passes a 1-element array containing the shared CSI UAMI principalId.
// Downstream consumers that use distinct UAMIs for portal vs worker pass
// a 2-element array; the loop collapses or expands accordingly without
// any template fork.
//
// `OBO_KEK_KID` (the un-versioned key URL) is captured by the OSS deploy
// orchestrator via the `oboKekKid` output below; consumers pin a specific
// version at decrypt time via the ciphertext envelope's `kekKid` field
// rather than via the env var.
// ==============================================================================

var kvCryptoUserRoleId = '12338af0-0e69-4776-bea7-57ae8d297424'

resource kvCryptoUserDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = if (oboEnabled) {
  scope: keyVault
  name: kvCryptoUserRoleId
}

resource oboKek 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (oboEnabled) {
  parent: keyVault
  name: oboKekName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'wrapKey'
      'unwrapKey'
    ]
    rotationPolicy: {
      lifetimeActions: [
        {
          trigger: {
            timeAfterCreate: 'P365D'
          }
          action: {
            type: 'Rotate'
          }
        }
        {
          trigger: {
            timeBeforeExpiry: 'P30D'
          }
          action: {
            type: 'Notify'
          }
        }
      ]
      attributes: {
        expiryTime: 'P730D'
      }
    }
  }
}

resource assignKvCryptoUserToOboConsumers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in oboKekUamiPrincipalIds: if (oboEnabled) {
  name: guid(keyVault.id, principalId, kvCryptoUserRoleId, 'obo-kek')
  scope: keyVault
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: kvCryptoUserDef.id
  }
}]

@description('Un-versioned key URL for the OBO KEK (e.g., https://<vault>.vault.azure.net/keys/obo-user-token-kek). Emits the substitute-env sentinel (`__PS_UNSET__`) when oboEnabled=false so the overlay .env substitution stays satisfied without the operator needing to set OBO_KEK_KID by hand. Worker / portal runtime strips the sentinel from process.env at startup, so the application sees the key as truly unset and the existing principal-only envelope path engages. When oboEnabled=true, the un-versioned URL is captured and pinned to a specific version per-envelope via the ciphertext `kekKid` field.')
output oboKekKid string = oboEnabled ? '${keyVault.properties.vaultUri}keys/${oboKekName}' : '__PS_UNSET__'
