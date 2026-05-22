<#
.SYNOPSIS
    Creates (or updates) the Entra app registration for a PilotSwarm portal stamp.

.DESCRIPTION
    Opinionated wrapper that produces the exact app-registration shape the
    PilotSwarm portal expects when PORTAL_AUTH_PROVIDER=entra:

    - signInAudience: AzureADMyOrg (single-tenant)
    - serviceManagementReference: supplied via -ServiceTreeId (REQUIRED — no default)
    - SPA platform (no Web reply URLs); redirect URI is the portal's https:// root
    - implicitGrantSettings: idToken + accessToken issuance enabled
    - MS Graph delegated permissions: User.Read + GroupMember.Read.All
    - Optional 'groups' claim on idToken, accessToken, and saml2Token
    - App roles (admin / user) — assignable to Users; created when -CreateAppRoles is set
    - Owner: current signed-in Azure CLI user (override with -Owner)
    - Service principal created by default (needed for tenant consent + assignments)
    - -AssignmentRequired sets appRoleAssignmentRequired=true on the SP so
      only users/groups explicitly assigned to the app can obtain a token

    The redirect URI for a stamp is the AFD endpoint (or AppGw FQDN) the
    portal is served from. You can either:

    1) Pass -RedirectUri https://my-portal.example.com  (explicit)
    2) Pass -EnvName <stamp-name>                       (auto-discovers from
       deploy/envs/<stamp>/bicep-outputs.cache.json — requires deploy to
       have run at least through the bicep-publish step)
    3) Pass neither and the app will be created without a redirect URI; you
       can add one later with -ExistingAppId once you know the endpoint.

    The script supports BOTH modes:
    - "Create a new app" (default)
    - "Add a redirect URI to an existing app" via -ExistingAppId — this is
      the typical pattern when one app reg serves multiple stamps.

.PARAMETER ServiceTreeId
    REQUIRED. Service Tree ID for your service, written as the
    serviceManagementReference on the app registration. Microsoft tenant
    policy requires every app registration to carry a valid Service Tree
    reference. There is intentionally no default — supply your own.

.PARAMETER DisplayName
    Display name for the app registration. Default: "PilotSwarm Portal - <EnvName>"
    or "PilotSwarm Portal" if EnvName is not provided.

.PARAMETER EnvName
    Stamp name (e.g. mystamp). When provided:
    - Used to derive the default DisplayName.
    - Used to auto-discover the AFD endpoint from
      deploy/envs/<EnvName>/bicep-outputs.cache.json if -RedirectUri is not given.

