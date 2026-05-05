// ==============================================================================
// PilotSwarm BaseInfra — AppGw existence probe.
//
// Runs a deployment script that calls `az network application-gateway show`
// against the parent RG. Outputs a `bool exists` consumed by
// `application-gateway.bicep` to drive the AGIC config-preservation
// ternary (defaults on first deploy, existing values on subsequent deploys).
//
// Mirrors postgresql-fleet-manager `check-appgw-exists.bicep`. We use the
// shared `approverIdentity` UAMI (already present in BaseInfra) granted
// Reader on the RG by `approver-rg-reader-rbac.bicep`.
// ==============================================================================

@description('Azure region for the deployment script.')
param location string

@description('Application Gateway name to probe.')
param applicationGatewayName string

@description('Resource ID of the UAMI used by the deployment script (must hold Reader on the parent RG).')
param userAssignedIdentityId string

@description('Used as forceUpdateTag so the existence check re-runs every deployment.')
param deploymentTimestamp string = utcNow()

resource checkAppGwExists 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: take('check-${applicationGatewayName}-exists', 64)
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    azCliVersion: '2.63.0'
    retentionInterval: 'P1D'
    timeout: 'PT5M'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: deploymentTimestamp
    arguments: '\'${applicationGatewayName}\' \'${resourceGroup().name}\''
    scriptContent: '''
      set -e

      APP_GW_NAME=$1
      RG_NAME=$2

      set +e
      OUTPUT=$(az network application-gateway show --name "$APP_GW_NAME" --resource-group "$RG_NAME" --query id -o tsv 2>&1)
      EXIT_CODE=$?
      set -e

      if [ $EXIT_CODE -eq 0 ]; then
        echo '{"exists": true}' > "$AZ_SCRIPTS_OUTPUT_PATH"
      elif echo "$OUTPUT" | grep -qi "ResourceNotFound\|could not be found\|was not found"; then
        echo '{"exists": false}' > "$AZ_SCRIPTS_OUTPUT_PATH"
      else
        echo "ERROR: Unexpected failure checking Application Gateway existence:" >&2
        echo "$OUTPUT" >&2
        exit 1
      fi
    '''
  }
}

@description('True if the Application Gateway already exists in the resource group.')
output exists bool = checkAppGwExists.properties.outputs.exists
