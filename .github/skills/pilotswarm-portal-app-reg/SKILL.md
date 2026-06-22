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
| "production stamp, lock down access" / "only certain people should sign in" / smoke-testing the role-driven authz | YES — create new with `-CreateAppRoles` and assign users to the `admin` / `user` roles |
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
- **No MS Graph / API permissions** declared. The portal does NOT call
  any downstream API at runtime — group/role claims ride on the token
  itself. SPA requests only OIDC standard scopes (`openid`, `profile`)
  at sign-in, which require no consent. Future downstream API access
  (e.g. ADO via OBO) belongs on per-purpose worker apps with their own
  admin consent — see `docs/proposals/portal-auth-provider-and-authz.md`.
- `groups` optional claim on `idToken`, `accessToken`, `saml2Token` with Default formatting
- Owner = signed-in user
- Service principal created

Optional (off by default, opt-in with switches):
- `-CreateAppRoles` defines two app roles (`admin`, `user`) that the
  portal's role-driven authorization engine reads from the access token
  (see `packages/portal/auth/authz/engine.js`)
- `-AssignmentRequired` sets `appRoleAssignmentRequired=true` on the
  service principal so only users/groups explicitly assigned to the app
  can obtain a token.

  ⚠️ **Caveat — leave OFF by default.** In tenants where user-consent
  is restricted to verified-publisher apps (e.g. the Microsoft corporate
  tenant), turning this on causes the first sign-in by every assigned
  principal to trip an AADSTS90094 admin-consent prompt for the OIDC
  scopes (`openid profile offline_access`) against Microsoft Graph,
  even though this app declares no API permissions. The workaround is
  a per-user "dance" (flip off, sign in once to accept user-consent for
  Graph, flip back on) or a tenant admin pre-granting the OIDC scopes.
  The recommended lockdown posture uses `-CreateAppRoles` plus role
  assignments in Entra, while leaving `appRoleAssignmentRequired=false`.
  The role assignment list **is** the allowlist — the engine's
  deny-by-default behavior rejects any signed-in principal without an
  admin/user role claim. See the posture matrix below.

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
  AssignmentRequired       false (default, recommended OFF — see caveat in "Underlying tooling" above)

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
| **Open** | neither (and `PORTAL_AUTHZ_DEFAULT_ROLE=user` in `.env`) | Any tenant user | Nobody — every signed-in user gets `user` | Short-lived test stamps; pure sandbox where the portal is intentionally open to the whole tenant |
| **Roles** (recommended for prod) | `-CreateAppRoles`, plus role assignments in Entra | Any tenant user can hit sign-in, but the engine denies anyone without an `admin` or `user` role claim | Users assigned to the `admin` app role via `Set-PortalAuthAssignments.ps1` or Enterprise apps > Users and groups | Production stamps. The role assignment in Entra **is** the allowlist; the engine is **deny-by-default** for principals with no admin/user role. No env-var allowlist needed. |
| **Roles + `appRoleAssignmentRequired=true`** (advanced opt-in) | `-CreateAppRoles -AssignmentRequired` | Only users/groups explicitly assigned to a role | Same as above | Same use cases as the previous row, but adds a second gate at the Entra level. Requires per-user admin or self consent for the OIDC scopes against Microsoft Graph the first time anyone signs in — in restricted tenants this trips AADSTS90094. Prefer the previous row unless you have tenant-admin support to pre-grant. |
| **Legacy email allowlist** (no roles) | neither, plus populate `PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` in the stamp's `.env` | Any tenant user can hit sign-in; the engine denies anyone whose email is not on the list | Users whose email matches `PORTAL_AUTHZ_ADMIN_GROUPS` | Stamps that don't want to do per-stamp Entra role assignments. The engine consults these allowlists only when the JWT carries no `roles[]` claim — combining them with `-CreateAppRoles` is redundant (the role-authoritative branch wins). |

**Deny-by-default is now in the engine** (since v0.1.33). When
`PORTAL_AUTHZ_DEFAULT_ROLE` is unset or set to `none`, a principal that
carries no admin/user role claim and matches no email allowlist is
denied at the portal layer — even when `appRoleAssignmentRequired` is
off. Set `PORTAL_AUTHZ_DEFAULT_ROLE=user` to restore the legacy "any
tenant user gets `user`" open posture (only do this for sandbox stamps).

**Pick one mechanism per stamp.** The engine's role-authoritative
branch (see `packages/portal/auth/authz/engine.js`) ignores
`PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` whenever the
JWT carries any `roles[]` claim. So if you chose **Roles**, do NOT
also populate the email allowlists — they are bypassed and become a
second source of truth the next operator has to reconcile. The
allowlists are only meaningful in the **Legacy email allowlist**
posture (no `-CreateAppRoles`).

