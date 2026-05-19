// ==============================================================================
// Auto-Approve Private Endpoint Connection from Front Door to Application Gateway
// Runs as a deployment script after Front Door origin is created
// 
// Usage:
//   module ApprovePrivateEndpoint '../../common/bicep/approve-private-endpoint.bicep' = {
//     name: 'approve-pe-${dTime}'
//     scope: az.resourceGroup(applicationGatewayResourceGroup)
//     params: {
//       location: location
//       applicationGatewayName: applicationGatewayName
//       applicationGatewayResourceGroup: applicationGatewayResourceGroup
//       managedIdentityId: MyManagedIdentity.id
//       dTime: dTime
//     }
//     dependsOn: [
//       FrontDoorOriginRoute  // Ensure origin is created first
//     ]
//   }
//
// Prerequisites:
//   - The managed identity must have Network Contributor role on the Application Gateway
//   - Use appgw-pe-approval-rbac.bicep in BaseInfra to grant the required permissions
// ==============================================================================

@description('Azure region for the deployment script')
param location string

@description('Application Gateway name')
param applicationGatewayName string

@description('Application Gateway resource group')
param applicationGatewayResourceGroup string

@description('Managed identity resource ID for running the deployment script')
param managedIdentityId string

@description('Current timestamp for unique deployment naming')
param dTime string

@description('Optional: Filter by request message prefix to approve only specific connections')
param requestMessageFilter string = ''

