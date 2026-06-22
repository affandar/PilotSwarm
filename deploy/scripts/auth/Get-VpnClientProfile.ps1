<#
.SYNOPSIS
    Downloads the Azure VPN Client profile (azurevpnconfig.xml) for a
    PilotSwarm VPN-enabled stamp and extracts it into the per-stamp
    local env folder.

.DESCRIPTION
    For stamps deployed with VPN_GATEWAY_ENABLED=true, this script
    resolves the gateway from the bicep outputs cache, calls
    `az network vnet-gateway vpn-client generate` to mint a fresh
    signed SAS URL, downloads the profile zip, and extracts it to:

        deploy/envs/local/<EnvName>/vpn-client/

    The key artifact for end users is:

        deploy/envs/local/<EnvName>/vpn-client/AzureVPN/azurevpnconfig.xml

    which imports directly into the Azure VPN Client app (Windows/macOS).

    The local env folder is gitignored (deploy/envs/.gitignore -> `local/`),
    so the profile never reaches git. Treat the XML as semi-sensitive: it
    contains the gateway public endpoint + AAD audience GUID, but no user
    credentials.

.PARAMETER EnvName
    The PilotSwarm stamp name (e.g. `chkrawvpn`). Required.
    The script reads VPN_GATEWAY_ID from
    deploy/.tmp/<EnvName>/bicep-outputs.cache.json.

.PARAMETER OutDir
    Optional override for the output directory. Default:
    deploy/envs/local/<EnvName>/vpn-client/

.PARAMETER Force
    Overwrite an existing vpn-client folder. Default: refuses to clobber.

.PARAMETER OpenFolder
    Open the output folder in Explorer after extraction (Windows only).

.EXAMPLE
    .\Get-VpnClientProfile.ps1 -EnvName chkrawvpn

    Downloads and extracts the VPN client profile to
    deploy/envs/local/chkrawvpn/vpn-client/.

.EXAMPLE
    .\Get-VpnClientProfile.ps1 -EnvName chkrawvpn -Force -OpenFolder

    Re-downloads (clobbers existing), opens the folder when done.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$EnvName,
    [Parameter(Mandatory=$false)][string]$OutDir,
    [Parameter(Mandatory=$false)][switch]$Force,
    [Parameter(Mandatory=$false)][switch]$OpenFolder
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $cur = Resolve-Path $here
    while ($cur -and -not (Test-Path (Join-Path $cur '.git'))) {
        $parent = Split-Path -Parent $cur
        if ($parent -eq $cur) { throw "Could not locate repo root from $here" }
        $cur = $parent
    }
    return $cur
}

function Test-AzureCliReady {
    $az = Get-Command az -ErrorAction SilentlyContinue
    if (-not $az) { Write-Error "Azure CLI ('az') not found in PATH."; return $false }
    $acct = az account show 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($acct)) {
        Write-Error "Not signed in. Run 'az login' first."
        return $false
    }
    return $true
}

Write-Host "Get-VpnClientProfile - Azure VPN client profile downloader" -ForegroundColor Green
Write-Host ""

if (-not (Test-AzureCliReady)) { throw "Azure CLI not ready." }

$repo = Get-RepoRoot
$cache = Join-Path $repo "deploy/.tmp/$EnvName/bicep-outputs.cache.json"
if (-not (Test-Path $cache)) {
    throw "bicep-outputs.cache.json not found at $cache. Has '$EnvName' been deployed yet?"
}

$outputs = Get-Content $cache -Raw | ConvertFrom-Json
if (-not ($outputs.PSObject.Properties.Name -contains 'VPN_GATEWAY_ID')) {
    throw "VPN_GATEWAY_ID missing from $cache. Is VPN_GATEWAY_ENABLED=true for '$EnvName'?"
}
$gwId = [string]$outputs.VPN_GATEWAY_ID
if ([string]::IsNullOrWhiteSpace($gwId)) {
    throw "VPN_GATEWAY_ID is empty in $cache. Is VPN_GATEWAY_ENABLED=true for '$EnvName'?"
}

# Parse `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworkGateways/<name>`
$gwName = $gwId.Split('/')[-1]
$gwRg = ($gwId -split '/resourceGroups/')[1].Split('/')[0]

Write-Host "Stamp        : $EnvName"
Write-Host "VPN gateway  : $gwName"
Write-Host "Resource grp : $gwRg"
Write-Host ""

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $repo "deploy/envs/local/$EnvName/vpn-client"
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

if (Test-Path $OutDir) {
    if (-not $Force) {
        Write-Error "Output directory already exists: $OutDir. Pass -Force to overwrite."
        exit 1
    }
    Write-Host "Removing existing $OutDir (-Force)..." -ForegroundColor Yellow
    Remove-Item $OutDir -Recurse -Force
}

Write-Host "Generating VPN client profile (this can take ~30-60s on first call)..." -ForegroundColor Yellow
$url = az network vnet-gateway vpn-client generate `
    --resource-group $gwRg `
    --name $gwName `
    --authentication-method EAPTLS `
    -o tsv 2>&1 | Where-Object { $_ -notmatch 'WARNING' } | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($url) -or ($url -notmatch '^https?://')) {
    throw "az network vnet-gateway vpn-client generate failed. Output: $url"
}
Write-Host "  OK: signed URL retrieved (SAS, ~1h validity)" -ForegroundColor Green

$tempZip = [System.IO.Path]::GetTempFileName() + ".zip"
try {
    Write-Host "Downloading profile zip..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing
    $zipBytes = (Get-Item $tempZip).Length
    Write-Host "  OK: $zipBytes bytes" -ForegroundColor Green

    Write-Host "Extracting to $OutDir ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    Expand-Archive -Path $tempZip -DestinationPath $OutDir -Force
    Write-Host "  OK: extracted" -ForegroundColor Green
} finally {
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
}

$xmlPath = Join-Path $OutDir "AzureVPN\azurevpnconfig.xml"
if (-not (Test-Path $xmlPath)) {
    Write-Warning "Expected AzureVPN/azurevpnconfig.xml not found under $OutDir. Inspect the contents manually."
} else {
    Write-Host ""
    Write-Host "=== VPN client profile ready ===" -ForegroundColor Green
    Write-Host "Profile XML : $xmlPath"
    Write-Host "Folder      : $OutDir"
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Install the Azure VPN Client (Microsoft Store on Windows; App Store on macOS)."
    Write-Host "  2. In the client: Import -> select $xmlPath"
    Write-Host "  3. Connect using your Entra ID account."
    Write-Host ""
    Write-Host "Distribution:"
    Write-Host "  - The profile XML is the same for every user (no per-user credentials)."
    Write-Host "  - Each end user still authenticates with their own Entra ID."
    Write-Host "  - The folder is under deploy/envs/local/ which is gitignored — never commit it."
    Write-Host ""
}

if ($OpenFolder -and $IsWindows -ne $false) {
    try { Start-Process explorer.exe -ArgumentList $OutDir } catch { Write-Warning "Could not open Explorer: $_" }
}
