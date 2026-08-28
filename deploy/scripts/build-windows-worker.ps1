<#
.SYNOPSIS
  Two-phase Windows worker image build (cached base + thin worker). Builds
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
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Registry,

    [string]$BaseTag   = 'latest',
    [string]$WorkerTag = 'dev',

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
    [switch]$UseAcrBuild
)

$ErrorActionPreference = 'Stop'

# Repo root = two levels up from deploy/scripts.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$loginServer  = "$Registry.azurecr.io"
$baseRepo     = 'pilotswarm-worker-base'
$workerRepo   = 'pilotswarm-worker-win'
$baseImageRef = "$loginServer/${baseRepo}:$BaseTag"

# -WorkerTags overrides the single -WorkerTag when provided (back-compat).
if (-not $WorkerTags -or $WorkerTags.Count -eq 0) { $WorkerTags = @($WorkerTag) }
$workerRefs = $WorkerTags | ForEach-Object { "$loginServer/${workerRepo}:$_" }

$mode      = if ($UseAcrBuild) { 'az acr build (server-side)' } else { 'docker build (local)' }
$published  = [bool]($Push -or $UseAcrBuild)

Write-Host "== PilotSwarm Windows worker build ==" -ForegroundColor Cyan
Write-Host "   registry : $loginServer"
Write-Host "   mode     : $mode"
Write-Host "   base     : ${baseRepo}:$BaseTag"
Write-Host "   worker   : $($WorkerTags -join ', ')"
Write-Host "   publish  : $published"
Write-Host "   repoRoot : $repoRoot"

# Local build/push needs the docker client authenticated to ACR (to pull the
# FROM base and to push). This is a token grab only — NOT a server-side build.
if (-not $UseAcrBuild) {
    Write-Host "`n[auth] az acr login --name $Registry" -ForegroundColor Yellow
    & az acr login --name $Registry
    if ($LASTEXITCODE) { throw "az acr login failed ($LASTEXITCODE)" }
}

# --- Phase 0: compile the SDK on the host (thin image COPYs sdk/dist) --------
if (-not $SkipSdkBuild) {
    Write-Host "`n[0/2] npm run build -w packages/sdk" -ForegroundColor Yellow
    Push-Location $repoRoot
    try { & npm run build -w packages/sdk; if ($LASTEXITCODE) { throw "SDK build failed ($LASTEXITCODE)" } }
    finally { Pop-Location }
} else {
    Write-Host "`n[0/2] SDK build skipped (-SkipSdkBuild)" -ForegroundColor DarkGray
}

# --- Phase 1: cached base image (slow; skipped if the tag already exists) -----
$baseExists = $false
if (-not $RebuildBase) {
    Write-Host "`n[1/2] checking for cached base $baseImageRef ..." -ForegroundColor Yellow
    $found = az acr repository show-tags --name $Registry --repository $baseRepo `
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
                '--image',"${baseRepo}:$BaseTag",
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
            & docker @buildArgs
            if ($LASTEXITCODE) { throw "local base build failed ($LASTEXITCODE)" }
            if ($Push) {
                Write-Host "      pushing base -> $baseImageRef" -ForegroundColor Yellow
                & docker push $baseImageRef
                if ($LASTEXITCODE) { throw "base push failed ($LASTEXITCODE)" }
            }
        }
    } finally { Pop-Location }
}

# --- Phase 2: thin worker image (fast inner loop) ----------------------------
Write-Host "`n[2/2] building thin worker -> $($workerRefs -join ', ')" -ForegroundColor Yellow
Push-Location $repoRoot
try {
    if ($UseAcrBuild) {
        $acrArgs = @('acr','build','--registry',$Registry,'--platform','windows')
        foreach ($t in $WorkerTags) { $acrArgs += @('--image', "${workerRepo}:$t") }
        $acrArgs += @(
            '--file','deploy/Dockerfile.worker.windows',
            '--build-arg',"WORKER_BASE_IMAGE=$baseImageRef",
            '--build-arg',"NPM_REGISTRY=$NpmRegistry",
            '.'
        )
        & az @acrArgs
        if ($LASTEXITCODE) { throw "worker build failed ($LASTEXITCODE)" }
    } else {
        $buildArgs = @('build')
        foreach ($r in $workerRefs) { $buildArgs += @('--tag', $r) }
        $buildArgs += @(
            '--file','deploy/Dockerfile.worker.windows',
            '--build-arg',"WORKER_BASE_IMAGE=$baseImageRef",
            '--build-arg',"NPM_REGISTRY=$NpmRegistry"
        )
        if ($Isolation) { $buildArgs += @('--isolation',$Isolation) }
        $buildArgs += '.'
        & docker @buildArgs
        if ($LASTEXITCODE) { throw "local worker build failed ($LASTEXITCODE)" }
        if ($Push) {
            foreach ($r in $workerRefs) {
                Write-Host "      pushing worker -> $r" -ForegroundColor Yellow
                & docker push $r
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
Write-Host "Set the worker tag as __IMAGE__ in the Windows git-repo-worker DaemonSet." -ForegroundColor Green