.PARAMETER RedirectUri
    Explicit SPA redirect URI (https://...). Overrides EnvName auto-discovery.

.PARAMETER ExistingAppId
    If provided, the script will NOT create a new app. Instead it appends
    the resolved redirect URI to the existing app's spa.redirectUris list
    (deduplicated). Useful for sharing one app reg across many stamps.

.PARAMETER Owner
    Object ID of the user to set as application owner. Defaults to the
    currently signed-in Azure CLI user.

.PARAMETER SkipGroupsClaim
    If set, do NOT add the 'groups' optional claim. Default is to include it
    so PORTAL_AUTH_ENTRA_*_GROUPS env vars can match against group object IDs
    in the token.

.PARAMETER CreateAppRoles
    If set, defines two app roles ('admin' and 'user') on the app registration.
    These are the roles the portal's role-driven authorization engine
    (packages/portal/auth/authz/engine.js) reads from the access token. After
    creation, assign users/groups to these roles via:
      - Entra portal: Enterprise applications > <app> > Users and groups
      - or `az ad sp app-role-assignment` (advanced)

.PARAMETER AssignmentRequired
    If set, configures the service principal with appRoleAssignmentRequired=true,
    which blocks any user not explicitly assigned (directly or via a group) to
    the app from obtaining a token. Recommended in combination with
    -CreateAppRoles for production stamps where only assigned users + roles
    should reach the portal at all.

.PARAMETER OutputFile
    Path to write a JSON summary { tenantId, clientId, objectId, redirectUri }.
    Defaults to deploy/envs/<EnvName>/entra-app.json when EnvName is provided.

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> -EnvName mystamp

    Creates a new app named "PilotSwarm Portal - mystamp", auto-discovers
    the redirect URI from deploy/envs/mystamp/bicep-outputs.cache.json, and
    writes the resulting clientId to deploy/envs/mystamp/entra-app.json.

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> `
        -DisplayName "PilotSwarm Portal" `
        -RedirectUri "https://my-portal.example.com"

    Creates a new app with an explicit redirect URI (no env-name).

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> `
        -EnvName prodstamp -CreateAppRoles -AssignmentRequired

    Creates a new app with 'admin' and 'user' app roles AND sets
    appRoleAssignmentRequired=true on the service principal. Only users
    explicitly assigned to one of the roles can sign in. This is the
    recommended posture for production stamps consuming the role-driven
    authorization engine (PORTAL_AUTH_ENTRA_ADMIN_ROLE/USER_ROLE).

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> `
        -ExistingAppId e4a81386-accc-48d5-b7d8-9f3324aec1e6 `
        -EnvName newstamp

    Adds the newstamp's AFD endpoint as a new SPA redirect URI on the
    existing shared app.

.NOTES
    Prerequisites:
    - Azure CLI installed and logged in (az login) as a tenant member with
      permission to create/modify Azure AD applications.
    - For -EnvName auto-discovery: bicep-outputs.cache.json must exist for
      that stamp.

    Outputs:
    - JSON summary file (see -OutputFile).
    - Stdout summary block including the value for PORTAL_AUTH_ENTRA_CLIENT_ID.

    This wrapper is intentionally NOT wired into the npm deploy pipeline. The
    deploy scripts still take PORTAL_AUTH_ENTRA_CLIENT_ID as input from .env.
    Run this wrapper first, copy the printed clientId into your stamp's .env,
    then proceed with deploy.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ServiceTreeId,
    [Parameter(Mandatory=$false)][string]$DisplayName,
    [Parameter(Mandatory=$false)][string]$EnvName,
    [Parameter(Mandatory=$false)][string]$RedirectUri,
    [Parameter(Mandatory=$false)][string]$ExistingAppId,
    [Parameter(Mandatory=$false)][string]$Owner,
    [Parameter(Mandatory=$false)][switch]$SkipGroupsClaim = $false,
    [Parameter(Mandatory=$false)][switch]$CreateAppRoles = $false,
    [Parameter(Mandatory=$false)][switch]$AssignmentRequired = $false,
    [Parameter(Mandatory=$false)][string]$OutputFile
)

$ErrorActionPreference = "Stop"

# MS Graph constants (well-known and stable)
$MS_GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000"
$MS_GRAPH_USER_READ_SCOPE_ID = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"
$MS_GRAPH_GROUPMEMBER_READ_ALL_SCOPE_ID = "bc024368-1153-4739-b217-4326f2e966d0"

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

function Resolve-RedirectUriFromEnv {
    param([string]$Env)
    $repo = Get-RepoRoot
    $cache = Join-Path $repo "deploy/envs/$Env/bicep-outputs.cache.json"
    if (-not (Test-Path $cache)) {
        Write-Warning "bicep-outputs.cache.json not found at $cache - cannot auto-discover redirect URI."
        return $null
    }
    try {
        $outputs = Get-Content $cache -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to parse ${cache}: $_"
        return $null
    }
    $candidates = @(
        $outputs.portalFqdn,
        $outputs.afdEndpointHostname,
        $outputs.portalUrl,
        $outputs.PORTAL_FQDN
    ) | Where-Object { $_ -and -not [string]::IsNullOrWhiteSpace($_) }
    if ($candidates.Count -eq 0) {
        foreach ($prop in $outputs.PSObject.Properties) {
            if ($prop.Value -is [string] -and $prop.Value -match '^[a-z0-9-]+\.[a-z0-9.-]+$') {
                $candidates += $prop.Value
            }
        }
    }
    if ($candidates.Count -eq 0) {
        Write-Warning "Could not find a portal hostname in $cache. Pass -RedirectUri explicitly."
        return $null
    }
    $portalHost = $candidates[0]
    if ($portalHost -notmatch '^https?://') { $portalHost = "https://$portalHost" }
    return $portalHost.TrimEnd('/')
}

function Build-RequiredResourceAccessJson {
    # Literal JSON - avoids PowerShell ConvertTo-Json mangling single-element arrays.
    return @"
[
  {
    "resourceAppId": "$MS_GRAPH_RESOURCE_APP_ID",
    "resourceAccess": [
      { "id": "$MS_GRAPH_USER_READ_SCOPE_ID", "type": "Scope" },
      { "id": "$MS_GRAPH_GROUPMEMBER_READ_ALL_SCOPE_ID", "type": "Scope" }
    ]
  }
]
"@
}

function Build-OptionalClaimsJson {
    param([bool]$IncludeGroups)
    # Literal JSON - empty additionalProperties array MUST serialize as []. PowerShell's
    # ConvertTo-Json converts @() to "" in PS 5.1 and to null in PS 7, neither of which
    # Graph accepts.
    if (-not $IncludeGroups) {
        return '{"idToken":[],"accessToken":[],"saml2Token":[]}'
    }
    $groupClaim = '{"name":"groups","essential":false,"additionalProperties":[]}'
    return "{`"idToken`":[$groupClaim],`"accessToken`":[$groupClaim],`"saml2Token`":[$groupClaim]}"
}

function Build-AppRolesJson {
    # Two roles read by packages/portal/auth/authz/engine.js: 'admin' and 'user'.
    # allowedMemberTypes=["User"] makes them assignable from "Users and groups".
    $adminRoleId = [System.Guid]::NewGuid().ToString()
    $userRoleId = [System.Guid]::NewGuid().ToString()
    return @"
[
  {
    "id": "$adminRoleId",
    "allowedMemberTypes": ["User"],
    "description": "Portal administrators. Grants full access including admin-only routes.",
    "displayName": "Admin",
    "isEnabled": true,
    "value": "admin"
  },
  {
    "id": "$userRoleId",
    "allowedMemberTypes": ["User"],
    "description": "Portal users. Grants standard signed-in access.",
    "displayName": "User",
    "isEnabled": true,
    "value": "user"
  }
]
"@
}

function Build-PlatformPatchBodyJson {
    param([string]$RedirectUriArg)
    # Literal JSON to guarantee redirectUris is always a JSON array, even when empty
    # or single-element.
    $urisJson = if ([string]::IsNullOrWhiteSpace($RedirectUriArg)) {
        "[]"
    } else {
        $escaped = $RedirectUriArg.Replace('\', '\\').Replace('"', '\"')
        "[`"$escaped`"]"
    }
    return @"
{
  "spa": { "redirectUris": $urisJson },
  "web": {
    "implicitGrantSettings": {
      "enableAccessTokenIssuance": true,
      "enableIdTokenIssuance": true
    }
  }
}
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

