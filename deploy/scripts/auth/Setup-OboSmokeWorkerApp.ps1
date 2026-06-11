<#
.SYNOPSIS
    Creates (or updates) the per-stamp Entra "smoke worker" app registration
    that the OBO live-smoke harness exchanges tokens against.

.DESCRIPTION
    Opinionated wrapper that produces the exact downstream-worker app shape
    the OBO smoke plugin expects when OBO_SMOKE_ENABLED=true:

    - signInAudience: AzureADMyOrg (single-tenant)
    - serviceManagementReference: supplied via -ServiceTreeId (REQUIRED)
    - Exposes an OAuth2 delegated scope (default "user_impersonation") under
      identifierUri "api://<appId>"; the resulting api://<appId>/.default
      is what the portal acquires a token *for* (the "upstream audience").
    - requestedAccessTokenVersion = 2 (so issued tokens are v2, compatible
      with @azure/msal-node acquireTokenOnBehalfOf in the worker).
    - requiredResourceAccess: Microsoft Graph delegated `User.Read`. The
      OBO exchange in the worker calls
      `acquireTokenOnBehalfOf({ scopes: ["https://graph.microsoft.com/User.Read"] })`;
      without this declaration the exchange returns AADSTS65001 even with
      pre-authorization in place. (`-GrantAdminConsent` optionally runs
      `az ad app permission admin-consent` when the running principal is
      Global Admin; otherwise the tenant admin grants consent once
      out-of-band per tenant.)
    - api.preAuthorizedApplications: the per-stamp PORTAL app's clientId,
      pre-authorized for the new delegated scope. This avoids an
      AADSTS65001 user-consent prompt at runtime when the portal acquires
      the worker-audienced token. The array is OVERWRITTEN (not merged)
      with a single-element list — each stamp has a strict 1:1
      portal-app -> worker-app relationship, so merging would risk
      leaving orphaned trust for rotated/deleted portal apps.
    - AKS workload-identity federated identity credential on the
      *Application* (not on a UAMI), so the worker pod's projected
      service-account token can be exchanged for a confidential-client
      assertion against this app. Subject defaults to
      `system:serviceaccount:pilotswarm:copilot-runtime-worker`, audience
      `api://AzureADTokenExchange`. The script reads the AKS OIDC issuer
      URL from `deploy/.tmp/<EnvName>/bicep-outputs.cache.json` (so run
      bicep first).

    Idempotency: re-runs are no-ops. The script looks up by display name
    first (override with -ExistingAppId), reuses the existing
    OAuth2PermissionScope id rather than minting a fresh GUID, and
    create-or-patches the FIC by deterministic name.

    Side-effects (strictly):
      (a) creates/updates the Entra app with scope, Graph User.Read,
          and pre-authorization;
      (b) creates/patches the AKS-trust FIC;
      (c) writes a JSON sidecar at -OutputFile;
      (d) prints exactly four KEY=value lines to stdout that the
          operator (or the npm-deployer agent via the `edit` tool) must
          paste into the per-stamp .env file.

    NEVER MODIFIES .env. The single-actor-on-.env invariant is preserved:
    `new-env.mjs` (scaffold), `compose-env.mjs` (bicep-output fold), and
    the operator/agent (paste) are the only mutators. Adding a PowerShell
    .env editor — even a small reusable one — invites the same pattern in
    every future auth wrapper and erodes that invariant.

.PARAMETER ServiceTreeId
    REQUIRED. Service Tree ID for your service, written as the
    serviceManagementReference on the app registration. Microsoft tenant
    policy requires every app registration to carry a valid Service Tree
    reference. There is intentionally no default — supply your own.

.PARAMETER EnvName
    REQUIRED. Stamp name (e.g. mystamp). Used to:
    - derive the default display name
    - derive the default sidecar output path
    - locate the AKS OIDC issuer URL in the per-stamp bicep cache
    - locate the per-stamp portal entra-app.json (for portal clientId)

