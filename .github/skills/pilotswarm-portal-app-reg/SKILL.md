---
name: pilotswarm-portal-app-reg
description: "Use when bringing up a PilotSwarm portal stamp with `PORTAL_AUTH_PROVIDER=entra` and no existing `PORTAL_AUTH_ENTRA_CLIENT_ID`. Drives the Entra app-registration step (create app, configure redirect URIs, optionally define app roles + require assignment, capture tenant/client IDs). Skip entirely for `PORTAL_AUTH_PROVIDER=none` or when a client ID is already supplied."
---

# pilotswarm-portal-app-reg

Drives the Entra app-registration step for a PilotSwarm portal stamp.

This skill is **optional** — only invoke it when the user wants
`PORTAL_AUTH_PROVIDER=entra` AND does not already have a
`PORTAL_AUTH_ENTRA_CLIENT_ID` to plug in. For `PORTAL_AUTH_PROVIDER=none`
(open sandbox), skip the whole skill.

## When to use this skill

| User signal | Use this skill? |
|---|---|
| "set up entra auth for a new stamp" / "I need a client id" / new stamp with no opinion on auth wiring | **YES — create new (default recommendation)** |
| "add a new stamp to the existing app" / mentions sharing a client id / wants single SSO consent across stamps | YES — `-ExistingAppId` mode |
| "production stamp, lock down access" / "only certain people should sign in" / smoke-testing the role-driven authz | YES — create new with `-CreateAppRoles -AssignmentRequired` |
| "skip auth" / "open sandbox" / `PORTAL_AUTH_PROVIDER=none` | NO — skip entirely |
| User already pasted a `PORTAL_AUTH_ENTRA_CLIENT_ID` | NO — that value flows straight through to deploy |

**Default posture: one dedicated app per stamp.** Recommend the
create-new path unless the user explicitly asks to share an existing
app. Per-stamp apps keep redirect URI lists short, make environment
teardown a single `az ad app delete`, and isolate consent / revocation
blast radius. The script auto-derives a friendly, env-specific display
name (`"PilotSwarm Portal - <EnvName>"`) from `-EnvName` — do not
override unless the user asks.

The deployer agent **must decide the auth posture before opening the
new-env defaults table**, because the value of
`PORTAL_AUTH_ENTRA_CLIENT_ID` depends on the outcome.

## Service Tree ID is required (no default)

`Setup-PortalAuth.ps1` requires `-ServiceTreeId` as a mandatory
parameter. Microsoft tenant policy rejects app registrations without a
valid `serviceManagementReference`, so the script does too.

Before invoking, ask the user for their Service Tree ID. If they don't
have one registered for their PilotSwarm deployment, stop and direct
them to register one — the tenant will reject `az ad app create`
otherwise. Do **not** invent a placeholder GUID.

## Underlying tooling

| Script | Path | Purpose |
|---|---|---|
| `Setup-PortalAuth.ps1` | `deploy/scripts/auth/` | Opinionated wrapper that produces the exact SPA-shaped app reg the portal expects |
| `Create3PApplication.ps1` | `deploy/scripts/auth/` | Generic Azure AD app primitive (reference; not used by the wrapper) |
| `README.md` | `deploy/scripts/auth/` | Operator docs |

The wrapper bakes in:
- `signInAudience: AzureADMyOrg`
- `serviceManagementReference: <-ServiceTreeId>` (operator-supplied)
- SPA platform (no Web reply URLs)
- `implicitGrantSettings`: id-token + access-token issuance ON
- MS Graph delegated permissions: `User.Read` + `GroupMember.Read.All`
- `groups` optional claim on `idToken`, `accessToken`, `saml2Token` with Default formatting
- Owner = signed-in user
- Service principal created

Optional (off by default, opt-in with switches):
- `-CreateAppRoles` defines two app roles (`admin`, `user`) that the
  portal's role-driven authorization engine reads from the access token
  (see `packages/portal/auth/authz/engine.js`)
