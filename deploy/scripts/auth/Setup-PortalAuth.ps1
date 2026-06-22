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
    - No MS Graph / API permissions declared. The portal does NOT call any
      downstream API at runtime — group/role claims ride on the ID token via
      optional-claims / app-roles, and the SPA only requests OIDC standard
      scopes (openid, profile) at sign-in. Future downstream API access (e.g.
      ADO via OBO) belongs on per-purpose worker apps, not the portal app.
    - Optional 'groups' claim on idToken, accessToken, and saml2Token
    - App roles (admin / user) — assignable to Users; created when -CreateAppRoles is set
    - Owner: current signed-in Azure CLI user (override with -Owner)
    - Service principal created by default (needed for tenant consent + assignments)
    - -AssignmentRequired (OPT-IN, off by default) sets
      appRoleAssignmentRequired=true on the SP so only users/groups
      explicitly assigned to the app can obtain a token. See the
      "Lockdown posture" note below — in many tenants this triggers an
      admin-consent prompt for first-time sign-in. The recommended
      lockdown path is `-CreateAppRoles` + role assignments in Entra
      (the role assignment is the allowlist), leaving
      `appRoleAssignmentRequired=false`.

    The redirect URI for a stamp is the AFD endpoint (or AppGw FQDN) the
    portal is served from. You can either:

    1) Pass -RedirectUri https://my-portal.example.com  (explicit)
    2) Pass -EnvName <stamp-name>                       (auto-discovers from
       deploy/.tmp/<stamp>/bicep-outputs.cache.json — requires deploy to
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
      deploy/.tmp/<EnvName>/bicep-outputs.cache.json if -RedirectUri is not given.

.PARAMETER RedirectUri
    Explicit SPA redirect URI(s) (https://...). Overrides EnvName auto-discovery.
    Accepts an array — pass multiple values to register more than one redirect URI
    (e.g. an AFD endpoint and a VPN-private portal hostname on the same stamp).

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
    OPT-IN. Off by default. If set, configures the service principal with
    appRoleAssignmentRequired=true, which blocks any user not explicitly
    assigned (directly or via a group) to the app from obtaining a token.

    CAVEAT: In tenants where user-consent is restricted to apps from
    verified publishers (e.g. the Microsoft corporate tenant), turning
    this on can trigger an AADSTS90094 admin-consent prompt for the very
    first sign-in by each assigned principal — even though this app
    declares NO API permissions. The OIDC sign-in flow still records a
    user-consent grant against Microsoft Graph for `openid profile
    offline_access`, and `appRoleAssignmentRequired=true` blocks that
    grant from being created on the user's behalf until they've already
    signed in once with the flag off. The workaround is a one-time
    "dance" per user (flip off, sign in, flip back on) or a tenant
    admin pre-granting the OIDC scopes.

    RECOMMENDED POSTURE for production: leave `-AssignmentRequired`
    off, use `-CreateAppRoles`, and assign users/groups to the `admin`
    / `user` roles in Entra (via Set-PortalAuthAssignments.ps1 or
    "Enterprise applications > Users and groups"). The role assignment
    list IS the allowlist for the Roles posture — the portal engine's
    role-authoritative branch denies any signed-in principal whose JWT
    does not carry an `admin` or `user` role claim. With v0.1.33+ the
    engine is deny-by-default (PORTAL_AUTHZ_DEFAULT_ROLE defaults to
    `none`), so no env-var allowlist is needed. The legacy
    PORTAL_AUTHZ_ADMIN_GROUPS / PORTAL_AUTHZ_USER_GROUPS allowlists
    are bypassed entirely when the JWT carries any roles[] claim;
    only populate them when running without -CreateAppRoles.

.PARAMETER OutputFile
    Path to write a JSON summary { tenantId, clientId, objectId, redirectUri }.
    Defaults to deploy/envs/local/<EnvName>/entra-app.json when EnvName is provided
    — co-located with the .env file scaffolded by deploy/scripts/new-env.mjs.

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> -EnvName mystamp

    Creates a new app named "PilotSwarm Portal - mystamp", auto-discovers
    the redirect URI from deploy/.tmp/mystamp/bicep-outputs.cache.json, and
    writes the resulting clientId to deploy/envs/local/mystamp/entra-app.json.

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> `
        -DisplayName "PilotSwarm Portal" `
        -RedirectUri "https://my-portal.example.com"

    Creates a new app with an explicit redirect URI (no env-name).

.EXAMPLE
    .\Setup-PortalAuth.ps1 -ServiceTreeId <your-service-tree-id> `
        -EnvName prodstamp -CreateAppRoles

    Creates a new app with 'admin' and 'user' app roles for production.
    `appRoleAssignmentRequired` is left at its safe default (false), so
    the first sign-in by each assigned admin does not trip the
    AADSTS90094 admin-consent gate in restricted tenants. Lockdown is
    enforced by the portal engine: with v0.1.33+ deny-by-default,
    assigned principals get `admin` / `user` from the JWT roles claim;
    unassigned signed-in users are denied at the portal layer. The
    portal matches the JWT roles claim by case-insensitive equality
    against the canonical values 'admin' and 'user' — no override env
    vars; the values are fixed. Do NOT also populate
    PORTAL_AUTHZ_ADMIN_GROUPS in the stamp's .env — it is bypassed
    by the role-authoritative branch when roles[] is present.

    To additionally turn on `appRoleAssignmentRequired=true` (opt-in,
    read the caveat under -AssignmentRequired first), pass
    `-AssignmentRequired` as well.

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
    [Parameter(Mandatory=$false)][string[]]$RedirectUri,
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
    $cache = Join-Path $repo "deploy/.tmp/$Env/bicep-outputs.cache.json"
    if (-not (Test-Path $cache)) {
        Write-Warning "bicep-outputs.cache.json not found at $cache - cannot auto-discover redirect URI."
        return @()
    }
    try {
        $outputs = Get-Content $cache -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to parse ${cache}: $_"
        return @()
    }
    # The deploy orchestrator's bicep cache uses UPPER_SNAKE keys
    # (deploy/scripts/lib/bicep-outputs-cache.mjs). For EDGE_MODE=afd the
    # public-facing URL is the AFD endpoint; for private/AppGw modes it
    # is the PORTAL_HOSTNAME (AppGw FQDN). When VPN_GATEWAY_ENABLED=true
    # on an AFD stamp we need BOTH: the AFD endpoint (public path) AND
    # the PORTAL_HOSTNAME (VPN-private path resolved via the AppGw
    # Private DNS A record — matches the AppGw HTTPS listener / AKV cert).
    $edgeMode = if ($outputs.PSObject.Properties.Name -contains 'EDGE_MODE') { [string]$outputs.EDGE_MODE } else { '' }
    $vpnEnabled = $false
    if ($outputs.PSObject.Properties.Name -contains 'VPN_GATEWAY_ID') {
        $vpnId = [string]$outputs.VPN_GATEWAY_ID
        if (-not [string]::IsNullOrWhiteSpace($vpnId)) { $vpnEnabled = $true }
    }

    $orderedKeys = if ($edgeMode -ieq 'afd') {
        if ($vpnEnabled) {
            # AFD + VPN: register both endpoints on the same app reg.
            @('FRONT_DOOR_ENDPOINT_HOST_NAME', 'PORTAL_HOSTNAME')
        } else {
            @('FRONT_DOOR_ENDPOINT_HOST_NAME', 'PORTAL_HOSTNAME')
        }
    } else {
        @('PORTAL_HOSTNAME', 'FRONT_DOOR_ENDPOINT_HOST_NAME')
    }

    $uris = New-Object System.Collections.Generic.List[string]
    foreach ($k in $orderedKeys) {
        if ($outputs.PSObject.Properties.Name -contains $k) {
            $v = [string]$outputs.$k
            if (-not [string]::IsNullOrWhiteSpace($v)) {
                if ($v -notmatch '^https?://') { $v = "https://$v" }
                $v = $v.TrimEnd('/')
                if (-not $uris.Contains($v)) { $uris.Add($v) }
                # Non-AFD+VPN modes: stop at the first match (preserves old behavior).
                if (-not ($edgeMode -ieq 'afd' -and $vpnEnabled)) { break }
            }
        }
    }
    if ($uris.Count -eq 0) {
        Write-Warning "Could not find a portal hostname (FRONT_DOOR_ENDPOINT_HOST_NAME / PORTAL_HOSTNAME) in $cache. Pass -RedirectUri explicitly."
        return @()
    }
    return @($uris)
}

function Build-RequiredResourceAccessJson {
    # Portal app declares NO API permissions. The SPA requests only OIDC standard
    # scopes (openid, profile) at sign-in, which require no consent. Downstream
    # API access (e.g. ADO via OBO) belongs on per-purpose worker apps with their
    # own admin consent — see docs/proposals/portal-auth-provider-and-authz.md.
    return "[]"
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
    param([string[]]$RedirectUris)
    # Literal JSON to guarantee redirectUris is always a JSON array, even when empty
    # or single-element.
    $items = @($RedirectUris | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $urisJson = if ($items.Count -eq 0) {
        "[]"
    } else {
        $escapedItems = $items | ForEach-Object {
            $esc = $_.Replace('\', '\\').Replace('"', '\"')
            "`"$esc`""
        }
        "[" + ($escapedItems -join ",") + "]"
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

# Resolve redirect URIs
if (($null -eq $RedirectUri -or $RedirectUri.Count -eq 0) -and -not [string]::IsNullOrWhiteSpace($EnvName)) {
    $RedirectUri = Resolve-RedirectUriFromEnv -Env $EnvName
    if ($RedirectUri -and $RedirectUri.Count -gt 0) {
        Write-Host "Resolved redirect URI(s) from env '$EnvName':"
        foreach ($u in $RedirectUri) { Write-Host "  - $u" }
    }
}
if ($RedirectUri -and $RedirectUri.Count -gt 0) {
    foreach ($u in $RedirectUri) {
        if ($u -notmatch '^https://') {
            throw "RedirectUri must be https://. Got: $u"
        }
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
    $OutputFile = Join-Path $repo "deploy/envs/local/$EnvName/entra-app.json"
}

# Decide mode
if (-not [string]::IsNullOrWhiteSpace($ExistingAppId)) {
    Write-Host ""
    Write-Host "Mode: ADD REDIRECT URI to existing app" -ForegroundColor Cyan
    Write-Host "  Existing App ID: $ExistingAppId"
    Write-Host "  New redirect URI(s):"
    foreach ($u in @($RedirectUri)) { Write-Host "    - $u" }
    if ($null -eq $RedirectUri -or $RedirectUri.Count -eq 0) {
        throw "-RedirectUri (or -EnvName for auto-discovery) is required when -ExistingAppId is set."
    }

    $existing = az ad app show --id $ExistingAppId 2>$null | ConvertFrom-Json
    if (-not $existing) { throw "Could not find app $ExistingAppId" }
    $objectId = $existing.id
    $currentUris = @()
    if ($existing.spa -and $existing.spa.redirectUris) { $currentUris = @($existing.spa.redirectUris) }
    $toAdd = @($RedirectUri | Where-Object { $currentUris -notcontains $_ })
    if ($toAdd.Count -eq 0) {
        Write-Host "All redirect URIs already present - no change." -ForegroundColor Yellow
    } else {
        $newUris = @(($currentUris + $RedirectUri) | Select-Object -Unique)
        $escapedUris = $newUris | ForEach-Object {
            '"' + ($_.Replace('\', '\\').Replace('"', '\"')) + '"'
        }
        $urisArrJson = "[" + ($escapedUris -join ",") + "]"
        $body = "{`"spa`":{`"redirectUris`":$urisArrJson}}"
        Invoke-GraphPatch -ObjectId $objectId -BodyJson $body -Description "Append SPA redirect URI(s)"
    }

    $clientId = $existing.appId
} else {
    Write-Host ""
    Write-Host "Mode: CREATE NEW app registration" -ForegroundColor Cyan
    Write-Host "  Display name        : $DisplayName"
    Write-Host "  Tenant              : $tenantId (single-tenant)"
    Write-Host "  Redirect URI(s)     : $(if ($RedirectUri -and $RedirectUri.Count -gt 0) { ($RedirectUri -join ', ') } else { '<none - add later>' })"
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
    $platformBody = Build-PlatformPatchBodyJson -RedirectUris @($RedirectUri)
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
    redirectUris   = @($RedirectUri)
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
if ($RedirectUri -and $RedirectUri.Count -gt 0) {
    foreach ($u in $RedirectUri) { Write-Host "Redirect URI                = $u" }
}
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
if ($EnvName) {
    Write-Host "  1. Paste PORTAL_AUTH_ENTRA_CLIENT_ID into deploy/envs/local/$EnvName/.env (or your shared .env.remote)"
} else {
    Write-Host "  1. Paste PORTAL_AUTH_ENTRA_CLIENT_ID into your stamp's .env (or .env.remote)"
}
Write-Host "  2. Ensure PORTAL_AUTH_PROVIDER=entra and PORTAL_AUTH_ENTRA_TENANT_ID are set"
if ($CreateAppRoles) {
    Write-Host "  3. Assign users/groups to the 'admin' / 'user' app roles:"
    Write-Host "        deploy/scripts/auth/Set-PortalAuthAssignments.ps1 -EnvName <env> -AdminAssignments <upn> [-UserAssignments ...]"
    Write-Host "     (Required when -AssignmentRequired is also set, otherwise role-less principals fall through to PORTAL_AUTHZ_DEFAULT_ROLE)"
    Write-Host "  4. Run the deploy flow as usual"
} else {
    Write-Host "  3. Run the deploy flow as usual"
}
Write-Host ""
Write-Host "  Admin consent is NOT required — the portal declares no API permissions; sign-in uses OIDC standard scopes (openid, profile)."