.PARAMETER DisplayName
    Display name for the app registration. Default:
    "PilotSwarm OBO Smoke Worker - <EnvName>".

.PARAMETER ExistingAppId
    If provided, the script will NOT create a new app. Instead it
    looks up by appId, patches scope/pre-auth/Graph-permission as needed,
    and create-or-patches the FIC. Use this when display-name lookup
    misbehaves (rare) or when you intentionally want to point at a
    pre-existing app you authored manually.

.PARAMETER PortalClientId
    Clientid (appId) of the per-stamp PORTAL app that will be
    pre-authorized to receive worker-audienced tokens. If omitted,
    the script reads `deploy/envs/local/<EnvName>/entra-app.json`
    (written by Setup-PortalAuth.ps1). Fail-fast if neither resolves.

.PARAMETER GraphScope
    Downstream OBO target scope. Default
    `https://graph.microsoft.com/User.Read`. Overridable for future
    smoke profiles targeting non-Graph downstream services.

.PARAMETER ServiceAccountNamespace
    Kubernetes namespace the worker pod runs in. Default "pilotswarm".
    Matches `deploy/services/base-infra/bicep/main.bicep` namespace
    derivation and `deploy/gitops/worker/base/service-account.yaml`.

.PARAMETER ServiceAccountName
    Kubernetes service account name the worker pod uses. Default
    "copilot-runtime-worker". Matches
    `deploy/gitops/worker/base/service-account.yaml`.

.PARAMETER GrantAdminConsent
    Switch (default off). When set, runs
    `az ad app permission admin-consent --id <appId>` after wiring
    Graph `User.Read`. Only meaningful when the running principal is
    a tenant Global Admin; harmless to set in lower-permission contexts
    (the consent call will warn and the script continues — the tenant
    admin can grant consent out-of-band).

.PARAMETER Owner
    Object ID of the user to set as application owner. Defaults to the
    currently signed-in Azure CLI user.

.PARAMETER OutputFile
    Path to write the JSON sidecar
    `{ tenantId, clientId, scope, graphScope, ficName, ficSubject,
       portalClientId, displayName, envName, serviceTreeId, createdAt }`.
    Defaults to `deploy/envs/local/<EnvName>/obo-smoke-worker-app.json`.

.EXAMPLE
    .\Setup-OboSmokeWorkerApp.ps1 -ServiceTreeId <your-service-tree-id> -EnvName <env-name>

    Creates (or finds) "PilotSwarm OBO Smoke Worker - <env-name>", wires
    the OAuth2 scope, pre-authorizes the portal app from
    deploy/envs/local/<env-name>/entra-app.json, creates the AKS FIC
    against the OIDC issuer in deploy/.tmp/<env-name>/bicep-outputs.cache.json,
    writes deploy/envs/local/<env-name>/obo-smoke-worker-app.json, and
    prints the five .env lines to paste.

