// ==============================================================================
// PilotSwarm BaseInfra — User-assigned managed identities.
//
// Four UAMIs are created here:
//   1. kubelet UAMI — bound to the AKS kubelet so pods can pull images from
//      ACR without an imagePullSecret (FR-004 / GitOps-friendly).
//   2. CSI SPC UAMI — used by the AKV Secrets Store CSI Provider to read
//      secrets out of Key Vault on behalf of the worker + portal pods
//      (FR-005). Federated identity credentials for the worker and portal
//      service accounts are materialised by `uami-federation.bicep` after
//      the AKS cluster's OIDC issuer URL is known.
//   4. AppGW PE approver UAMI — runs the Portal deployment script that
//      auto-approves the Front Door → AppGW Private Link connection
//      (`approve-private-endpoint.bicep`). RBAC (Network Contributor on the
//      AppGW) is wired in `appgw-pe-approval-rbac.bicep`. Created in
//      BaseInfra so the AppGW exists before the role assignment runs.
//   5. AppGW UAMI — attached to the Application Gateway resource itself.
//      Mirrors postgresql-fleet-manager's `appGatewayManagedIdName`. Exists
//      primarily so the AGIC addon identity can hold "Managed Identity
//      Operator" on it (required by AGIC docs to mutate AppGw config that
//      references a UAMI). Wired in `agic-rbac.bicep`.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix applied to every UAMI.')
param resourceNamePrefix string

var kubeletIdentityName = '${resourceNamePrefix}-kubelet-mid'
var csiIdentityName = '${resourceNamePrefix}-csi-mid'
var approverIdentityName = '${resourceNamePrefix}-pe-approver-mid'
var aksControlPlaneIdentityName = '${resourceNamePrefix}-aks-cp-mid'
// Application Gateway UAMI. Mirrors postgresql-fleet-manager's `appGatewayManagedIdName`
// pattern. Required so the AGIC addon can call `assignUserAssignedIdentity` on the
// AppGw (granted via the Managed Identity Operator role on this UAMI in
// `agic-rbac.bicep`). System-assigned / addon-only identities don't satisfy
// AGIC's role requirements per Microsoft AGIC docs.
var appGwIdentityName = '${resourceNamePrefix}-appgw-mid'

resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: kubeletIdentityName
  location: location
}

// AKS control-plane identity. Required to be UserAssigned (not SystemAssigned)
// because the cluster uses a custom kubelet identity (Azure constraint:
// CustomKubeletIdentityOnlySupportedOnUserAssignedMSICluster).
resource aksControlPlaneIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: aksControlPlaneIdentityName
  location: location
}

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: csiIdentityName
  location: location
}

resource approverIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: approverIdentityName
  location: location
}

resource appGwIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: appGwIdentityName
  location: location
}

output kubeletIdentityName string = kubeletIdentity.name
output kubeletIdentityResourceId string = kubeletIdentity.id
output kubeletIdentityPrincipalId string = kubeletIdentity.properties.principalId
output kubeletIdentityClientId string = kubeletIdentity.properties.clientId

output csiIdentityName string = csiIdentity.name
output csiIdentityResourceId string = csiIdentity.id
output csiIdentityPrincipalId string = csiIdentity.properties.principalId
output csiIdentityClientId string = csiIdentity.properties.clientId

output approverIdentityName string = approverIdentity.name
output approverIdentityResourceId string = approverIdentity.id
output approverIdentityPrincipalId string = approverIdentity.properties.principalId
output approverIdentityClientId string = approverIdentity.properties.clientId

output aksControlPlaneIdentityName string = aksControlPlaneIdentity.name
output aksControlPlaneIdentityResourceId string = aksControlPlaneIdentity.id
output aksControlPlaneIdentityPrincipalId string = aksControlPlaneIdentity.properties.principalId
output aksControlPlaneIdentityClientId string = aksControlPlaneIdentity.properties.clientId

output appGwIdentityName string = appGwIdentity.name
output appGwIdentityResourceId string = appGwIdentity.id
output appGwIdentityPrincipalId string = appGwIdentity.properties.principalId
output appGwIdentityClientId string = appGwIdentity.properties.clientId
