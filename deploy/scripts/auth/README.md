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
| `Setup-OboSmokeWorkerApp.ps1` | Opinionated wrapper that creates the per-stamp **OBO live-smoke downstream worker app** — required only when running OBO live-smoke against a stamp. Creates the app, exposes an OAuth2 delegated scope, declares Microsoft Graph `User.Read` as a delegated permission, pre-authorizes the per-stamp portal app, and create-or-patches the AKS workload-identity federated identity credential on the Entra application itself. Writes a sidecar JSON and prints the smoke `.env` paste block. Idempotent. See "OBO smoke worker app" below + `.github/skills/pilotswarm-obo-smoke-app-reg/SKILL.md`. |

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

For OBO live-smoke, run the smoke worker image variant (`--variant smoke`) and compose the emitted smoke env overlay into the stamp env before worker rollout.

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
| `appRoleAssignmentRequired` (`-AssignmentRequired`) | optional, off by default | Sets `appRoleAssignmentRequired=true` on the SP — blocks unassigned users from getting a token at all. **Leave OFF in tenants with restricted user-consent policies** (e.g. Microsoft corporate tenant): turning it on causes AADSTS90094 admin-consent prompts on every assigned user's first sign-in. With `-CreateAppRoles` + role assignments, the engine's role-authoritative branch already denies any principal without a role claim — `-AssignmentRequired` is redundant for lockdown in that posture. |
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
  -CreateAppRoles
```

- Creates `"PilotSwarm Portal - prodstamp"`
- Defines `admin` and `user` app roles (assignable from "Users and groups")
- Leaves `appRoleAssignmentRequired=false` (the recommended default —
  see the caveat below)
- Auto-discovers redirect URI from `deploy/.tmp/prodstamp/bicep-outputs.cache.json`
- Writes `{ tenantId, clientId, objectId, redirectUri }` to `deploy/envs/local/prodstamp/entra-app.json`
- Prints env-var lines to paste into the stamp's `.env`

After the script:

1. Assign at least one user to `admin` via
   `Set-PortalAuthAssignments.ps1` (see
   `.github/skills/pilotswarm-portal-auth-assignments/SKILL.md`). The
   role assignment list in Entra **is** the allowlist for this stamp —
   no env-var allowlist needed.
2. Deploy the stamp. The portal engine is deny-by-default (since
   v0.1.33): assigned users get `admin` / `user` from the JWT `roles`
   claim; anyone else who signs in (any tenant user, since
   `appRoleAssignmentRequired=false`) hits the engine's no-role,
   no-allowlist branch and is denied.

Do **not** also populate `PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS` here — when the JWT carries `roles[]`, the
engine's role-authoritative branch ignores the email allowlists
entirely (see `packages/portal/auth/authz/engine.js`). Two sources of
truth for "who's an admin" just confuses the next operator.

No admin-consent step is required — the app declares no API
permissions; sign-in uses OIDC standard scopes (`openid`, `profile`)
which require no consent.

### Advanced: Entra-level lockdown with `appRoleAssignmentRequired=true`

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName prodstamp \
  -CreateAppRoles \
  -AssignmentRequired
```

⚠️ **Caveat.** In tenants where user-consent is restricted to
verified-publisher apps (e.g. the Microsoft corporate tenant), turning
on `appRoleAssignmentRequired=true` causes the first sign-in by every
assigned principal to trip an AADSTS90094 admin-consent prompt for the
OIDC scopes (`openid profile offline_access`) against Microsoft Graph,
even though this app declares no API permissions. Use this posture
only when you have tenant-admin support to pre-grant OIDC scopes for
the app, or you accept that each assigned principal will need to do
the one-time consent dance (flip the flag off, sign in once, flip the
flag back on).

For most production stamps, prefer the **Production stamp
(recommended posture)** above: `-CreateAppRoles` + role assignments +
engine deny-by-default, with `appRoleAssignmentRequired=false`. The
role assignment in Entra is already the allowlist; flipping
`appRoleAssignmentRequired=true` only adds value if you want a second
gate at the Entra level (and can tolerate the restricted-tenant
caveat).