- `-AssignmentRequired` sets `appRoleAssignmentRequired=true` on the
  service principal so only users/groups explicitly assigned to the app
  can obtain a token

These bakes are NOT user-configurable — they are the contract the
PilotSwarm portal depends on. The script's parameters only cover the
things that vary per invocation.

## Discovery (run before showing the table)

```bash
az account show --query "{tenant:tenantId, user:user.name, userObjectId:id}" -o json
```

- `tenant` → user's current tenant (used as `PORTAL_AUTH_ENTRA_TENANT_ID`)
- `user` → suggested display-name suffix and known to the operator
- The wrapper itself derives the owner objectId via `az ad signed-in-user show`,
  but surface the UPN so the user knows whose name will be on the app

If the user provided an `EnvName` (stamp name) and a bicep-output cache
exists, also surface the resolved redirect URI:

```bash
# Path: deploy/envs/<env>/bicep-outputs.cache.json
# Look for: portalFqdn | afdEndpointHostname | portalUrl | PORTAL_FQDN
```

## Present the full input surface upfront

Show every parameter in a single table — same UX contract as
`pilotswarm-new-env-deploy`. Mark each value `(default)`, `(discovered)`,
`(required)`, or `(suggested)`:

```
Mode
  mode                     create-new (default)        # create-new | add-redirect-to-existing

Identity
  ServiceTreeId            <required: no default>
  DisplayName              <suggested: "PilotSwarm Portal - ${EnvName}">
  Owner                    <discovered: ${userObjectId} (${user})>
  SkipGroupsClaim          false (default)             # keep groups claim ON for PORTAL_AUTH_ENTRA_*_GROUPS

Role-driven authz (recommended for prod stamps)
  CreateAppRoles           false (default)             # add 'admin' + 'user' app roles
  AssignmentRequired       false (default)             # require explicit assignment to obtain a token

Redirect URI (mode=create-new only)
  EnvName                  <required-or-pick-one>
  RedirectUri              <auto-discover from EnvName, OR ask user explicitly>
                           # leave both empty to create app shell first, add URI later

Existing app (mode=add-redirect-to-existing)
  ExistingAppId            <required for this mode>
  RedirectUri              <required for this mode>

Output
  OutputFile               deploy/envs/${EnvName}/entra-app.json (default when EnvName given)
```

State the chosen mode explicitly to the user before invoking. Confirm
before running — this WRITES to Entra and creates a permanent app reg.

## Decide app-role posture before invoking

There are three meaningful postures for a portal stamp; pick one with
the user:

| Posture | Switches | Who can sign in | Who gets the `admin` role | When to use |
|---|---|---|---|---|
| **Open** | neither | Any tenant user | Nobody (all signed-in users get `PORTAL_AUTHZ_DEFAULT_ROLE`, typically `user`) | Short-lived test stamps; pure sandbox |
| **Roles, no lockdown** | `-CreateAppRoles` | Any tenant user | Users assigned to `admin` via Enterprise apps > Users and groups (role-less principals still sign in and fall through to `defaultRole`) | Dev stamps where you want some admins but don't need to block other tenant users |
| **Roles + lockdown** (recommended for prod) | `-CreateAppRoles -AssignmentRequired` | Only users/groups explicitly assigned to a role | Same as above | Production stamps where the portal should only be reachable by named individuals |

The "Roles + lockdown" posture closes the gap where a tenant user with
no role assignment still gets `defaultRole`. With
`appRoleAssignmentRequired=true`, an unassigned principal gets a sign-in
error from Entra before any token is issued — they never reach the
portal at all.

**Don't mix postures in the env.** When you choose either roles posture,
leave `PORTAL_AUTHZ_ADMIN_GROUPS` and `PORTAL_AUTHZ_USER_GROUPS` empty
in the stamp's `.env`. The portal authz engine treats role claims as
authoritative when present (see `packages/portal/auth/authz/engine.js`
and `docs/portal-entra-app-roles.md`); the email-allowlist envs are
the **Open**-posture mechanism only. Populating both creates a
duplicate source of truth that the next person reading the env will
have to untangle — and the role claim will win regardless.

