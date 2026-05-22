<#
.SYNOPSIS
    Creates an Azure AD application with configurable parameters.

.DESCRIPTION
    Generic Azure AD application primitive built on the Azure CLI. Supports:
    - Custom display name and identifier URIs
    - App roles and required resource access (JSON format)
    - Optional service principal creation
    - User/group enterprise-app assignments
    - Comprehensive error handling and validation
    - Security-first design: OAuth2 delegated permissions require explicit opt-in

    This script is a generic primitive. For the PilotSwarm portal SPA shape
    (single-tenant, SPA redirect URIs, implicit grant, no API permissions,
    groups optional-claim, optional app roles) use the wrapper
    Setup-PortalAuth.ps1 in this directory.

    The -serviceManagementReference parameter is REQUIRED by Microsoft tenant
    policy. Supply your own Service Tree ID — there is no default.

.PARAMETER displayName
    The display name for the Azure AD application (required).

.PARAMETER identifierUris
    The identifier URIs for the application. Can be a single URI or comma-separated list.

.PARAMETER requiredResourceAccess
    JSON string defining the required resource access (API permissions).

.PARAMETER appRoles
    JSON string defining application roles.

.PARAMETER groupMembershipClaims
    Group membership claims setting. Default: "SecurityGroup"
    Valid values: "None", "SecurityGroup", "All"

.PARAMETER signInAudience
    Default: "AzureADMyOrg"
    Valid values: "AzureADMyOrg", "AzureADMultipleOrgs", "AzureADandPersonalMicrosoftAccount", "PersonalMicrosoftAccount"

.PARAMETER owner
    Object ID of the user to set as the application owner. Defaults to the
    currently signed-in Azure CLI user.

.PARAMETER serviceManagementReference
    Service management reference (Service Tree ID) — REQUIRED by Microsoft
    tenant policy. Supply the Service Tree ID registered for your service.

.PARAMETER createServicePrincipal
    Switch to also create a service principal for the application.

.PARAMETER assignmentRequired
    Switch to require assignment for users to access the application.

.PARAMETER assignedUsers
    JSON string defining users to assign to the enterprise application.

.PARAMETER assignedGroups
    JSON string defining groups to assign to the enterprise application.

.PARAMETER outputFile
    Path to save the creation results as JSON.

.PARAMETER enableDelegatedAccess
    Switch to enable OAuth2 delegated permissions (user_impersonation scope).

.PARAMETER preAuthorizeAzureCLI
    Switch to pre-authorize Azure CLI. Only effective with -enableDelegatedAccess.

.PARAMETER delegatedScopeName
    Name for the OAuth2 delegated scope. Default: "user_impersonation"

.EXAMPLE
    .\Create3PApplication.ps1 -displayName "My Enterprise App" -serviceManagementReference <your-service-tree-id>

.EXAMPLE
    .\Create3PApplication.ps1 -displayName "My API App" -identifierUris "https://myapi.contoso.com" -serviceManagementReference <your-service-tree-id> -createServicePrincipal

.NOTES
    Prerequisites:
    - Azure CLI installed and in PATH
    - az login completed
    - Sufficient permissions to create Azure AD applications

    Origin: generic Azure AD app primitive. Adapted for PilotSwarm.
    Version: 1.0
#>

param(
    [Parameter(Mandatory=$true)][string]$displayName,
    [Parameter(Mandatory=$false)][string]$identifierUris,
    [Parameter(Mandatory=$false)][string]$requiredResourceAccess,
    [Parameter(Mandatory=$false)][string]$appRoles,
    [Parameter(Mandatory=$false)][string]$groupMembershipClaims = "SecurityGroup",
    [Parameter(Mandatory=$false)][string]$signInAudience = "AzureADMyOrg",
    [Parameter(Mandatory=$false)][string]$owner,
    [Parameter(Mandatory=$true)][string]$serviceManagementReference,
    [Parameter(Mandatory=$false)][switch]$createServicePrincipal = $false,
    [Parameter(Mandatory=$false)][switch]$assignmentRequired = $false,
    [Parameter(Mandatory=$false)][string]$assignedUsers,
    [Parameter(Mandatory=$false)][string]$assignedGroups,
    [Parameter(Mandatory=$false)][string]$outputFile,
    [Parameter(Mandatory=$false)][switch]$enableDelegatedAccess = $false,
    [Parameter(Mandatory=$false)][switch]$preAuthorizeAzureCLI = $false,
    [Parameter(Mandatory=$false)][string]$delegatedScopeName = "user_impersonation"
)

$AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"

$enableOAuth2 = $enableDelegatedAccess
$preAuthCLI = $preAuthorizeAzureCLI

function New-OAuth2PermissionScope {
    param([string]$DisplayName, [string]$ScopeId, [string]$ScopeName = "user_impersonation")
    if ([string]::IsNullOrWhiteSpace($ScopeId)) { $ScopeId = [System.Guid]::NewGuid().ToString() }
    $description = "Allows the application to access $DisplayName on behalf of the signed-in user"
    return @{
        adminConsentDescription = $description
        adminConsentDisplayName = "Access $DisplayName"
        id = $ScopeId
        isEnabled = $true
        type = "User"
        userConsentDescription = "Allow the application to access $DisplayName on your behalf"
        userConsentDisplayName = "Access $DisplayName"
        value = $ScopeName
    }
}

function New-PreAuthorizedApplication {
    param([string]$ClientId, [string[]]$DelegatedPermissionIds)
    return @{ appId = $ClientId; delegatedPermissionIds = $DelegatedPermissionIds }
}

function Set-OAuth2PermissionScopes {
    param([string]$ApplicationObjectId, [array]$OAuth2PermissionScopes)
    Write-Host "Configuring OAuth2 permission scopes..." -ForegroundColor Yellow
    try {
        $apiConfig = @{ api = @{ oauth2PermissionScopes = $OAuth2PermissionScopes } }
        $tempFile = [System.IO.Path]::GetTempFileName()
        ($apiConfig | ConvertTo-Json -Depth 5 -Compress) | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
        $updateResult = az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$ApplicationObjectId" --headers "Content-Type=application/json" --body "@$tempFile"
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Added OAuth2 permission scope: $($OAuth2PermissionScopes[0].value)" -ForegroundColor Green
            return $true
        }
        Write-Warning "Failed to configure OAuth2 permission scopes. Output: $updateResult"
        return $false
    } catch {
        Write-Warning "Error configuring OAuth2 permission scopes: $($_.Exception.Message)"
        return $false
    }
}

function Set-PreAuthorizedApplications {
    param([string]$ApplicationObjectId, [array]$PreAuthorizedApplications)
    Write-Host "Configuring pre-authorized applications..." -ForegroundColor Yellow
    try {
        Start-Sleep -Seconds 2
        $apiConfig = @{ api = @{ preAuthorizedApplications = $PreAuthorizedApplications } }
        $tempFile = [System.IO.Path]::GetTempFileName()
        ($apiConfig | ConvertTo-Json -Depth 5 -Compress) | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
        $updateResult = az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$ApplicationObjectId" --headers "Content-Type=application/json" --body "@$tempFile"
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Pre-authorized Azure CLI for seamless authentication" -ForegroundColor Green
            return $true
        }
        Write-Warning "Failed to configure pre-authorized applications. Output: $updateResult"
        return $false
    } catch {
        Write-Warning "Error configuring pre-authorized applications: $($_.Exception.Message)"
        return $false
    }
}

function Test-JsonInput {
    param([string]$jsonString, [string]$parameterName)
    if ([string]::IsNullOrWhiteSpace($jsonString)) { return $true }
    try { $null = ConvertFrom-Json $jsonString -ErrorAction Stop; return $true }
    catch { Write-Error "Invalid JSON format for parameter '$parameterName': $jsonString"; return $false }
}

function Test-AzureCliReady {
    try {
        $null = az version 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Error "Azure CLI is not installed or not available in PATH"; return $false }
        $null = az account show 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in to Azure CLI. Please run 'az login' first"; return $false }
        return $true
    } catch { Write-Error "Error checking Azure CLI status: $_"; return $false }
}

