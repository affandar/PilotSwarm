// ==============================================================================
// PilotSwarm BaseInfra — RBAC for the AKV cert-script UAMI.
//
// The Portal Bicep runs `akv-ssl-certificate.bicep` (and optionally
// `akv-certificate-issuer.bicep`) as deployment scripts. Those scripts
// need permission to create / read certificates in the BaseInfra Key
// Vault. We grant the approver UAMI (already used for AppGW PE approval)
// the built-in `Key Vault Certificates Officer` role on the AKV — a single
// dedicated identity per BaseInfra keeps role-grant churn low and matches
// the postgresql-fleet-manager `infraDeployManagedIdName` pattern.
//
// Lives in BaseInfra (not Portal) because the AKV is created here and the
// role assignment must exist before Portal's deployment script runs.
// ==============================================================================

@description('Name of the BaseInfra Key Vault.')
param keyVaultName string

@description('Principal ID of the approver UAMI (BaseInfra Uami.outputs.approverIdentityPrincipalId).')
param approverPrincipalId string

// Built-in role: Key Vault Certificates Officer.
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#key-vault-certificates-officer
var kvCertificatesOfficerRoleId = 'a4417e6f-fecd-4de8-b567-7b0420556985'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvCertOfficerRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: keyVault
  name: kvCertificatesOfficerRoleId
}

resource assignKvCertOfficerToApprover 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, approverPrincipalId, kvCertificatesOfficerRoleId)
  scope: keyVault
  properties: {
    principalId: approverPrincipalId
    roleDefinitionId: kvCertOfficerRoleDef.id
    principalType: 'ServicePrincipal'
  }
}
