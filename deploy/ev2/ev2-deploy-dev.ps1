# ev2-deploy-dev.ps1 — unified EV2 Test-endpoint dev-loop helper for PilotSwarm.
#
# Reads deploy/ev2/services.json (the root index with fleet-wide defaults +
# pointers to per-service manifests) and each targeted service's
# deploy/ev2/<Service>/service.json (self-contained per-service config).
# Stages the selected ServiceGroup's tree (plus any build outputs) under
# `deploy/ev2/.staging/` (gitignored, inside the repo), then invokes the
# internal EV2 cmdlets from AzureServiceDeployClient.ps1
# (Register-AzureServiceArtifacts + New-AzureServiceRollout). This is
# NOT an `az rollout start` / Azure CLI flow.
#
# Adding a new service: drop deploy/ev2/<Name>/service.json and add one
# entry under `services` in services.json. No changes to this script.
#
# Prerequisites (see docs/deploying-to-aks-ev2.md):
#   1. Clone the EV2 Quickstart repo:
#        https://msazure.visualstudio.com/Azure-Express/_git/Quickstart
#   2. In an elevated **native Windows PowerShell 5.1 x64** session, run:
#        cd <Quickstart>\Ev2_PowerShell
#        . .\AzureServiceDeployClient.ps1
#   3. Your corp account must be in the EV2 operator AAD group registered
#      on the PilotSwarm ServiceTree entry (pass the ServiceId via the
#      -ServiceId parameter, or export PS_EV2_SERVICE_ID).
#   4. `az` on PATH (for `az bicep build`). `docker buildx` + ACR login
#      only required when -BuildImage is used.
#
# Side effects:
#   - Writes under deploy/ev2/.staging/ (gitignored; safe to delete).
#   - Optionally runs `az bicep build` and/or `docker buildx ... --push`.
#   - Triggers EV2 Test-endpoint rollouts via the caller's interactive AAD
#     session. Does NOT modify the repo working tree.

[CmdletBinding()]
param (
    # Target service name. Must match a key in deploy/ev2/services.json.
    # Validated at runtime (not via ValidateSet) so new services can be
    # added by creating <Name>/service.json + one index entry.
    [Parameter(Mandatory = $true)]
    [string]$Service,

    [ValidateSet('Dev', 'Prod')]
    [string]$Environment = 'Dev',

    # ServiceTree GUID. Can also be provided via $env:PS_EV2_SERVICE_ID.
    [string]$ServiceId = $env:PS_EV2_SERVICE_ID,

    # Region filter for -Select. Default pulled from services.json per-service.
    [string]$Region,

    # Step filter for -Select. '*' runs all orchestratedSteps.
    [string]$Steps = '*',

    # Also deploy GlobalInfra + BaseInfra first (fleet-manager parity).
    # Ignored when -Service is itself GlobalInfra/BaseInfra.
    [switch]$DeployInfra,

    # Skip the build stage (Bicep compile + optional image push). Useful
    # when re-rolling the same ArtifactsVersion after a registration.
    [switch]$SkipBuild,

    # Skip Register-AzureServiceArtifacts.
    [switch]$SkipRegister,

    # Build + push the service's container image to -HoldingAcr before
    # rollout. Requires `docker buildx`, `az acr login`, and -HoldingAcr +
    # -ImageTag. Only meaningful for Worker/Portal.
    [switch]$BuildImage,

    [string]$HoldingAcr,
    [string]$ImageTag,

    # Run Test-AzureServiceRollout instead of New-AzureServiceRollout.
    [switch]$TestOnly,

    # Pass -Force to Register-AzureServiceArtifacts.
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Resolve-RepoRoot {
    (Resolve-Path -Path (Join-Path $PSScriptRoot '..' '..')).Path
}

function Assert-Ev2Cmdlets {
    foreach ($cmd in 'Register-AzureServiceArtifacts', 'New-AzureServiceRollout', 'Test-AzureServiceRollout') {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            throw "EV2 cmdlet '$cmd' not found. Load it: cd <Quickstart>\Ev2_PowerShell; . .\AzureServiceDeployClient.ps1"
        }
    }
}

function Get-ServicesIndex {
    param([string]$RepoRoot)
    $path = Join-Path $RepoRoot 'deploy/ev2/services.json'
    if (-not (Test-Path $path)) { throw "root service index not found: $path" }
    return Get-Content $path -Raw | ConvertFrom-Json
}