### Sandbox stamp (open posture, explicit opt-in)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName mystamp
```

Then set `PORTAL_AUTHZ_DEFAULT_ROLE=user` in
`deploy/envs/local/mystamp/.env`.

- Same shape but no app roles, no `appRoleAssignmentRequired`
- Any user in the tenant can sign in and is granted `user`

Without `PORTAL_AUTHZ_DEFAULT_ROLE=user`, the portal engine's new
deny-by-default behavior rejects every sign-in for a no-allowlist,
no-roles stamp.

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
- Will not configure `PORTAL_AUTHZ_*` env vars — those are deploy-time
  inputs to the portal `.env`. The roles-mode path needs no env-var
  knobs (the engine matches the JWT `roles` claim by case-insensitive
  equality against the canonical values `admin` / `user` that this
  script creates).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Insufficient privileges to complete the operation` on `az ad app create` | Account is missing the "Application Developer" role or higher in Entra | Have an Entra admin grant the role, or run as someone who has it |
| `Service tree ID is not valid` / tenant policy rejection | `-ServiceTreeId` not registered in your tenant's Service Tree | Register a Service Tree entry for the PilotSwarm deployment, then re-run with the registered GUID |
| `az ad signed-in-user show` returns empty | You ran `az login --identity` (managed identity) or service-principal login | Run the script under an interactive `az login` user account |
| Portal still shows "sign in" loop after deploy | Most often: redirect URI on the app reg doesn't match the deployed AFD endpoint exactly | Run `az ad app show --id <clientId> --query "spa.redirectUris"` and compare against your portal's `https://` root |
| Group claims missing from access token | The `groups` optional claim was not added to the app reg (or the user is in 200+ groups, triggering Graph overage which is unsupported here) | Re-run the script — it idempotently re-applies the optional-claim. If overage is the cause, switch the stamp to roles posture (`-CreateAppRoles`) instead of group-based authz |
| Signed-in user with no role gets `defaultRole` instead of being denied | The stamp has `PORTAL_AUTHZ_DEFAULT_ROLE=user` (legacy open posture) | Leave `PORTAL_AUTHZ_DEFAULT_ROLE` unset (defaults to `none` = deny-by-default since v0.1.33). With `-CreateAppRoles`, assigned users get `admin`/`user` via the JWT role claim; unassigned signed-in users are denied by the engine |
| First sign-in fails with `AADSTS90094` admin-consent prompt after `-AssignmentRequired` | Tenant user-consent policy restricts non-verified-publisher apps; the OIDC sign-in flow can't create the user-consent grant for Microsoft Graph (`openid profile offline_access`) on the user's behalf while `appRoleAssignmentRequired=true` blocks them | One-time dance: `az ad sp update --id <sp-objectId> --set appRoleAssignmentRequired=false`, have each affected user sign in once to accept user-consent, then flip back to `true`. Or drop `-AssignmentRequired` entirely — with `-CreateAppRoles` + role assignments, the engine's deny-by-default behavior already enforces lockdown without needing the Entra-side gate |
| `403` on portal admin routes | Signed-in user does not have the `admin` app role (or matching group via `PORTAL_AUTH_ENTRA_ADMIN_GROUPS`) | Assign the user to the `admin` role: `pwsh -File deploy/scripts/auth/Set-PortalAuthAssignments.ps1 -EnvName <stamp> -AdminAssignments <upn>` (or via Entra portal "Users and groups") |

## OBO smoke worker app (`Setup-OboSmokeWorkerApp.ps1`)

The OBO live-smoke harness (`pilotswarm smoke <stamp> --profile obo`)
exercises the full two-hop OBO chain on a deployed stamp: portal
acquires a worker-audienced token → worker exchanges that token via
`acquireTokenOnBehalfOf` for a Microsoft Graph `User.Read` token →
worker calls Graph as the signed-in user. That chain requires a
**per-stamp downstream worker AAD app** distinct from the portal app
and from the worker's own UAMI.

`Setup-OboSmokeWorkerApp.ps1` provisions that app and its supporting
infra in a single idempotent invocation. It is the OBO analog of
`Setup-PortalAuth.ps1` and runs after both the portal app-reg and the
per-stamp bicep step have succeeded.

### What it does

1. Creates (or finds, by display name) the app
   `"PilotSwarm OBO Smoke Worker - <EnvName>"`.