# ---- Main ----

Write-Host "Setup-PortalAuth - Entra app registration for PilotSwarm portal" -ForegroundColor Green
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

# Resolve redirect URI
if ([string]::IsNullOrWhiteSpace($RedirectUri) -and -not [string]::IsNullOrWhiteSpace($EnvName)) {
    $RedirectUri = Resolve-RedirectUriFromEnv -Env $EnvName
    if ($RedirectUri) { Write-Host "Resolved redirect URI from env '$EnvName': $RedirectUri" }
}
if (-not [string]::IsNullOrWhiteSpace($RedirectUri)) {
    if ($RedirectUri -notmatch '^https://') {
        throw "RedirectUri must be https://. Got: $RedirectUri"
    }
}

# Resolve display name
if ([string]::IsNullOrWhiteSpace($DisplayName)) {
    if (-not [string]::IsNullOrWhiteSpace($EnvName)) {
        $DisplayName = "PilotSwarm Portal - $EnvName"
    } else {
        $DisplayName = "PilotSwarm Portal"
    }
}

# Resolve output file
if ([string]::IsNullOrWhiteSpace($OutputFile) -and -not [string]::IsNullOrWhiteSpace($EnvName)) {
    $repo = Get-RepoRoot
    $OutputFile = Join-Path $repo "deploy/envs/$EnvName/entra-app.json"
}

