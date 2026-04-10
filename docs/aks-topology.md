# PilotSwarm AKS Topology

## Subscription & Resource Group

| Field | Value |
|-------|-------|
| Subscription | Azure PostgreSQL AI Playground (`043a8e55-a702-4610-bffb-f2cc510c4340`) |
| Resource Group | `pilotswarm-rg` |
| Location | `westus3` |
| AKS Managed RG | `MC_pilotswarm-rg_pilotswarm-aks_westus3` (auto-managed) |

## Resources

| Resource | Name | SKU / Config |
|----------|------|-------------|
| VNet | `pilotswarm-vnet` | Address space: `10.16.0.0/12` |
| NSG | `pilotswarm-nsg` | Attached to `aks-subnet` |
| AKS | `pilotswarm-aks` | K8s 1.33, Azure CNI, Standard tier |
| ACR | `pilotswarmacr` | Basic, admin enabled (for pull secret) |
| Postgres Flex | `pilotswarm-pg` | v17, `Standard_D2ads_v5`, 64 GB |
| Storage | `pilotswarmsessions` | StorageV2, Standard_LRS |
| Blob Container | `copilot-sessions` | Session dehydration blobs |

## Network Topology

```
                    ┌─────────────────────────────────────────────┐
                    │  Azure PostgreSQL AI Playground              │
                    │  Subscription: 043a8e55-...                 │
                    │  Resource Group: pilotswarm-rg               │
                    └─────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  pilotswarm-vnet  (10.16.0.0/12)                                        │
  │                                                                          │
  │  ┌────────────────────────────────────────────────────────────────────┐  │
  │  │  aks-subnet  (10.16.0.0/16)                                        │  │
  │  │  NSG: pilotswarm-nsg                                               │  │
  │  │                                                                     │  │
  │  │  AKS Nodes (Azure CNI — pods get VNet IPs directly):               │  │
  │  │    ├─ aks-...-vmss000000  10.16.0.33                               │  │
  │  │    └─ aks-...-vmss000001  10.16.0.4                                │  │
  │  │                                                                     │  │
  │  │  Pods (namespace: copilot-runtime):                                │  │
  │  │    ├─ 6x copilot-runtime-worker    (Running)                       │  │
  │  │    └─ 1x pilotswarm-portal         (Running, port 3001)            │  │
  │  │                                                                     │  │
  │  │  Services:                                                          │  │
  │  │    ├─ pilotswarm-portal  ClusterIP (10.0.115.116:3001)             │  │
  │  │    └─ nginx (app-routing-system ns)                                │  │
  │  │        Public LB: 20.106.114.177 (static)                         │  │
  │  │        DNS: pilotswarm-portal.westus3.cloudapp.azure.com           │  │
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
  │  pilotswarm-pg.postgres.database.    │
  │    azure.com                          │
  │  PG Flex v17, Standard_D2ads_v5      │
  │  Firewall: AllowAzureServices (0/0)  │
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │  pilotswarmsessions (StorageV2)      │
  │  Container: copilot-sessions         │
  │  SKU: Standard_LRS                   │
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │  pilotswarmacr (ACR Basic)           │
  │  Images: copilot-runtime-worker,     │
  │          pilotswarm-portal           │
  └──────────────────────────────────────┘
```

## NSG Rules (pilotswarm-nsg)

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
| Name | `pilotswarm-aks` |
| FQDN | `pilotswarm-pilotswarm-rg-043a8e-au3kq85k.hcp.westus3.azmk8s.io` |
| Kubernetes | 1.33.7 |
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
| copilot-runtime-worker | 6 | `pilotswarmacr.azurecr.io/copilot-runtime-worker:latest` |
| pilotswarm-portal | 1 | `pilotswarmacr.azurecr.io/pilotswarm-portal:latest` |

### Services

| Service | Type | ClusterIP | External IP | Port |
|---------|------|-----------|-------------|------|
| pilotswarm-portal | ClusterIP | 10.0.115.116 | — | 3001 |
| nginx (app-routing-system) | LoadBalancer (public) | 10.0.255.72 | 20.106.114.177 (static) | 80, 443 |

### Ingress

| Ingress | Class | Host | TLS |
|---------|-------|------|-----|
| pilotswarm-portal | webapprouting.kubernetes.azure.com | pilotswarm-portal.westus3.cloudapp.azure.com | Let's Encrypt (cert-manager, secret: `portal-tls`) |

### Secrets

| Secret | Type | Keys |
|--------|------|------|
| copilot-runtime-secrets | Opaque | DATABASE_URL, GITHUB_TOKEN, AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_CONTAINER, AZURE_OAI_KEY, AZURE_MODEL_ROUTER_KEY, AZURE_FW_GLM5_KEY, AZURE_KIMI_K25_KEY, PORTAL_AUTH_PROVIDER, PORTAL_AUTH_ENTRA_TENANT_ID, PORTAL_AUTH_ENTRA_CLIENT_ID, PORTAL_AUTHZ_ADMIN_GROUPS, PORTAL_AUTHZ_USER_GROUPS, K8S_CONTEXT (15 total) |
| acr-pull | docker-registry | ACR admin credentials for `pilotswarmacr.azurecr.io` |

### Managed Identity Roles

| Identity | Role | Scope |
|----------|------|-------|
| AKS cluster (`7ca38093-...`) | Network Contributor | `pilotswarm-vnet` |
| Kubelet (`f336af95-...`) | AcrPull | `pilotswarmacr` (via `--attach-acr`) |

## Entra ID (Portal Auth)

| Field | Value |
|-------|-------|
| Tenant | `72f988bf-86f1-41af-91ab-2d7cd011db47` (Microsoft) |
| Client ID | `afe6edbf-7324-4cc8-a1ef-7ae0d87ce18f` |

## Access Status

| Access Method | Status | Notes |
|--------------|--------|-------|
| Corp VPN | **Working** | Traffic from CorpNetSaw matches NSG rules 104/110 |
| Corp WiFi | **Working** | Traffic from CorpNetPublic matches NSG rules 103/120 |
| Public internet | **Blocked** | NRMS rules 105-109 deny Internet |
| Specific external IPs | **On request** | Add temporary NSG rule at priority 200 |
| In-cluster (pod-to-pod) | **Working** | Workers connect to PG, orchestrations running |

## Access Control Summary

Access is gated by the NSG on the AKS subnet. The portal uses a **public LoadBalancer** — the NSG `pilotswarm-nsg` allows CorpNetSaw/CorpNetPublic and denies Internet. Entra ID provides application-level auth. No `loadBalancerSourceRanges`, no VPN routing dependencies, no VNet peering needed.

For non-corp IPs, add a temporary NSG rule:
```bash
az network nsg rule create --resource-group pilotswarm-rg --nsg-name pilotswarm-nsg \
  --name Allow-Temp-ExternalIP --priority 200 --direction Inbound --access Allow \
  --protocol Tcp --source-address-prefixes <IP> --destination-port-ranges 443 80
```
