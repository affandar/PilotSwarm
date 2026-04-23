// ==============================================================================
// PilotSwarm BaseInfra — User-assigned managed identities.
//
// Two UAMIs are created here:
//   1. kubelet UAMI — bound to the AKS kubelet so pods can pull images from
//      ACR without an imagePullSecret (FR-004 / GitOps-friendly).
//   2. CSI SPC UAMI — used by the AKV Secrets Store CSI Provider to read
//      secrets out of Key Vault on behalf of the worker + portal pods
//      (FR-005). Federated identity credentials for the worker and portal
//      service accounts are materialised by `uami-federation.bicep` after
//      the AKS cluster's OIDC issuer URL is known.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix applied to both UAMIs.')
param resourceNamePrefix string

var kubeletIdentityName = '${resourceNamePrefix}-kubelet-mid'
var csiIdentityName = '${resourceNamePrefix}-csi-mid'

resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: kubeletIdentityName
  location: location
}

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: csiIdentityName
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
