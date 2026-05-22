<#
.SYNOPSIS
    Assigns users and groups to the 'admin' / 'user' app roles on a
    PilotSwarm portal Entra app registration.

.DESCRIPTION
    Companion to Setup-PortalAuth.ps1. Where Setup-PortalAuth creates the
    app + service principal + roles, this script just manages role
    assignments — list, add, remove. It can be re-run any time to grant
    or revoke access without touching the app itself.

    Identifiers can be:
      - User Principal Name (e.g. alice@contoso.com)
      - User or Group object id (GUID)
      - Group display name

    The script resolves each identifier to a principal via Microsoft
    Graph, looks up the role IDs from the app's appRoles collection,
    and POSTs to /servicePrincipals/{sp-id}/appRoleAssignedTo. Already-
    assigned principals are treated as no-ops (idempotent).

.PARAMETER AppId
    The clientId (appId) of the portal app. Required unless -EnvName
    auto-discovers it from deploy/envs/local/<env>/entra-app.json.

.PARAMETER EnvName
    Auto-discover -AppId from deploy/envs/local/<env>/entra-app.json
    (the summary file Setup-PortalAuth writes).

.PARAMETER AdminAssignments
    Identifiers to assign to the 'admin' role. Comma-separated when
    passed via command line, e.g.
        -AdminAssignments alice@contoso.com,bob@contoso.com

.PARAMETER UserAssignments
    Identifiers to assign to the 'user' role.

.PARAMETER List
    Lists current assignments instead of modifying anything. Implies
    no other action.

.PARAMETER Remove
    With -AdminAssignments / -UserAssignments, removes those
    assignments instead of adding them.

.PARAMETER AdminRoleValue
    Override the role 'value' the script treats as admin. Default: admin

.PARAMETER UserRoleValue
    Override the role 'value' the script treats as user. Default: user

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName chkentra `
        -AdminAssignments chkraw@microsoft.com

    Adds chkraw@microsoft.com to the admin role on the chkentra
    stamp's portal app.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName chkentra `
        -AdminAssignments alice@contoso.com,bob@contoso.com `
        -UserAssignments "Portal Beta Users"

    Adds two users to admin and one group (by display name) to user.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName chkentra -List

    Prints current admin/user assignments without modifying anything.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName chkentra `
        -AdminAssignments alice@contoso.com -Remove

    Removes alice@contoso.com from the admin role.

.NOTES
    Prerequisites:
    - Azure CLI installed and logged in (az login). The signed-in user
      must be an owner of the app/SP or hold a directory role that
      permits app-role assignment management (e.g. Application
      Administrator, Cloud Application Administrator, or the SP's
      Owner role).
    - The app must already have the 'admin' / 'user' app roles. Run
      Setup-PortalAuth.ps1 with -CreateAppRoles first if it doesn't.
#>

[CmdletBinding(DefaultParameterSetName='Assign')]
param(
    [Parameter(Mandatory=$false)][string]$AppId,
    [Parameter(Mandatory=$false)][string]$EnvName,
    [Parameter(Mandatory=$false)][string[]]$AdminAssignments = @(),
    [Parameter(Mandatory=$false)][string[]]$UserAssignments = @(),
    [Parameter(Mandatory=$false)][switch]$List,
    [Parameter(Mandatory=$false)][switch]$Remove,
    [Parameter(Mandatory=$false)][string]$AdminRoleValue = "admin",
    [Parameter(Mandatory=$false)][string]$UserRoleValue = "user"
)

$ErrorActionPreference = "Stop"

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

function Resolve-AppIdFromEnv {
    param([string]$Env)
    $repo = Get-RepoRoot
    $summary = Join-Path $repo "deploy/envs/local/$Env/entra-app.json"
    if (-not (Test-Path $summary)) {
        throw "No entra-app.json found for env '$Env' at $summary. Pass -AppId explicitly, or run Setup-PortalAuth.ps1 first."
    }
    $j = Get-Content $summary -Raw | ConvertFrom-Json
    if (-not $j.clientId) { throw "$summary has no clientId field" }
    return $j.clientId
}

