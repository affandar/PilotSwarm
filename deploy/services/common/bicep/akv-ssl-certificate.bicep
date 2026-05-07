// ==============================================================================
// AKV-managed SSL certificate (idempotent).
//
// Adapted from an internal reference deployment
// (https://github.com/.../src/Deploy/Common/bicep/ssl-certificate.bicep).
//
// Behaviour:
//   * If the cert already exists in Key Vault, the script is a no-op (so the
//     module is safe to re-run on every Portal deploy).
//   * Otherwise the script generates a default policy, stamps the
//     `CN=<certificateSubject>`, sets the issuer name (default `Self` for
//     OSS / dev — overridable to a CA registered via
//     `akv-certificate-issuer.bicep` for enterprise / production), and creates the
//     cert.
//
// The created cert is also exposed as a KV *secret* under the same name,
// which is what the Secrets Store CSI driver / SPC consumes (see
// `deploy/gitops/portal/base/secret-provider-class.yaml`, second
// SecretProviderClass `pilotswarm-portal-tls`).
// ==============================================================================

@description('Azure region used for the deployment script container.')
param location string

@description('AKV name that will own the certificate.')
param akvName string

@description('Certificate (and KV secret) name. Must match the SPC objectName for the portal TLS volume.')
param certificateName string

@description('Certificate subject (CN). Typically the portal hostname, e.g. <name>-<region>.<domainSuffix>.')
param certificateSubject string

@description('AKV issuer name. `Self` issues a self-signed cert (OSS / dev default). Override to a name registered via akv-certificate-issuer.bicep when running with a CA (enterprise).')
param issuerName string = 'Self'

@description('Resource id of the UAMI the deployment script runs as. Must hold Key Vault Certificates Officer on `akvName`.')
param scriptIdentityResourceId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: akvName
}

resource certScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  // Stable name (matches reference deployment pattern). The script
  // body is itself idempotent — `az keyvault certificate show` early-exits
  // when the cert already exists — so re-running the deployment is a
  // no-op rather than producing a fresh deploymentScript resource each
  // time. Do NOT append `utcNow()` here: that pollutes the resource
  // group with one orphaned script per deploy.
  name: '${certificateName}-creation'
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
      if az keyvault certificate show --vault-name "{0}" --name "{1}" > /dev/null 2>&1; then
        echo "Certificate ''{1}'' already exists in vault ''{0}''. Skipping creation."
        exit 0
      fi
      echo "Creating certificate ''{1}'' (subject CN={2}, issuer {3}) in vault ''{0}''..."
      policy=$(az keyvault certificate get-default-policy | jq '.x509CertificateProperties.subject = "CN={2}" | .issuerParameters.name = "{3}"')
      echo "$policy" > cert-policy.json
      az keyvault certificate create \
        --vault-name "{0}" \
        --name "{1}" \
        --policy "@cert-policy.json"
    ''', akvName, certificateName, certificateSubject, issuerName)
  }
  dependsOn: [
    keyVault
  ]
}

@description('KV secret URL that resolves to the created certificate (PEM-with-private-key by default for Self issuer).')
output certificateSecretUri string = 'https://${akvName}.vault.azure.net/secrets/${certificateName}'