.EXAMPLE
    .\Setup-OboSmokeWorkerApp.ps1 -ServiceTreeId <your-service-tree-id> `
        -EnvName <env-name> `
        -PortalClientId 11111111-2222-3333-4444-555555555555 `
        -GrantAdminConsent

    Same, with an explicit portal clientId override (skip the sidecar
    read) and an attempt to grant tenant-wide admin consent for the
    Graph User.Read delegated permission.

.NOTES
    Prerequisites:
    - Azure CLI installed and logged in (`az login`) as a tenant member
      with permission to create/modify Azure AD applications.
    - Bicep must have run for the stamp (so the AKS OIDC issuer URL is
      cached at `deploy/.tmp/<EnvName>/bicep-outputs.cache.json`).
    - For default `-PortalClientId` resolution, Setup-PortalAuth.ps1 must
      have run first (so `deploy/envs/local/<EnvName>/entra-app.json`
      exists).

    Outputs:
    - JSON sidecar at -OutputFile.
    - Stdout paste-block with exactly four KEY=value lines:
        PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE
        OBO_SMOKE_WORKER_APP_TENANT_ID
        OBO_SMOKE_WORKER_APP_CLIENT_ID
        OBO_SMOKE_WORKER_APP_GRAPH_SCOPE

    This wrapper is intentionally NOT wired into `new-env.mjs`. The
    pilotswarm-npm-deployer agent's Step 0.b orchestrates the
    invocation, then pastes the four printed lines into the per-stamp
    .env using its `edit` tool — same workflow as the existing portal
    app-reg.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ServiceTreeId,
    [Parameter(Mandatory=$true)][string]$EnvName,
    [Parameter(Mandatory=$false)][string]$DisplayName,
    [Parameter(Mandatory=$false)][string]$ExistingAppId,
    [Parameter(Mandatory=$false)][string]$PortalClientId,
    [Parameter(Mandatory=$false)][string]$GraphScope = "https://graph.microsoft.com/User.Read",
    [Parameter(Mandatory=$false)][string]$ServiceAccountNamespace = "pilotswarm",
    [Parameter(Mandatory=$false)][string]$ServiceAccountName = "copilot-runtime-worker",
    [Parameter(Mandatory=$false)][switch]$GrantAdminConsent = $false,
    [Parameter(Mandatory=$false)][string]$Owner,
    [Parameter(Mandatory=$false)][string]$OutputFile
)

$ErrorActionPreference = "Stop"

# MS Graph constants (well-known and stable)
$MS_GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000"
$MS_GRAPH_USER_READ_DELEGATED_ID = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"

# AKS workload-identity audience (canonical)
$AKS_WORKLOAD_IDENTITY_AUDIENCE = "api://AzureADTokenExchange"

function Test-AzureCliReady {
    try {
        $null = az version 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Error "Azure CLI is not installed or not in PATH"; return $false }
        $null = az account show 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in. Run 'az login' first."; return $false }
        return $true
    } catch { Write-Error "Error checking az CLI: $_"; return $false }
}

function Get-RepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
}

function Resolve-OidcIssuerFromEnv {
    param([string]$Env)
    $repo = Get-RepoRoot
    $cache = Join-Path $repo "deploy/.tmp/$Env/bicep-outputs.cache.json"
    if (-not (Test-Path $cache)) {
        throw "AKS OIDC issuer URL is required for the workload-identity FIC, but $cache is missing. Run bicep first (the npm-deployer agent's bicep step) so the OIDC issuer URL is cached, then re-run this script."
    }
    try {
        $outputs = Get-Content $cache -Raw | ConvertFrom-Json
    } catch {
        throw "Failed to parse ${cache}: $_"
    }
    # bicep-outputs.cache.json keys are UPPER_SNAKE per deploy/scripts/lib/bicep-outputs-cache.mjs.
    # The AKS module emits oidcIssuerUrl -> OIDC_ISSUER_URL.
    $candidateKeys = @('OIDC_ISSUER_URL', 'AKS_OIDC_ISSUER_URL', 'oidcIssuerUrl')
    foreach ($k in $candidateKeys) {
        if ($outputs.PSObject.Properties.Name -contains $k) {
            $v = [string]$outputs.$k
            if (-not [string]::IsNullOrWhiteSpace($v)) { return $v.TrimEnd('/') }
        }
    }
    throw "Could not find OIDC issuer URL in $cache (looked for $($candidateKeys -join ', ')). Confirm the AKS bicep module ran and emitted the OIDC issuer."
}

function Resolve-PortalClientIdFromSidecar {
    param([string]$Env)
    $repo = Get-RepoRoot
    $sidecar = Join-Path $repo "deploy/envs/local/$Env/entra-app.json"
    if (-not (Test-Path $sidecar)) { return $null }
    try {
        $obj = Get-Content $sidecar -Raw | ConvertFrom-Json
        if ($obj -and -not [string]::IsNullOrWhiteSpace([string]$obj.clientId)) {
            return [string]$obj.clientId
        }
    } catch {
        Write-Warning "Failed to parse ${sidecar}: $_"
    }
    return $null
}

function Build-RequiredResourceAccessJson {
    # Graph delegated User.Read. Without this declaration the runtime OBO
    # exchange acquireTokenOnBehalfOf({ scopes: ["https://graph.microsoft.com/User.Read"] })
    # returns AADSTS65001 even when pre-authorization is in place — Entra
    # checks requiredResourceAccess to verify the worker app can receive
    # Graph tokens.
    return @"
[
  {
    "resourceAppId": "$MS_GRAPH_RESOURCE_APP_ID",
    "resourceAccess": [
      { "id": "$MS_GRAPH_USER_READ_DELEGATED_ID", "type": "Scope" }
    ]
  }
]
"@
}

function Invoke-GraphPatch {
    param([string]$ObjectId, [string]$BodyJson, [string]$Description)
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        $BodyJson | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
        $out = az rest --method PATCH `
            --uri "https://graph.microsoft.com/v1.0/applications/$ObjectId" `
            --headers "Content-Type=application/json" `
            --body "@$tempFile" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Graph PATCH failed ($Description): $out"
        }
        Write-Host "  OK: $Description" -ForegroundColor Green
    } finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-ExistingOAuth2ScopeId {
    param([string]$AppShowJson)
    try {
        $obj = $AppShowJson | ConvertFrom-Json
        if ($obj.api -and $obj.api.oauth2PermissionScopes) {
            $existing = @($obj.api.oauth2PermissionScopes) | Where-Object { $_.value -eq "user_impersonation" } | Select-Object -First 1
            if ($existing -and -not [string]::IsNullOrWhiteSpace([string]$existing.id)) {
                return [string]$existing.id
            }
        }
    } catch { }
    return $null
}

