---
name: pilotswarm-obo-smoke-app-reg
description: "Use when bringing up a PilotSwarm stamp that will run OBO live-smoke. Drives the Entra app-registration step for the per-stamp OBO live-smoke downstream worker app — creates/finds the app, declares Microsoft Graph `User.Read` delegated permission, mints an OAuth2 scope, pre-authorizes the portal app, and create-or-patches the federated identity credential (default MSI-as-FIC; optional AKS-direct). Skip entirely for default production stamps or stamps that do not run the OBO smoke profile."
---

# pilotswarm-obo-smoke-app-reg

Drives the Entra app-registration step for the OBO live-smoke **downstream
worker app** on a PilotSwarm stamp.

This skill is **optional** — only invoke it when the stamp will run
`pilotswarm smoke <stamp> --profile obo`. It provisions the downstream
worker app and emits the smoke env overlay block. Opting the worker into
smoke also requires building the worker image with `--variant smoke` so
`/app/packages/obo-smoke-plugin` exists in the image.

## When to use this skill

| User signal | Use this skill? |
|---|---|
| "enable OBO live-smoke on stamp X" / will run `pilotswarm smoke <stamp> --profile obo` | **YES** |
| "set up the worker app for OBO smoke" / "need a downstream app for the smoke profile" | YES |
| Re-running on a stamp that already has the smoke env values pasted | YES — the wrapper is idempotent (re-reads scope GUID, no-ops on existing FIC) |
| Pointing at a manually-managed downstream app | YES — pass `-ExistingAppId <appId>`; the wrapper patches scope/pre-auth/FIC on whatever app you point at |
| default production stamp / no live-smoke needed | NO — skip entirely |

## Sequencing inside the new-env flow (two-phase)

The wrapper supports two phases — **app-shell** and **patch-fic** — so
nothing in the deploy pipeline has to wait on Entra:

1. **`-Mode app-shell`** runs alongside `pilotswarm-portal-app-reg`,
   **before** bicep. It creates/finds the app, mints the OAuth2 scope,
   declares Graph `User.Read` delegated permission, pre-authorizes the
   portal app, and emits the `.env` paste block. **No FIC** (and no
   OIDC issuer dependency). Bicep/manifests/rollout can all proceed
   from here.
2. **`-Mode patch-fic`** runs **after the full deploy completes**
   (bicep + manifests + rollout). It looks up the existing app by
   display name and create-or-patches the FIC on the Entra application.
   The default `-FicPattern msi` reads `WORKLOAD_IDENTITY_CLIENT_ID` from
   `deploy/.tmp/<stamp>/bicep-outputs.cache.json`, resolves that UAMI's
   enterprise-app/service-principal object id, and writes an eSTS FIC
   (`issuer=https://login.microsoftonline.com/<tenant>/v2.0`, `subject=<uami-object-id>`).
   No `.env` changes and no k8s changes — the worker pod is already
   using the UAMI and will start accepting OBO exchanges as soon as the
   app FIC exists in AAD. Run this just before
   `pilotswarm smoke <stamp> --profile obo`.

The worker pod boots fine without the app FIC; the app FIC is only
consulted at runtime when a tool actually performs an OBO exchange.
There is no pod restart between patch-fic and the smoke run.

For one-shot operator use against an already-deployed cluster, the
back-compat default `-Mode all` does both phases in one invocation
(requires bicep outputs to be present).

This mirrors how `pilotswarm-portal-app-reg` patches the portal-app's
SPA redirect URIs after the AFD endpoint is known — the app is created
early; deployment-derived bits are patched in later.

## Service Tree ID is required (no default)

`Setup-OboSmokeWorkerApp.ps1` requires `-ServiceTreeId` as a mandatory
parameter. Microsoft tenant policy rejects app registrations without a
valid `serviceManagementReference`, so the script does too.

Before invoking, ask the user for their Service Tree ID. If they don't
have one registered for their PilotSwarm deployment, stop and direct
them to register one — the tenant will reject `az ad app create`
otherwise. Do **not** invent a placeholder GUID.

## Underlying tooling

| Script | Path | Purpose |
|---|---|---|
| `Setup-OboSmokeWorkerApp.ps1` | `deploy/scripts/auth/` | Opinionated wrapper that produces the exact downstream-worker app shape the OBO smoke plugin expects |
| `README.md` | `deploy/scripts/auth/` | Operator docs |

The wrapper bakes in (these are NOT user-configurable — they are the
contract the smoke harness depends on):

