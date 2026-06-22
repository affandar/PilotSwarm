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
      pre-authorization in place. Per-user consent at portal sign-in is
      the default path; `-GrantAdminConsent` is an optional shortcut that
      pre-grants tenant-wide consent when the running principal is a
      Global Admin / Cloud Application Administrator.
    - api.preAuthorizedApplications: the per-stamp PORTAL app's clientId,
      pre-authorized for the new delegated scope. This avoids an
      AADSTS65001 user-consent prompt at runtime when the portal acquires
      the worker-audienced token. The array is OVERWRITTEN (not merged)
      with a single-element list — each stamp has a strict 1:1
      portal-app -> worker-app relationship, so merging would risk
      leaving orphaned trust for rotated/deleted portal apps.
    - By default, an MSI-as-FIC federated identity credential on the
      *Application*: issuer `https://login.microsoftonline.com/<tenant>/v2.0`,
      subject = the worker UAMI's enterprise-app/service-principal object id,
      audience `api://AzureADTokenExchange`. The worker pod first exchanges its
      AKS service-account token for a UAMI token (using the existing AKS FIC on
      the UAMI), then uses that UAMI token as the confidential-client assertion
      for this app. This is the Microsoft CORP-compatible pattern.
    - Optional `-FicPattern aks-direct` preserves the historical AKS-direct FIC
      on the Application for tenants that allow it. That pattern uses the AKS
      OIDC issuer URL and service-account subject directly.

    Idempotency: re-runs are no-ops. The script looks up by display name
    first (override with -ExistingAppId), reuses the existing
    OAuth2PermissionScope id rather than minting a fresh GUID, and
    create-or-patches the FIC by deterministic name.

    Modes (`-Mode`):
      - `app-shell` — Creates/updates the app + scope + Graph permission
        + portal pre-authorization + (optional) admin consent. **Does
        NOT create the FIC.** Bicep does not need to have run. Emits the
        smoke env paste-block. Recommended as the first call, alongside
        the portal app-reg, before bicep.
      - `patch-fic` — Looks up the existing app, resolves the selected
        `-FicPattern` trust inputs from the bicep cache, create-or-patches the FIC.
        Bicep MUST have run. Recommended after the full deploy completes,
        just before OBO smoke. Does NOT touch app config or emit
        the paste-block (env was already correct from app-shell).
      - `all` (default, back-compat) — Runs app-shell + patch-fic in
        one invocation. Requires bicep to have run first.

    Side-effects (strictly):
      (a) creates/updates the Entra app with scope, Graph User.Read,
          and pre-authorization (app-shell, all);
      (b) creates/patches the selected FIC pattern (patch-fic, all);
      (c) writes a JSON sidecar at -OutputFile (every mode updates the
          fields it knows about);
      (d) prints the smoke env KEY=value paste-block to stdout
          (app-shell, all only).

    NEVER MODIFIES .env. The single-actor-on-.env invariant is preserved:
    `new-env.mjs` (scaffold), `compose-env.mjs` (bicep-output fold), and
    the operator/agent (paste) are the only mutators. Adding a PowerShell
    .env editor — even a small reusable one — invites the same pattern in
    every future auth wrapper and erodes that invariant.

.PARAMETER Mode
    `app-shell` | `patch-fic` | `all`. Default `all` (back-compat).

    - `app-shell` runs the app/scope/Graph/pre-auth/(consent) steps and
      stops. Use as the early step alongside portal app-reg; does not
      require bicep to have run.
    - `patch-fic` looks up the existing app and create-or-patches the
      selected FIC pattern. Default `msi` reads WORKLOAD_IDENTITY_CLIENT_ID
      from the bicep cache and uses that UAMI's object id as subject.
      Optional `aks-direct` uses the OIDC issuer cached by bicep. Run after
      the full deploy completes, just before OBO smoke.
    - `all` runs both phases in one invocation (current behavior).

.PARAMETER ServiceTreeId
    REQUIRED. Service Tree ID for your service, written as the
    serviceManagementReference on the app registration. Microsoft tenant
    policy requires every app registration to carry a valid Service Tree
    reference. There is intentionally no default — supply your own.

