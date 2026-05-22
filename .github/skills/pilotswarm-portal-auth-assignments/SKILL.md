---
name: pilotswarm-portal-auth-assignments
description: "Use when adding or removing users / groups from the 'admin' or 'user' app roles on a PilotSwarm portal Entra app. Wraps deploy/scripts/auth/Set-PortalAuthAssignments.ps1 — idempotent, re-runnable, resolves UPNs / object ids / group display names. Required after `Setup-PortalAuth.ps1 -CreateAppRoles` when admission is role-driven. Other skills/agents that need to grant or revoke portal access should delegate here instead of generating the Graph calls themselves."
---

# pilotswarm-portal-auth-assignments

Drives app-role assignment management for a PilotSwarm portal Entra app
registration. This is the **operations** complement to
`pilotswarm-portal-app-reg`:

| Skill | Concern |
|---|---|
| `pilotswarm-portal-app-reg` | One-shot: create the app + SP + role definitions |
| `pilotswarm-portal-auth-assignments` (this one) | Ongoing: who is assigned to which role |

Role assignments are independent of app creation. Use this skill any
time you need to grant or revoke portal access — initial bring-up,
adding a new admin months later, removing an offboarded user, etc.

## When to use this skill

| User signal | Use this skill? |
|---|---|
| Just ran `Setup-PortalAuth.ps1 -CreateAppRoles` and need to assign the deploying user as admin | **YES** |
| "give alice admin access to the portal" / "add bob to the user role" / "remove carol" | YES |
| "list who has access to the portal" | YES (`-List`) |
| Smoke-testing role-driven authz on a fresh stamp | YES |
| `PORTAL_AUTH_PROVIDER=none` or open-allowlist posture (no app roles) | NO — there's nothing to assign |
| App reg doesn't exist yet | NO — run `pilotswarm-portal-app-reg` first |

## When the deployer agent should invoke this automatically

In the `pilotswarm-npm-deployer` flow, after `Setup-PortalAuth.ps1`
finishes with `-CreateAppRoles`, the deployer **must** invoke this
skill before declaring auth setup complete. Without at least one admin
assignment, an `-AssignmentRequired` app is unreachable by anyone (no
one can sign in), and a no-`-AssignmentRequired` app is denied at the
portal engine (deny-by-default since v0.1.33) for every signed-in
user, since none of them carry the `admin` or `user` role claim yet.

Default: assign the deploying user (UPN from `az account show`) to the
`admin` role unless the user overrides the list in the Step 2 defaults
table.

## Underlying tooling

| Script | Path | Purpose |
|---|---|---|
| `Set-PortalAuthAssignments.ps1` | `deploy/scripts/auth/` | Add / remove / list app-role assignments |
| `Setup-PortalAuth.ps1` | `deploy/scripts/auth/` | Prerequisite — creates app + roles |
| `README.md` | `deploy/scripts/auth/` | Operator docs |

The script reads role IDs from the app's `appRoles` collection, resolves
each identifier via Microsoft Graph, then POSTs to
`/servicePrincipals/{spId}/appRoleAssignedTo`. Already-assigned
principals are treated as no-ops.

## Identifier formats

Each entry in `-AdminAssignments` / `-UserAssignments` can be:

- **UPN** — `alice@contoso.com` (User lookup)
- **Object ID (GUID)** — tried as User first, then Group
- **Group display name** — `"Portal Beta Users"` (quote anything with
  spaces)

Comma-separate multiple values on the command line:

```
-AdminAssignments alice@contoso.com,bob@contoso.com
-UserAssignments "Portal Beta Users","Portal Pilot"
```

## Permissions required

The signed-in `az` user (the one running the script) must be **either**:

- An **owner** of the portal app registration / its service principal, **or**
- Hold a directory role that permits app-role assignment management:
  Application Administrator, Cloud Application Administrator, or
  Privileged Role Administrator.

If you get `Authorization_RequestDenied` from Graph, that's the
missing permission. Have an owner of the app run the script, or ask
a tenant admin to add the deployer as an SP owner:

```bash
az ad app owner add --id <appId> --owner-object-id <user-objectId>
```

## Invocation

Always invoke `pwsh` directly:

```bash
# Add (the common case after fresh app creation)
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Set-PortalAuthAssignments.ps1 \
  -EnvName <stamp> \
  -AdminAssignments <upn>[,<upn>...] \
  [-UserAssignments <upn-or-group>[,...]]

# List
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Set-PortalAuthAssignments.ps1 \
  -EnvName <stamp> -List

# Remove
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Set-PortalAuthAssignments.ps1 \
  -EnvName <stamp> \
  -AdminAssignments <upn> -Remove
```

`-EnvName` auto-resolves `-AppId` from
`deploy/envs/local/<stamp>/entra-app.json` (the summary file
`Setup-PortalAuth.ps1` writes). Pass `-AppId <clientId>` directly if
that file isn't available.

`-AdminRoleValue` / `-UserRoleValue` override the role `value` strings
the script looks up — but the portal authz engine matches the JWT
`roles` claim only against the canonical literal values `admin` and
`user`, so overriding the role values here will leave the portal
unable to recognize them. Keep the defaults unless you also plan to
add a new app role and gate-check it explicitly in code; do not try
to alias custom role values onto the built-in admin/user buckets.

## Expected outcome

After invocation the script prints the full current assignment table.
Confirm:
- The intended admin(s) appear under role `admin`
- No leftover assignments from a prior posture remain
- The stamp's `.env` has `PORTAL_AUTHZ_*_GROUPS` empty (roles-mode —
  see `pilotswarm-portal-app-reg`)

If a user reports `forbidden` or sees only `user` UI when they expect
admin, re-run with `-List` to check assignments before debugging the
portal or token-claim pipeline.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `App '...' has no role with value 'admin'` | App was created without `-CreateAppRoles` | Run `Setup-PortalAuth.ps1 -CreateAppRoles -ExistingAppId <id>` to add roles, then retry |
| `Could not resolve '<x>'` | UPN typo, user not in tenant, or group name doesn't match | Verify with `az ad user show --id <upn>` or `az ad group list --display-name <name>` |
| `Authorization_RequestDenied` on POST | Caller lacks app-role assignment permission | See "Permissions required" above |
| `Could not load service principal for app` | App exists but SP was never created | Run `az ad sp create --id <appId>` then retry |

## What this skill is NOT for

- **Creating the app or roles** → use `pilotswarm-portal-app-reg`
- **Toggling `appRoleAssignmentRequired`** → use `Setup-PortalAuth.ps1` flags
- **Changing role definitions** (renaming `admin` to `superadmin`, etc.) → manual `az ad app update --app-roles` against a JSON file; out of scope here
- **Email-allowlist mode** (`PORTAL_AUTHZ_*_GROUPS`) → that's pure
  `.env` config, no Graph calls needed
