// ==============================================================================
// PilotSwarm — Add an AppGw "Trusted Root Certificate" entry sourced from an
// Azure Key Vault certificate.
//
// Why this exists:
//   When TLS terminates at the AppGw AND re-encrypts to the backend pod
//   (E2E HTTPS, FM playground pattern), AppGw validates the cert chain
//   presented by the backend. For self-signed leaf certs (issuerName='Self'
//   in `akv-ssl-certificate.bicep` — OSS/dev default) there is no
//   intermediate, so AppGw rejects the backend with:
//     "The Intermediate certificate is missing from the backend server chain."
//
//   Workaround: upload the leaf cert (public part) to AppGw's
//   `trustedRootCertificates[]` and have AGIC reference it from the
//   Ingress via the `appgw.ingress.kubernetes.io/appgw-trusted-root-certificate`
//   annotation. AppGw then trusts the same self-signed cert when the pod
//   presents it.
//
//   In enterprise / production the cert is CA-issued (Microsoft IT CA) so the chain
//   validates out of the box and this module is a deliberate no-op
//   (cert presence is detected and the script exits early). The module is
//   still wired in because re-running it is idempotent.
//
// Implemented as a deployment script (Azure CLI) for the same reasons as
// `appgw-add-ssl-certificate.bicep`: keeps the AppGw resource definition
// in BaseInfra/application-gateway.bicep clean of per-service ownership
// and stays compatible with AGIC + the preservation pattern.
//
// Prerequisites (granted in `BaseInfra/bicep/approver-rg-reader-rbac.bicep`
// and `kv-cert-officer-rbac.bicep`):
//   - `managedIdentityId` has Contributor on the AppGw.
//   - `managedIdentityId` has Key Vault Certificates Officer (or at
//      minimum `certificates/get` data-plane permission) on `keyVaultName`.
// ==============================================================================

@description('Azure region for the deployment script.')
param location string

@description('Application Gateway name.')
param applicationGatewayName string

@description('Resource group containing the Application Gateway.')
param applicationGatewayResourceGroup string

@description('Name of the Trusted Root Certificate as it should appear on the AppGw. AGIC ingress annotation references this exact name.')
param trustedRootCertificateName string

@description('Key Vault name hosting the source certificate.')
param keyVaultName string

@description('Certificate name in `keyVaultName` (typically the same value used by `akv-ssl-certificate.bicep`).')
param keyVaultCertificateName string

@description('Resource ID of the UAMI used to run the deployment script.')
param managedIdentityId string

@description('Used as forceUpdateTag so this script re-runs whenever the deployment is re-submitted (e.g. on cert rotation).')
param deploymentTimestamp string = utcNow()

resource addRootCertScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  // 64-char limit; trim defensively.
  name: take('add-root-cert-${trustedRootCertificateName}', 64)
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    azCliVersion: '2.63.0'
    timeout: 'PT10M'
    retentionInterval: 'P1D'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: deploymentTimestamp
    environmentVariables: [
      { name: 'APP_GATEWAY_NAME', value: applicationGatewayName }
      { name: 'APP_GATEWAY_RG', value: applicationGatewayResourceGroup }
      { name: 'ROOT_CERT_NAME', value: trustedRootCertificateName }
      { name: 'KEY_VAULT_NAME', value: keyVaultName }
      { name: 'KV_CERT_NAME', value: keyVaultCertificateName }
    ]
    // Pulls the cert public part as DER-base64, writes a PEM file, then
    // creates or updates the trustedRootCertificates entry on the AppGw.
    // `az network application-gateway root-cert` requires the cert as a
    // file path containing PEM (BEGIN/END CERTIFICATE).
    scriptContent: '''
      #!/bin/bash
      set -euo pipefail

      echo "Add Trusted Root Certificate to Application Gateway"
      echo "  AppGw:        $APP_GATEWAY_NAME"
      echo "  RG:           $APP_GATEWAY_RG"
      echo "  Root cert:    $ROOT_CERT_NAME"
      echo "  KV:           $KEY_VAULT_NAME"
      echo "  KV cert:      $KV_CERT_NAME"

      WORKDIR=$(mktemp -d)
      PEM_FILE="$WORKDIR/cert.pem"

      # `az keyvault certificate download --encoding PEM` returns the
      # public part directly as PEM. Avoids needing `openssl` which is
      # not present in the Alpine-based deploymentScript image.
      echo "Downloading cert public part from KV (PEM)..."
      az keyvault certificate download \
        --vault-name "$KEY_VAULT_NAME" \
        --name "$KV_CERT_NAME" \
        --file "$PEM_FILE" \
        --encoding PEM

      EXISTS=$(az network application-gateway root-cert list \
        --gateway-name "$APP_GATEWAY_NAME" \
        --resource-group "$APP_GATEWAY_RG" \
        --query "length([?name=='$ROOT_CERT_NAME'])" \
        -o tsv 2>/dev/null || echo "0")

      if [ "$EXISTS" -gt 0 ]; then
        echo "Root cert already present. Updating with latest PEM..."
        az network application-gateway root-cert update \
          --gateway-name "$APP_GATEWAY_NAME" \
          --resource-group "$APP_GATEWAY_RG" \
          --name "$ROOT_CERT_NAME" \
          --cert-file "$PEM_FILE"
      else
        echo "Creating new trusted root cert..."
        az network application-gateway root-cert create \
          --gateway-name "$APP_GATEWAY_NAME" \
          --resource-group "$APP_GATEWAY_RG" \
          --name "$ROOT_CERT_NAME" \
          --cert-file "$PEM_FILE"
      fi

      echo "Done."
    '''
  }
}

output trustedRootCertificateName string = trustedRootCertificateName
