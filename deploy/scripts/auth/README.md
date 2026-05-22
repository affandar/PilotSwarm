# PilotSwarm Portal — Entra app registration scripts

PowerShell helpers for provisioning the Azure AD app registration that backs
`PORTAL_AUTH_PROVIDER=entra` on a PilotSwarm portal stamp.

These scripts are **not** wired into `npm run deploy` or the legacy
`scripts/deploy-aks.sh` flow. The deploy flows still consume
`PORTAL_AUTH_ENTRA_CLIENT_ID` as an input from your stamp's `.env` /
`.env.remote`. Run the wrapper here first, copy the printed client ID
into the env, then run deploy.

The agent / skill driving PilotSwarm npm deployments will offer to run
this for you (see `.github/skills/pilotswarm-portal-app-reg/SKILL.md`).
You can also invoke it directly.

## Files

| File | Purpose |
|------|---------|
| `Create3PApplication.ps1` | Generic Azure AD application primitive. Useful if you need a non-portal app registration (e.g. a worker daemon with app roles). The PilotSwarm portal wrapper does **not** call this — it does its own SPA-shaped `az ad app create` so it can configure the SPA platform + implicit-grant + per-token-type groups claim, which the generic primitive doesn't expose. |
| `Setup-PortalAuth.ps1` | Opinionated wrapper that creates the exact shape the PilotSwarm portal expects. See "Defaults" below. |
| `Set-PortalAuthAssignments.ps1` | Add / remove / list user + group assignments against the `admin` / `user` app roles on an existing portal app. Idempotent. Re-runnable. See `.github/skills/pilotswarm-portal-auth-assignments/SKILL.md` for full operator docs. |

## Prerequisites

- Azure CLI installed and on PATH
- PowerShell 7+ (`pwsh`) installed — these scripts run on **Windows, Linux, and macOS**.
  - Windows: install `pwsh` (PS 7) from <https://aka.ms/PowerShell>. Both `powershell.exe` (5.1) and `pwsh` (7) work; PS 7 is preferred.
  - macOS: `brew install --cask powershell`
  - Linux: see <https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux>
- `az login` completed as a user in the target tenant with permission to
  create application registrations (typically the "Application Developer"
  Entra role or higher).
- For `-EnvName` auto-discovery: the stamp's
  `deploy/.tmp/<EnvName>/bicep-outputs.cache.json` must exist (i.e. the
  bicep-publish step of `npm run deploy` has run at least once).

The scripts use only cross-platform pwsh APIs (`Join-Path`, `Resolve-Path`,
`[System.IO.Path]::GetTempFileName()`, `az`) and forward-slash path
separators throughout, so the same invocation works in all three OSes.

## Service Tree ID is required

Microsoft tenant policy requires every app registration to carry a valid
`serviceManagementReference` (Service Tree ID). `Setup-PortalAuth.ps1`
requires `-ServiceTreeId` as a mandatory parameter — **there is no
default**. Supply the Service Tree ID registered for your service.

If your organization does not yet have a Service Tree entry for the
PilotSwarm deployment, register one before running these scripts. The
tenant will reject `az ad app create` without a recognized value.

## Defaults (baked into Setup-PortalAuth.ps1)

| Setting | Value | Why |
|---------|-------|-----|
| `signInAudience` | `AzureADMyOrg` | Single-tenant (your tenant only) |
| `serviceManagementReference` | from `-ServiceTreeId` (required) | Tenant policy requires it |
| Platform | SPA (Single-page application) | Portal is a browser SPA using MSAL |
| `web.implicitGrantSettings.enableIdTokenIssuance` | `true` | Matches portal MSAL config |
| `web.implicitGrantSettings.enableAccessTokenIssuance` | `true` | Matches portal MSAL config |
| MS Graph delegated scopes | **none** | Portal never calls Graph at runtime; group/role claims ride on the ID token. SPA requests only OIDC standard scopes (`openid`, `profile`) at sign-in, which require no consent. Future downstream API access (e.g. ADO via OBO) belongs on per-purpose worker apps. |
| Optional `groups` claim | `idToken`, `accessToken`, `saml2Token` | Required for group-based admin/user role mapping (`PORTAL_AUTH_ENTRA_ADMIN_GROUPS`, `PORTAL_AUTH_ENTRA_USER_GROUPS`) |
| App roles (`-CreateAppRoles`) | optional `admin` + `user` (allowedMemberTypes=["User"]) | Read by `packages/portal/auth/authz/engine.js` — assign principals via "Enterprise applications > Users and groups" |
| `appRoleAssignmentRequired` (`-AssignmentRequired`) | optional, `true` when set | Blocks unassigned users from getting a token at all |
| Identifier URIs | none | Not an API |
| Service principal | created | Needed for tenant consent + role assignments |
| Owner | current signed-in user | Override with `-Owner <objectId>` |

## Common usage

All examples below run identically in **bash** (Linux/macOS) and **pwsh**
(any OS), because `pwsh -File <script>` is a single token from the
parent shell's perspective and all named parameters can be passed on
one line. Inside the script everything is pwsh.

If you want to break a long invocation across multiple lines, use the
line-continuation char native to your shell: `\` in bash, `` ` ``
(backtick) in pwsh.

### Production stamp (recommended posture)

```bash
# From repo root, any OS. Replace <your-service-tree-id> with your real ID.
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName prodstamp \
  -CreateAppRoles \
  -AssignmentRequired
```

