// ==============================================================================
// PilotSwarm BaseInfra — Federated identity credentials for workload identity.
//
// Attaches two federated credentials to the CSI SPC UAMI so the
// copilot-runtime-worker and pilotswarm-portal Kubernetes service
// accounts can exchange their projected SA tokens for Azure AD tokens.
//
// Invoked after `aks.bicep` because the OIDC issuer URL is read from the
// cluster output.
// ==============================================================================

@description('Name of the CSI SPC user-assigned managed identity (parent of the federated credentials).')
param csiIdentityName string

@description('AKS cluster OIDC issuer URL (from aks.bicep output).')
param oidcIssuerUrl string

@description('Kubernetes namespace hosting both service accounts.')
param serviceAccountNamespace string = 'copilot-runtime'

@description('Worker service account name.')
param workerServiceAccountName string = 'copilot-runtime-worker'

@description('Portal service account name.')
param portalServiceAccountName string = 'pilotswarm-portal'

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: csiIdentityName
}

resource workerFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: csiIdentity
  name: 'worker-fedcred'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${workerServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource portalFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: csiIdentity
  name: 'portal-fedcred'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${portalServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
  dependsOn: [
    workerFederation
  ]
}
