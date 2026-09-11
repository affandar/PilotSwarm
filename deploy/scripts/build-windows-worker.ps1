<#
.SYNOPSIS
  Composable Windows worker image build (cached base + thin worker). Builds
  LOCALLY with `docker build` by default and pushes to ACR only with -Push.

.DESCRIPTION
  Windows worker images are the split-image design in
  docs/proposals/windows-worker-image-followup.md:

    Phase 1  pilotswarm-worker-base   (servercore + Node + MinGit + pwsh)
             SLOW (multi-GB servercore pull, per-file layer commits). Built
             ONCE and cached in ACR; rebuilt only when a tool version moves.

    Phase 2  pilotswarm-worker-win    (FROM the base + npm ci + COPY dist/)
             FAST (minutes). This is the inner loop — rerun it per code change.

  By default this script skips Phase 1 when the base tag already exists in the
  registry, so the common path is just the fast Phase 2. Pass -RebuildBase to
  force the base rebuild after bumping -NodeVersion / -GitVersion / -PwshVersion.

  Composition repositories can use -BaseOnly to obtain the canonical base,
  add private layers, then pass the resulting image back through
  -WorkerBaseImage. The thin SDK layer remains topmost in either mode.

  The thin worker COPYs packages/sdk/dist/, so the SDK is compiled on the host
  first (same as deploy/scripts/lib/build-image.mjs), then `.` is used as the
  local `docker build` context (.dockerignore keeps it to a few MB).

  BUILD LOCATION: local `docker build` is the default and the source of truth —
  a build must go green on your box before anything touches the registry. ACR is
  used only to (a) authenticate the docker client so the FROM base can be pulled
  and (b) receive `docker push` when you pass -Push. The old server-side path is
  still available behind -UseAcrBuild (which necessarily publishes to ACR).

.PARAMETER Registry
  ACR name WITHOUT the .azurecr.io suffix (e.g. 'mycontainerregistry'). Required
  — no registry host name is baked into this repo.

.EXAMPLE
  # Inner loop: build the thin worker LOCALLY (base pulled from ACR), no push.
  ./build-windows-worker.ps1 -Registry myacr -WorkerTag dev2

.EXAMPLE
  # Build locally, then publish current + an immutable dated tag to ACR.
  ./build-windows-worker.ps1 -Registry myacr -WorkerTags current,az-devbox-20260828 -Push

.EXAMPLE
  # First time (or after a tool bump): build base + worker locally and push.
  ./build-windows-worker.ps1 -Registry myacr -RebuildBase -WorkerTag dev1 -Push

.EXAMPLE
  # Escape hatch: build server-side with `az acr build` (publishes to ACR).
  ./build-windows-worker.ps1 -Registry myacr -WorkerTag dev3 -UseAcrBuild

