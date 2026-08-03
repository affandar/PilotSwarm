# PilotSwarm AKS Topology

This describes the **shape** of a PilotSwarm AKS deployment, not the identity of
any particular one. This repo is public, so no subscription, tenant, resource,
host, or IP names are recorded here.

## Placeholders

Every `<placeholder>` below resolves from `.env.remote` (gitignored) or from the
live resources. The deploy scripts read the same variables, so what you put in
`.env.remote` is the single source of truth.

| Placeholder | `.env.remote` variable | Otherwise resolve with |
|---|---|---|
| `<subscription>` | `AZURE_SUBSCRIPTION_ID` | `az account list -o table` |
| `<resource-group>` | — | `az group list -o table` |
| `<region>` | — | `az group show -n <resource-group> --query location -o tsv` |
| `<cluster>` | `K8S_CONTEXT` | `az aks list -o table` |
| `<acr>` | `ACR_NAME` | `az acr list -o table` |
| `<pg-server>` | host inside `DATABASE_URL` | `az postgres flexible-server list -o table` |
| `<storage-account>` | inside `AZURE_STORAGE_CONNECTION_STRING` | `az storage account list -o table` |
| `<portal-host>` | — | `kubectl get ingress -n copilot-runtime -o wide` |
| `<namespace>` | `K8S_NAMESPACE` | — |

## Subscription & Resource Group

| Field | Value |
|-------|-------|
| Subscription | `<subscription>` |
| Resource Group | `<resource-group>` |
| Location | `<region>` |
| AKS Managed RG | `MC_<resource-group>_<cluster>_<region>` (auto-managed) |

## Resources

| Resource | Name | SKU / Config |
|----------|------|-------------|
| VNet | `<prefix>-vnet` | Address space: `10.16.0.0/12` |
| NSG | `<prefix>-nsg` | Attached to `aks-subnet` |
| AKS | `<cluster>` | K8s 1.33, Azure CNI, Standard tier |
| ACR | `<acr>` | Basic, admin enabled (for pull secret) |
| Postgres Flex | `<pg-server>` | v17, `Standard_D2ads_v5`, 64 GB |
| Storage | `<storage-account>` | StorageV2, Standard_LRS |
| Blob Container | `copilot-sessions` | Session dehydration blobs |

## Network Topology

```
                    ┌─────────────────────────────────────────────┐
                    │  Subscription: <subscription>                │
                    │  Resource Group: <resource-group>            │
                    └─────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  <prefix>-vnet  (10.16.0.0/12)                                          │
  │                                                                          │
  │  ┌────────────────────────────────────────────────────────────────────┐  │
  │  │  aks-subnet  (10.16.0.0/16)                                        │  │
  │  │  NSG: <prefix>-nsg                                                 │  │
  │  │                                                                     │  │
  │  │  AKS Nodes (Azure CNI — pods get VNet IPs directly):               │  │
  │  │    ├─ aks-...-vmss000000                                           │  │
  │  │    └─ aks-...-vmss000001                                           │  │
  │  │                                                                     │  │
  │  │  Pods (namespace: copilot-runtime):                                │  │
  │  │    ├─ Nx copilot-runtime-worker    (Running)                       │  │
  │  │    └─ 1x pilotswarm-portal         (Running, port 3001)            │  │
  │  │                                                                     │  │
  │  │  Services:                                                          │  │
  │  │    ├─ pilotswarm-portal  ClusterIP (:3001)                         │  │
  │  │    └─ nginx (app-routing-system ns)                                │  │
  │  │        Public LB: <static public IP>                               │  │
  │  │        DNS: <portal-host>                                          │  │
  │  │        Ports: 80, 443                                               │  │
  │  │        TLS: Let's Encrypt (cert-manager, auto-renewed)             │  │
  │  │                                                                     │  │
  │  │  Route Tables: NONE                                                │  │
  │  │  VNet Peering: NONE                                                │  │
  │  └────────────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────────┘

                         │ (outbound)
                         ▼
  ┌──────────────────────────────────────┐
  │  <pg-server>.postgres.database.      │
  │    azure.com                          │
  │  PG Flex v17, Standard_D2ads_v5      │
  │  Firewall: AllowAzureServices (0/0)  │
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │  <storage-account> (StorageV2)       │
  │  Container: copilot-sessions         │
  │  SKU: Standard_LRS                   │
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │  <acr> (ACR Basic)                   │
  │  Images: copilot-runtime-worker,     │
  │          pilotswarm-portal           │
  └──────────────────────────────────────┘
```

## NSG Rules