function Resolve-Principal {
    <#
    Resolves a user-supplied identifier to @{ id; type; display } where
    type is "User" or "Group". Returns $null if nothing matches.

    Lookup order:
      - GUID  → User first, then Group
      - UPN-like (contains '@') → User by UPN
      - Otherwise → User by UPN (in case bare alias), then Group by displayName
    #>
    param([string]$Identifier)
    if ([string]::IsNullOrWhiteSpace($Identifier)) { return $null }
    $id = $Identifier.Trim()
    $isGuid = $id -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    if ($isGuid) {
        $u = az ad user show --id $id 2>$null
        if ($LASTEXITCODE -eq 0 -and $u) {
            $obj = $u | ConvertFrom-Json
            return @{ id = $obj.id; type = "User"; display = $obj.userPrincipalName }
        }
        $g = az ad group show --group $id 2>$null
        if ($LASTEXITCODE -eq 0 -and $g) {
            $obj = $g | ConvertFrom-Json
            return @{ id = $obj.id; type = "Group"; display = $obj.displayName }
        }
        return $null
    }

    $u = az ad user show --id $id 2>$null
    if ($LASTEXITCODE -eq 0 -and $u) {
        $obj = $u | ConvertFrom-Json
        return @{ id = $obj.id; type = "User"; display = $obj.userPrincipalName }
    }
    $g = az ad group list --display-name $id --query "[0]" 2>$null
    if ($LASTEXITCODE -eq 0 -and $g -and "$g".Trim() -ne "null" -and "$g".Trim() -ne "") {
        $obj = $g | ConvertFrom-Json
        if ($obj) { return @{ id = $obj.id; type = "Group"; display = $obj.displayName } }
    }
    return $null
}

function Get-AppContext {
    <#
    Loads { spObjectId, roleMap } for the given appId.
    roleMap is value → role GUID (e.g. 'admin' → '...').
    #>
    param([string]$AppId)
    $app = az ad app show --id $AppId 2>$null | ConvertFrom-Json
    if (-not $app) { throw "Could not load app $AppId" }
    $sp = az ad sp show --id $AppId 2>$null | ConvertFrom-Json
    if (-not $sp) { throw "Could not load service principal for app $AppId. Has the SP been created?" }
    $map = @{}
    foreach ($r in @($app.appRoles)) {
        if ($r.value -and $r.id) { $map[$r.value] = $r.id }
    }
    return @{
        appId        = $AppId
        appObjectId  = $app.id
        spObjectId   = $sp.id
        displayName  = $app.displayName
        roleMap      = $map
    }
}

function Get-CurrentAssignments {
    param([string]$SpObjectId)
    $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignedTo"
    $out = az rest --method GET --url $url 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to list current assignments: $out" }
    $parsed = $out | ConvertFrom-Json
    return @($parsed.value)
}

function New-AppRoleAssignment {
    param([string]$SpObjectId, [string]$PrincipalId, [string]$AppRoleId, [string]$DisplayHint)
    $body = @{ principalId = $PrincipalId; resourceId = $SpObjectId; appRoleId = $AppRoleId } | ConvertTo-Json -Compress
    $bodyFile = [System.IO.Path]::GetTempFileName()
    try {
        $body | Out-File -FilePath $bodyFile -Encoding UTF8 -NoNewline
        $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignedTo"
        $out = az rest --method POST --url $url --headers "Content-Type=application/json" --body "@$bodyFile" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    OK: assigned $DisplayHint" -ForegroundColor Green
            return $true
        }
        $outStr = "$out"
        if ($outStr -match 'Permission being assigned was already assigned' -or $outStr -match 'already exists') {
            Write-Host "    OK: $DisplayHint already assigned (no-op)" -ForegroundColor DarkGray
            return $true
        }
        Write-Warning "    Failed to assign ${DisplayHint}: $outStr"
        return $false
    } finally {
        if (Test-Path $bodyFile) { Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue }
    }
}

function Remove-AppRoleAssignment {
    param([string]$SpObjectId, [string]$AssignmentId, [string]$DisplayHint)
    $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignedTo/$AssignmentId"
    $out = az rest --method DELETE --url $url 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    OK: removed $DisplayHint" -ForegroundColor Green
        return $true
    }
    Write-Warning "    Failed to remove ${DisplayHint}: $out"
    return $false
}

function Invoke-AssignBatch {
    param([hashtable]$Ctx, [string]$RoleValue, [string[]]$Identifiers)
    if (-not $Identifiers -or $Identifiers.Count -eq 0) { return }
    if (-not $Ctx.roleMap.ContainsKey($RoleValue)) {
        Write-Warning "App '$($Ctx.displayName)' has no role with value '$RoleValue' - skipping $($Identifiers.Count) assignment(s). Did you run Setup-PortalAuth.ps1 with -CreateAppRoles?"
        return
    }
    $roleId = $Ctx.roleMap[$RoleValue]
    Write-Host "  Assigning '$RoleValue' role to $($Identifiers.Count) principal(s)..." -ForegroundColor Yellow
    foreach ($ident in $Identifiers) {
        $p = Resolve-Principal -Identifier $ident
        if (-not $p) {
            Write-Warning "    Could not resolve '$ident' to a User or Group - skipping"
            continue
        }
        $null = New-AppRoleAssignment -SpObjectId $Ctx.spObjectId -PrincipalId $p.id -AppRoleId $roleId -DisplayHint "$($p.display) [$($p.type)] -> $RoleValue"
    }
}