.EXAMPLE
  # Composition flow: publish/reuse the platform base, add external layers,
  # then place the platform SDK layer on top of the externally composed image.
  $base = ./build-windows-worker.ps1 -Registry myacr -BaseTag stable -BaseOnly -UseAcrBuild |
    Select-Object -Last 1
  ./build-windows-worker.ps1 -Registry myacr -WorkerBaseImage $privateLayers `
    -WorkerTag composed -Push
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Registry,

    [string]$BaseTag   = 'latest',
    [string]$WorkerTag = 'dev',

    # Build/reuse only the canonical OS+runtime base and emit its full image
    # reference. A composition repository can add layers before invoking this
    # script again with -WorkerBaseImage.
    [switch]$BaseOnly,

    # Override the image beneath the thin SDK layer. When set, Phase 1 is
    # skipped entirely; the supplied image may include composition-owned tools.
    [string]$WorkerBaseImage,

    # Image repositories are configurable so composition repositories can keep
    # intermediate and final images under their own naming policy.
    [string]$BaseRepo = 'pilotswarm-worker-base',
    [string]$WorkerRepo = 'pilotswarm-worker-win',

    # One or more worker tags to produce (first is primary). Overrides -WorkerTag
    # when set; e.g. -WorkerTags current,az-devbox-20260828 stamps an immutable
    # dated tag alongside the mutable 'current'.
    [string[]]$WorkerTags,

    # Tool versions for the base image (only used when the base is (re)built).
    # Keep NodeVersion tracking the Linux base's Node 24 line.
    [string]$NodeVersion = '24.8.0',
    [string]$GitVersion  = '2.47.1',
    [string]$PwshVersion = '7.4.6',

    # Optional npm mirror for networks that can't reach registry.npmjs.org.
    [string]$NpmRegistry = 'https://registry.npmjs.org/',

    # Force the (slow) base rebuild even if the tag already exists.
    [switch]$RebuildBase,

    # Skip the host-side SDK compile (only safe if packages/sdk/dist is current).
    [switch]$SkipSdkBuild,

    [string]$WindowsTag = 'ltsc2022',

    # Windows container isolation for the LOCAL docker build. '' = daemon default
    # (process on Server hosts, hyperv on client hosts). Force 'process' for speed
    # on a matching Server 2022 host, or 'hyperv' for cross-build compatibility.
    [ValidateSet('', 'process', 'hyperv')]
    [string]$Isolation = '',

    # Publish the locally built images to ACR after a successful build. Local
    # build is always the source of truth; ACR is only ever a push destination
    # (never a server-side builder) unless -UseAcrBuild is given.
    [switch]$Push,

    # Escape hatch: build server-side with `az acr build` instead of local
    # `docker build` (the pre-refactor behaviour). Implies publishing to ACR.
    [switch]$UseAcrBuild,

    # Max seconds to wait for Docker Desktop and the Windows engine.
    [int]$DaemonTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

function Resolve-DockerExe {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($path in @(
        "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe",
        'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    )) {
        if (Test-Path $path) { return $path }
    }
    throw 'docker CLI not found on PATH or in known Docker Desktop install locations.'
}

function Resolve-DockerCliExe {
    foreach ($path in @(
        "$env:LOCALAPPDATA\Programs\DockerDesktop\DockerCli.exe",
        'C:\Program Files\Docker\Docker\DockerCli.exe'
    )) {
        if (Test-Path $path) { return $path }
    }
    return $null
}

function Resolve-DockerDesktopExe {
    foreach ($path in @(
        "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe",
        'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    )) {
        if (Test-Path $path) { return $path }
    }
    return $null
}

function Get-DockerServerOs {
    param([string]$Docker)
    $serverOs = & $Docker version --format '{{.Server.Os}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $serverOs) { return $serverOs.Trim() }
    return $null
}

function Wait-DockerServerOs {
    param([string]$Docker, [string]$WantOs, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-DockerServerOs -Docker $Docker) -eq $WantOs) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Initialize-WindowsDocker {
    param([int]$TimeoutSec)
    $docker = Resolve-DockerExe
    if (-not (Get-DockerServerOs -Docker $docker)) {
        $desktop = Resolve-DockerDesktopExe
        if (-not $desktop) {
            throw 'Docker daemon is unavailable and Docker Desktop.exe was not found. Start a Windows container engine and retry.'
        }
        Write-Host "Docker daemon is down; launching $desktop" -ForegroundColor Yellow
        Start-Process -FilePath $desktop | Out-Null
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline -and -not (Get-DockerServerOs -Docker $docker)) {
            Start-Sleep -Seconds 3
        }
        if (-not (Get-DockerServerOs -Docker $docker)) {
            throw "Docker Desktop did not start within ${TimeoutSec}s."
        }
    }
    if ((Get-DockerServerOs -Docker $docker) -ne 'windows') {
        $dockerCli = Resolve-DockerCliExe
        if (-not $dockerCli) {
            throw 'Docker is not using Windows containers and DockerCli.exe was not found. Switch Docker Desktop to Windows containers and retry.'
        }
        Write-Host "Switching Docker Desktop to the Windows engine." -ForegroundColor Yellow
        & $dockerCli -SwitchWindowsEngine | Out-Null
        if (-not (Wait-DockerServerOs -Docker $docker -WantOs 'windows' -TimeoutSec $TimeoutSec)) {
            throw "Docker Desktop did not switch to the Windows engine within ${TimeoutSec}s."
        }
    }
    return $docker
}

if ($BaseOnly -and $WorkerBaseImage) {
    throw '-BaseOnly and -WorkerBaseImage are mutually exclusive.'
}
if ($WorkerBaseImage -and $RebuildBase) {
    throw '-RebuildBase cannot be used with -WorkerBaseImage because the platform base phase is skipped.'
}

# Repo root = two levels up from deploy/scripts.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$loginServer = "$Registry.azurecr.io"
$baseImageRef = "$loginServer/${BaseRepo}:$BaseTag"

# -WorkerTags overrides the single -WorkerTag when provided (back-compat).
if (-not $WorkerTags -or $WorkerTags.Count -eq 0) { $WorkerTags = @($WorkerTag) }
$workerRefs = @($WorkerTags | ForEach-Object { "$loginServer/${WorkerRepo}:$_" })
$mode = if ($UseAcrBuild) { 'az acr build (server-side)' } else { 'docker build (local)' }
$published = [bool]($Push -or $UseAcrBuild)

Write-Host "== PilotSwarm Windows worker build ==" -ForegroundColor Cyan
Write-Host "   registry : $loginServer"
Write-Host "   mode     : $mode"
Write-Host "   base     : $(if ($WorkerBaseImage) { "$WorkerBaseImage (external composition)" } else { "${BaseRepo}:$BaseTag" })"
Write-Host "   worker   : $(if ($BaseOnly) { '(skipped: base only)' } else { $WorkerTags -join ', ' })"
Write-Host "   publish  : $published"
Write-Host "   repoRoot : $repoRoot"

# Local build/push needs the docker client authenticated to ACR (to pull the
# FROM base and to push). This is a token grab only — NOT a server-side build.
if (-not $UseAcrBuild) {
    $docker = Initialize-WindowsDocker -TimeoutSec $DaemonTimeoutSec
    Write-Host "`n[auth] az acr login --name $Registry" -ForegroundColor Yellow
    & az acr login --name $Registry
    if ($LASTEXITCODE) { throw "az acr login failed ($LASTEXITCODE)" }
}