# Decide mode
if (-not [string]::IsNullOrWhiteSpace($ExistingAppId)) {
    Write-Host ""
    Write-Host "Mode: ADD REDIRECT URI to existing app" -ForegroundColor Cyan
    Write-Host "  Existing App ID: $ExistingAppId"
    Write-Host "  New redirect URI: $RedirectUri"
    if ([string]::IsNullOrWhiteSpace($RedirectUri)) {
        throw "-RedirectUri (or -EnvName for auto-discovery) is required when -ExistingAppId is set."
    }

    $existing = az ad app show --id $ExistingAppId 2>$null | ConvertFrom-Json
    if (-not $existing) { throw "Could not find app $ExistingAppId" }
    $objectId = $existing.id
    $currentUris = @()
    if ($existing.spa -and $existing.spa.redirectUris) { $currentUris = @($existing.spa.redirectUris) }
    if ($currentUris -contains $RedirectUri) {
        Write-Host "Redirect URI already present - no change." -ForegroundColor Yellow
    } else {
        $newUris = @($currentUris + $RedirectUri | Select-Object -Unique)
        $escapedUris = $newUris | ForEach-Object {
            '"' + ($_.Replace('\', '\\').Replace('"', '\"')) + '"'
        }
        $urisArrJson = "[" + ($escapedUris -join ",") + "]"
        $body = "{`"spa`":{`"redirectUris`":$urisArrJson}}"
        Invoke-GraphPatch -ObjectId $objectId -BodyJson $body -Description "Append SPA redirect URI"
    }

    $clientId = $existing.appId
} else {
    Write-Host ""
    Write-Host "Mode: CREATE NEW app registration" -ForegroundColor Cyan
    Write-Host "  Display name        : $DisplayName"
    Write-Host "  Tenant              : $tenantId (single-tenant)"
    Write-Host "  Redirect URI        : $(if ($RedirectUri) { $RedirectUri } else { '<none - add later>' })"
    Write-Host "  Service Tree ID     : $ServiceTreeId"
    Write-Host "  Groups claim        : $(if ($SkipGroupsClaim) { 'NO' } else { 'YES (idToken+accessToken+saml2Token)' })"
    Write-Host "  App roles           : $(if ($CreateAppRoles) { 'YES (admin + user)' } else { 'NO' })"
    Write-Host "  Assignment required : $(if ($AssignmentRequired) { 'YES (only assigned users can sign in)' } else { 'NO (any tenant user can sign in)' })"
    Write-Host ""

    $tempFiles = @()
    try {
        $requiredResJson = Build-RequiredResourceAccessJson
        $reqFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $reqFile
        $requiredResJson | Out-File -FilePath $reqFile -Encoding UTF8 -NoNewline

        $optClaimsJson = Build-OptionalClaimsJson -IncludeGroups (-not $SkipGroupsClaim)
        $optFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $optFile
        $optClaimsJson | Out-File -FilePath $optFile -Encoding UTF8 -NoNewline

        $createArgs = @(
            "ad", "app", "create",
            "--display-name", $DisplayName,
            "--sign-in-audience", "AzureADMyOrg",
            "--service-management-reference", $ServiceTreeId,
            "--required-resource-access", "@$reqFile",
            "--optional-claims", "@$optFile"
        )

        if ($CreateAppRoles) {
            $appRolesJson = Build-AppRolesJson
            $rolesFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $rolesFile
            $appRolesJson | Out-File -FilePath $rolesFile -Encoding UTF8 -NoNewline
            $createArgs += "--app-roles", "@$rolesFile"
        }

        Write-Host "Creating app registration..." -ForegroundColor Yellow
        $createOut = az @createArgs
        if ($LASTEXITCODE -ne 0) { throw "az ad app create failed: $createOut" }
        $created = $createOut | ConvertFrom-Json
        $clientId = $created.appId
        $objectId = $created.id
        Write-Host "  OK: Created app - appId=$clientId, objectId=$objectId" -ForegroundColor Green
    } finally {
        foreach ($f in $tempFiles) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
    }

    # Configure SPA platform + implicit grant via Graph PATCH (az ad app create does not expose these)
    $platformBody = Build-PlatformPatchBodyJson -RedirectUriArg $RedirectUri
    Invoke-GraphPatch -ObjectId $objectId -BodyJson $platformBody -Description "Configure SPA platform + implicit grant (id+access tokens)"

    # Set owner
    if (-not [string]::IsNullOrWhiteSpace($Owner)) {
        $null = az ad app owner add --id $clientId --owner-object-id $Owner 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host "  OK: Set owner: $Owner" -ForegroundColor Green }
        else { Write-Warning "Failed to set owner $Owner" }
    }

    # Create service principal
    Write-Host "Creating service principal..." -ForegroundColor Yellow
    $spOut = az ad sp create --id $clientId 2>&1
    $spObjectId = $null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Service principal creation failed: $spOut"
    } else {
        $sp = $spOut | ConvertFrom-Json
        $spObjectId = $sp.id
        Write-Host "  OK: Created service principal: $spObjectId" -ForegroundColor Green
    }

    # Set appRoleAssignmentRequired on the service principal
    if ($AssignmentRequired -and $spObjectId) {
        Write-Host "Setting appRoleAssignmentRequired=true on service principal..." -ForegroundColor Yellow
        $null = az ad sp update --id $spObjectId --set appRoleAssignmentRequired=true 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK: appRoleAssignmentRequired=true (only assigned users will get a token)" -ForegroundColor Green
        } else {
            Write-Warning "Failed to set appRoleAssignmentRequired on $spObjectId"
        }
    }
}

