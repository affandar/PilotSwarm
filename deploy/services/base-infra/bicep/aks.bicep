// ==============================================================================
// PilotSwarm BaseInfra — AKS cluster.
//
// Cluster features:
//   - `microsoft.flux` extension (installed as a separate module, since
//     cluster extensions are child resources of the cluster).
//   - `azureKeyvaultSecretsProvider` addon (FR-005) so SecretProviderClass
//     manifests can pull secrets out of the Phase-3 Key Vault.
//   - Application Gateway Ingress Controller (AGIC) addon bound to the
//     WAF_v2 AppGW provisioned in `application-gateway.bicep`.
//   - Workload identity + OIDC issuer enabled so the CSI SPC UAMI's
//     federated credentials work for the worker and portal service
//     accounts.
//   - Kubelet identity is a user-assigned MI (input) so ACR pulls work
//     without an imagePullSecret (FR-004).
//
// Cluster control-plane identity: SystemAssigned for simplicity. The
// cluster's system-assigned MI needs `Managed Identity Operator` on the
// kubelet UAMI; that role assignment is emitted by this module below.
// ==============================================================================

@description('Azure region.')
param location string

@description('AKS cluster name.')
param clusterName string

@description('Kubernetes version.')
param kubernetesVersion string = '1.34'

@description('AKS node subnet ID.')
param aksSubnetId string

@description('Edge topology mode. afd = enable the ingressApplicationGateway (AGIC) addon bound to applicationGatewayId. private = enable the webAppRouting (NGINX) addon instead and ignore applicationGatewayId. The post-deploy step (deploy.mjs) patches the addon-created NginxIngressController CR to expose the LoadBalancer Service as internal-only.')
@allowed([
  'afd'
  'private'
])
param edgeMode string = 'afd'

@description('Resource ID of the Application Gateway used by the AGIC addon. Required when edgeMode=afd; ignored when edgeMode=private.')
param applicationGatewayId string = ''

@description('Resource ID of the Log Analytics workspace for the omsAgent (Container Insights) addon. The addon ships pod/node/event telemetry to this workspace using the modern AAD-auth path; the per-cluster Data Collection Rule (see aks-container-insights-dcr.bicep) selects ContainerLogV2.')
param logAnalyticsWorkspaceResourceId string

@description('Resource ID of the pre-created kubelet UAMI.')
param kubeletIdentityResourceId string

@description('Client ID of the kubelet UAMI.')
param kubeletIdentityClientId string

@description('Principal (object) ID of the kubelet UAMI.')
param kubeletIdentityPrincipalId string

@description('Resource ID of the AKS control-plane UAMI.')
param aksControlPlaneIdentityResourceId string

@description('Principal (object) ID of the AKS control-plane UAMI. Used for the Managed Identity Operator role assignment on the kubelet UAMI.')
param aksControlPlaneIdentityPrincipalId string

@description('System node pool VM size.')
param systemPoolVmSize string = 'Standard_D2ds_v5'

@description('User node pool VM size.')
param userPoolVmSize string = 'Standard_D4ds_v5'

@description('User node pool initial node count.')
param userPoolCount int = 2

