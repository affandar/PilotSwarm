// ==============================================================================
// PilotSwarm — Add an SSL certificate to an existing Application Gateway from
// an Azure Key Vault secret reference.
//
// Used when TLS terminates at the AppGw (instead of inside the Pod). Adapted
// verbatim from an internal reference deployment.
//
// Implemented as a deployment script (not a Bicep `sslCertificates` array
// entry) because:
//   1. The AppGw resource definition is owned by `BaseInfra/bicep/application-gateway.bicep`,
//      and adding entries there during a per-service deploy would create a
//      cross-deployment ownership conflict with AGIC + the preservation
//      pattern.
//   2. `az network application-gateway ssl-cert create/update` is body-idempotent,
//      so successive deploys with the same KV reference are a no-op.
//
// Prerequisites:
//   - The `managedIdentityId` must have Contributor on the AppGw.
//   - The AppGw's own UAMI must have Key Vault Secrets User on the AKV
//     hosting the cert (so the AppGw control plane can pull the secret).
//   - The cert must already exist as a secret in AKV.
// ==============================================================================

@description('Azure region for the deployment script.')
param location string

@description('Application Gateway name.')
param applicationGatewayName string

@description('Resource group containing the Application Gateway.')
param applicationGatewayResourceGroup string

@description('Name of the SSL certificate as it should appear on the AppGw.')
param certificateName string

@description('AKV secret URI for the certificate (e.g. https://myvault.vault.azure.net/secrets/my-tls-cert).')
#disable-next-line secure-secrets-in-params
param keyVaultSecretId string

@description('Resource ID of the UAMI used to run the deployment script (needs Contributor on the AppGw).')
param managedIdentityId string

@description('Used as forceUpdateTag so this script re-runs whenever the deployment is re-submitted.')
param deploymentTimestamp string = utcNow()

resource addSslCertScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: take('add-ssl-cert-${certificateName}', 64)
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
      {
        name: 'APP_GATEWAY_NAME'
        value: applicationGatewayName
      }
      {
        name: 'APP_GATEWAY_RG'
        value: applicationGatewayResourceGroup
      }
      {
        name: 'CERT_NAME'
        value: certificateName
      }
      {
        name: 'KEY_VAULT_SECRET_ID'
        value: keyVaultSecretId
      }
    ]
    scriptContent: '''
      #!/bin/bash
      set -e

      echo "Add SSL Certificate to Application Gateway"
      echo "  AppGw:    $APP_GATEWAY_NAME"
      echo "  RG:       $APP_GATEWAY_RG"
      echo "  Cert:     $CERT_NAME"
      echo "  KV ref:   $KEY_VAULT_SECRET_ID"

      CERT_COUNT=$(az network application-gateway ssl-cert list \
        --gateway-name "$APP_GATEWAY_NAME" \
        --resource-group "$APP_GATEWAY_RG" \
        --query "length([?name=='$CERT_NAME'])" \
        -o tsv 2>/dev/null || echo "0")

      if [ "$CERT_COUNT" -gt 0 ]; then
        CURRENT_SECRET_ID=$(az network application-gateway ssl-cert show \
          --gateway-name "$APP_GATEWAY_NAME" \
          --resource-group "$APP_GATEWAY_RG" \
          --name "$CERT_NAME" \
          --query "keyVaultSecretId" \
          -o tsv 2>/dev/null || echo "")
        if [ "$CURRENT_SECRET_ID" == "$KEY_VAULT_SECRET_ID" ]; then
          echo "Cert already references the expected KV secret. Nothing to do."
        else
          echo "Updating cert KV reference..."
          az network application-gateway ssl-cert update \
            --gateway-name "$APP_GATEWAY_NAME" \
            --resource-group "$APP_GATEWAY_RG" \
            --name "$CERT_NAME" \
            --key-vault-secret-id "$KEY_VAULT_SECRET_ID"
          echo "Cert KV reference updated."
        fi
      else
        echo "Adding new cert..."
        az network application-gateway ssl-cert create \
          --gateway-name "$APP_GATEWAY_NAME" \
          --resource-group "$APP_GATEWAY_RG" \
          --name "$CERT_NAME" \
          --key-vault-secret-id "$KEY_VAULT_SECRET_ID"
        echo "Cert added."
      fi
    '''
  }
}

output certificateName string = certificateName