- `signInAudience: AzureADMyOrg` (single-tenant)
- `serviceManagementReference: <-ServiceTreeId>` (operator-supplied)
- **An OAuth2 delegated scope** (default `user_impersonation`) exposed
  under `identifierUri: api://<appId>`. The resulting
  `api://<appId>/.default` is what the portal acquires a token *for*
  (the "upstream audience" in the two-hop OBO chain).
- `requestedAccessTokenVersion = 2` so issued tokens are v2 — compatible
  with `@azure/msal-node`'s `acquireTokenOnBehalfOf` in the worker.
- **Microsoft Graph `User.Read` declared as a delegated permission**
  (`type=Scope`, NOT `type=Role`). The worker's OBO exchange calls
  `acquireTokenOnBehalfOf({ scopes: ["https://graph.microsoft.com/User.Read"] })`;
  without this declaration the exchange returns `AADSTS65001` at
  runtime even with pre-authorization in place. (`-GrantAdminConsent`
  is an optional shortcut for tenants where per-user consent is
  blocked and a Global Admin / Cloud Application Administrator is
  running the wrapper.)
- **`api.preAuthorizedApplications`** populated with the per-stamp
  PORTAL app's clientId, pre-authorized for the new delegated scope.
  This avoids an `AADSTS65001` user-consent prompt at runtime when
  the portal acquires the worker-audienced token. The array is
  **OVERWRITTEN** (not merged) with a single-element list — each
  stamp has a strict 1:1 portal-app → worker-app relationship, so
  merging would risk leaving orphaned trust for rotated/deleted
  portal apps.
- **Federated identity credential on the Application**, defaulting to
  the CORP-compatible **MSI-as-FIC** pattern. The worker pod first uses
  its existing AKS service-account FIC on the UAMI
  (`WORKLOAD_IDENTITY_CLIENT_ID`) to get a UAMI token, then the smoke
  plugin uses that UAMI token as the `client_assertion` for the worker
  3P app. The app FIC is: issuer
  `https://login.microsoftonline.com/<tenant>/v2.0`, subject
  `<uami-service-principal-object-id>`, audience
  `api://AzureADTokenExchange`. Optional `-FicPattern aks-direct`
  preserves the historical AKS OIDC issuer + service-account subject
  app FIC for tenants that explicitly allow it.

## The two OBO scope keys (read before invoking)

The wrapper produces two scope-shaped values that look similar but
serve different ends of the OBO chain. Do not conflate them.

| Key | Value emitted | Role in OBO |
|---|---|---|
| `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE` | `api://<worker-app-id>/.default offline_access` | **Upstream audience.** Tells the portal's MSAL "acquire a token *for* this audience". Without it the portal acquires a token for the portal app itself, and the worker's OBO exchange returns `AADSTS50013` (invalid audience). |
| `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE` | `https://graph.microsoft.com/User.Read` | **Downstream resource.** Tells the worker's `acquireTokenOnBehalfOf` "exchange the user assertion for a token *to call* this Graph scope". Must match the declared `requiredResourceAccess.resourceAccess` on the worker app, or the exchange returns `AADSTS65001`. |

The wrapper's `-GraphScope` parameter (default
`https://graph.microsoft.com/User.Read`) overrides the second key only;
the first is always derived from the worker app's own clientId.

## Discovery (run before invoking)

```bash
az account show --query "{tenant:tenantId, user:user.name, userObjectId:id}" -o json
```