function Resolve-ServiceConfig {
    param($Index, [string]$Name, [string]$Env, [string]$RepoRoot)
    if (-not $Index.services.PSObject.Properties.Name.Contains($Name)) {
        $known = ($Index.services.PSObject.Properties.Name -join ', ')
        throw "Service '$Name' not in services.json (known: $known)"
    }
    $manifestRel = $Index.services.$Name.manifest
    $manifestAbs = Join-Path $RepoRoot "deploy/ev2/$manifestRel"
    if (-not (Test-Path $manifestAbs)) {
        throw "Per-service manifest not found: $manifestAbs (indexed from services.json as '$manifestRel')"
    }
    $svc = Get-Content $manifestAbs -Raw | ConvertFrom-Json
    $resolved = [ordered]@{
        Name             = $Name
        ManifestPath     = $manifestAbs
        ServiceGroupName = $svc.serviceGroupName -replace '\{env\}', $Env
        SgRoot           = $svc.sgRoot
        RolloutSpec      = $svc.rolloutSpec
        BicepMain        = $svc.bicepMain
        BicepParam       = if ($svc.PSObject.Properties.Name -contains 'bicepParams' -and $svc.bicepParams) { $svc.bicepParams.$Env } else { $null }
        ArmTemplateOut   = $svc.armTemplateOut
        DockerImageRepo  = $svc.dockerImageRepo
        Dockerfile       = if ($svc.PSObject.Properties.Name -contains 'dockerfile') { $svc.dockerfile } else { $null }
        KustomizeOverlay = if ($svc.PSObject.Properties.Name -contains 'kustomizeOverlay') {
            $svc.kustomizeOverlay -replace '\{envLower\}', $Env.ToLowerInvariant()
        } else { $null }
        IsInfra          = [bool]$svc.isInfra
        DefaultRegion    = if ($svc.PSObject.Properties.Name -contains 'defaultRegion' -and $svc.defaultRegion) { $svc.defaultRegion } else { $Index.defaultRegion }
    }
    return [pscustomobject]$resolved
}

function Get-ArtifactsVersion {
    param([string]$SgRootAbs)
    $versionFile = Join-Path $SgRootAbs 'version.txt'
    if (-not (Test-Path $versionFile)) { throw "version.txt missing under $SgRootAbs" }
    return (Get-Content $versionFile -Raw).Trim()
}

function Invoke-BicepBuild {
    param([string]$RepoRoot, $Config)
    if (-not $Config.BicepMain) {
        Write-Host "[$($Config.Name)] no Bicep to build, skipping." -ForegroundColor DarkGray
        return
    }
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "az CLI not found on PATH — required for 'az bicep build'."
    }
    $bicepAbs = Join-Path $RepoRoot "deploy/ev2/$($Config.BicepMain)"
    $outAbs = Join-Path $RepoRoot "deploy/ev2/$($Config.ArmTemplateOut)"
    $outDir = Split-Path $outAbs -Parent
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    Write-Host "[$($Config.Name)] az bicep build --file $bicepAbs --outfile $outAbs"
    & az bicep build --file $bicepAbs --outfile $outAbs
    if ($LASTEXITCODE -ne 0) { throw "az bicep build failed for $bicepAbs" }

    if ($Config.BicepParam) {
        $paramAbs = Join-Path $RepoRoot "deploy/ev2/$($Config.BicepParam)"
        Write-Host "[$($Config.Name)] az bicep build-params --file $paramAbs"
        & az bicep build-params --file $paramAbs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "az bicep build-params failed for $paramAbs" }
    }
}

function Invoke-ImageBuildPush {
    param([string]$RepoRoot, $Config, [string]$Acr, [string]$Tag)
    if (-not $Config.DockerImageRepo) {
        Write-Host "[$($Config.Name)] no dockerImageRepo in manifest, skipping image build." -ForegroundColor DarkGray
        return
    }
    if (-not $Acr) { throw "-HoldingAcr is required when -BuildImage is set." }
    if (-not $Tag) { throw "-ImageTag is required when -BuildImage is set." }
    if (-not $Config.Dockerfile) { throw "dockerfile missing from services.json for $($Config.Name)." }
    $dockerfileAbs = Join-Path $RepoRoot $Config.Dockerfile
    $imageRef = "$Acr/$($Config.DockerImageRepo):$Tag"
    Write-Host "[$($Config.Name)] docker buildx build --platform linux/amd64 --push -t $imageRef -f $dockerfileAbs $RepoRoot"
    & docker buildx build --platform linux/amd64 --push -t $imageRef -f $dockerfileAbs $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw "docker buildx build failed for $($Config.Name)." }
}