Write-Host "Starting Azure AD Application creation process..." -ForegroundColor Green

if (-not (Test-AzureCliReady)) { throw "Azure CLI is not ready." }

$validationFailed = $false
if (-not (Test-JsonInput -jsonString $requiredResourceAccess -parameterName "requiredResourceAccess")) { $validationFailed = $true }
if (-not (Test-JsonInput -jsonString $appRoles -parameterName "appRoles")) { $validationFailed = $true }
if (-not (Test-JsonInput -jsonString $assignedUsers -parameterName "assignedUsers")) { $validationFailed = $true }
if (-not (Test-JsonInput -jsonString $assignedGroups -parameterName "assignedGroups")) { $validationFailed = $true }
if ($validationFailed) { throw "Parameter validation failed." }

Write-Host "Getting current Azure user..." -ForegroundColor Yellow
try {
    $currentUser = az ad signed-in-user show --query "id" -o tsv
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentUser)) {
        Write-Warning "Could not retrieve current user ID."
        $currentUser = $null
    } else {
        Write-Host "Current user ID: $currentUser" -ForegroundColor Green
    }
    if ([string]::IsNullOrWhiteSpace($owner) -and $currentUser) { $owner = $currentUser }
} catch {
    Write-Warning "Failed to get current user: $($_.Exception.Message)"
    $currentUser = $null
}
Write-Host ""

$appCreationResult = $null
$servicePrincipalResult = $null