.PARAMETER EnvName
    REQUIRED. Stamp name (e.g. mystamp). Used to:
    - derive the default display name
    - derive the default sidecar output path
    - locate selected FIC inputs in the per-stamp bicep cache
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

.PARAMETER FicPattern
    `msi` | `aks-direct`. Default `msi`.

    - `msi` (default): CORP-compatible MSI-as-FIC pattern. Reads
      WORKLOAD_IDENTITY_CLIENT_ID from the bicep cache, resolves the UAMI's
      service-principal object id, and creates an eSTS FIC on the worker app:
      issuer `https://login.microsoftonline.com/<tenant>/v2.0`, subject
      `<uami-sp-object-id>`.
    - `aks-direct`: historical AKS-direct FIC on the worker app. Uses the AKS
      OIDC issuer and Kubernetes service-account subject directly. Only use in
      tenants that explicitly allow AKS-direct FICs on 3P apps.

.PARAMETER GrantAdminConsent
    Switch (default off). When set, runs
    `az ad app permission admin-consent --id <appId>` after wiring
    Graph `User.Read`. Optional shortcut that skips the per-user
    consent prompt on every user's first sign-in. Only meaningful
    when the running principal is a tenant Global Admin or Cloud
    Application Administrator; harmless to set in lower-permission
    contexts (the consent call will warn and the script continues —
    per-user consent at sign-in remains the default path).

.PARAMETER Owner
    Object ID of the user to set as application owner. Defaults to the
    currently signed-in Azure CLI user.

.PARAMETER OutputFile
    Path to write the JSON sidecar
    `{ tenantId, clientId, scope, graphScope, ficName, ficSubject,
       ficIssuer, fic, portalClientId, displayName, envName,
       serviceTreeId, createdAt }`.
    Defaults to `deploy/envs/local/<EnvName>/obo-smoke-worker-app.json`.

.EXAMPLE
    # Recommended two-phase pattern (mirrors portal-app-reg redirect-URI flow):

    # Phase 1 — run early, alongside portal app-reg, BEFORE bicep:
    .\Setup-OboSmokeWorkerApp.ps1 -Mode app-shell `
        -ServiceTreeId <your-service-tree-id> -EnvName <env-name>

    # Bicep runs (npm-deployer agent's bicep step), emitting the UAMI client id.

    # Phase 2 — run AFTER bicep, BEFORE `worker manifests,rollout`:
    .\Setup-OboSmokeWorkerApp.ps1 -Mode patch-fic `
        -ServiceTreeId <your-service-tree-id> -EnvName <env-name>

.EXAMPLE
    # Back-compat single-shot (default Mode=all): app-shell + patch-fic
    # in one call. Requires bicep to have run first.
    .\Setup-OboSmokeWorkerApp.ps1 -ServiceTreeId <your-service-tree-id> -EnvName <env-name>

    Creates (or finds) "PilotSwarm OBO Smoke Worker - <env-name>", wires
    the OAuth2 scope, pre-authorizes the portal app from
    deploy/envs/local/<env-name>/entra-app.json, creates the default MSI-as-FIC
    using WORKLOAD_IDENTITY_CLIENT_ID in deploy/.tmp/<env-name>/bicep-outputs.cache.json,
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
    - For `-Mode patch-fic` or `-Mode all`: bicep must have run for the
      stamp (so WORKLOAD_IDENTITY_CLIENT_ID for default MSI-as-FIC, or the
      AKS OIDC issuer for `-FicPattern aks-direct`, is cached at
      `deploy/.tmp/<EnvName>/bicep-outputs.cache.json`). `-Mode app-shell`
      has no bicep dependency.
    - For default `-PortalClientId` resolution (app-shell, all):
      Setup-PortalAuth.ps1 must have run first (so
      `deploy/envs/local/<EnvName>/entra-app.json` exists).

    Outputs:
    - JSON sidecar at -OutputFile (every mode updates fields it knows).
    - Stdout paste-block (app-shell, all only) with five KEY=value lines:
        PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE
        OBO_SMOKE_WORKER_APP_TENANT_ID
        OBO_SMOKE_WORKER_APP_CLIENT_ID
        OBO_SMOKE_WORKER_APP_GRAPH_SCOPE
        PLUGIN_DIRS

    This wrapper is intentionally NOT wired into `new-env.mjs`. The
    pilotswarm-npm-deployer agent's Step 0.b orchestrates the
    invocation, then pastes the printed lines into the per-stamp
    .env using its `edit` tool — same workflow as the existing portal
    app-reg.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ServiceTreeId,
    [Parameter(Mandatory=$true)][string]$EnvName,
    [Parameter(Mandatory=$false)][ValidateSet("app-shell","patch-fic","all")][string]$Mode = "all",
    [Parameter(Mandatory=$false)][string]$DisplayName,
    [Parameter(Mandatory=$false)][string]$ExistingAppId,
    [Parameter(Mandatory=$false)][string]$PortalClientId,
    [Parameter(Mandatory=$false)][string]$GraphScope = "https://graph.microsoft.com/User.Read",
    [Parameter(Mandatory=$false)][string]$ServiceAccountNamespace = "pilotswarm",
    [Parameter(Mandatory=$false)][string]$ServiceAccountName = "copilot-runtime-worker",
    [Parameter(Mandatory=$false)][ValidateSet("msi","aks-direct")][string]$FicPattern = "msi",
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

