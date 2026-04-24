# ev2-deploy-dev.ps1 — dev-loop helper for the Worker EV2 ServiceGroup.
#
# Registers the Worker service-artifacts tree with the EV2 Test endpoint and
# starts a test rollout using the internal EV2 PowerShell cmdlets
# (Register-AzureServiceArtifacts / New-AzureServiceRollout). This is NOT
# an `az rollout start` / Azure CLI flow — EV2 Dev/Test uses internal
# cmdlets from the EV2 Quickstart repo.
#
# Prerequisites (see docs/deploying-to-aks-ev2.md):
#   1. Clone the EV2 Quickstart repo:
#        https://msazure.visualstudio.com/Azure-Express/_git/Quickstart
#   2. In an elevated PowerShell 5.1 (Windows x64) session, run:
#        cd <Quickstart>\Ev2_PowerShell
#        .\AzureServiceDeployClient.ps1
#      This loads Register-AzureServiceArtifacts / New-AzureServiceRollout
#      and prompts for interactive AAD sign-in.
#   3. Your corp account must be a member of the EV2 operator group
#      registered on the ServiceId for PilotSwarm (see -ServiceId param).
#   4. `kubectl` on PATH (optional; used for local Kustomize preview only).
#
# Side effects: Writes only to the EV2 Test infra via the caller's
# interactive credential. Does not modify the repo working tree.

[CmdletBinding()]
param (
    # ServiceTree GUID for PilotSwarm. Fill in after Service Tree onboarding.
    [string]$ServiceId = '00000000-0000-0000-0000-000000000000',

    # Env-qualified ServiceGroup name; must match the
    # Configuration/ServiceGroup/<this>.Configuration.json file that ships
    # inside the service-artifacts root.
    [string]$ServiceGroupName = 'Microsoft.PilotSwarm.Worker.Dev',

    # Azure-managed SDP stage map. Override for single-stage dev rollouts.
    [string]$StageMapName = 'Microsoft.Azure.SDP.Standard',

    # Region filter for -Select. westus3 is the only prod region today.
    [string]$Region = 'westus3',

    # Step filter for -Select. '*' runs all orchestratedSteps.
    [string]$Steps = '*',

    # Local path (under this SG root) to the overlay consumed by
    # DeployApplicationManifest.sh on the EV2 side.
    [string]$OverlayPath = 'deploy/gitops/worker/overlays/dev',

    # If set, runs Test-AzureServiceRollout (validation only) instead of
    # New-AzureServiceRollout (real deployment).
    [switch]$TestOnly,

    # Skip Register-AzureServiceArtifacts (useful when re-running with the
    # same ArtifactsVersion in version.txt).
    [switch]$SkipRegister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Verify EV2 cmdlets loaded.
foreach ($cmd in 'Register-AzureServiceArtifacts', 'New-AzureServiceRollout', 'Test-AzureServiceRollout') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "EV2 cmdlet '$cmd' not found. Load it first: cd <Quickstart>\Ev2_PowerShell; .\AzureServiceDeployClient.ps1"
    }
}

$RepoRoot = (Resolve-Path -Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
$ServiceGroupSource = Join-Path $PSScriptRoot 'Ev2AppDeployment'
$OverlaySource = Join-Path $RepoRoot $OverlayPath

if (-not (Test-Path $OverlaySource)) { throw "Overlay path not found: $OverlaySource" }
if (-not (Test-Path $ServiceGroupSource)) { throw "Service-artifacts root not found: $ServiceGroupSource" }

# Stage a service-artifacts root in %TEMP% so uncommitted working-tree edits
# are included. Copy both the EV2 tree and the overlay the EV2 shell extension
# will consume.
$Staging = Join-Path ([IO.Path]::GetTempPath()) ("ps-worker-ev2-" + [Guid]::NewGuid().ToString('N'))
Write-Host "Staging service-artifacts root at: $Staging"
New-Item -ItemType Directory -Path $Staging -Force | Out-Null
Copy-Item -Recurse -Path "$ServiceGroupSource\*" -Destination $Staging
Copy-Item -Recurse -Path $OverlaySource -Destination (Join-Path $Staging 'overlay')

if (Get-Command kubectl -ErrorAction SilentlyContinue) {
    $renderedDir = Join-Path $Staging 'rendered'
    New-Item -ItemType Directory -Path $renderedDir -Force | Out-Null
    Write-Host "Rendering Kustomize preview to $renderedDir\manifests.yaml"
    & kubectl kustomize $OverlaySource | Out-File -FilePath (Join-Path $renderedDir 'manifests.yaml') -Encoding UTF8
}
else {
    Write-Warning "kubectl not found - skipping local Kustomize preview."
}

$VersionFile = Join-Path $Staging 'version.txt'
if (-not (Test-Path $VersionFile)) { throw "version.txt missing under $Staging" }
$ArtifactsVersion = (Get-Content $VersionFile -Raw).Trim()
Write-Host "ArtifactsVersion: $ArtifactsVersion"

if (-not $SkipRegister) {
    Write-Host "Register-AzureServiceArtifacts -ServiceGroupRoot $Staging -RolloutSpec rolloutSpec.json -RolloutInfra Test"
    Register-AzureServiceArtifacts -ServiceGroupRoot $Staging -RolloutSpec 'rolloutSpec.json' -RolloutInfra Test -Force -ErrorAction Stop
}

$commonArgs = @{
    ServiceIdentifier = $ServiceId
    ServiceGroup      = $ServiceGroupName
    StageMapName      = $StageMapName
    ArtifactsVersion  = $ArtifactsVersion
    Select            = "regions($Region).steps($Steps)"
    RolloutInfra      = 'Test'
    WaitToComplete    = $true
    ErrorAction       = 'Stop'
}

if ($TestOnly) {
    Write-Host "Test-AzureServiceRollout ..."
    Test-AzureServiceRollout @commonArgs
}
else {
    Write-Host "New-AzureServiceRollout ..."
    New-AzureServiceRollout @commonArgs
}
