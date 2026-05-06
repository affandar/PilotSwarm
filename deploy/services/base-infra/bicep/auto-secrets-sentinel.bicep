// ==============================================================================
// PilotSwarm BaseInfra — Auto-populated Key Vault sentinels.
//
// Writes the SEED_SECRETS_UNSET_SENTINEL value to KV for any auto-populated
// secret whose source resource was NOT provisioned in this stamp. The worker
// SPC mounts these unconditionally, so every stamp must have the secret —
// the worker's sentinel-strip in packages/sdk/examples/worker.js drops the
// env var at startup, leaving the catalog provider treated as unset.
//
// Currently writes (only when Foundry is disabled):
//
//   • azure-oai-key — `__PS_UNSET__` placeholder. When foundryEnabled,
//     foundry.bicep writes the real key1 directly (co-located with the
//     account resource) so this module is conditionally skipped.
//
// Sentinel literal kept in lock-step with
// deploy/scripts/lib/seed-secrets.mjs::SEED_SECRETS_UNSET_SENTINEL.
// ==============================================================================

@description('Key Vault name. Caller (main.bicep) must already have granted CSI SPC UAMI Key Vault Secrets User on this vault.')
param keyVaultName string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource azureOaiKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-oai-key'
  properties: {
    value: '__PS_UNSET__'
    contentType: 'text/plain'
  }
}
