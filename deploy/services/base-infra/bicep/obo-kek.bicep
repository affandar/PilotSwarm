// ==============================================================================
// PilotSwarm BaseInfra — OBO Key Encryption Key (KEK).
//
// Single-responsibility module: provisions the AKV key + role assignments
// used by the User OBO Propagation feature. Caller is responsible for
// gating instantiation behind `oboEnabled` — this module always emits the
// key + role assignments when instantiated.
//
// The key is used by the worker's `AkvEnvelopeCrypto`
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

@description('Name of the existing Key Vault to provision the OBO KEK into. The vault must already exist (typically created by keyvault.bicep in the same deployment).')
param keyVaultName string

@description('Name of the OBO KEK to provision. Default matches the canonical name agreed with downstream consumers: `obo-user-token-kek`.')
param oboKekName string = 'obo-user-token-kek'

@description('Array of AAD principal IDs (UAMI principalIds) that need wrapKey/unwrapKey on the OBO KEK. PilotSwarm reference deploy passes the single shared CSI UAMI principalId (both worker and portal pods federate against it). Downstream consumers that use a different UAMI topology can pass an array of distinct principalIds — one role assignment is emitted per element.')
param oboKekUamiPrincipalIds array = []

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

var kvCryptoUserRoleId = '12338af0-0e69-4776-bea7-57ae8d297424'

resource kvCryptoUserDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: keyVault
  name: kvCryptoUserRoleId
}

resource oboKek 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
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

resource assignKvCryptoUserToOboConsumers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in oboKekUamiPrincipalIds: {
  name: guid(keyVault.id, principalId, kvCryptoUserRoleId, 'obo-kek')
  scope: keyVault
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: kvCryptoUserDef.id
  }
}]

@description('Un-versioned key URL for the OBO KEK (e.g., https://<vault>.vault.azure.net/keys/obo-user-token-kek). Captured by the OSS deploy orchestrator (deploy-bicep.mjs OUTPUT_ALIAS) into env key OBO_KEK_KID. Consumers pin a specific version at decrypt time via the ciphertext envelope `kekKid` field rather than via this env var.')
output oboKekKid string = '${keyVault.properties.vaultUri}keys/${oboKekName}'
