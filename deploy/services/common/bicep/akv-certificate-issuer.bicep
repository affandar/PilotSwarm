// ==============================================================================
// AKV certificate issuer registration (idempotent).
//
// Adapted from postgresql-fleet-manager `BaseInfra/bicep/akv-certificate-issuer.bicep`.
// Registers a named CA on a Key Vault so subsequent
// `akv-ssl-certificate.bicep` calls can issue certs against that CA instead
// of `Self`. Use this when running under EV2 with an internal CA (e.g.
// OneCertV2 / DigiCert). For OSS / dev the default `Self` issuer in
// `akv-ssl-certificate.bicep` is sufficient and this module is not needed.
// ==============================================================================

@description('Azure region used for the deployment script container.')
param location string

@description('Target AKV.')
param akvName string

@description('Issuer name to register on the AKV (e.g. `OneCertV2`, `digicert`).')
param issuerName string

@description('Provider id (e.g. `OneCertV2`, `DigiCert`).')
param provider string

@description('Resource id of the UAMI the deployment script runs as. Must hold Key Vault Certificates Officer on `akvName`.')
param scriptIdentityResourceId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: akvName
}

resource registerIssuer 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: '${issuerName}-issuer-script'
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentityResourceId}': {}
    }
  }
  properties: {
    azCliVersion: '2.53.0'
    timeout: 'PT10M'
    cleanupPreference: 'OnSuccess'
    retentionInterval: 'P1D'
    scriptContent: format('''
      set -e
      az keyvault certificate issuer create \
        --vault-name "{0}" \
        --issuer-name "{1}" \
        --provider "{2}"
    ''', akvName, issuerName, provider)
  }
  dependsOn: [
    keyVault
  ]
}