function Invoke-RemoveBatch {
    param([hashtable]$Ctx, [string]$RoleValue, [string[]]$Identifiers)
    if (-not $Identifiers -or $Identifiers.Count -eq 0) { return }
    if (-not $Ctx.roleMap.ContainsKey($RoleValue)) {
        Write-Warning "App '$($Ctx.displayName)' has no role with value '$RoleValue' - nothing to remove"
        return
    }
    $roleId = $Ctx.roleMap[$RoleValue]
    $current = Get-CurrentAssignments -SpObjectId $Ctx.spObjectId
    Write-Host "  Removing '$RoleValue' role from $($Identifiers.Count) principal(s)..." -ForegroundColor Yellow
    foreach ($ident in $Identifiers) {
        $p = Resolve-Principal -Identifier $ident
        if (-not $p) {
            Write-Warning "    Could not resolve '$ident' to a User or Group - skipping"
            continue
        }
        $match = $current | Where-Object { $_.principalId -eq $p.id -and $_.appRoleId -eq $roleId } | Select-Object -First 1
        if (-not $match) {
            Write-Host "    SKIP: $($p.display) [$($p.type)] is not currently assigned to '$RoleValue'" -ForegroundColor DarkGray
            continue
        }
        $null = Remove-AppRoleAssignment -SpObjectId $Ctx.spObjectId -AssignmentId $match.id -DisplayHint "$($p.display) [$($p.type)] -> $RoleValue"
    }
}

function Show-Assignments {
    param([hashtable]$Ctx)
    $current = Get-CurrentAssignments -SpObjectId $Ctx.spObjectId
    Write-Host ""
    Write-Host "Current assignments for '$($Ctx.displayName)' (appId $($Ctx.appId)):" -ForegroundColor Cyan
    if (-not $current -or $current.Count -eq 0) {
        Write-Host "  (none)" -ForegroundColor DarkGray
        return
    }
    # Reverse the role map for display
    $idToValue = @{}
    foreach ($k in $Ctx.roleMap.Keys) { $idToValue[$Ctx.roleMap[$k]] = $k }
    $rows = $current | ForEach-Object {
        $roleValue = $idToValue[$_.appRoleId]
        if (-not $roleValue) { $roleValue = $_.appRoleId }
        [pscustomobject]@{
            Role         = $roleValue
            Principal    = $_.principalDisplayName
            PrincipalType= $_.principalType
            PrincipalId  = $_.principalId
        }
    }
    $rows | Sort-Object Role, Principal | Format-Table -AutoSize
}

# --- Main ---

if (-not (Test-AzureCliReady)) { exit 1 }

if ([string]::IsNullOrWhiteSpace($AppId)) {
    if ([string]::IsNullOrWhiteSpace($EnvName)) {
        throw "Provide either -AppId or -EnvName."
    }
    $AppId = Resolve-AppIdFromEnv -Env $EnvName
    Write-Host "Resolved AppId from env '$EnvName': $AppId" -ForegroundColor DarkGray
}

$ctx = Get-AppContext -AppId $AppId
Write-Host ""
Write-Host "Target app: $($ctx.displayName)  (appId=$AppId)" -ForegroundColor Cyan
Write-Host "  Service principal object id: $($ctx.spObjectId)"
Write-Host "  Available roles: $((@($ctx.roleMap.Keys) | Sort-Object) -join ', ')"

if ($List) {
    Show-Assignments -Ctx $ctx
    exit 0
}

if ($Remove) {
    Invoke-RemoveBatch -Ctx $ctx -RoleValue $AdminRoleValue -Identifiers $AdminAssignments
    Invoke-RemoveBatch -Ctx $ctx -RoleValue $UserRoleValue -Identifiers $UserAssignments
} else {
    Invoke-AssignBatch -Ctx $ctx -RoleValue $AdminRoleValue -Identifiers $AdminAssignments
    Invoke-AssignBatch -Ctx $ctx -RoleValue $UserRoleValue -Identifiers $UserAssignments
}

Show-Assignments -Ctx $ctx