function New-RepoScratchFile {
    $repo = Get-RepoRoot
    $scratch = Join-Path $repo "deploy/.tmp/auth-scratch"
    if (-not (Test-Path $scratch)) {
        New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    }
    return (Join-Path $scratch ("obo-smoke-" + [System.Guid]::NewGuid().ToString("N") + ".json"))
}

function Resolve-OidcIssuerFromEnv {
    param([string]$Env)
    $repo = Get-RepoRoot
    $cache = Join-Path $repo "deploy/.tmp/$Env/bicep-outputs.cache.json"
    if (-not (Test-Path $cache)) {
        throw "AKS OIDC issuer URL is required for -FicPattern aks-direct, but $cache is missing. Run bicep first (the npm-deployer agent's bicep step) so the OIDC issuer URL is cached, then re-run this script."
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

function Resolve-WorkloadIdentityClientIdFromEnv {
    param([string]$Env)
    $repo = Get-RepoRoot
    $cache = Join-Path $repo "deploy/.tmp/$Env/bicep-outputs.cache.json"
    if (-not (Test-Path $cache)) {
        throw "WORKLOAD_IDENTITY_CLIENT_ID is required for the MSI-as-FIC pattern, but $cache is missing. Run bicep first so the UAMI client id is cached, then re-run this script."
    }
    try {
        $outputs = Get-Content $cache -Raw | ConvertFrom-Json
    } catch {
        throw "Failed to parse ${cache}: $_"
    }
    # csiIdentityClientId is aliased by deploy-bicep.mjs to WORKLOAD_IDENTITY_CLIENT_ID.
    $candidateKeys = @('WORKLOAD_IDENTITY_CLIENT_ID', 'CSI_IDENTITY_CLIENT_ID', 'csiIdentityClientId')
    foreach ($k in $candidateKeys) {
        if ($outputs.PSObject.Properties.Name -contains $k) {
            $v = [string]$outputs.$k
            if (-not [string]::IsNullOrWhiteSpace($v)) { return $v.Trim() }
        }
    }
    throw "Could not find WORKLOAD_IDENTITY_CLIENT_ID in $cache (looked for $($candidateKeys -join ', ')). Confirm base-infra bicep ran and emitted csiIdentityClientId."
}

function Resolve-ServicePrincipalObjectId {
    param([string]$ClientId)
    $spObjectId = az ad sp show --id $ClientId --query id -o tsv 2>&1
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($spObjectId)) {
        throw "Failed to resolve service-principal object id for UAMI client id $ClientId via 'az ad sp show --id <client-id>': $spObjectId"
    }
    return ([string]$spObjectId).Trim()
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
    $tempFile = New-RepoScratchFile
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

function Build-ApiScopePatchBodyJson {
    param([string]$ScopeId, [string]$ScopeDisplayName)
    # Phase 1 PATCH: define oauth2PermissionScopes + requestedAccessTokenVersion=2.
    # Microsoft Graph rejects a combined PATCH that *also* sets
    # preAuthorizedApplications referencing $ScopeId in the same request because
    # the scope id is not yet persisted at validation time. The pre-auth array
    # must go in a follow-up PATCH (see Build-ApiPreAuthPatchBodyJson) once the
    # scope exists.
    $description = "Allows the application to access $ScopeDisplayName on behalf of the signed-in user"
    $userConsent = "Allow the application to access $ScopeDisplayName on your behalf"
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
    ]
  }
}
"@
}

