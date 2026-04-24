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
#   4. `az` on PATH (for `az bicep build`). `docker buildx` + `gzip`
#      (or PowerShell GZipStream on Windows) only required when
#      -BuildImage is used — the image tarball is bundled as an EV2
#      service artifact, not pre-pushed to a holding ACR.
#
# Side effects:
#   - Writes under deploy/ev2/.staging/ (gitignored; safe to delete).
#   - Optionally runs `az bicep build` and/or builds+exports a container
#     image into the staged SG artifact at ContainerImages/<repo>.tar.gz.
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

    # Build + export the service's container image as a tarball and stage
    # it into the EV2 ServiceGroup artifact at
    # <sgRoot>/ContainerImages/<imageName>.tar.gz. EV2's UploadContainer
    # shell extension wgets that path (via a SAS URL minted by EV2 from
    # the scope-binding `reference`) and pushes it to the target ACR
    # using oras. Requires local `docker buildx` and `gzip`. Only
    # meaningful for Worker/Portal. Image tag comes from version.txt
    # (i.e. $buildVersion() at rollout time).
    [switch]$BuildImage,

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

function Invoke-ImageBuildExport {
    # Build the service's image locally and export it as a gzipped
    # tarball into the staged SG tree at ContainerImages/<repo>.tar.gz,
    # so it travels inside the EV2 service artifact and gets uploaded
    # by `Register-AzureServiceArtifacts`. This mirrors the official
    # Microsoft/fleet-manager pattern (tar artifact + oras push at
    # rollout time), not a holding-ACR pre-push.
    param([string]$RepoRoot, $Config, [string]$StagedSgRoot, [string]$Tag)
    if (-not $Config.DockerImageRepo) {
        Write-Host "[$($Config.Name)] no dockerImageRepo in service.json, skipping image build." -ForegroundColor DarkGray
        return
    }
    if (-not $Config.Dockerfile) { throw "dockerfile missing from service.json for $($Config.Name)." }
    $dockerfileAbs = Join-Path $RepoRoot $Config.Dockerfile

    $tempTag = "$($Config.DockerImageRepo):$Tag"
    Write-Host "[$($Config.Name)] docker buildx build --platform linux/amd64 --load -t $tempTag -f $dockerfileAbs $RepoRoot"
    & docker buildx build --platform linux/amd64 --load -t $tempTag -f $dockerfileAbs $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw "docker buildx build failed for $($Config.Name)." }

    $imagesDir = Join-Path $StagedSgRoot 'ContainerImages'
    if (Test-Path $imagesDir) { Remove-Item $imagesDir -Recurse -Force }
    New-Item -ItemType Directory -Path $imagesDir -Force | Out-Null

    $tarPath = Join-Path $imagesDir "$($Config.DockerImageRepo).tar"
    Write-Host "[$($Config.Name)] docker save -o $tarPath $tempTag"
    & docker save -o $tarPath $tempTag
    if ($LASTEXITCODE -ne 0) { throw "docker save failed for $($Config.Name)." }

    $gzPath = "$tarPath.gz"
    if (Test-Path $gzPath) { Remove-Item $gzPath -Force }
    Write-Host "[$($Config.Name)] gzipping image tarball -> $gzPath"
    # Prefer gzip if available; fall back to .NET GZipStream on Windows dev boxes.
    $gzipCmd = Get-Command gzip -ErrorAction SilentlyContinue
    if ($gzipCmd) {
        & gzip -f $tarPath
        if ($LASTEXITCODE -ne 0) { throw "gzip failed for $tarPath." }
    } else {
        $in = [System.IO.File]::OpenRead($tarPath)
        try {
            $out = [System.IO.File]::Create($gzPath)
            try {
                $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
                try { $in.CopyTo($gz) } finally { $gz.Dispose() }
            } finally { $out.Dispose() }
        } finally { $in.Dispose() }
        Remove-Item $tarPath -Force
    }

    Write-Host "[$($Config.Name)] staged image tarball at $gzPath" -ForegroundColor DarkGray
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

    # Mirror the Common/ assets the per-service SG depends on into the
    # staged tree so the resulting EV2 artifact is self-contained. The
    # rollout-parameter `package.reference.path` values point at zip
    # files at the SG root (UploadContainer.zip, DeployApplicationManifest.zip,
    # manifests.zip); the Parameters/DeployApplicationManifest.parameters.json
    # is a loose artifact uploaded alongside them and re-written by
    # scope-binding token substitution at artifact-upload time.
    New-DeployPackages -RepoRoot $RepoRoot -Config $Config -StagedSgRoot $staging

    return $staging
}

function New-ZipFromFiles {
    param([string]$ZipPath, [string[]]$Files)
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path $Files -DestinationPath $ZipPath -Force
}

function New-ZipFromFolder {
    param([string]$ZipPath, [string]$FolderPath)
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    # Compress-Archive with a trailing '*' puts children at the archive
    # root instead of nesting under the folder name. This matches the
    # FM MSBuild-assembled zips (manifests.zip root = base/, overlays/).
    Compress-Archive -Path (Join-Path $FolderPath '*') -DestinationPath $ZipPath -Force
}

