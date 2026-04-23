# ev2-deploy-dev.ps1 — dev-loop helper for the Portal EV2 ServiceGroup.
#
# Stages the Portal Ev2AppDeployment tree into a temp service-group-root
# directory (so uncommitted working-tree changes are deployed) and invokes
# `az rollout start` against the dev Service Connection.
#
# Prerequisites:
#   - Azure CLI (`az`) installed and logged in.
#   - The `az-rollout` extension installed:
#         az extension add --name rollout
#   - An EV2 dev Service Connection / Service Principal configured with
#     permission to trigger rollouts in the dev EV2 service identifier.
#   - `kubectl` on PATH (so the rendered Kustomize output can be staged).
#
# Side effects:
#   - Writes only to the dev subscription via the configured Service
#     Connection; does not modify the repo working tree or push commits.

[CmdletBinding()]
param (
    [string]$ServiceName = 'Microsoft.PilotSwarm.Portal.Dev',
    [string]$ParametersFile = 'Ev2AppDeployment/Parameters/dev.deploymentParameters.json',
    [string]$RolloutSpec = 'Ev2AppDeployment/rolloutSpec.json',
    [string]$OverlayPath = 'deploy/gitops/portal/overlays/dev'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
$ServiceGroupSource = Join-Path $PSScriptRoot '.'
$OverlaySource = Join-Path $RepoRoot $OverlayPath

if (-not (Test-Path $OverlaySource)) {
    throw "Overlay path not found: $OverlaySource"
}

$Staging = Join-Path ([IO.Path]::GetTempPath()) ("ps-portal-ev2-" + [Guid]::NewGuid().ToString('N'))
Write-Host "Staging service-group-root at: $Staging"
New-Item -ItemType Directory -Path $Staging -Force | Out-Null

Copy-Item -Recurse -Path (Join-Path $ServiceGroupSource 'Ev2AppDeployment') -Destination $Staging
Copy-Item -Recurse -Path (Join-Path $ServiceGroupSource 'Ev2InfraDeployment') -Destination $Staging
Copy-Item -Recurse -Path $OverlaySource -Destination (Join-Path $Staging 'overlay')

if (Get-Command kubectl -ErrorAction SilentlyContinue) {
    $renderedDir = Join-Path $Staging 'rendered'
    New-Item -ItemType Directory -Path $renderedDir -Force | Out-Null
    Write-Host "Rendering Kustomize preview to $renderedDir\manifests.yaml"
    & kubectl kustomize $OverlaySource | Out-File -FilePath (Join-Path $renderedDir 'manifests.yaml') -Encoding UTF8
}
else {
    Write-Warning "kubectl not found — skipping local Kustomize render (EV2 side will still render via DeployApplicationManifest.sh)."
}

Write-Host "Invoking: az rollout start --service-name $ServiceName --service-group-root $Staging --rollout-spec $RolloutSpec --parameters $ParametersFile"
& az rollout start `
    --service-name $ServiceName `
    --service-group-root $Staging `
    --rollout-spec $RolloutSpec `
    --parameters $ParametersFile