2. Mints (or re-reads) an OAuth2 delegated scope `user_impersonation`
   under `identifierUri: api://<appId>` with
   `requestedAccessTokenVersion = 2` (so issued tokens are v2 —
   `@azure/msal-node`'s `acquireTokenOnBehalfOf` requires v2).
3. Declares Microsoft Graph `User.Read` as a **delegated** permission
   (`type=Scope`). Without this declaration, the worker's OBO exchange
   returns `AADSTS65001` at runtime even with pre-authorization in
   place.
4. Overwrites `api.preAuthorizedApplications` with a single-element
   array containing the per-stamp portal app's clientId (read from
   `deploy/envs/local/<EnvName>/entra-app.json`, or supplied via
   `-PortalClientId`). Overwrite (not merge) because each stamp has a
   strict 1:1 portal-app → worker-app relationship.
5. Create-or-patches the AKS workload-identity federated identity
   credential **on the Entra application** (not on a UAMI). Subject
   defaults to `system:serviceaccount:pilotswarm:copilot-runtime-worker`,
   audience `api://AzureADTokenExchange`. The OIDC issuer URL is read
   from `deploy/.tmp/<EnvName>/bicep-outputs.cache.json`.
6. Optionally (`-GrantAdminConsent`) runs `az ad app permission
   admin-consent` for Graph `User.Read`. A shortcut that skips the
   per-user consent prompt on first sign-in for every user; only
   meaningful when the running principal is a tenant Global Admin (or
   a Cloud Application Administrator). Per-user consent at portal
   sign-in is the default path otherwise.
7. Writes a JSON sidecar at
   `deploy/envs/local/<EnvName>/obo-smoke-worker-app.json`.
8. Prints the smoke `.env` paste block to stdout for the operator to
   paste into `deploy/envs/local/<EnvName>/.env`:

   ```
   PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE=api://<worker-app-id>/.default offline_access
   OBO_SMOKE_WORKER_APP_TENANT_ID=<tenant-id>
   OBO_SMOKE_WORKER_APP_CLIENT_ID=<worker-app-id>
   OBO_SMOKE_WORKER_APP_GRAPH_SCOPE=https://graph.microsoft.com/User.Read
   PLUGIN_DIRS=/app/packages/obo-smoke-plugin
   ```

**The wrapper never edits `.env`** — same single-actor-on-`.env`
invariant `Setup-PortalAuth.ps1` preserves. Paste the lines
yourself, or have the npm-deployer agent do it via its `edit` tool.

### Invocation

Two-phase (recommended for new-env bring-up):

```bash
# Phase 1 — before bicep (alongside Setup-PortalAuth.ps1):
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -Mode app-shell \
  -ServiceTreeId <id> \
  -EnvName <stamp>

# Phase 2 — after bicep, before worker manifests,rollout:
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -Mode patch-fic \
  -ServiceTreeId <id> \
  -EnvName <stamp>
```

Single-shot (back-compat default; requires bicep to have run):

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -ServiceTreeId <id> \
  -EnvName <stamp>
```

`-Mode app-shell` skips the FIC and OIDC-issuer dependency; only the
app + scope + pre-auth are created and the `.env` paste block is
emitted. `-Mode patch-fic` looks up the existing app, reads the OIDC
issuer from `deploy/.tmp/<EnvName>/bicep-outputs.cache.json`, and
create-or-patches the FIC (no `.env` changes). `-Mode all` (default)
does both.

For full parameter reference, troubleshooting, and the
upstream-audience-vs-downstream-resource scope distinction, see
`.github/skills/pilotswarm-obo-smoke-app-reg/SKILL.md`.

### When NOT to run it

- Default production stamps or any stamp that will not run OBO live-smoke. Runtime opt-in also requires a worker image built with `--variant smoke` and the smoke env overlay, including `PLUGIN_DIRS=/app/packages/obo-smoke-plugin`.
- Stamps using `PORTAL_AUTH_PROVIDER=none` — the smoke harness
  requires a signed-in portal user.

For stamps that already have the smoke env values pasted, re-running
the wrapper is a safe no-op (idempotent re-read of the OAuth2 scope
GUID, FIC create-or-patch by deterministic name). To point at a
manually-managed downstream app, pass `-ExistingAppId <appId>` rather
than skipping the wrapper — the FIC + Graph perm + pre-auth still
need to be patched on whatever app the smoke env points at.

## Why `Create3PApplication.ps1` is included

`Create3PApplication.ps1` is a generic Azure AD app primitive included
for completeness — future scripts that need a non-portal-shaped app
registration (e.g. a worker daemon with app-roles, a confidential
client) can use it directly. The PilotSwarm portal wrapper does not
call it because the portal needs SPA-specific Graph PATCH calls that
the generic primitive doesn't perform.