@description('Availability zones. Empty array disables zone placement (useful for dev in zone-limited regions).')
param availabilityZones array = []

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' = {
  name: clusterName
  location: location
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${aksControlPlaneIdentityResourceId}': {}
    }
  }
  properties: {
    enableRBAC: true
    dnsPrefix: clusterName
    nodeResourceGroup: '${clusterName}-nodes'
    kubernetesVersion: kubernetesVersion
    identityProfile: {
      kubeletidentity: {
        resourceId: kubeletIdentityResourceId
        clientId: kubeletIdentityClientId
        objectId: kubeletIdentityPrincipalId
      }
    }
    agentPoolProfiles: [
      {
        name: 'systempool'
        mode: 'System'
        count: 1
        minCount: 1
        maxCount: 5
        enableAutoScaling: true
        vmSize: systemPoolVmSize
        osType: 'Linux'
        osSKU: 'AzureLinux'
        osDiskSizeGB: 60
        osDiskType: 'Ephemeral'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: aksSubnetId
        availabilityZones: availabilityZones
        nodeTaints: [
          'CriticalAddonsOnly=true:NoSchedule'
        ]
      }
      {
        name: 'userpool'
        mode: 'User'
        count: userPoolCount
        minCount: 1
        maxCount: 10
        enableAutoScaling: true
        vmSize: userPoolVmSize
        osType: 'Linux'
        osSKU: 'AzureLinux'
        osDiskSizeGB: 128
        osDiskType: 'Ephemeral'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: aksSubnetId
        availabilityZones: availabilityZones
      }
    ]
    addonProfiles: edgeMode == 'afd' ? {
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '30m'
        }
      }
      ingressApplicationGateway: {
        enabled: true
        config: {
          applicationGatewayId: applicationGatewayId
        }
      }
      omsAgent: {
        enabled: true
        config: {
          useAADAuth: 'true'
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceResourceId
        }
      }
    } : {
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '30m'
        }
      }
      // AKS managed NGINX ingress controller. The addon stands up a default
      // NginxIngressController CR that creates a LoadBalancer Service in
      // the addon's namespace (app-routing-system). To make the LB
      // private, deploy.mjs runs a post-deploy `kubectl patch` that adds
      // `service.beta.kubernetes.io/azure-load-balancer-internal: "true"`
      // to the addon's Service via the CR's `loadBalancerAnnotations`
      // field. We don't bake that into bicep because the CR isn't
      // declared as a bicep resource — it's reconciled by the addon
      // operator after the cluster is up.
      webAppRouting: {
        enabled: true
      }
      omsAgent: {
        enabled: true
        config: {
          useAADAuth: 'true'
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceResourceId
        }
      }
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'calico'
      dnsServiceIP: '10.0.0.10'
      serviceCidrs: [
        '10.0.0.0/16'
      ]
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
    }
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
    oidcIssuerProfile: {
      enabled: true
    }
    apiServerAccessProfile: {
      enablePrivateCluster: false
    }
  }
}

// ---------------------------------------------------------------------------
// Managed Identity Operator: the cluster control-plane UAMI must be able
// to operate the kubelet UAMI (read/use it as the kubelet identity).
// With UserAssigned cluster identity, aks.identity.principalId is null, so
// we assign the role to the control-plane UAMI's principal directly.
// ---------------------------------------------------------------------------
var managedIdentityOperatorRoleId = 'f1a07417-d97a-45cb-824c-7a7467783830'

resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(kubeletIdentityResourceId, '/'))
}

resource miOperatorDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: kubeletIdentity
  name: managedIdentityOperatorRoleId
}

resource assignMiOperatorToCluster 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kubeletIdentity.id, aksControlPlaneIdentityResourceId, managedIdentityOperatorRoleId)
  scope: kubeletIdentity
  properties: {
    principalId: aksControlPlaneIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: miOperatorDef.id
  }
}

// ---------------------------------------------------------------------------
// Flux extension. Uses the kubelet identity for Azure Blob authentication,
// matching the approach in the reference deployment (the Flux Azure Blob
// source controller does not yet support workload identity).
// ---------------------------------------------------------------------------
resource fluxExtension 'Microsoft.KubernetesConfiguration/extensions@2023-05-01' = {
  scope: aks
  name: 'flux'
  properties: {
    extensionType: 'microsoft.flux'
    autoUpgradeMinorVersion: true
    configurationSettings: {
      useKubeletIdentity: 'true'
    }
    scope: {
      cluster: {
        releaseNamespace: 'flux-system'
      }
    }
  }
}

output aksClusterId string = aks.id
output aksClusterName string = aks.name
output aksControlPlanePrincipalId string = aksControlPlaneIdentityPrincipalId
output oidcIssuerUrl string = aks.properties.oidcIssuerProfile.issuerURL
output nodeResourceGroup string = aks.properties.nodeResourceGroup

// AGIC addon's auto-created managed identity. The AKS RP names it deterministically
// `ingressapplicationgateway-<clusterName>` in the cluster's node resource group.
// Consumed by `agic-rbac.bicep` to grant Contributor/MI-Operator/Network-Contributor.
// In private mode (webAppRouting addon) this identity does not exist and the
// emitted name is unused — agic-rbac is itself skipped at the main.bicep layer.
output agicAddonIdentityName string = 'ingressapplicationgateway-${aks.name}'