function Build-ApiPatchBodyJson {
    param([string]$ScopeId, [string]$ScopeDisplayName, [string]$PortalAppId)
    # Single PATCH that sets oauth2PermissionScopes, requestedAccessTokenVersion=2,
    # and preAuthorizedApplications (overwritten with single-element array).
    $description = "Allows the application to access $ScopeDisplayName on behalf of the signed-in user"
    $userConsent = "Allow the application to access $ScopeDisplayName on your behalf"
    $portalEscaped = $PortalAppId.Replace('"', '\"')
    return @"
{
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [
      {
        "id": "$ScopeId",
        "adminConsentDescription": "$description",
        "adminConsentDisplayName": "Access $ScopeDisplayName",
        "isEnabled": true,
        "type": "User",
        "userConsentDescription": "$userConsent",
        "userConsentDisplayName": "Access $ScopeDisplayName",
        "value": "user_impersonation"
      }
    ],
    "preAuthorizedApplications": [
      {
        "appId": "$portalEscaped",
        "delegatedPermissionIds": ["$ScopeId"]
      }
    ]
  }
}
"@
}

function Build-RequiredResourceAccessPatchJson {
    return @"
{
  "requiredResourceAccess": [
    {
      "resourceAppId": "$MS_GRAPH_RESOURCE_APP_ID",
      "resourceAccess": [
        { "id": "$MS_GRAPH_USER_READ_DELEGATED_ID", "type": "Scope" }
      ]
    }
  ]
}
"@
}

function Build-IdentifierUrisPatchJson {
    param([string]$AppId)
    return "{`"identifierUris`":[`"api://$AppId`"]}"
}

function Test-RequiredResourceAccessHasGraphUserRead {
    param([string]$AppShowJson)
    try {
        $obj = $AppShowJson | ConvertFrom-Json
        if (-not $obj.requiredResourceAccess) { return $false }
        foreach ($rra in @($obj.requiredResourceAccess)) {
            if ($rra.resourceAppId -ne $MS_GRAPH_RESOURCE_APP_ID) { continue }
            foreach ($ra in @($rra.resourceAccess)) {
                if ($ra.id -eq $MS_GRAPH_USER_READ_DELEGATED_ID -and $ra.type -eq "Scope") { return $true }
            }
        }
    } catch { }
    return $false
}