// Deployment script to approve pending private endpoint connections
// Note: Deployment scripts are meant to run once per deployment, so unique naming is intentional
#disable-next-line use-stable-resource-identifiers
resource approvePrivateEndpoint 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'approve-pe-${applicationGatewayName}-${substring(uniqueString(dTime), 0, 6)}'
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    azCliVersion: '2.52.0'
    timeout: 'PT10M'
    retentionInterval: 'PT1H'
    cleanupPreference: 'OnSuccess'
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
        name: 'REQUEST_MESSAGE_FILTER'
        value: requestMessageFilter
      }
    ]
    scriptContent: '''
      #!/bin/bash
      set -e
      
      echo "=============================================="
      echo "Private Endpoint Connection Auto-Approval"
      echo "=============================================="
      echo "Application Gateway: $APP_GATEWAY_NAME"
      echo "Resource Group: $APP_GATEWAY_RG"
      echo "Request Message Filter: ${REQUEST_MESSAGE_FILTER:-'(none - approve all)'}"
      echo ""

      # Retry-wrapped `az network private-endpoint-connection list`. Ported
      # from waldemort c9e946c (PAW Review PR #7, SF-1 + IMPROVE-1): the
      # prior script swallowed `az` errors with `2>/dev/null || echo "[]"`,
      # masking auth / RBAC / RG failures as the legitimate "no pending
      # connections" case. We now surface stderr, keep the exit code, and
      # retry up to 3 times with exponential backoff (1s/2s/4s) so transient
      # RBAC propagation does not cause flaky deploys. On exhaustion we exit
      # non-zero so the bicep deployment fails loudly.
      list_pe_connections() {
        local attempts=3
        local backoffs=(1 2 4)
        local i=0
        local out=""
        while [ $i -lt $attempts ]; do
          if out=$(az network private-endpoint-connection list \
                    --name "$APP_GATEWAY_NAME" \
                    --resource-group "$APP_GATEWAY_RG" \
                    --type Microsoft.Network/applicationGateways \
                    -o json); then
            echo "$out"
            return 0
          fi
          if [ $i -lt $((attempts - 1)) ]; then
            echo "  [retry] PE-list attempt $((i + 1))/$attempts failed; sleeping ${backoffs[$i]}s..." >&2
            sleep "${backoffs[$i]}"
          fi
          i=$((i + 1))
        done
        echo "ERROR: az network private-endpoint-connection list failed after $attempts attempts (auth / RBAC propagation / RG missing). Aborting." >&2
        return 1
      }

      # Match-pending helper. Filters CONNECTIONS to status == "Pending".
      # The narrower discriminator (description == REQUEST_MESSAGE_FILTER) is
      # applied in the approval loop below. An earlier port added an
      # `EXPECTED_REQUESTER_RESOURCE_ID` substring filter on
      # privateEndpoint.id (MF-3, ported from waldemort c9e946c). It was
      # reverted in PR #31 follow-up: the only consumer in this repo is the
      # AFD wiring (single-purpose AppGw PLS), AFD-managed PE ids contain
      # no customer-side identifier, and any substring we could pass is
      # itself Microsoft-internal (e.g. `eafd-Prod-`) — i.e. no better than
      # the description filter we already apply, while adding deploy-time
      # fragility if Microsoft renames their managed namespace.
      filter_pending() {
        local conns="$1"
        echo "$conns" | jq '[.[] | select(.properties.privateLinkServiceConnectionState.status == "Pending")]'
      }

      # List all pending private endpoint connections
      echo "Checking for pending private endpoint connections..."
      CONNECTIONS=$(list_pe_connections)

      # Filter for pending connections
      PENDING_CONNECTIONS=$(filter_pending "$CONNECTIONS")
      CONNECTION_COUNT=$(echo "$PENDING_CONNECTIONS" | jq 'length')
      echo "Found $CONNECTION_COUNT pending connection(s)"

      if [ "$CONNECTION_COUNT" -eq 0 ] || [ "$CONNECTION_COUNT" = "null" ]; then
        echo "No pending connections to approve"
        # Write output as JSON
        cat > "$AZ_SCRIPTS_OUTPUT_PATH" << 'EOF'
{"approvedCount": 0, "connections": []}
EOF
        exit 0
      fi

      # Approve each pending connection
      APPROVED_COUNT=0
      APPROVED_CONNECTIONS="[]"
      
      # Process each connection
      echo "$PENDING_CONNECTIONS" | jq -c '.[]' | while read -r conn; do
        CONNECTION_ID=$(echo "$conn" | jq -r '.id')
        CONNECTION_NAME=$(echo "$conn" | jq -r '.name')
        REQUEST_MESSAGE=$(echo "$conn" | jq -r '.properties.privateLinkServiceConnectionState.description // ""')
        
        # Apply filter if specified
        if [ -n "$REQUEST_MESSAGE_FILTER" ]; then
          if [[ ! "$REQUEST_MESSAGE" == *"$REQUEST_MESSAGE_FILTER"* ]]; then
            echo "Skipping connection (filter mismatch): $CONNECTION_NAME"
            continue
          fi
        fi
        
        echo ""
        echo "Approving connection: $CONNECTION_NAME"
        echo "  Request message: $REQUEST_MESSAGE"
        
        az network private-endpoint-connection approve \
          --id "$CONNECTION_ID" \
          --description "Auto-approved by deployment script" \
          -o none
        
        echo "  ✓ Approved"
      done
      
      # Re-count approved (connections that are now Approved). Uses the
      # retry-wrapped lister.
      FINAL_CONNECTIONS=$(list_pe_connections)

      APPROVED_LIST=$(echo "$FINAL_CONNECTIONS" | jq '[.[] | select(.properties.privateLinkServiceConnectionState.status == "Approved") | .name]')
      APPROVED_COUNT=$(echo "$APPROVED_LIST" | jq 'length')
      
      echo ""
      echo "=============================================="
      echo "Summary: $APPROVED_COUNT approved connection(s)"
      echo "=============================================="
      
      # Output result for Bicep - write as proper JSON file
      cat > "$AZ_SCRIPTS_OUTPUT_PATH" << EOF
{"approvedCount": $APPROVED_COUNT, "connections": $APPROVED_LIST}
EOF
    '''
  }
}

@description('Number of private endpoint connections approved')
output approvedCount int = int(approvePrivateEndpoint.properties.outputs.approvedCount)

@description('Names of approved connections')
output approvedConnections array = approvePrivateEndpoint.properties.outputs.connections