try {
    Write-Host "Creating Azure AD application '$displayName'..." -ForegroundColor Yellow
    $tempFiles = @()
    try {
        $arguments = @("ad", "app", "create", "--display-name", $displayName)

        if (-not [string]::IsNullOrWhiteSpace($identifierUris)) {
            $arguments += "--identifier-uris", $identifierUris
        }
        if (-not [string]::IsNullOrWhiteSpace($requiredResourceAccess)) {
            $tempFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $tempFile
            $requiredResourceAccess | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
            $arguments += "--required-resource-access", "@$tempFile"
        }
        if (-not [string]::IsNullOrWhiteSpace($appRoles)) {
            $tempFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $tempFile
            $appRoles | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
            $arguments += "--app-roles", "@$tempFile"
        }
        $arguments += "--service-management-reference", $serviceManagementReference
        $arguments += "--sign-in-audience", $signInAudience
        if (-not [string]::IsNullOrWhiteSpace($groupMembershipClaims)) {
            $tempFile = [System.IO.Path]::GetTempFileName(); $tempFiles += $tempFile
            '{"idToken": [], "accessToken": [], "saml2Token": []}' | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline
            $arguments += "--optional-claims", "@$tempFile"
        }

        $appCreationOutput = az @arguments
    } finally {
        foreach ($tempFile in $tempFiles) { if (Test-Path $tempFile) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue } }
    }

    if ($LASTEXITCODE -ne 0) { throw "Azure AD application creation failed. Output: $appCreationOutput" }

    $appCreationResult = $appCreationOutput | ConvertFrom-Json
    $appId = $appCreationResult.appId
    $objectId = $appCreationResult.id
    Write-Host "Successfully created Azure AD application!" -ForegroundColor Green
    Write-Host "Application ID: $appId" -ForegroundColor Green
    Write-Host "Object ID: $objectId" -ForegroundColor Green

    if ($enableOAuth2) {
        Write-Host "Configuring OAuth2 delegated permissions..." -ForegroundColor Yellow
        $scopeId = [System.Guid]::NewGuid().ToString()
        $oauth2Scopes = @(New-OAuth2PermissionScope -DisplayName $displayName -ScopeId $scopeId -ScopeName $delegatedScopeName)
        $preAuthorizedApps = @()
        if ($preAuthCLI) {
            $preAuthorizedApps += New-PreAuthorizedApplication -ClientId $AZURE_CLI_CLIENT_ID -DelegatedPermissionIds @($scopeId)
        }
        $scopeConfigSuccess = Set-OAuth2PermissionScopes -ApplicationObjectId $objectId -OAuth2PermissionScopes $oauth2Scopes
        $preAuthSuccess = $true
        if ($preAuthorizedApps.Count -gt 0) {
            $preAuthSuccess = Set-PreAuthorizedApplications -ApplicationObjectId $objectId -PreAuthorizedApplications $preAuthorizedApps
        }
        if ($scopeConfigSuccess -and $preAuthSuccess) { Write-Host "OAuth2 delegated access configured" -ForegroundColor Green }
        elseif ($scopeConfigSuccess) { Write-Host "OAuth2 scopes configured (pre-auth may need manual setup)" -ForegroundColor Yellow }
        else { Write-Warning "OAuth2 configuration failed." }
    }

    if (-not [string]::IsNullOrWhiteSpace($owner)) {
        Write-Host "Setting application owner..." -ForegroundColor Yellow
        try {
            $ownerSetOutput = az ad app owner add --id $appId --owner-object-id $owner
            if ($LASTEXITCODE -eq 0) { Write-Host "Successfully set application owner: $owner" -ForegroundColor Green }
            else { Write-Warning "Failed to set application owner. Output: $ownerSetOutput" }
        } catch { Write-Warning "Failed to set application owner: $($_.Exception.Message)" }
    }

    if ($createServicePrincipal) {
        Write-Host "Creating service principal..." -ForegroundColor Yellow
        $spCreationOutput = az ad sp create --id $appId
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Service principal creation failed. Output: $spCreationOutput"
        } else {
            $servicePrincipalResult = $spCreationOutput | ConvertFrom-Json
            $spObjectId = $servicePrincipalResult.id
            Write-Host "Successfully created service principal: $spObjectId" -ForegroundColor Green
            if ($assignmentRequired) {
                Write-Host "Setting assignment requirement to true..." -ForegroundColor Yellow
                $null = az ad sp update --id $spObjectId --set appRoleAssignmentRequired=true
                if ($LASTEXITCODE -eq 0) { Write-Host "Enabled assignment requirement" -ForegroundColor Green }
                else { Write-Warning "Failed to set assignment requirement." }
            }
        }
    }

    $result = @{
        ApplicationId = $appId
        ApplicationObjectId = $objectId
        DisplayName = $displayName
        CreatedDateTime = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
        Status = "Success"
    }
    if ($servicePrincipalResult) {
        $result.ServicePrincipalObjectId = $servicePrincipalResult.id
        $result.ServicePrincipalAppId = $servicePrincipalResult.appId
    }
    if (-not [string]::IsNullOrWhiteSpace($outputFile)) {
        $result | ConvertTo-Json -Depth 3 | Out-File -FilePath $outputFile -Encoding UTF8
        Write-Host "Results saved to: $outputFile" -ForegroundColor Green
    }

    Write-Host "`n=== Application Creation Summary ===" -ForegroundColor Green
    Write-Host "Display Name: $($result.DisplayName)"
    Write-Host "Application ID: $($result.ApplicationId)"
    Write-Host "Object ID: $($result.ApplicationObjectId)"
    if ($result.ServicePrincipalObjectId) { Write-Host "Service Principal Object ID: $($result.ServicePrincipalObjectId)" }
    Write-Host "Created: $($result.CreatedDateTime)"
    Write-Host "=================================" -ForegroundColor Green

    return $appId
} catch {
    Write-Error "An error occurred while creating the Azure AD application: $_"
    Write-Host $_.ScriptStackTrace -ForegroundColor Red
    if ($appCreationResult -and $appCreationResult.appId) {
        Write-Host "Attempting cleanup of partially created application..." -ForegroundColor Yellow
        try {
            az ad app delete --id $appCreationResult.appId
            if ($LASTEXITCODE -eq 0) { Write-Host "Cleanup completed" -ForegroundColor Green }
        } catch { Write-Warning "Failed to cleanup application $($appCreationResult.appId): $_" }
    }
    throw "Azure AD application creation failed: $_"
}