function Test-IdentifierUriPresent {
    param([string]$AppShowJson, [string]$AppId)
    try {
        $obj = $AppShowJson | ConvertFrom-Json
        if (-not $obj.identifierUris) { return $false }
        return (@($obj.identifierUris) -contains "api://$AppId")
    } catch { return $false }
}

function Find-AppByDisplayName {
    param([string]$Name)
    $matchesJson = az ad app list --display-name $Name --query "[].{appId:appId, objectId:id}" -o json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az ad app list failed: $matchesJson"
    }
    $arr = @($matchesJson | ConvertFrom-Json)
    if ($arr.Count -eq 0) { return $null }
    if ($arr.Count -gt 1) {
        $ids = ($arr | ForEach-Object { $_.appId }) -join ", "
        throw "Display-name lookup for '$Name' matched $($arr.Count) apps ($ids). Pass -ExistingAppId explicitly or rename the duplicates."
    }
    return $arr[0]
}

function Invoke-FicCreateOrPatch {
    param(
        [string]$AppObjectId,
        [string]$FicName,
        [string]$Issuer,
        [string]$Subject,
        [string[]]$Audiences
    )
    $listOut = az rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/federatedIdentityCredentials" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list federated identity credentials on app $AppObjectId : $listOut"
    }
    $existing = $null
    try {
        $list = ($listOut | ConvertFrom-Json).value
        if ($list) {
            $existing = @($list) | Where-Object { $_.name -eq $FicName } | Select-Object -First 1
        }
    } catch { }

    $audiencesJson = "[" + (($Audiences | ForEach-Object { "`"$_`"" }) -join ",") + "]"

    if ($null -eq $existing) {
        $body = @"
{
  "name": "$FicName",
  "issuer": "$Issuer",
  "subject": "$Subject",
  "audiences": $audiencesJson
}
"@
        $tempFile = [System.IO.Path]::GetTempFileName()
        try {
            $body | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
            $out = az rest --method POST `
                --uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/federatedIdentityCredentials" `
                --headers "Content-Type=application/json" `
                --body "@$tempFile" 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "FIC create failed: $out"
            }
            Write-Host "  OK: Created federated identity credential '$FicName'" -ForegroundColor Green
        } finally {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        }
        return $true
    }

    # Compare and PATCH-in-place on drift (preserves AAD-issued credential id)
    $existingAudiences = @($existing.audiences) | Sort-Object
    $desiredAudiences = @($Audiences) | Sort-Object
    $audiencesEqual = (($existingAudiences -join ",") -eq ($desiredAudiences -join ","))
    if ($existing.issuer -eq $Issuer -and $existing.subject -eq $Subject -and $audiencesEqual) {
        Write-Host "  OK: Federated identity credential '$FicName' already current (no change)" -ForegroundColor Green
        return $false
    }
    $patchBody = @"
{
  "issuer": "$Issuer",
  "subject": "$Subject",
  "audiences": $audiencesJson
}
"@
    $ficId = $existing.id
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        $patchBody | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
        $out = az rest --method PATCH `
            --uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/federatedIdentityCredentials/$ficId" `
            --headers "Content-Type=application/json" `
            --body "@$tempFile" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "FIC patch failed: $out"
        }
        Write-Host "  OK: Patched federated identity credential '$FicName' (subject/issuer/audience drift corrected)" -ForegroundColor Green
    } finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
    return $true
}

# ---- Main ----

Write-Host "Setup-OboSmokeWorkerApp - Entra worker app for PilotSwarm OBO live-smoke" -ForegroundColor Green
Write-Host ""

if (-not (Test-AzureCliReady)) { throw "Azure CLI not ready." }

$tenantId = az account show --query "tenantId" -o tsv
if ([string]::IsNullOrWhiteSpace($tenantId)) { throw "Could not read tenantId from 'az account show'." }
Write-Host "Tenant ID: $tenantId"

if ([string]::IsNullOrWhiteSpace($Owner)) {
    $Owner = az ad signed-in-user show --query "id" -o tsv
    if ([string]::IsNullOrWhiteSpace($Owner)) {
        Write-Warning "Could not detect signed-in user; owner will not be set."
        $Owner = $null
    } else {
        Write-Host "Owner (signed-in user): $Owner"
    }
}

# Resolve display name
if ([string]::IsNullOrWhiteSpace($DisplayName)) {
    $DisplayName = "PilotSwarm OBO Smoke Worker - $EnvName"
}

# Resolve sidecar output path
if ([string]::IsNullOrWhiteSpace($OutputFile)) {
    $repo = Get-RepoRoot
    $OutputFile = Join-Path $repo "deploy/envs/local/$EnvName/obo-smoke-worker-app.json"
}

# Resolve portal clientId (for pre-authorization)
if ([string]::IsNullOrWhiteSpace($PortalClientId)) {
    $PortalClientId = Resolve-PortalClientIdFromSidecar -Env $EnvName
    if (-not [string]::IsNullOrWhiteSpace($PortalClientId)) {
        Write-Host "Resolved portal clientId from entra-app.json: $PortalClientId"
    }
}
if ([string]::IsNullOrWhiteSpace($PortalClientId)) {
    throw "Portal clientId is required for pre-authorization, but neither -PortalClientId was supplied nor was deploy/envs/local/$EnvName/entra-app.json found. Run Setup-PortalAuth.ps1 first, or pass -PortalClientId explicitly."
}
# Validate the portal clientId actually exists
$portalShow = az ad app show --id $PortalClientId --query "id" -o tsv 2>&1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($portalShow)) {
    throw "Portal clientId $PortalClientId does not resolve to an existing app in this tenant. If the portal app was rotated, re-run Setup-PortalAuth.ps1 (which refreshes entra-app.json) or pass -PortalClientId explicitly with the current value."
}

# Resolve OIDC issuer up front (fail fast if bicep hasn't run)
$oidcIssuer = Resolve-OidcIssuerFromEnv -Env $EnvName
Write-Host "AKS OIDC issuer: $oidcIssuer"

# FIC subject and name
$ficSubject = "system:serviceaccount:${ServiceAccountNamespace}:${ServiceAccountName}"
$ficName = "pilotswarm-worker-$EnvName"

# Decide create-or-find
$clientId = $null
$objectId = $null
$mode = $null
if (-not [string]::IsNullOrWhiteSpace($ExistingAppId)) {
    Write-Host ""
    Write-Host "Mode: USE EXPLICIT existing app (-ExistingAppId)" -ForegroundColor Cyan
    Write-Host "  App ID: $ExistingAppId"
    $existing = az ad app show --id $ExistingAppId 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($existing)) {
        throw "Could not find app $ExistingAppId"
    }
    $existingObj = $existing | ConvertFrom-Json
    $clientId = $existingObj.appId
    $objectId = $existingObj.id
    $existingAppShowJson = $existing
    $mode = "existing"
} else {
    $found = Find-AppByDisplayName -Name $DisplayName
    if ($found) {
        Write-Host ""
        Write-Host "Mode: FOUND existing app by display name '$DisplayName'" -ForegroundColor Cyan
        Write-Host "  App ID: $($found.appId)"
        $clientId = $found.appId
        $objectId = $found.objectId
        $existingAppShowJson = az ad app show --id $clientId 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Could not re-show app $clientId" }
        $mode = "existing"
    } else {
        Write-Host ""
        Write-Host "Mode: CREATE NEW app registration" -ForegroundColor Cyan
        Write-Host "  Display name        : $DisplayName"
        Write-Host "  Tenant              : $tenantId (single-tenant)"
        Write-Host "  Service Tree ID     : $ServiceTreeId"
        Write-Host "  Graph permission    : User.Read (delegated)"
        Write-Host ""

        $tempFiles = @()
        try {
            $reqJson = Build-RequiredResourceAccessJson
            $reqFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $reqFile
            $reqJson | Out-File -FilePath $reqFile -Encoding UTF8 -NoNewline

            $createArgs = @(
                "ad", "app", "create",
                "--display-name", $DisplayName,
                "--sign-in-audience", "AzureADMyOrg",
                "--service-management-reference", $ServiceTreeId,
                "--required-resource-access", "@$reqFile"
            )
            Write-Host "Creating app registration..." -ForegroundColor Yellow
            $createOut = az @createArgs
            if ($LASTEXITCODE -ne 0) { throw "az ad app create failed: $createOut" }
            $created = $createOut | ConvertFrom-Json
            $clientId = $created.appId
            $objectId = $created.id
            Write-Host "  OK: Created app - appId=$clientId, objectId=$objectId" -ForegroundColor Green

            # Set owner (best-effort)
            if (-not [string]::IsNullOrWhiteSpace($Owner)) {
                $null = az ad app owner add --id $clientId --owner-object-id $Owner 2>&1
                if ($LASTEXITCODE -eq 0) { Write-Host "  OK: Set owner: $Owner" -ForegroundColor Green }
                else { Write-Warning "Failed to set owner $Owner" }
            }

            # Create service principal (required for tenant consent + FIC trust)
            Write-Host "Creating service principal..." -ForegroundColor Yellow
            $spOut = az ad sp create --id $clientId 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Service principal creation failed: $spOut"
            } else {
                $sp = $spOut | ConvertFrom-Json
                Write-Host "  OK: Created service principal: $($sp.id)" -ForegroundColor Green
            }

            # Re-show so identifierUris / api fields are fresh for downstream PATCHes
            $existingAppShowJson = az ad app show --id $clientId 2>$null
        } finally {
            foreach ($f in $tempFiles) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
        }
        $mode = "created"
    }
}

# --- identifierUri: api://<appId> must be set before scopes can be patched ---
if (-not (Test-IdentifierUriPresent -AppShowJson $existingAppShowJson -AppId $clientId)) {
    $idJson = Build-IdentifierUrisPatchJson -AppId $clientId
    Invoke-GraphPatch -ObjectId $objectId -BodyJson $idJson -Description "Set identifierUris = [api://$clientId]"
    $existingAppShowJson = az ad app show --id $clientId 2>$null
} else {
    Write-Host "  OK: identifierUri api://$clientId already present (no change)" -ForegroundColor Green
}

# --- requiredResourceAccess: ensure Graph User.Read present on existing apps ---
if ($mode -eq "existing" -and -not (Test-RequiredResourceAccessHasGraphUserRead -AppShowJson $existingAppShowJson)) {
    $rraJson = Build-RequiredResourceAccessPatchJson
    Invoke-GraphPatch -ObjectId $objectId -BodyJson $rraJson -Description "Add Graph User.Read delegated requiredResourceAccess"
} elseif ($mode -eq "existing") {
    Write-Host "  OK: Graph User.Read delegated requiredResourceAccess already present (no change)" -ForegroundColor Green
}

# --- OAuth2 scope + pre-authorization (single PATCH that touches api{}) ---
$scopeId = Get-ExistingOAuth2ScopeId -AppShowJson $existingAppShowJson
if ([string]::IsNullOrWhiteSpace($scopeId)) {
    $scopeId = [System.Guid]::NewGuid().ToString()
    Write-Host "Minting new OAuth2 scope id: $scopeId" -ForegroundColor Yellow
} else {
    Write-Host "Reusing existing OAuth2 scope id: $scopeId" -ForegroundColor Yellow
}
$apiPatch = Build-ApiPatchBodyJson -ScopeId $scopeId -ScopeDisplayName $DisplayName -PortalAppId $PortalClientId
Invoke-GraphPatch -ObjectId $objectId -BodyJson $apiPatch -Description "Set OAuth2 scope (user_impersonation) + requestedAccessTokenVersion=2 + preAuthorizedApplications=[portal $PortalClientId]"

# --- Optional admin consent for Graph User.Read ---
if ($GrantAdminConsent) {
    Write-Host "Granting tenant-wide admin consent for Graph User.Read..." -ForegroundColor Yellow
    $consentOut = az ad app permission admin-consent --id $clientId 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK: Admin consent granted" -ForegroundColor Green
    } else {
        Write-Warning "Admin-consent failed (likely insufficient permissions on signed-in principal). A tenant Global Admin must grant consent for Microsoft Graph User.Read on app $clientId once per tenant before the first smoke run. Continuing — the rest of the script does not depend on consent."
        Write-Warning "  $consentOut"
    }
}

# --- AKS workload-identity federated credential on the app ---
Write-Host "Configuring AKS workload-identity federated credential..." -ForegroundColor Yellow
Write-Host "  Name     : $ficName"
Write-Host "  Issuer   : $oidcIssuer"
Write-Host "  Subject  : $ficSubject"
Write-Host "  Audience : $AKS_WORKLOAD_IDENTITY_AUDIENCE"
$null = Invoke-FicCreateOrPatch -AppObjectId $objectId -FicName $ficName -Issuer $oidcIssuer -Subject $ficSubject -Audiences @($AKS_WORKLOAD_IDENTITY_AUDIENCE)

# --- Sidecar JSON ---
$scope = "api://$clientId/.default"
$summary = [ordered]@{
    tenantId        = $tenantId
    clientId        = $clientId
    objectId        = $objectId
    scope           = $scope
    graphScope      = $GraphScope
    ficName         = $ficName
    ficSubject      = $ficSubject
    ficIssuer       = $oidcIssuer
    portalClientId  = $PortalClientId
    displayName     = $DisplayName
    envName         = $EnvName
    serviceTreeId   = $ServiceTreeId
    createdAt       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$parent = Split-Path -Parent $OutputFile
if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
($summary | ConvertTo-Json -Depth 4) | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host "Wrote sidecar to $OutputFile" -ForegroundColor Green

# --- Stdout paste-block: EXACTLY four KEY=value lines, in the documented order ---
Write-Host ""
Write-Host "=== PilotSwarm OBO Smoke Worker App ===" -ForegroundColor Green
Write-Host "# Paste into deploy/envs/local/$EnvName/.env"
Write-Host "PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE=$scope offline_access"
Write-Host "OBO_SMOKE_WORKER_APP_TENANT_ID=$tenantId"
Write-Host "OBO_SMOKE_WORKER_APP_CLIENT_ID=$clientId"
Write-Host "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE=$GraphScope"
Write-Host "PLUGIN_DIRS=/app/packages/obo-smoke-plugin"
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Step 2 of 2: paste the five lines above into deploy/envs/local/$EnvName/.env" -ForegroundColor Cyan
Write-Host "  Then re-run the deploy's worker manifests/rollout step so the new env values reach the pod."
Write-Host ""
Write-Host "  PLUGIN_DIRS points at the OBO smoke plugin inside the worker image." -ForegroundColor DarkGray
Write-Host "  If you already set PLUGIN_DIRS for another plugin, append a comma-separated" -ForegroundColor DarkGray
Write-Host "  entry rather than replacing the value." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  This script does NOT modify .env (single-actor invariant). The operator," -ForegroundColor DarkGray
Write-Host "  or the pilotswarm-npm-deployer agent's Step 0.b via its 'edit' tool, is the" -ForegroundColor DarkGray
Write-Host "  only actor that mutates the per-stamp .env file." -ForegroundColor DarkGray
if (-not $GrantAdminConsent) {
    Write-Host ""
    Write-Host "  NOTE: Microsoft Graph User.Read delegated consent is required before the" -ForegroundColor Yellow
    Write-Host "        first smoke run. Either re-run with -GrantAdminConsent (if you are a" -ForegroundColor Yellow
    Write-Host "        tenant Global Admin) or have a tenant admin grant consent for app" -ForegroundColor Yellow
    Write-Host "        $clientId once per tenant." -ForegroundColor Yellow
}