# --- Phase 1: cached platform base (skipped for an external composed base) ----
if (-not $WorkerBaseImage) {
    $baseExists = $false
    if (-not $RebuildBase) {
        Write-Host "`n[1/2] checking for cached base $baseImageRef ..." -ForegroundColor Yellow
        $found = az acr repository show-tags --name $Registry --repository $BaseRepo `
                    --query "[?@=='$BaseTag'] | [0]" -o tsv 2>$null
        if ($found -eq $BaseTag) { $baseExists = $true }
    }

    if ($baseExists) {
        Write-Host "      base tag present in ACR -> skipping base build (use -RebuildBase to force)" -ForegroundColor Green
        Write-Host "      (local worker build pulls it via the FROM if not already cached locally)" -ForegroundColor DarkGray
    } else {
        Write-Host "`n[1/2] building base (SLOW; ~10-20 min) -> $baseImageRef" -ForegroundColor Yellow
        Push-Location $repoRoot
        try {
            if ($UseAcrBuild) {
                $acrArgs = @(
                    'acr','build','--registry',$Registry,'--platform','windows',
                    '--image',"${BaseRepo}:$BaseTag",
                    '--file','deploy/Dockerfile.worker-base.windows',
                    '--build-arg',"WINDOWS_TAG=$WindowsTag",
                    '--build-arg',"NODE_VERSION=$NodeVersion",
                    '--build-arg',"GIT_VERSION=$GitVersion",
                    '--build-arg',"PWSH_VERSION=$PwshVersion",
                    '.'
                )
                & az @acrArgs
                if ($LASTEXITCODE) { throw "base build failed ($LASTEXITCODE)" }
            } else {
                $buildArgs = @(
                    'build',
                    '--file','deploy/Dockerfile.worker-base.windows',
                    '--build-arg',"WINDOWS_TAG=$WindowsTag",
                    '--build-arg',"NODE_VERSION=$NodeVersion",
                    '--build-arg',"GIT_VERSION=$GitVersion",
                    '--build-arg',"PWSH_VERSION=$PwshVersion",
                    '--tag',$baseImageRef
                )
                if ($Isolation) { $buildArgs += @('--isolation',$Isolation) }
                $buildArgs += '.'
                & $docker @buildArgs
                if ($LASTEXITCODE) { throw "local base build failed ($LASTEXITCODE)" }
                if ($Push) {
                    Write-Host "      pushing base -> $baseImageRef" -ForegroundColor Yellow
                    & $docker push $baseImageRef
                    if ($LASTEXITCODE) { throw "base push failed ($LASTEXITCODE)" }
                }
            }
        } finally { Pop-Location }
    }
}

