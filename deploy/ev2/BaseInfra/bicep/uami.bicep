// ==============================================================================
// PilotSwarm BaseInfra — User-assigned managed identities.
//
// Three UAMIs are created here:
//   1. kubelet UAMI — bound to the AKS kubelet so pods can pull images from
//      ACR without an imagePullSecret (FR-004 / GitOps-friendly).
//   2. CSI SPC UAMI — used by the AKV Secrets Store CSI Provider to read
//      secrets out of Key Vault on behalf of the worker + portal pods
//      (FR-005). Federated identity credentials for the worker and portal
//      service accounts are materialised by `uami-federation.bicep` after
//      the AKS cluster's OIDC issuer URL is known.
//   3. EV2 deploy UAMI — attached to the ACI sandbox that EV2 spins up for
//      each shell-extension step (UploadContainer / DeployApplicationManifest).
//      Required because the ephemeral container's system-assigned identity
//      cannot be pre-granted roles on the target ACR / storage account. RBAC
//      is wired in `ev2-deploy-rbac.bicep` (AcrPush + Storage Blob Data
//      Contributor). Matches fleet-manager's ServiceFluxDeploy UAMI pattern.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix applied to every UAMI.')
param resourceNamePrefix string

var kubeletIdentityName = '${resourceNamePrefix}-kubelet-mid'
var csiIdentityName = '${resourceNamePrefix}-csi-mid'
var ev2DeployIdentityName = '${resourceNamePrefix}-ev2-deploy-mid'

resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: kubeletIdentityName
  location: location
}

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: csiIdentityName
  location: location
}

resource ev2DeployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: ev2DeployIdentityName
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

output ev2DeployIdentityName string = ev2DeployIdentity.name
output ev2DeployIdentityResourceId string = ev2DeployIdentity.id
output ev2DeployIdentityPrincipalId string = ev2DeployIdentity.properties.principalId
output ev2DeployIdentityClientId string = ev2DeployIdentity.properties.clientId
