// ==============================================================================
// Auto-Approve Private Endpoint Connection from Front Door to Application Gateway
// Runs as a deployment script after Front Door origin is created
// 
// Usage:
//   module ApprovePrivateEndpoint '../../Common/bicep/approve-private-endpoint.bicep' = {
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
      
      # List all pending private endpoint connections
      echo "Checking for pending private endpoint connections..."
      CONNECTIONS=$(az network private-endpoint-connection list \
        --name "$APP_GATEWAY_NAME" \
        --resource-group "$APP_GATEWAY_RG" \
        --type Microsoft.Network/applicationGateways \
        -o json 2>/dev/null || echo "[]")
      
      # Filter for pending connections
      PENDING_CONNECTIONS=$(echo "$CONNECTIONS" | jq '[.[] | select(.properties.privateLinkServiceConnectionState.status == "Pending")]')
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
      
      # Re-count approved (connections that are now Approved)
      FINAL_CONNECTIONS=$(az network private-endpoint-connection list \
        --name "$APP_GATEWAY_NAME" \
        --resource-group "$APP_GATEWAY_RG" \
        --type Microsoft.Network/applicationGateways \
        -o json 2>/dev/null || echo "[]")
      
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