- Creates `"PilotSwarm Portal - prodstamp"`
- Defines `admin` and `user` app roles (assignable from "Users and groups")
- Sets `appRoleAssignmentRequired=true` on the SP — only explicitly
  assigned users/groups can obtain a token
- Auto-discovers redirect URI from `deploy/.tmp/prodstamp/bicep-outputs.cache.json`
- Writes `{ tenantId, clientId, objectId, redirectUri }` to `deploy/envs/local/prodstamp/entra-app.json`
- Prints env-var lines to paste into the stamp's `.env`

After the script: assign at least one user to `admin` (so you can sign in)
via `Set-PortalAuthAssignments.ps1` (see
`.github/skills/pilotswarm-portal-auth-assignments/SKILL.md`). No admin
consent step is required — the app declares no API permissions; sign-in
uses OIDC standard scopes (`openid`, `profile`) which require no consent.

### Sandbox stamp (no role gating)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName mystamp
```

- Same shape but no app roles, no `appRoleAssignmentRequired`
- Any user in the tenant can sign in
- `PORTAL_AUTHZ_DEFAULT_ROLE` (typically `user`) decides the role of
  every signed-in principal

### Share one app across multiple stamps

If you have an existing app reg and just want to add a new stamp's
redirect URI to it:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -ExistingAppId <existing-app-id> \
  -EnvName mystamp
```

This appends the stamp's AFD endpoint to the existing app's SPA redirect
URI list (deduped) — no other modifications. `-ServiceTreeId` is still
required for parameter parsing but is not re-applied to the existing app.

### Pre-deploy creation (no redirect URI yet)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -DisplayName "PilotSwarm Portal - newstamp"
```

Creates the app shell with the correct policy/permissions/claims but
with an empty redirect-URI list. After deploy finishes, run again with
`-ExistingAppId <newAppId> -EnvName newstamp` to add the discovered URI.

## What this script will NOT do

- Will not write to `.env` files — you must paste `PORTAL_AUTH_ENTRA_CLIENT_ID`
  yourself (so secrets surface explicitly).
- Will not grant admin consent — none is required. The app declares no
  API permissions; the SPA requests only OIDC standard scopes (`openid`,
  `profile`) at sign-in, which require no consent. Group and role claims
  are populated by the token itself (via the `groups` optional claim and
  app-role assignments), not by runtime API calls — the portal never
  calls Graph or any other downstream API.
- Will not assign users to app roles. Use `Set-PortalAuthAssignments.ps1`
  (this folder) — wraps the Graph calls, idempotent, accepts UPNs /
  object IDs / group display names:
  ```
  pwsh -NoProfile -ExecutionPolicy Bypass \
    -File deploy/scripts/auth/Set-PortalAuthAssignments.ps1 \
    -EnvName <stamp> -AdminAssignments <upn> [-UserAssignments <upn|group>...]
  ```
  See `.github/skills/pilotswarm-portal-auth-assignments/SKILL.md` for
  full operator docs. The Entra portal UI
  ("Enterprise applications > <app> > Users and groups") still works
  if you'd rather click.
- Will not configure `PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAME`,
  `PORTAL_AUTHZ_ENTRA_USER_ROLE_NAME`, or any other `PORTAL_AUTHZ_*` env
  vars — those are deploy-time inputs to the portal `.env` (and default
  to suffix-strip mapping when unset, so most stamps don't need them).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Insufficient privileges to complete the operation` on `az ad app create` | Account is missing the "Application Developer" role or higher in Entra | Have an Entra admin grant the role, or run as someone who has it |
| `Service tree ID is not valid` / tenant policy rejection | `-ServiceTreeId` not registered in your tenant's Service Tree | Register a Service Tree entry for the PilotSwarm deployment, then re-run with the registered GUID |
| `az ad signed-in-user show` returns empty | You ran `az login --identity` (managed identity) or service-principal login | Run the script under an interactive `az login` user account |
| Portal still shows "sign in" loop after deploy | Most often: redirect URI on the app reg doesn't match the deployed AFD endpoint exactly | Run `az ad app show --id <clientId> --query "spa.redirectUris"` and compare against your portal's `https://` root |
| Group claims missing from access token | The `groups` optional claim was not added to the app reg (or the user is in 200+ groups, triggering Graph overage which is unsupported here) | Re-run the script — it idempotently re-applies the optional-claim. If overage is the cause, switch the stamp to roles posture (`-CreateAppRoles`) instead of group-based authz |
| Signed-in user with no role gets `defaultRole` instead of being denied | `-AssignmentRequired` was NOT set, so any tenant user can sign in even without an app-role assignment | Re-run with `-AssignmentRequired` (or set it manually: `az ad sp update --id <sp-objectId> --set appRoleAssignmentRequired=true`) |
| `403` on portal admin routes | Signed-in user does not have the `admin` app role (or matching group via `PORTAL_AUTH_ENTRA_ADMIN_GROUPS`) | Assign the user to the `admin` role: `pwsh -File deploy/scripts/auth/Set-PortalAuthAssignments.ps1 -EnvName <stamp> -AdminAssignments <upn>` (or via Entra portal "Users and groups") |

## Why `Create3PApplication.ps1` is included

`Create3PApplication.ps1` is a generic Azure AD app primitive included
for completeness — future scripts that need a non-portal-shaped app
registration (e.g. a worker daemon with app-roles, a confidential
client) can use it directly. The PilotSwarm portal wrapper does not
call it because the portal needs SPA-specific Graph PATCH calls that
the generic primitive doesn't perform.
