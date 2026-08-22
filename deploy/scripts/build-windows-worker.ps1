<#
.SYNOPSIS
  Two-phase Windows worker image build (cached base + thin worker) via ACR.

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
  first (same as deploy/scripts/lib/build-image.mjs), then `.` is uploaded as
  the ACR build context (.dockerignore keeps it to a few MB).

.PARAMETER Registry
  ACR name WITHOUT the .azurecr.io suffix (e.g. 'mycontainerregistry'). Required
  — no registry host name is baked into this repo.

.EXAMPLE
  # First time (or after a tool bump): build base + worker.
  ./build-windows-worker.ps1 -Registry myacr -RebuildBase -WorkerTag dev1

.EXAMPLE
  # Inner loop: base already cached, just rebuild the thin worker.
  ./build-windows-worker.ps1 -Registry myacr -WorkerTag dev2
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Registry,

    [string]$BaseTag   = 'latest',
    [string]$WorkerTag = 'dev',

    # Tool versions for the base image (only used when the base is (re)built).
    # Keep NodeVersion tracking the Linux base's Node 24 line.
    [string]$NodeVersion = '24.8.0',
    [string]$GitVersion  = '2.47.1',
    [string]$PwshVersion = '7.4.6',

    # Optional npm mirror for networks that can't reach registry.npmjs.org.
    [string]$NpmRegistry = 'https://registry.npmjs.org/',

    # Force the slow base rebuild even if the tag already exists.
    [switch]$RebuildBase,

    # Skip the host-side SDK compile (only safe if packages/sdk/dist is current).
    [switch]$SkipSdkBuild,

    [string]$WindowsTag = 'ltsc2022'
)

$ErrorActionPreference = 'Stop'

# Repo root = two levels up from deploy/scripts.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$loginServer = "$Registry.azurecr.io"
$baseRepo   = 'pilotswarm-worker-base'
$workerRepo = 'pilotswarm-worker-win'
$baseImageRef = "$loginServer/${baseRepo}:$BaseTag"

Write-Host "== PilotSwarm Windows worker build ==" -ForegroundColor Cyan
Write-Host "   registry : $loginServer"
Write-Host "   base     : ${baseRepo}:$BaseTag"
Write-Host "   worker   : ${workerRepo}:$WorkerTag"
Write-Host "   repoRoot : $repoRoot"

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
    Write-Host "      base tag present -> skipping slow base build (use -RebuildBase to force)" -ForegroundColor Green
} else {
    Write-Host "`n[1/2] building base (SLOW; ~10-20 min) -> $baseImageRef" -ForegroundColor Yellow
    Push-Location $repoRoot
    try {
        & az acr build `
            --registry $Registry `
            --platform windows `
            --image "${baseRepo}:$BaseTag" `
            --file deploy/Dockerfile.worker-base.windows `
            --build-arg "WINDOWS_TAG=$WindowsTag" `
            --build-arg "NODE_VERSION=$NodeVersion" `
            --build-arg "GIT_VERSION=$GitVersion" `
            --build-arg "PWSH_VERSION=$PwshVersion" `
            .
        if ($LASTEXITCODE) { throw "base build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

# --- Phase 2: thin worker image (fast inner loop) ----------------------------
Write-Host "`n[2/2] building thin worker -> $loginServer/${workerRepo}:$WorkerTag" -ForegroundColor Yellow
Push-Location $repoRoot
try {
    & az acr build `
        --registry $Registry `
        --platform windows `
        --image "${workerRepo}:$WorkerTag" `
        --file deploy/Dockerfile.worker.windows `
        --build-arg "WORKER_BASE_IMAGE=$baseImageRef" `
        --build-arg "NPM_REGISTRY=$NpmRegistry" `
        .
    if ($LASTEXITCODE) { throw "worker build failed ($LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host "`nDone. Worker image: $loginServer/${workerRepo}:$WorkerTag" -ForegroundColor Green
Write-Host "Set this as __IMAGE__ in the Windows git-repo-worker DaemonSet." -ForegroundColor Green