function New-DeployPackages {
    # Assemble the three EV2 shell-extension artifacts referenced by the
    # SG's rollout-parameter files:
    #
    #   <SgRoot>/UploadContainer.zip             — UploadContainer.sh
    #   <SgRoot>/DeployApplicationManifest.zip   — DeployApplicationManifest.sh
    #                                              + GenerateEnvForEv2.ps1
    #   <SgRoot>/manifests.zip                   — service gitops tree
    #                                              (base/ + overlays/<env>/)
    #
    # The loose parameters JSON
    # (<SgRoot>/Parameters/DeployApplicationManifest.parameters.json) is
    # copied in via Common/ and then replaced by EV2 when the per-service
    # scope-binding is applied at artifact upload (enableScopeTagBindings).
    param([string]$RepoRoot, $Config, [string]$StagedSgRoot)

    $commonScripts = Join-Path $RepoRoot 'deploy/ev2/Common/scripts'
    $commonParams  = Join-Path $RepoRoot 'deploy/ev2/Common/Parameters'

    foreach ($needed in 'UploadContainer.sh', 'DeployApplicationManifest.sh', 'GenerateEnvForEv2.ps1') {
        $p = Join-Path $commonScripts $needed
        if (-not (Test-Path $p)) { throw "Common script missing: $p" }
    }

    # 1) UploadContainer.zip
    $uploadZip = Join-Path $StagedSgRoot 'UploadContainer.zip'
    New-ZipFromFiles -ZipPath $uploadZip -Files @((Join-Path $commonScripts 'UploadContainer.sh'))
    Write-Host "[$($Config.Name)] packaged $uploadZip" -ForegroundColor DarkGray

    # 2) DeployApplicationManifest.zip
    $deployZip = Join-Path $StagedSgRoot 'DeployApplicationManifest.zip'
    New-ZipFromFiles -ZipPath $deployZip -Files @(
        (Join-Path $commonScripts 'DeployApplicationManifest.sh'),
        (Join-Path $commonScripts 'GenerateEnvForEv2.ps1')
    )
    Write-Host "[$($Config.Name)] packaged $deployZip" -ForegroundColor DarkGray

    # 3) manifests.zip — assembled-to-temp then zipped (no pre-render).
    # Contains the service's gitops tree (base/ + overlays/<env>/) at the
    # zip root so DeployApplicationManifest.sh can cd into the unzipped
    # 'manifests/' directory and resolve `$DEPLOYMENT_OVERLAY_PATH/.env`
    # (e.g. 'overlays/dev/.env'). Flux reads the same layout from the
    # blob container (kustomizationPath = 'overlays/<env>').
    if ($Config.KustomizeOverlay) {
        # Derive the per-service gitops root: strip the trailing
        # 'overlays/<env>' from kustomizeOverlay to get e.g.
        # deploy/gitops/worker.
        $overlayAbs = Join-Path $RepoRoot $Config.KustomizeOverlay
        $svcGitopsRoot = Split-Path (Split-Path $overlayAbs -Parent) -Parent
        if (-not (Test-Path $svcGitopsRoot)) { throw "Service gitops root not found: $svcGitopsRoot" }
        $manifestAssembly = Join-Path $StagedSgRoot '.manifest-assembly'
        if (Test-Path $manifestAssembly) { Remove-Item $manifestAssembly -Recurse -Force }
        New-Item -ItemType Directory -Path $manifestAssembly -Force | Out-Null
        Copy-Item -Recurse -Path (Join-Path $svcGitopsRoot '*') -Destination $manifestAssembly
        $manifestsZip = Join-Path $StagedSgRoot 'manifests.zip'
        New-ZipFromFolder -ZipPath $manifestsZip -FolderPath $manifestAssembly
        Remove-Item $manifestAssembly -Recurse -Force
        Write-Host "[$($Config.Name)] packaged $manifestsZip (source: $svcGitopsRoot)" -ForegroundColor DarkGray
    }

    # 4) Loose parameters JSON staged under Parameters/ next to the
    # rollout-parameter files. EV2 substitutes the __TOKENS__ here
    # because the corresponding environmentVariable reference has
    # enableScopeTagBindings=true.
    #
    # The two rollout-parameter files (UploadContainer.Linux.Rollout.json
    # and DeployApplicationManifest.Linux.Rollout.json) are also shared
    # across services — they're pure __TOKEN__ templates resolved by
    # each service's scopeBinding.json. Materialize them into the
    # staged Parameters/ directory so EV2 sees them at the path
    # serviceModel.json's `rolloutParametersPath` expects.
    $sharedParamFiles = @(
        'DeployApplicationManifest.parameters.json',
        'UploadContainer.Linux.Rollout.json',
        'DeployApplicationManifest.Linux.Rollout.json'
    )
    $stagedParamsDir = Join-Path $StagedSgRoot 'Parameters'
    if (-not (Test-Path $stagedParamsDir)) { New-Item -ItemType Directory -Path $stagedParamsDir -Force | Out-Null }
    foreach ($f in $sharedParamFiles) {
        $src = Join-Path $commonParams $f
        if (-not (Test-Path $src)) { throw "Common parameters file missing: $src" }
        $dst = Join-Path $stagedParamsDir $f
        if (Test-Path $dst) {
            # A service-local copy was staged from the SG tree first.
            # Respect it — divergence is intentional.
            Write-Host "[$($Config.Name)] kept service-local $dst (overrides Common/)" -ForegroundColor DarkYellow
            continue
        }
        Copy-Item -Path $src -Destination $dst
        Write-Host "[$($Config.Name)] staged $dst" -ForegroundColor DarkGray
    }
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
    }

    $staging = New-Staging -RepoRoot $RepoRoot -Config $Config
    $artifactsVersion = Get-ArtifactsVersion -SgRootAbs $staging

    # Export the image into the staged SG tree AFTER staging copies the
    # source SG (so we write into .staging and never pollute the repo).
    # The tag matches ArtifactsVersion so EV2's $buildVersion() token
    # resolves to the same value at rollout time.
    if (-not $SkipBuild -and $BuildImage) {
        Invoke-ImageBuildExport -RepoRoot $RepoRoot -Config $Config -StagedSgRoot $staging -Tag $artifactsVersion
    }

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