function New-Staging {
    param([string]$RepoRoot, $Config)
    $stagingRoot = Join-Path $RepoRoot 'deploy/ev2/.staging'
    if (-not (Test-Path $stagingRoot)) { New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0, 6))
    $staging = Join-Path $stagingRoot "$($Config.Name)-$stamp"
    $sgSource = Join-Path $RepoRoot "deploy/ev2/$($Config.SgRoot)"
    if (-not (Test-Path $sgSource)) { throw "SG source not found: $sgSource" }
    Write-Host "[$($Config.Name)] staging -> $staging"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Copy-Item -Recurse -Path (Join-Path $sgSource '*') -Destination $staging
    # Copy overlay next to the SG tree so DeployApplicationManifest.sh can see it.
    if ($Config.KustomizeOverlay) {
        $overlaySrc = Join-Path $RepoRoot $Config.KustomizeOverlay
        if (Test-Path $overlaySrc) {
            Copy-Item -Recurse -Path $overlaySrc -Destination (Join-Path $staging 'overlay')
            if (Get-Command kubectl -ErrorAction SilentlyContinue) {
                $rendered = Join-Path $staging 'rendered/manifests.yaml'
                New-Item -ItemType Directory -Path (Split-Path $rendered) -Force | Out-Null
                & kubectl kustomize $overlaySrc | Out-File -FilePath $rendered -Encoding UTF8
                Write-Host "[$($Config.Name)] kustomize preview -> $rendered" -ForegroundColor DarkGray
            }
        }
        else {
            Write-Warning "[$($Config.Name)] overlay not found at $overlaySrc"
        }
    }
    return $staging
}

function Get-RolloutErrors {
    param($RolloutStatus)
    if (-not $RolloutStatus -or -not $RolloutStatus.ResourceGroups) {
        Write-Host "No rollout status / resource groups to inspect." -ForegroundColor Yellow
        return
    }
    Write-Host "---- Rollout errors ----" -ForegroundColor Cyan
    foreach ($rg in $RolloutStatus.ResourceGroups) {
        if (-not $rg.Resources) { continue }
        foreach ($res in $rg.Resources) {
            if (-not $res.Actions) { continue }
            foreach ($act in $res.Actions) {
                if ($act.Status -eq 'Succeeded') { continue }
                Write-Host "[$($rg.Name)/$($res.Name)] $($act.Name) [$($act.StepName)] -> $($act.Status)" -ForegroundColor Red
                if ($act.ActionOperationInfo -and $act.ActionOperationInfo.ErrorInfo) {
                    $err = $act.ActionOperationInfo.ErrorInfo
                    Write-Host "    ErrorCode:   $($err.ErrorCode)"   -ForegroundColor Red
                    Write-Host "    ErrorReason: $($err.ErrorReason)" -ForegroundColor Red
                    if ($err.HelpLink) { Write-Host "    HelpLink:    $($err.HelpLink)" -ForegroundColor Yellow }
                }
                if ($act.ResourceOperations) {
                    foreach ($op in $act.ResourceOperations) {
                        if ($op.State -eq 'Succeeded' -or -not $op.ErrorInfo) { continue }
                        Write-Host "    ResourceOp:  $($op.Name) [$($op.ResourceType)] $($op.State) $($op.StatusCode)" -ForegroundColor Red
                        Write-Host "      Code:   $($op.ErrorInfo.ErrorCode)"   -ForegroundColor Red
                        Write-Host "      Reason: $($op.ErrorInfo.ErrorReason)" -ForegroundColor Red
                    }
                }
            }
        }
    }
    Write-Host "------------------------" -ForegroundColor Cyan
}