- `tenant` → the tenant the app will be created in (must match
  `PORTAL_AUTH_ENTRA_TENANT_ID` in the stamp's `.env`)
- `user` → operator UPN, surfaced so they know whose name will be on
  the app

Also confirm:

- `deploy/envs/local/<stamp>/entra-app.json` exists (portal app-reg
  ran). If not, run the `pilotswarm-portal-app-reg` skill first, or
  pass `-PortalClientId <appId>` explicitly.
- `deploy/.tmp/<stamp>/bicep-outputs.cache.json` exists and contains
  `WORKLOAD_IDENTITY_CLIENT_ID` for the default MSI-as-FIC pattern
  (or an OIDC issuer URL when using `-FicPattern aks-direct`). If not,
  run bicep first
  (`node deploy/scripts/deploy.mjs base-infra <stamp> --steps bicep`).

## Present the input surface upfront

```
Identity
  ServiceTreeId            <required: no default>
  EnvName                  <required: stamp name>
  DisplayName              <suggested: "PilotSwarm OBO Smoke Worker - ${EnvName}">
  Owner                    <discovered: ${userObjectId} (${user})>

Portal trust (pre-authorization)
  PortalClientId           <auto-discover from deploy/envs/local/${EnvName}/entra-app.json,
                            OR pass explicitly>

Downstream scope
  GraphScope               https://graph.microsoft.com/User.Read (default)

Federated identity credential
  FicPattern               msi (default, CORP-compatible) | aks-direct
  WORKLOAD_IDENTITY_CLIENT_ID  <auto-discover from bicep cache for msi>
  ServiceAccountNamespace  pilotswarm (aks-direct only)
  ServiceAccountName       copilot-runtime-worker (aks-direct only)

Optional
  ExistingAppId            <only when you want to point at a pre-existing app>
  GrantAdminConsent        false (default)            # optional shortcut; per-user consent at sign-in is the default path
  OutputFile               deploy/envs/local/${EnvName}/obo-smoke-worker-app.json (default)
```

State the chosen mode explicitly before invoking. Confirm — this
WRITES to Entra and creates a permanent app reg plus an FIC.

## Invocation

Always invoke `pwsh` directly. The shell-quoting and `-File`-vs-`-Command`
rules from `pilotswarm-portal-app-reg` apply identically here.

### Two-phase (recommended for new-env bring-up)

**Phase 1 — `app-shell` (before bicep, alongside portal app-reg)**

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -Mode app-shell \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name>
```

This:

1. Creates (or finds, by display name) the app
   `"PilotSwarm OBO Smoke Worker - <stamp-name>"`.
2. Mints (or re-reads) the OAuth2 delegated scope `user_impersonation`
   under `identifierUri: api://<appId>`.
3. Declares Graph `User.Read` delegated permission.
4. Overwrites `api.preAuthorizedApplications` with a single-element
   array containing the per-stamp portal app's clientId (read from
   `deploy/envs/local/<stamp>/entra-app.json`).
5. Writes a JSON sidecar at
   `deploy/envs/local/<stamp>/obo-smoke-worker-app.json` (`fic.issuer`
   and `fic.subject` are `null` until patch-fic runs).
6. Prints the smoke `.env` paste block to stdout — paste it now.

**Phase 2 — `patch-fic` (after the full deploy completes; just before smoke)**

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -Mode patch-fic \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name>
```

This:

1. Finds the existing app by display name (errors out if app-shell
   hasn't run; pass `-ExistingAppId` to bypass the lookup).
2. Create-or-patches the default MSI-as-FIC trust using
   `WORKLOAD_IDENTITY_CLIENT_ID` from
   `deploy/.tmp/<stamp>/bicep-outputs.cache.json` (issuer
   `https://login.microsoftonline.com/<tenant>/v2.0`, subject
   `<uami-object-id>`, audience `api://AzureADTokenExchange`). Pass
   `-FicPattern aks-direct` only in tenants where AKS-direct app FICs
   are allowed.
3. Patches `fic.pattern`, `fic.issuer`, and `fic.subject` into the
   existing sidecar JSON while preserving legacy top-level fields.
4. **No `.env` paste block** — env was finalized in app-shell.

### One-shot (back-compat default; `-Mode all`)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name>
```

Runs app-shell + patch-fic in a single invocation. Requires bicep to
have already produced the selected FIC inputs. Use for operator re-runs
against an already-deployed stamp, or when you don't care about the
two-phase ordering.

### FIC pattern override (rare)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -Mode patch-fic \
  -FicPattern aks-direct \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name>
```

Use `aks-direct` only in tenants/scenarios where policy explicitly
allows AKS OIDC issuer + Kubernetes service-account subject FICs on 3P
apps. Microsoft CORP requires the default `msi` pattern.

### With tenant-admin consent (optional shortcut)

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name> \
  -GrantAdminConsent
```

Only meaningful when the running principal is a tenant Global Admin
(or a Cloud Application Administrator scoped to this app). Skips the
per-user consent prompt at first sign-in. Harmless to set in
lower-permission contexts — the consent call will warn and the script
continues; per-user consent at sign-in still works.

### Point at a pre-existing app

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -ServiceTreeId <your-service-tree-id> \
  -EnvName <stamp-name> \
  -ExistingAppId <appId>
```

Skips the display-name lookup. Patches scope, Graph permission,
pre-authorization, and FIC on the supplied app. Use when display-name
lookup misbehaves (rare) or you intentionally want to manage the app
yourself.

## After the script runs

The script prints the smoke env overlay lines for the operator to paste:

```
PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE=api://<worker-app-id>/.default offline_access
OBO_SMOKE_WORKER_APP_TENANT_ID=<tenantId>
OBO_SMOKE_WORKER_APP_CLIENT_ID=<worker-app-id>
OBO_SMOKE_WORKER_APP_GRAPH_SCOPE=https://graph.microsoft.com/User.Read
PLUGIN_DIRS=/app/packages/obo-smoke-plugin
```