function Build-ApiPreAuthPatchBodyJson {
    param([string]$ScopeId, [string]$PortalAppId)
    # Phase 2 PATCH: set preAuthorizedApplications referencing the scope id that
    # was persisted by the phase-1 PATCH above. Overwrites with a
    # single-element array (idempotent on re-run).
    $portalEscaped = $PortalAppId.Replace('"', '\"')
    return @"
{
  "api": {
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
        [string[]]$Audiences,
        [string]$Description
    )
    $listOut = az rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/federatedIdentityCredentials" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list federated identity credentials on app $AppObjectId : $listOut"
    }
    Write-Host "  Existing federated identity credentials before patch:" -ForegroundColor DarkGray
    $existing = $null
    $sameTrust = $null
    try {
        $list = ($listOut | ConvertFrom-Json).value
        if ($list) {
            foreach ($fic in @($list)) {
                Write-Host "    - $($fic.name): issuer=$($fic.issuer), subject=$($fic.subject)" -ForegroundColor DarkGray
            }
            $existing = @($list) | Where-Object { $_.name -eq $FicName } | Select-Object -First 1
            $desiredAudienceKey = (@($Audiences) | Sort-Object) -join ","
            $sameTrust = @($list) | Where-Object {
                $candidateAudienceKey = (@($_.audiences) | Sort-Object) -join ","
                $_.issuer -eq $Issuer -and $_.subject -eq $Subject -and $candidateAudienceKey -eq $desiredAudienceKey
            } | Select-Object -First 1
        } else {
            Write-Host "    (none)" -ForegroundColor DarkGray
        }
    } catch { }

    $audiencesJson = "[" + (($Audiences | ForEach-Object { "`"$_`"" }) -join ",") + "]"

    if ($sameTrust) {
        Write-Host "  OK: Federated identity credential '$($sameTrust.name)' already trusts issuer+subject (no change)" -ForegroundColor Green
        return $false
    }

    if ($null -eq $existing) {
        $body = @"
{
  "name": "$FicName",
  "issuer": "$Issuer",
  "subject": "$Subject",
  "description": "$Description",
  "audiences": $audiencesJson
}
"@
        $tempFile = New-RepoScratchFile
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
            $afterOut = az rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/federatedIdentityCredentials" 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to list federated identity credentials on app $AppObjectId after create: $afterOut"
            }
            Write-Host "  Federated identity credentials after create:" -ForegroundColor DarkGray
            try {
                $afterList = ($afterOut | ConvertFrom-Json).value
                if ($afterList) {
                    foreach ($fic in @($afterList)) {
                        Write-Host "    - $($fic.name): issuer=$($fic.issuer), subject=$($fic.subject)" -ForegroundColor DarkGray
                    }
                } else {
                    Write-Host "    (none)" -ForegroundColor DarkGray
                }
            } catch { }
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
  "description": "$Description",
  "audiences": $audiencesJson
}
"@
    $ficId = $existing.id
    $tempFile = New-RepoScratchFile
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
    $afterOut = az rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/federatedIdentityCredentials" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list federated identity credentials on app $AppObjectId after patch: $afterOut"
    }
    Write-Host "  Federated identity credentials after patch:" -ForegroundColor DarkGray
    try {
        $afterList = ($afterOut | ConvertFrom-Json).value
        if ($afterList) {
            foreach ($fic in @($afterList)) {
                Write-Host "    - $($fic.name): issuer=$($fic.issuer), subject=$($fic.subject)" -ForegroundColor DarkGray
            }
        } else {
            Write-Host "    (none)" -ForegroundColor DarkGray
        }
    } catch { }
    return $true
}

# ---- Main ----

Write-Host "Setup-OboSmokeWorkerApp - Entra worker app for PilotSwarm OBO live-smoke" -ForegroundColor Green
Write-Host "Mode: $Mode" -ForegroundColor Cyan
Write-Host "FIC pattern: $FicPattern" -ForegroundColor Cyan
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

# Resolve portal clientId (for pre-authorization). Skipped in patch-fic mode
# because pre-authorization is set during app-shell and the existing app
# already has it on file.
if ($Mode -ne "patch-fic") {
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
}

# Resolve FIC inputs up front (fail fast if bicep hasn't run). Skipped in
# app-shell mode because that phase intentionally runs before bicep.
$ficIssuer = $null
$ficSubject = $null
$uamiClientId = $null
if ($Mode -ne "app-shell") {
    if ($FicPattern -eq "msi") {
        $uamiClientId = Resolve-WorkloadIdentityClientIdFromEnv -Env $EnvName
        $uamiObjectId = Resolve-ServicePrincipalObjectId -ClientId $uamiClientId
        $ficIssuer = "https://login.microsoftonline.com/$tenantId/v2.0"
        $ficSubject = $uamiObjectId
        Write-Host "MSI-as-FIC UAMI client id: $uamiClientId"
        Write-Host "MSI-as-FIC UAMI object id: $uamiObjectId"
    } else {
        $ficIssuer = Resolve-OidcIssuerFromEnv -Env $EnvName
        $ficSubject = "system:serviceaccount:${ServiceAccountNamespace}:${ServiceAccountName}"
        Write-Host "AKS OIDC issuer: $ficIssuer"
    }
}

# FIC subject and name
$ficName = if ($FicPattern -eq "msi") { "pilotswarm-obo-smoke-worker-$EnvName-msi" } else { "pilotswarm-worker-$EnvName" }

# Decide create-or-find. In patch-fic mode the app MUST already exist.
$clientId = $null
$objectId = $null
$findMode = $null
if (-not [string]::IsNullOrWhiteSpace($ExistingAppId)) {
    Write-Host ""
    Write-Host "App resolution: USE EXPLICIT existing app (-ExistingAppId)" -ForegroundColor Cyan
    Write-Host "  App ID: $ExistingAppId"
    $existing = az ad app show --id $ExistingAppId 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($existing)) {
        throw "Could not find app $ExistingAppId"
    }
    $existingObj = $existing | ConvertFrom-Json
    $clientId = $existingObj.appId
    $objectId = $existingObj.id
    $existingAppShowJson = $existing
    $findMode = "existing"
} else {
    $found = Find-AppByDisplayName -Name $DisplayName
    if ($found) {
        Write-Host ""
        Write-Host "App resolution: FOUND existing app by display name '$DisplayName'" -ForegroundColor Cyan
        Write-Host "  App ID: $($found.appId)"
        $clientId = $found.appId
        $objectId = $found.objectId
        $existingAppShowJson = az ad app show --id $clientId 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Could not re-show app $clientId" }
        $findMode = "existing"
    } elseif ($Mode -eq "patch-fic") {
        throw "patch-fic mode requires the app '$DisplayName' to already exist (run -Mode app-shell first, or pass -ExistingAppId)."
    } else {
        Write-Host ""
        Write-Host "App resolution: CREATE NEW app registration" -ForegroundColor Cyan
        Write-Host "  Display name        : $DisplayName"
        Write-Host "  Tenant              : $tenantId (single-tenant)"
        Write-Host "  Service Tree ID     : $ServiceTreeId"
        Write-Host "  Graph permission    : User.Read (delegated)"
        Write-Host ""

        $tempFiles = @()
        try {
            $reqJson = Build-RequiredResourceAccessJson
            $reqFile = New-RepoScratchFile; $tempFiles += $reqFile
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
        $findMode = "created"
    }
}

# === App-shell phase: identifierUri / Graph perm / scope / pre-auth / consent ===
if ($Mode -ne "patch-fic") {
    # --- identifierUri: api://<appId> must be set before scopes can be patched ---
    if (-not (Test-IdentifierUriPresent -AppShowJson $existingAppShowJson -AppId $clientId)) {
        $idJson = Build-IdentifierUrisPatchJson -AppId $clientId
        Invoke-GraphPatch -ObjectId $objectId -BodyJson $idJson -Description "Set identifierUris = [api://$clientId]"
        $existingAppShowJson = az ad app show --id $clientId 2>$null
    } else {
        Write-Host "  OK: identifierUri api://$clientId already present (no change)" -ForegroundColor Green
    }

    # --- requiredResourceAccess: ensure Graph User.Read present on existing apps ---
    if ($findMode -eq "existing" -and -not (Test-RequiredResourceAccessHasGraphUserRead -AppShowJson $existingAppShowJson)) {
        $rraJson = Build-RequiredResourceAccessPatchJson
        Invoke-GraphPatch -ObjectId $objectId -BodyJson $rraJson -Description "Add Graph User.Read delegated requiredResourceAccess"
    } elseif ($findMode -eq "existing") {
        Write-Host "  OK: Graph User.Read delegated requiredResourceAccess already present (no change)" -ForegroundColor Green
    }

    # --- OAuth2 scope + pre-authorization (two-phase PATCH on api{}) ---
    # Microsoft Graph requires two separate PATCHes here:
    #   1) Define oauth2PermissionScopes + requestedAccessTokenVersion=2.
    #   2) Set preAuthorizedApplications (which references the scope id that was
    #      persisted by step 1). A combined PATCH fails validation because the
    #      scope id isn't yet persisted when preAuthorizedApplications is parsed.
    $scopeId = Get-ExistingOAuth2ScopeId -AppShowJson $existingAppShowJson
    if ([string]::IsNullOrWhiteSpace($scopeId)) {
        $scopeId = [System.Guid]::NewGuid().ToString()
        Write-Host "Minting new OAuth2 scope id: $scopeId" -ForegroundColor Yellow
    } else {
        Write-Host "Reusing existing OAuth2 scope id: $scopeId" -ForegroundColor Yellow
    }
    $scopePatch = Build-ApiScopePatchBodyJson -ScopeId $scopeId -ScopeDisplayName $DisplayName
    Invoke-GraphPatch -ObjectId $objectId -BodyJson $scopePatch -Description "Set OAuth2 scope (user_impersonation) + requestedAccessTokenVersion=2"

    $preAuthPatch = Build-ApiPreAuthPatchBodyJson -ScopeId $scopeId -PortalAppId $PortalClientId
    Invoke-GraphPatch -ObjectId $objectId -BodyJson $preAuthPatch -Description "Set preAuthorizedApplications=[portal $PortalClientId]"

    # --- Optional admin consent for Graph User.Read ---
    if ($GrantAdminConsent) {
        Write-Host "Granting tenant-wide admin consent for Graph User.Read..." -ForegroundColor Yellow
        $consentOut = az ad app permission admin-consent --id $clientId 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK: Admin consent granted" -ForegroundColor Green
        } else {
            Write-Warning "Admin-consent failed (likely insufficient permissions on signed-in principal). This is OK — per-user consent at portal sign-in remains the default path; each user will accept the consent prompt for Graph User.Read on their first OBO smoke sign-in. To grant tenant-wide consent later, a Global Admin or Cloud Application Administrator can run 'az ad app permission admin-consent --id $clientId'. Continuing — the rest of the script does not depend on consent."
            Write-Warning "  $consentOut"
        }
    }
}

# === Patch-FIC phase: federated credential on the app ===
if ($Mode -ne "app-shell") {
    Write-Host "Configuring $FicPattern federated identity credential..." -ForegroundColor Yellow
    Write-Host "  Name     : $ficName"
    Write-Host "  Issuer   : $ficIssuer"
    Write-Host "  Subject  : $ficSubject"
    Write-Host "  Audience : $AKS_WORKLOAD_IDENTITY_AUDIENCE"
    $ficDescription = if ($FicPattern -eq "msi") {
        "PilotSwarm OBO smoke worker MSI-as-FIC trust for $EnvName (UAMI client id $uamiClientId)"
    } else {
        "PilotSwarm OBO smoke worker AKS-direct workload identity trust for $EnvName"
    }
    $null = Invoke-FicCreateOrPatch -AppObjectId $objectId -FicName $ficName -Issuer $ficIssuer -Subject $ficSubject -Audiences @($AKS_WORKLOAD_IDENTITY_AUDIENCE) -Description $ficDescription
}

# --- Sidecar JSON ---
# Read existing sidecar (if any) so patch-fic preserves portalClientId etc.
# written by an earlier app-shell run, and so app-shell preserves ficIssuer
# from any earlier patch-fic run.
$existingSummary = $null
if (Test-Path $OutputFile) {
    try { $existingSummary = Get-Content $OutputFile -Raw | ConvertFrom-Json } catch { }
}
$scope = "api://$clientId/.default"
# Phase-aware fields: app-shell knows scope/portalClientId; patch-fic knows ficIssuer.
$resolvedPortalClientId = if ($Mode -eq "patch-fic" -and $existingSummary -and $existingSummary.portalClientId) { [string]$existingSummary.portalClientId } else { $PortalClientId }
$resolvedFicIssuer = if ($Mode -eq "app-shell" -and $existingSummary -and $existingSummary.ficIssuer) { [string]$existingSummary.ficIssuer } else { $ficIssuer }
$resolvedFicSubject = if ($Mode -eq "app-shell" -and $existingSummary -and $existingSummary.ficSubject) { [string]$existingSummary.ficSubject } else { $ficSubject }
$resolvedFicPattern = if ($Mode -eq "app-shell" -and $existingSummary -and $existingSummary.fic -and $existingSummary.fic.pattern) { [string]$existingSummary.fic.pattern } else { $FicPattern }
$summary = [ordered]@{
    tenantId        = $tenantId
    clientId        = $clientId
    objectId        = $objectId
    scope           = $scope
    graphScope      = $GraphScope
    ficName         = $ficName
    ficSubject      = $resolvedFicSubject
    ficIssuer       = $resolvedFicIssuer
    fic             = [ordered]@{
        pattern   = $resolvedFicPattern
        name      = $ficName
        issuer    = $resolvedFicIssuer
        subject   = $resolvedFicSubject
        audiences = @($AKS_WORKLOAD_IDENTITY_AUDIENCE)
    }
    portalClientId  = $resolvedPortalClientId
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

# --- Stdout paste-block: app-shell and all only (env doesn't change in patch-fic) ---
if ($Mode -eq "patch-fic") {
    Write-Host ""
    Write-Host "=== FIC patched. No .env or k8s changes needed. ===" -ForegroundColor Green
    Write-Host "  Worker pod accepts OBO exchanges as soon as AAD sees the FIC (no pod restart)." -ForegroundColor Cyan
    Write-Host "  Next: pilotswarm smoke $EnvName --profile obo" -ForegroundColor Cyan
    return
}

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
if ($Mode -eq "app-shell") {
    Write-Host "Step 1 of 2 (app-shell): paste the five lines above into deploy/envs/local/$EnvName/.env" -ForegroundColor Cyan
    Write-Host "  Then run the full deploy (bicep + manifests + rollout). When the stamp is up," -ForegroundColor Cyan
    Write-Host "  re-invoke with -Mode patch-fic just before running 'pilotswarm smoke'." -ForegroundColor Cyan
} else {
    Write-Host "Step 2 of 2: paste the five lines above into deploy/envs/local/$EnvName/.env" -ForegroundColor Cyan
    Write-Host "  Then re-run the deploy's worker manifests/rollout step so the new env values reach the pod."
}
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
    Write-Host "  NOTE: Microsoft Graph User.Read delegated permission requires consent." -ForegroundColor Yellow
    Write-Host "        Default path: each user accepts the per-user consent prompt at" -ForegroundColor Yellow
    Write-Host "        their first portal sign-in (no tenant admin involvement needed)." -ForegroundColor Yellow
    Write-Host "        Optional shortcut: re-run with -GrantAdminConsent (Global Admin /" -ForegroundColor Yellow
    Write-Host "        Cloud Application Administrator) to pre-grant tenant-wide consent" -ForegroundColor Yellow
    Write-Host "        for app $clientId." -ForegroundColor Yellow
}