function Start-Ev2RegisterAndDeploy {
    param(
        [string]$StagingRoot,
        [string]$RolloutSpec,
        [string]$ServiceId,
        [string]$ServiceGroupName,
        [string]$StageMapName,
        [string]$ArtifactsVersion,
        [string]$Region,
        [string]$Steps,
        [switch]$SkipRegister,
        [switch]$Force,
        [switch]$TestOnly
    )

    if (-not $SkipRegister) {
        Write-Host "Register-AzureServiceArtifacts -ServiceGroupRoot $StagingRoot -RolloutSpec $RolloutSpec -RolloutInfra Test"
        Register-AzureServiceArtifacts -ServiceGroupRoot $StagingRoot -RolloutSpec $RolloutSpec -RolloutInfra Test -Force:$Force -ErrorAction Stop
    }

    $common = @{
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
        Write-Host "Test-AzureServiceRollout $ServiceGroupName @ $ArtifactsVersion ..."
        Test-AzureServiceRollout @common
        return
    }

    Write-Host "New-AzureServiceRollout $ServiceGroupName @ $ArtifactsVersion ..."
    $status = New-AzureServiceRollout @common
    if ($status -and $status.Status -and $status.Status -ne 'Succeeded') {
        Get-RolloutErrors -RolloutStatus $status
        throw "Rollout failed for $ServiceGroupName (Status=$($status.Status))"
    }
}

function Invoke-ServiceDeploy {
    param([string]$RepoRoot, $Index, $Config, [string]$Env, [string]$Region)

    if (-not $SkipBuild) {
        Invoke-BicepBuild -RepoRoot $RepoRoot -Config $Config
        if ($BuildImage) {
            Invoke-ImageBuildPush -RepoRoot $RepoRoot -Config $Config -Acr $HoldingAcr -Tag $ImageTag
        }
    }

    $staging = New-Staging -RepoRoot $RepoRoot -Config $Config
    $artifactsVersion = Get-ArtifactsVersion -SgRootAbs $staging
    Write-Host "[$($Config.Name)] ArtifactsVersion=$artifactsVersion Region=$Region ServiceGroup=$($Config.ServiceGroupName)"

    Start-Ev2RegisterAndDeploy `
        -StagingRoot $staging `
        -RolloutSpec $Config.RolloutSpec `
        -ServiceId $ServiceId `
        -ServiceGroupName $Config.ServiceGroupName `
        -StageMapName $Index.stageMapName `
        -ArtifactsVersion $artifactsVersion `
        -Region $Region `
        -Steps $Steps `
        -SkipRegister:$SkipRegister `
        -Force:$Force `
        -TestOnly:$TestOnly
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Assert-Ev2Cmdlets
if (-not $ServiceId) {
    throw "ServiceId is required. Pass -ServiceId <guid> or set `$env:PS_EV2_SERVICE_ID."
}

$repoRoot = Resolve-RepoRoot
$index = Get-ServicesIndex -RepoRoot $repoRoot

$primary = Resolve-ServiceConfig -Index $index -Name $Service -Env $Environment -RepoRoot $repoRoot
if (-not $Region) { $Region = $primary.DefaultRegion }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "PilotSwarm EV2 dev deploy  (endpoint=Test)"                         -ForegroundColor Cyan
Write-Host "  Service:      $($primary.Name)"                                   -ForegroundColor Yellow
Write-Host "  Manifest:     $($primary.ManifestPath)"                           -ForegroundColor DarkGray
Write-Host "  Environment:  $Environment"                                       -ForegroundColor Yellow
Write-Host "  ServiceGroup: $($primary.ServiceGroupName)"                       -ForegroundColor Yellow
Write-Host "  Region:       $Region"                                            -ForegroundColor Yellow
Write-Host "  DeployInfra:  $DeployInfra"                                       -ForegroundColor Yellow
Write-Host "  BuildImage:   $BuildImage"                                        -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan

try {
    if ($DeployInfra -and -not $primary.IsInfra) {
        $infraNames = if ($index.PSObject.Properties.Name -contains 'infraOrder' -and $index.infraOrder) {
            $index.infraOrder
        } else {
            @('GlobalInfra', 'BaseInfra')
        }
        foreach ($infraName in $infraNames) {
            if ($infraName -eq $primary.Name) { continue }
            $infraCfg = Resolve-ServiceConfig -Index $index -Name $infraName -Env $Environment -RepoRoot $repoRoot
            $infraRegion = $infraCfg.DefaultRegion
            Write-Host "---- Deploying prerequisite: $infraName ----" -ForegroundColor Cyan
            Invoke-ServiceDeploy -RepoRoot $repoRoot -Index $index -Config $infraCfg -Env $Environment -Region $infraRegion
        }
    }

    Invoke-ServiceDeploy -RepoRoot $repoRoot -Index $index -Config $primary -Env $Environment -Region $Region
    Write-Host "Done." -ForegroundColor Green
}
catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    throw
}
