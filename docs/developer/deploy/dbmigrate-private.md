# DBMigrate private nonproduction deployment

The `dbmigrate-private` deployment profile is an opt-in, fail-closed profile for
two independent nonproduction PilotSwarm stamps. It does not alter the existing
standard deployment defaults.

## Supported topology

- One isolated stamp each for test and development. Do not share AKS, PostgreSQL,
  Storage, Key Vault, ACR, Foundry, workload identities, runtime state, or
  deployment state between stamps.
- A shared nonproduction management hub may host Azure Bastion Standard and one
  no-public-IP management VM. Hub/spoke peering disables forwarded traffic and
  gateway transit; the spokes are not transitively connected.
- Bastion is the only public management endpoint. PilotSwarm portal ingress,
  AKS API access, and Azure service data planes remain private.
- Operators use individual Entra identities, individual VM sessions, and
  individual PilotSwarm portal identities. Shared accounts, browser profiles,
  token caches, and durable credentials on the management VM are prohibited.
- The catalog contains only the stamp-owned Azure AI Foundry provider and GPT
  deployments. `azure-foundry:gpt-5.4-mini` is the default.

This repository does not implement SQLMORT's internal deployment orchestrator,
corporate networking, T3/ephemeral worker clusters, Azure DevOps broker,
compliance integrations, or on-call automation. Treat those as separate
capabilities, not implied PilotSwarm features.

Required Azure resource providers include `Microsoft.ContainerService`,
`Microsoft.ContainerRegistry`, `Microsoft.Storage`, `Microsoft.KeyVault`,
`Microsoft.DBforPostgreSQL`, `Microsoft.CognitiveServices`,
`Microsoft.Network`, `Microsoft.Compute`, `Microsoft.ManagedIdentity`,
`Microsoft.OperationalInsights`, `Microsoft.Insights`,
`Microsoft.KubernetesConfiguration`, and `Microsoft.Authorization`. Registration
is a separate approved subscription mutation; this repository does not perform
it implicitly.

The current planning envelope is approximately USD 700–1,000 per stamp/month
before model usage, plus the shared Bastion/management VM. Confirm current
prices, log ingestion, egress, backup, private endpoint, and Foundry token costs
before approval. The bounded pool ceilings avoid the previous topology where
two stamps could consume all 100 West US 3 DDSv5-family vCPUs, but an operator
must still verify regional total, VM-family, AKS surge, public-IP/Bastion, and
Foundry deployment quota.

## Profile configuration

Scaffold a stamp only after the subscription, region, DNS, certificate issuer,
Entra application, quota, alert recipient, and model quota are approved:

```powershell
npm run deploy:new-env -- dbmigtest `
  --profile dbmigrate-private `
  --subscription <verified-subscription-id> `
  --location westus3 `
  --edge-mode private `
  --tls-source akv `
  --host dbmigtest `
  --private-dns-zone <private-zone> `
  --ssl-cert-domain-suffix <private-zone> `
  --foundry-enabled y
```

The profile sets `STRICT_PRIVATE=true`, `GPT_ONLY=true`, Premium ACR, bounded
nonproduction AKS autoscaling, 14-day database backup retention, 14-day Storage
delete recovery, private portal visibility, enforced ownership, and Entra
authentication. Before any validation or deployment, set:

- `PORTAL_AUTH_ENTRA_TENANT_ID`
- `PORTAL_AUTH_ENTRA_CLIENT_ID`
- `PORTAL_AUTHZ_ADMIN_GROUPS` and `PORTAL_AUTHZ_USER_GROUPS`
- `MONITOR_ALERT_EMAIL`
- `FOUNDRY_DEPLOYMENTS_FILE`
- private DNS/certificate inputs required by the selected AKV issuer

The deploy command refuses the profile if public edge mode, self-signed or ACME
TLS, unauthenticated portal access, unrestricted admin scope, non-GPT models,
missing operational contacts, unsafe pool ceilings, or insufficient recovery
retention are configured.

## Deterministic validation and evidence

These commands render the same parameter files used by deployment. `validate`
and `what-if` never create resource groups. The approved empty resource groups
must already exist.

```powershell
az account set --subscription <verified-subscription-id>
npm run deploy -- all dbmigtest --steps validate
npm run deploy -- all dbmigtest --steps what-if
```

What-if JSON is written under `deploy/.tmp/<service>/<env>/what-if/`. Preserve
the evidence with the deployment approval record. Review every delete,
replacement, public-network change, role assignment, DNS link, and quota-impacting
change before allowing `bicep`.

No deployment is approved until local Bicep compilation, script tests, Azure
validation, and Azure what-if all pass against the pinned subscription.

## Foundry compatibility gate

Model existence and quota are not sufficient. The target deployment must accept
representative full-framework PilotSwarm prompts without an Azure AI safety-policy
rejection.

From the private management network, place the Foundry key only in the process
environment and run:

```powershell
$env:FOUNDRY_ENDPOINT = "https://<account>.cognitiveservices.azure.com"
$env:AZURE_OAI_KEY = "<temporary-process-only-key>"
$env:FOUNDRY_SMOKE_MODEL = "gpt-5.4-mini"
$env:FOUNDRY_SMOKE_EVIDENCE = "deploy/.tmp/dbmigtest/foundry-smoke.json"
npm run deploy:foundry-smoke
Remove-Item Env:AZURE_OAI_KEY
```

The evidence contains only endpoint host, model, request fingerprint,
request/correlation ID, HTTP status, and sanitized policy fields. It never
stores the prompt or key. HTTP 400 `content_filter`,
`ResponsibleAIPolicyViolation`, or `jailbreak.detected=true` fails closed.
Never weaken or bypass Azure AI safety filters to pass this gate.

An earlier standalone environment provisioned the model successfully but three
full-framework requests to `gpt-5.4-mini` version `2026-03-17` were rejected by
that policy. Therefore prompt minimization/provider compatibility remains an
explicit no-go item until both this smoke test and a post-deployment PilotSwarm
conversation succeed with the intended framework prompt.

## Shared management hub

Deploy the hub independently from either stamp. The template is
`deploy/services/management-hub/bicep/main.bicep`.

The safe order is:

1. Deploy the hub VNet, Bastion, and management VM with empty `spokes` and
   `privateDnsZones`.
2. From the management VM, deploy each stamp's BaseInfra.
3. Re-run the hub template with the created spoke VNets and private DNS zones
   to establish bidirectional non-transitive peering and hub DNS links. Include
   the AKS-managed private-cluster DNS zone from the node resource group as well
   as the ACR, Blob, Key Vault, PostgreSQL, and Foundry zones.
4. From the management VM, deploy manifests and run private-cluster rollout
   checks.

```powershell
az deployment group validate `
  --subscription <verified-subscription-id> `
  --resource-group <management-resource-group> `
  --template-file deploy/services/management-hub/bicep/main.bicep `
  --parameters @<rendered-management-hub-parameters.json> `
  --parameters spokes=@<spokes.json> privateDnsZones=@<private-dns-zones.json>

az deployment group what-if `
  --subscription <verified-subscription-id> `
  --resource-group <management-resource-group> `
  --template-file deploy/services/management-hub/bicep/main.bicep `
  --parameters @<rendered-management-hub-parameters.json> `
  --parameters spokes=@<spokes.json> privateDnsZones=@<private-dns-zones.json> `
  --result-format FullResourcePayloads --no-pretty-print --output json
```