**Assignment is a separate step.** This skill creates the app + role
definitions, but does not assign any principals to them. Immediately
after invoking `Setup-PortalAuth.ps1 -CreateAppRoles`, use the
[`pilotswarm-portal-auth-assignments`](../pilotswarm-portal-auth-assignments/SKILL.md)
skill to assign at least one admin (default: the deploying user).
Without that, a `-AssignmentRequired` app is unreachable and a
no-lockdown app leaves everyone falling through to
`PORTAL_AUTHZ_DEFAULT_ROLE` with no admin.

## Invocation

Always invoke `pwsh` directly. Do not wrap through `npm` — there is no
npm wrapper for this script intentionally (keeps the deploy npm pipeline
focused on what's controlled by `.env`).

**Shell compatibility:** the script runs identically on Windows, Linux,
and macOS as long as PowerShell 7+ (`pwsh`) is installed. From the
calling shell's perspective the invocation is a single `pwsh -File ...`
token followed by named parameters — bash and pwsh handle it the same
way. Use `\` for line continuation in bash, `` ` `` (backtick) in pwsh.
The script uses forward-slash path separators and cross-platform pwsh
APIs internally. See `deploy/scripts/auth/README.md` for `pwsh` install
commands per OS.

**Shell quoting pitfalls** (read before running ad-hoc pwsh from another
shell):

- Always invoke this wrapper with `-File`, never `-Command`. `-File`
  takes a path + named params and is immune to outer-shell expansion.
- If you must run an ad-hoc snippet (e.g. a quick version probe), the
  outer shell — whether PowerShell, bash, or zsh — will try to expand
  `$VAR` and backticks before pwsh ever sees them. Two safe forms:
  - `pwsh -Version` (no script needed — preferred for version checks)
  - `pwsh -NoProfile -Command '<single-quoted script>'` (single quotes
    suppress outer-shell expansion in both bash and PowerShell)
- Do **not** use `pwsh -Command "$PSVersionTable…"` from a PowerShell
  parent — the parent evaluates `$PSVersionTable` first and passes
  garbage to the child. The same trap applies to bash with `"$VAR"`.
- For multi-line scripts, prefer a real `.ps1` file invoked with
  `-File`. Inline `-Command` is for one-liners only.

### Create new for a stamp (default — recommended)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name>
```

`-EnvName` does double duty: it sets the display name to
`"PilotSwarm Portal - <stamp-name>"` automatically and tells the script
where to read/write per-stamp artifacts. Do **not** pass `-DisplayName`
unless the user wants a non-standard name.

This auto-discovers the redirect URI from
`deploy/envs/<stamp>/bicep-outputs.cache.json` and writes a JSON summary
to `deploy/envs/<stamp>/entra-app.json`. If the bicep cache doesn't
exist yet (you're running BEFORE first deploy), keep `-EnvName` for the
display name and per-stamp output path, and add `-RedirectUri` once you
know the AFD endpoint (or omit it entirely to create the app shell now
and append the URI after bicep runs):

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name> \
  -RedirectUri "https://<predicted-afd-fqdn>"
```

### Create new for a production stamp (roles + lockdown)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name> \
  -CreateAppRoles \
  -AssignmentRequired
```

After this completes the operator MUST:
1. Open Entra portal > Enterprise applications > `"PilotSwarm Portal - <stamp-name>"` > Users and groups
2. Add at least one user (themselves, usually) to the `Admin` role —
   otherwise no one can sign in because `appRoleAssignmentRequired=true`.

### Add a stamp to a shared existing app

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -ExistingAppId <appId> \
  -EnvName <stamp-name>
```

(`-ServiceTreeId` is still required for parameter parsing in this mode
but is not re-applied to the existing app.)

## After the script runs

The script prints two lines the user must paste somewhere:

```
PORTAL_AUTH_ENTRA_TENANT_ID = <tenantId>
PORTAL_AUTH_ENTRA_CLIENT_ID = <new-app-id>
```

For a stamp using the npm `new-env` orchestrator, the operator paths are:
1. **If you have NOT scaffolded the stamp yet**: hand the values to the
   user before `new-env` runs so they go into the scaffolded `.env`
   in the right place.
2. **If you ALREADY scaffolded with `PORTAL_AUTH_PROVIDER=none`**: the
   user edits `deploy/envs/<stamp>/.env` to flip provider to `entra`
   and paste the two values, then re-runs deploy from the manifests
   step (`node deploy/scripts/deploy.mjs portal <stamp> --steps manifests,rollout`).

For the legacy bash AKS flow (`scripts/deploy-aks.sh` /
`scripts/deploy-portal.sh`), paste the values into `.env.remote`
(or wherever your live cluster reads portal config from) and re-run
`./scripts/deploy-portal.sh`.

The wrapper itself NEVER edits `.env` files — the operator pastes the
values explicitly so they surface visibly.

## Admin consent

The `GroupMember.Read.All` delegated scope typically requires admin
consent in the tenant. The wrapper does **not** grant consent. After
the app is created, mention to the user:

```bash
az ad app permission admin-consent --id <new-app-id>
```

(requires tenant admin role) or direct them to the Azure portal: App
registration → API permissions → "Grant admin consent".

Without consent, sign-in still works but group claims will be empty,
and `PORTAL_AUTH_ENTRA_ADMIN_GROUPS` / `PORTAL_AUTH_ENTRA_USER_GROUPS`
keyed on group object IDs will not match. UPN-based admin lists
(`PORTAL_AUTHZ_ADMIN_GROUPS`) still work without consent.

## Role assignments (when -CreateAppRoles is used)

After the script creates the `admin` and `user` app roles, principals
must still be assigned. The script does NOT do this — it only defines
the roles. Two paths:

1. **Entra portal** (recommended for one-offs): Enterprise applications
   > `"PilotSwarm Portal - <stamp>"` > Users and groups > Add
   user/group > pick role.
2. **Scripted** (CI / many users): `az rest` against
   `https://graph.microsoft.com/v1.0/servicePrincipals/<sp-objectId>/appRoleAssignedTo`
   with the principal ID, resource ID (the SP's own object ID), and
   `appRoleId` from the entra-app.json summary.

If `-AssignmentRequired` is set and no one is assigned, sign-in fails
with `AADSTS50105: The signed in user is not assigned to a role for the
application`. Assign the operator FIRST so they can finish setting up.

## What this skill will not do

- Will not write to `.env` files (operator surfaces values explicitly)
- Will not grant admin consent (separate tenant-admin action)
- Will not assign users to app roles (Entra portal or `az rest` after creation)
- Will not modify the npm `new-env` / `deploy` pipelines — they
  continue to consume `PORTAL_AUTH_ENTRA_CLIENT_ID` as plain input
- Will not provision app registrations of non-portal shapes — for
  worker daemons or APIs, use `Create3PApplication.ps1` directly or
  write a new wrapper
- Will not invent a Service Tree ID — operator must supply

## Constraints

- `-ServiceTreeId` is **mandatory by tenant policy** — refuse to
  invent a placeholder
- Never run the wrapper against a non-target tenant — the script will
  succeed but the app will be useless to your portal
- Never propose granting `Application.ReadWrite.All` or similar
  high-privilege tenant scopes — `User.Read` + `GroupMember.Read.All`
  is the full delegated-scope surface the portal needs
- Single-tenant only by design. Multi-tenant or personal-MSA sign-in is
  out of scope for the wrapper; use `Create3PApplication.ps1` if you
  need a different shape