# Write summary file
$summary = [ordered]@{
    tenantId       = $tenantId
    clientId       = $clientId
    objectId       = $objectId
    displayName    = $DisplayName
    redirectUri    = $RedirectUri
    envName        = $EnvName
    serviceTreeId  = $ServiceTreeId
    appRolesCreated     = [bool]$CreateAppRoles
    assignmentRequired  = [bool]$AssignmentRequired
    createdAt      = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
}
if (-not [string]::IsNullOrWhiteSpace($OutputFile)) {
    $parent = Split-Path -Parent $OutputFile
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    ($summary | ConvertTo-Json -Depth 4) | Out-File -FilePath $OutputFile -Encoding UTF8
    Write-Host ""
    Write-Host "Wrote summary to $OutputFile" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== PilotSwarm Portal App Registration ===" -ForegroundColor Green
Write-Host "PORTAL_AUTH_ENTRA_TENANT_ID = $tenantId"
Write-Host "PORTAL_AUTH_ENTRA_CLIENT_ID = $clientId"
if ($RedirectUri) { Write-Host "Redirect URI                = $RedirectUri" }
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
if ($EnvName) {
    Write-Host "  1. Paste PORTAL_AUTH_ENTRA_CLIENT_ID into deploy/envs/$EnvName/.env (or your shared .env.remote)"
} else {
    Write-Host "  1. Paste PORTAL_AUTH_ENTRA_CLIENT_ID into your stamp's .env (or .env.remote)"
}
Write-Host "  2. Ensure PORTAL_AUTH_PROVIDER=entra and PORTAL_AUTH_ENTRA_TENANT_ID are set"
if ($CreateAppRoles) {
    Write-Host "  3. Assign users/groups to the 'admin' / 'user' app roles:"
    Write-Host "        Entra portal > Enterprise applications > $DisplayName > Users and groups"
    Write-Host "     (Required when -AssignmentRequired is also set, otherwise role-less principals fall through to PORTAL_AUTHZ_DEFAULT_ROLE)"
    Write-Host "  4. Grant admin consent for GroupMember.Read.All:"
} else {
    Write-Host "  3. Grant admin consent for GroupMember.Read.All:"
}
Write-Host "        az ad app permission admin-consent --id $clientId"
Write-Host "  5. Run the deploy flow as usual"