Only after separate approval, replace `what-if` with `create`. Assign Azure
Virtual Machine Administrator Login or User Login to named operators through a
separate, human-approved RBAC step. Do not store an admin password in parameter
files; the VM disables password authentication.

## Azure DevOps boundary

PilotSwarm does not currently implement live Azure DevOps work-item, branch,
commit, draft-PR, build, review, or merge operations. Browser-side repository
package import and the mock DevOps sample are not an automation broker.

Future automation must use a separate broker workload identity that is never
assigned to general worker pods. Its API may expose only:

- work-item read/update required for the approved workflow
- task-branch creation
- commit/push to that task branch
- draft pull-request creation
- build and policy status reads

It must not expose voting, approval, auto-complete, completion/merge, bypass,
branch deletion, ACL, service-connection, or administrative operations. Azure
DevOps permissions do not independently provide draft-create-without-complete;
token isolation and the broker API are mandatory. Human reviewers alone approve
and merge.

For the proposed integration, the broker is scoped to Azure DevOps organization
`msdata`, project `Tina`, and repository `MigrationAutomation`; broader
organization/project permissions are not part of this deployment.

## Operations, recovery, and rollback

- Alert routing must be tested before workload onboarding. Minimum coverage is
  AKS/worker unavailability, Flux reconciliation failure, PostgreSQL availability
  and capacity, certificate expiry/failure, provider/policy failures, budget
  exhaustion, and subscription cost thresholds.
- PostgreSQL backup retention and Storage versioning/delete retention are
  preventive controls, not restore evidence. Perform and record a test restore
  before the stamp is accepted.
- Preserve the previous image tag, staged manifests, rendered parameters,
  what-if evidence, database backup/restore point, and Storage recovery evidence
  for every upgrade.
- Roll back manifests and images first. Do not roll back a schema or restore a
  database until the compatibility and data-loss decision is approved.
- A private-cluster upgrade requires spare regional and VM-family quota for surge
  nodes. Two default stamps must not consume the full subscription quota.
- The owning team must define patching, certificate renewal, model compatibility,
  incident response, backup testing, cost review, and after-hours escalation.

## Go/no-go checklist

Deployment is **no-go** until every item is true:

- verified nonproduction subscription ID and human deployment approval
- required resource providers registered through an approved change
- approved region, AKS version, VM-family quota, Foundry model quota, and surge headroom
- attributed or replaced pre-existing managed identities
- private DNS zone and trusted private certificate issuer available
- management hub validated, peering reviewed, and named operator access approved
- strict-private profile validation and what-if evidence approved
- no public access on AKS API, ACR, Storage, Key Vault, PostgreSQL, or Foundry
- Entra portal login, ownership enforcement, private visibility, and admin groups verified
- GPT-only catalog and deployment file verified
- Foundry policy smoke test and a real PilotSwarm conversation both succeed
- alerts deliver to the named on-call recipient
- backup restore and Storage recovery evidence recorded
- Azure DevOps broker remains disabled until separately implemented and approved

The test stamp is deployed first. The development stamp is blocked until the
test stamp completes networking, auth, model, recovery, monitoring, upgrade, and
rollback acceptance.