**Assignment is a separate step.** This skill creates the app + role
definitions, but does not assign any principals to them. Immediately
after invoking `Setup-PortalAuth.ps1 -CreateAppRoles`, use the
[`pilotswarm-portal-auth-assignments`](../pilotswarm-portal-auth-assignments/SKILL.md)
skill to assign at least one admin (default: the deploying user).
Without that, every sign-in is denied at the portal layer because no
one has the `admin` or `user` role claim yet.

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
to `deploy/envs/<stamp>/entra-app.json`. **AFD + VPN stamps**
(`VPN_GATEWAY_ENABLED=true` with `EDGE_MODE=afd`) get **two** redirect
URIs registered automatically: the AFD endpoint (public path) and the
portal `PORTAL_HOSTNAME` (VPN-private path, served by the AppGw
listener behind the Private DNS A record). If the bicep cache doesn't
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

### Create new for a production stamp (roles — recommended)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name> \
  -CreateAppRoles
```

After this completes the operator MUST assign at least one admin via
`Set-PortalAuthAssignments.ps1 -EnvName <stamp-name> -AdminAssignments <upn>`
(or Entra portal > Enterprise applications > `"PilotSwarm Portal - <stamp-name>"` > Users and groups).

The portal engine is deny-by-default (since v0.1.33). With role
assignments in place, assigned users get `admin` / `user` from the JWT
`roles` claim. Any tenant user can still hit the sign-in page (since
`appRoleAssignmentRequired=false`), but the engine rejects them when
they arrive without a role claim. Do **not** also populate
`PORTAL_AUTHZ_ADMIN_GROUPS` here — when the JWT carries `roles[]`, the
engine's role-authoritative branch ignores the email allowlists
entirely.

### Advanced: roles + `appRoleAssignmentRequired=true` (Entra-level lockdown)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-PortalAuth.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name> \
  -CreateAppRoles \
  -AssignmentRequired
```

Use only when you have tenant-admin support to pre-grant the OIDC
scopes for the app, OR you accept that each assigned principal will
need to do the one-time consent dance described in the caveat above.

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

**Not required.** The portal app registration declares **no API
permissions**. The SPA requests only OIDC standard scopes (`openid`,
`profile`) at sign-in, which require no user or admin consent. The
portal's own-API token (`<clientId>/.default` acquired silently after
login) is a token to the portal's own app, not to any external resource,
so it also requires no consent.

This is deliberate: the portal does **not** call MS Graph or any other
downstream API at runtime. Group and role claims that drive
authorization are sourced from the ID token directly:

- Group membership via the `groups` optional claim configured on the
  app registration (the wrapper applies this).
- Role membership via Entra app-role assignments (created with
  `-CreateAppRoles`, assigned via `Set-PortalAuthAssignments.ps1`).

If a user is a member of 200+ groups, Entra emits the `_claim_names` /
`hasGroups` overage indicator instead of an inline `groups` claim. The
portal does not resolve overage (would require Graph and admin
consent). Stamps with overage-prone users should use the roles posture
(`-CreateAppRoles`) instead of group-based authz.

## Role assignments (when -CreateAppRoles is used)

After the script creates the `admin` and `user` app roles, principals
must still be assigned. The script does NOT do this — it only defines
the roles. Use the dedicated assignments script + skill:

- `deploy/scripts/auth/Set-PortalAuthAssignments.ps1` — idempotent
  add/remove/list. See
  `.github/skills/pilotswarm-portal-auth-assignments/SKILL.md`.
- Entra portal ("Enterprise applications > <app> > Users and groups")
  still works if you'd rather click.

If `-AssignmentRequired` is set and no one is assigned, sign-in fails
with `AADSTS50105: The signed in user is not assigned to a role for the
application`. Assign the operator FIRST so they can finish setting up.

If `-AssignmentRequired` is NOT set (the recommended default), the
**portal engine** still enforces deny-by-default: a signed-in
principal with no admin/user role claim sees a "You are not authorized
to access this portal" page rather than the app. Assign at least one
app-role admin via `Set-PortalAuthAssignments.ps1` before the first
sign-in so someone can actually reach the portal.

## What this skill will not do

- Will not write to `.env` files (operator surfaces values explicitly)
- Will not assign users to app roles — use `Set-PortalAuthAssignments.ps1`
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
- Never propose granting `Application.ReadWrite.All`,
  `GroupMember.Read.All`, `User.Read`, or any other delegated/app
  scope on the portal app — the portal declares **no API permissions**
  at runtime. Downstream API access (e.g. ADO via OBO) belongs on
  per-purpose worker apps, not the portal app
- Re-running the wrapper against a legacy app reg (created before this
  shape was canonized) will normalize `requiredResourceAccess` to `[]`
  by removing dead-weight `User.Read`. This is intentional — `User.Read`
  was declared but never actually used at runtime. Legacy users with
  existing consent records are unaffected; the portal's `.default`
  scope on its own clientId continues to work
- Single-tenant only by design. Multi-tenant or personal-MSA sign-in is
  out of scope for the wrapper; use `Create3PApplication.ps1` if you
  need a different shape