if ($BaseOnly) {
    Write-Host "`nDone. Base image: $baseImageRef" -ForegroundColor Green
    Write-Output $baseImageRef
    return
}

$effectiveWorkerBase = if ($WorkerBaseImage) { $WorkerBaseImage } else { $baseImageRef }
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE) { throw "git rev-parse HEAD failed ($LASTEXITCODE)" }
$buildId = $WorkerTags[0]

# --- Phase 0: compile the SDK on the host (thin image COPYs sdk/dist) --------
if (-not $SkipSdkBuild) {
    Write-Host "`n[0/2] npm run build -w packages/sdk" -ForegroundColor Yellow
    Push-Location $repoRoot
    try { & npm run build -w packages/sdk; if ($LASTEXITCODE) { throw "SDK build failed ($LASTEXITCODE)" } }
    finally { Pop-Location }
} else {
    Write-Host "`n[0/2] SDK build skipped (-SkipSdkBuild)" -ForegroundColor DarkGray
}

# --- Phase 2: thin SDK worker image (always topmost) -------------------------
Write-Host "`n[2/2] building thin worker FROM $effectiveWorkerBase -> $($workerRefs -join ', ')" -ForegroundColor Yellow
Push-Location $repoRoot
try {
    if ($UseAcrBuild) {
        $acrArgs = @('acr','build','--registry',$Registry,'--platform','windows')
        foreach ($t in $WorkerTags) { $acrArgs += @('--image', "${WorkerRepo}:$t") }
        $acrArgs += @(
            '--file','deploy/Dockerfile.worker.windows',
            '--build-arg',"WORKER_BASE_IMAGE=$effectiveWorkerBase",
            '--build-arg',"NPM_REGISTRY=$NpmRegistry",
            '--build-arg',"PILOTSWARM_SOURCE_COMMIT=$sourceCommit",
            '--build-arg',"PILOTSWARM_BUILD_ID=$buildId",
            '.'
        )
        & az @acrArgs
        if ($LASTEXITCODE) { throw "worker build failed ($LASTEXITCODE)" }
    } else {
        $buildArgs = @('build')
        foreach ($r in $workerRefs) { $buildArgs += @('--tag', $r) }
        $buildArgs += @(
            '--file','deploy/Dockerfile.worker.windows',
            '--build-arg',"WORKER_BASE_IMAGE=$effectiveWorkerBase",
            '--build-arg',"NPM_REGISTRY=$NpmRegistry",
            '--build-arg',"PILOTSWARM_SOURCE_COMMIT=$sourceCommit",
            '--build-arg',"PILOTSWARM_BUILD_ID=$buildId"
        )
        if ($Isolation) { $buildArgs += @('--isolation',$Isolation) }
        $buildArgs += '.'
        & $docker @buildArgs
        if ($LASTEXITCODE) { throw "local worker build failed ($LASTEXITCODE)" }
        if ($Push) {
            foreach ($r in $workerRefs) {
                Write-Host "      pushing worker -> $r" -ForegroundColor Yellow
                & $docker push $r
                if ($LASTEXITCODE) { throw "worker push failed for $r ($LASTEXITCODE)" }
            }
        }
    }
} finally { Pop-Location }

Write-Host "`nDone. Worker image(s): $($workerRefs -join ', ')" -ForegroundColor Green
if (-not $published) {
    Write-Host "Built locally, NOT pushed. Publish with:" -ForegroundColor Yellow
    foreach ($r in $workerRefs) { Write-Host "   docker push $r" -ForegroundColor Yellow }
}
Write-Host "Pass the complete image reference to the deployment service." -ForegroundColor Green
Write-Output $workerRefs[0]