| Priority | Name | Direction | Access | Source |
|----------|------|-----------|--------|--------|
| 101 | NRMS-Rule-101 | Inbound | Allow | VirtualNetwork |
| 103 | NRMS-Rule-103 | Inbound | Allow | CorpNetPublic |
| 104 | NRMS-Rule-104 | Inbound | Allow | CorpNetSaw |
| 105-109 | NRMS-Rule-105–109 | Inbound | Deny | Internet |
| 110 | Allow-CorpNetSaw | Inbound | Allow | CorpNetSaw |
| 120 | Allow-CorpNetPublic | Inbound | Allow | CorpNetPublic |

NRMS rules (101–109) are corp-managed and auto-applied. Rules 110/120 are custom.

## AKS Cluster Details

| Field | Value |
|-------|-------|
| Name | `<cluster>` |
| FQDN | `az aks show -g <resource-group> -n <cluster> --query fqdn -o tsv` |
| Kubernetes | 1.33.x |
| Network Plugin | Azure CNI |
| Service CIDR | `10.0.0.0/16` |
| DNS Service IP | `10.0.0.10` |
| Node Pool | 2x `Standard_D8ds_v5` (8 vCPU, 32 GB each) |
| Ingress | app-routing enabled |
| Identity | System-assigned managed identity |

## K8S Resources (namespace: copilot-runtime)

### Deployments

| Deployment | Replicas | Image |
|-----------|----------|-------|
| copilot-runtime-worker | N | `<acr>.azurecr.io/copilot-runtime-worker:latest` |
| pilotswarm-portal | 1 | `<acr>.azurecr.io/pilotswarm-portal:latest` |

### Services

| Service | Type | External IP | Port |
|---------|------|-------------|------|
| pilotswarm-portal | ClusterIP | — | 3001 |
| nginx (app-routing-system) | LoadBalancer (public) | static public IP | 80, 443 |

### Ingress

| Ingress | Class | Host | TLS |
|---------|-------|------|-----|
| pilotswarm-portal | webapprouting.kubernetes.azure.com | `<portal-host>` | Let's Encrypt (cert-manager, secret: `portal-tls`) |

### Secrets

| Secret | Type | Keys |
|--------|------|------|
| copilot-runtime-secrets | Opaque | DATABASE_URL, GITHUB_TOKEN, AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_CONTAINER, AZURE_OAI_KEY, AZURE_MODEL_ROUTER_KEY, AZURE_FW_GLM5_KEY, AZURE_KIMI_K25_KEY, PORTAL_AUTH_PROVIDER, PORTAL_AUTH_ENTRA_TENANT_ID, PORTAL_AUTH_ENTRA_CLIENT_ID, PORTAL_AUTHZ_ADMIN_GROUPS, PORTAL_AUTHZ_USER_GROUPS, K8S_CONTEXT (15 total) |
| acr-pull | docker-registry | ACR admin credentials for `<acr>.azurecr.io` |

### Managed Identity Roles

| Identity | Role | Scope |
|----------|------|-------|
| AKS cluster | Network Contributor | `<prefix>-vnet` |
| Kubelet | AcrPull | `<acr>` (via `--attach-acr`) |

## Entra ID (Portal Auth)

Tenant and client ids live in `.env.remote` / the `copilot-runtime-secrets`
secret as `PORTAL_AUTH_ENTRA_TENANT_ID` and `PORTAL_AUTH_ENTRA_CLIENT_ID`. They
are not recorded here.

## Access Status

| Access Method | Status | Notes |
|--------------|--------|-------|
| Corp VPN | **Working** | Traffic from CorpNetSaw matches NSG rules 104/110 |
| Corp WiFi | **Working** | Traffic from CorpNetPublic matches NSG rules 103/120 |
| Public internet | **Blocked** | NRMS rules 105-109 deny Internet |
| Specific external IPs | **On request** | Add temporary NSG rule at priority 200 |
| In-cluster (pod-to-pod) | **Working** | Workers connect to PG, orchestrations running |

## Access Control Summary

Access is gated by the NSG on the AKS subnet. The portal uses a **public
LoadBalancer** — the NSG allows CorpNetSaw/CorpNetPublic and denies Internet.
Entra ID provides application-level auth. No `loadBalancerSourceRanges`, no VPN
routing dependencies, no VNet peering needed.

For non-corp IPs, add a temporary NSG rule:
```bash
az network nsg rule create --resource-group <resource-group> --nsg-name <prefix>-nsg \
  --name Allow-Temp-ExternalIP --priority 200 --direction Inbound --access Allow \
  --protocol Tcp --source-address-prefixes <IP> --destination-port-ranges 443 80
```