**The wrapper itself NEVER edits `.env`** — the single-actor-on-`.env`
invariant is sacred. The only `.env` mutators in this repo are:

- `new-env.mjs` (initial scaffold)
- `compose-env.mjs` (bicep-output fold)
- the operator (or the agent using `edit`) pasting from a sidecar

Use the `edit` tool to paste these lines into
`deploy/envs/local/<stamp>/.env`, replacing any existing
`__PS_UNSET__` sentinels or empty values for these keys in place. If `PLUGIN_DIRS` already has entries, append `/app/packages/obo-smoke-plugin` comma-separated rather than replacing them.

**Verification (tightened gate)**: before invoking
`worker manifests,rollout`, run this grep and require zero matches:

```bash
grep -E '^(PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE|OBO_SMOKE_WORKER_APP_(TENANT_ID|CLIENT_ID|GRAPH_SCOPE)|PLUGIN_DIRS)=(__PS_UNSET__)?$' deploy/envs/local/<stamp>/.env
```

If any line matches, you forgot to paste — re-read the wrapper's
stdout and apply the paste block via `edit` before invoking
`worker manifests,rollout`. The standard Step 3b grep is not
sufficient for OBO smoke: it only checks key presence, not non-empty
non-sentinel value.

## Consent

The worker app declares Microsoft Graph `User.Read` as a **delegated**
permission. The portal acquires `api://<worker-app-id>/.default
offline_access` at sign-in — `.default` expands to every pre-configured
permission on the worker app, so the user sees a sign-in prompt that
includes "Sign you in and read your profile" (the Graph `User.Read`
consent), attached to the worker app's service principal. When the user
accepts, a per-user delegated grant is recorded against the worker SP
and OBO works for that user on subsequent runs.

**Per-user consent is the default and the recommended path** for OBO
live-smoke. Each user (including the operator) consents for themselves
once at first sign-in; no tenant admin involvement required. This is
the same model the portal itself uses for OIDC sign-in.

**Admin consent is an optional shortcut** (a one-time tenant-wide grant
that skips per-user prompts on shared stamps). Three paths exist if you
want it:

1. **Tenant Global Admin running the wrapper**: pass
   `-GrantAdminConsent` — the wrapper invokes
   `az ad app permission admin-consent` after wiring the permission.
2. **Cloud Application Administrator / Application Administrator
   out-of-band**: these roles can grant consent for a single app
   without being Global Admin. Run
   `az ad app permission admin-consent --id <worker-app-id>` once per
   tenant, or click "Grant admin consent" in Entra portal → App
   registrations → Worker app → API permissions.
3. **Skip admin consent entirely**: leave `-GrantAdminConsent` off.
   Each user trips a per-user consent prompt on their first OBO smoke
   sign-in and accepts. Fine for individual smoke runs.

In highly restricted tenants where user consent is blocked even for
Microsoft Graph `User.Read` (rare — `User.Read` is normally the bare
minimum sign-in scope), per-user consent fails with `AADSTS65001` at
runtime and admin consent becomes mandatory.

## Idempotency

Re-runs are no-ops:

- App lookup is by display name (`PilotSwarm OBO Smoke Worker -
  <stamp>`); the wrapper reuses the existing app rather than minting a
  duplicate.
- The OAuth2 scope GUID is re-read from the existing app rather than
  regenerated (regenerating would invalidate any tokens minted against
  the old scope id).
- `preAuthorizedApplications` is overwritten in place with the current
  portal clientId.
- The FIC is create-or-patched by deterministic name (default
  `pilotswarm-obo-smoke-worker-<stamp>-msi`; `pilotswarm-worker-<stamp>`
  for explicit `-FicPattern aks-direct`) and skipped if an existing FIC
  already has the desired issuer+subject+audience.

If you renamed the app in the Entra portal, the wrapper will create a
fresh app and the old one is orphaned — clean it up manually with
`az ad app delete --id <old-appId>`.

## Sidecar JSON shape

The sidecar at
`deploy/envs/local/<stamp>/obo-smoke-worker-app.json` carries:

```json
{
  "tenantId": "<tenantId>",
  "clientId": "<worker-app-id>",
  "scope": "api://<worker-app-id>/.default",
  "graphScope": "https://graph.microsoft.com/User.Read",
  "ficName": "pilotswarm-obo-smoke-worker-<stamp>-msi",
  "ficSubject": "<uami-service-principal-object-id>",
  "ficIssuer": "https://login.microsoftonline.com/<tenant>/v2.0",
  "fic": {
    "pattern": "msi",
    "name": "pilotswarm-obo-smoke-worker-<stamp>-msi",
    "issuer": "https://login.microsoftonline.com/<tenant>/v2.0",
    "subject": "<uami-service-principal-object-id>",
    "audiences": ["api://AzureADTokenExchange"]
  },
  "portalClientId": "<portal-app-id>",
  "displayName": "PilotSwarm OBO Smoke Worker - <stamp>",
  "envName": "<stamp>",
  "serviceTreeId": "<id>",
  "createdAt": "<utc-iso>"
}
```

The sidecar is purely informational — nothing in the deploy pipeline
reads it. The smoke env overlay keys are the source of truth at runtime.
Legacy top-level `ficName` / `ficSubject` / `ficIssuer` remain for
back-compat; new consumers should prefer `fic.pattern`, `fic.issuer`,
and `fic.subject`. In two-phase use, `app-shell` writes all fields
except the resolved FIC issuer/subject (which are `null`);
`patch-fic` reads the sidecar back and merges them in.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `WORKLOAD_IDENTITY_CLIENT_ID is required for the MSI-as-FIC pattern` | `deploy/.tmp/<stamp>/bicep-outputs.cache.json` doesn't exist or lacks the UAMI client id key (you ran `-Mode patch-fic` or `-Mode all` too early) | Run bicep first (`node deploy/scripts/deploy.mjs base-infra <stamp> --steps bicep`) and retry, or use `-Mode app-shell` for the pre-bicep phase and re-invoke with `-Mode patch-fic` after bicep |
| `AKS OIDC issuer URL is missing — run bicep first` | You used `-FicPattern aks-direct` and the bicep cache lacks the OIDC issuer key | Prefer default `-FicPattern msi` unless your tenant explicitly allows AKS-direct; otherwise run bicep and retry |
| `patch-fic mode requires the app '...' to already exist` | You ran `-Mode patch-fic` without running `-Mode app-shell` first | Run `-Mode app-shell` first, or pass `-ExistingAppId <appId>` to point at a manually-managed app |
| `Portal entra-app.json not found at ...` | Portal app-reg hasn't run yet (or stamp uses `PORTAL_AUTH_PROVIDER=none`) | Run `pilotswarm-portal-app-reg` first, or pass `-PortalClientId <appId>` explicitly. OBO smoke is incompatible with `PORTAL_AUTH_PROVIDER=none` — the smoke driver expects a portal-signed-in user. |
| At smoke run: `AADSTS50013: Assertion audience does not match` | The portal acquired a token for the wrong audience | The `.env` key `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE` is missing, empty, or `__PS_UNSET__`. Run the tightened grep above; paste the wrapper's stdout if it fails. |
| At smoke run: `AADSTS65001: The user or administrator has not consented to use the application` | The signed-in user hasn't yet consented to Graph `User.Read` on the worker app's service principal. Normally per-user consent is offered at portal sign-in; this only persists if the tenant blocks user consent for the worker app | Have each affected user sign out and back in to accept the consent prompt. If user consent is blocked tenant-wide for the worker app, grant admin consent once: re-run with `-GrantAdminConsent` as a Global Admin, OR have a Cloud Application Administrator run `az ad app permission admin-consent --id <worker-app-id>`. |
| At smoke run: worker pod logs show `AADSTS70021: No matching federated identity record found` | FIC subject/audience/issuer don't match the assertion token. For default MSI-as-FIC, the app FIC must trust the UAMI object id; for `aks-direct`, it must trust the AKS OIDC issuer + service-account subject. | Re-run `-Mode patch-fic` with default `-FicPattern msi`. If intentionally using `aks-direct`, confirm the worker pod's service account and namespace match the stamp's configured deployment values (or re-run wrapper with `-ServiceAccountNamespace` / `-ServiceAccountName` overrides). |
| Re-run creates a duplicate app instead of reusing | The existing app's display name was changed | The wrapper looks up by display name. Either rename the app back, or pass `-ExistingAppId <appId>` to point at it explicitly. |

## See also

- `.github/skills/pilotswarm-new-env-deploy/SKILL.md` — full new-env
  flow; the OBO smoke step is optional within it.
- `.github/skills/pilotswarm-portal-app-reg/SKILL.md` — sibling skill
  for the portal app; runs first in the chain.
- `deploy/scripts/auth/README.md` — operator docs for both wrapper
  scripts.
- `docs/operations/live-smoke.md` — end-to-end live-smoke runbook.
- `docs/operations/obo-kek-runbook.md` — broader OBO operator runbook.
