# Live OBO Smoke

> Repeatable, harness-driven verification that the User OBO Propagation
> feature works end-to-end on a deployed PilotSwarm stamp. Used as a
> release gate (FR-018), post-incident verification, and post-deploy
> stamp-bringup check.
>
> Feature spec (FR/SC numbering referenced throughout this document):
> [`docs/specs/user-obo-propagation.md`](../specs/user-obo-propagation.md).

## When to run

- **Release gate** before publishing a new `pilotswarm-sdk` /
  `pilotswarm-cli` major or minor that touches the OBO surface
  (Phases 1–6 of the User OBO Propagation feature). Required signoff
  is a clean run on at least one designated smoke stamp.
- **Post-incident** when investigating a suspected portal-MSAL,
  envelope-encryption, or worker-side OBO regression. The harness
  pinpoints the failing step (preflight, auth, whoami, force-reauth)
  rather than leaving you with a generic "session hangs" symptom.
- **Post-deploy bringup** for any new stamp opting in to OBO. Run
  immediately after `OBO_ENABLED=true` lands so you have a clean
  baseline before any consumer (ExampleApp, etc.) wires in.

## Prerequisites

These are one-time-per-tenant or one-time-per-stamp setup costs.
None of them are created automatically by the workflow or driver.

### Smoke AAD app (per-stamp, auto-provisioned)

A dedicated AAD app registration **per smoke stamp** (one per
deployment, not one shared across the tenant). It exposes a `.default`
scope that the **portal** acquires on behalf of the signed-in user
(admission scope is the portal's own client-id; the smoke app is the
*downstream* worker app for OBO purposes).

For new-env stamps on AKS, **do not create or wire this app by hand**.
The repo ships an opinionated wrapper that auto-provisions the
app + FIC + portal pre-authorization end-to-end:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 \
  -ServiceTreeId <id> \
  -EnvName <stamp>
```

The wrapper produces exactly the shape the smoke harness expects:

1. An exposed-API scope (`user_impersonation` by default) under
   `identifierUri: api://<appId>`; the portal acquires
   `api://<appId>/.default offline_access`.
2. Microsoft Graph `User.Read` declared as a **delegated** permission
   (`type=Scope`, not `type=Role`). Admin consent is required once
   per tenant — pass `-GrantAdminConsent` to the wrapper if running
   as a tenant Global Admin, otherwise grant consent out-of-band.
3. `api.preAuthorizedApplications` populated with the per-stamp
   portal app's clientId (read from
   `deploy/envs/local/<stamp>/entra-app.json`), so the portal
   doesn't trigger a runtime user-consent prompt.
4. **On AKS (the default)**: an AKS workload-identity federated
   identity credential on the *Application* itself (subject =
   `system:serviceaccount:pilotswarm:copilot-runtime-worker`,
   audience = `api://AzureADTokenExchange`) — no client secret
   needed.
5. **For the local-developer backend only**: a client secret stored
   in `OBO_SMOKE_WORKER_APP_CLIENT_SECRET`. The wrapper does **not**
   mint this secret; create it manually via `az ad app credential
   reset` when running the worker outside a pod.

See [`pilotswarm-obo-smoke-app-reg`](../../.github/skills/pilotswarm-obo-smoke-app-reg/SKILL.md)
for the full skill (parameters, troubleshooting, sidecar shape) and
the npm-deployer agent's Step 0.b for sequencing inside a new-env
flow.

> **Two scopes that look alike, but aren't.** Don't conflate
> `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`
> (`api://<worker-app-id>/.default offline_access` — the **upstream
> audience** the portal acquires a token *for*) with
> `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE`
> (`https://graph.microsoft.com/User.Read` — the **downstream
> resource** the worker exchanges that token *to*). They are different
> ends of the two-hop OBO chain; swapping them produces
> `AADSTS50013` (wrong audience) or `AADSTS65001` (missing delegated
> permission) at runtime.

### Per-stamp env (auto-populated by the wrapper)

In the stamp's `deploy/envs/local/<stamp>/.env`:

| Key | Value |
|---|---|
| `OBO_ENABLED` | `true` (envelope-encrypted token path) |
| `OBO_SMOKE_ENABLED` | `true` (registers `obo_smoke_*` tools on worker startup) |
| `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE` | `api://<smoke-app-client-id>/.default` |
| `PORTAL_AUTH_ENTRA_TENANT_ID` / `PORTAL_AUTH_ENTRA_CLIENT_ID` | Existing portal Entra config |
| `OBO_SMOKE_WORKER_APP_TENANT_ID` | smoke app tenant id |
| `OBO_SMOKE_WORKER_APP_CLIENT_ID` | smoke app client id |
| `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE` | `https://graph.microsoft.com/User.Read` |
| `OBO_SMOKE_WORKER_APP_CLIENT_SECRET` | (only for local-dev backend; FIC pods read from `AZURE_FEDERATED_TOKEN_FILE`) |
| `OBO_SMOKE_TEST_USER_UPN` | (optional) UPN to assert against `graph.upn`; if unset, any non-empty UPN passes |

These keys are wired through the deploy pipeline so a `worker --steps
manifests,rollout` re-render projects them into the worker pod's
ConfigMap (`compose-env.mjs` falls them back to the `__PS_UNSET__`
sentinel when a stamp omits any of them, and the worker overlay's
`OBO_SMOKE_WORKER_APP_*` block strips the sentinel at startup so the
smoke plugin treats absent values as `undefined`). On AKS, leave
`OBO_SMOKE_WORKER_APP_CLIENT_SECRET` unset — the plugin uses the
stamp's existing workload-identity FIC machinery
(`WORKLOAD_IDENTITY_CLIENT_ID` + `AZURE_FEDERATED_TOKEN_FILE`). For
local-dev (running the worker outside a pod), set the secret in the
stamp's local `.env` instead. **Production stamps must leave
`OBO_SMOKE_ENABLED=false`** — the smoke tools are not authz-gated and
would otherwise expose a `force_reauth` path to any signed-in user.

The plugin auto-selects between the FIC and client-secret backends at
**handler-call time** (FR-025): when `AZURE_FEDERATED_TOKEN_FILE` is
present, the FIC backend wins precedence; the secret is logged once
as ignored. AKS workload-identity sets `AZURE_FEDERATED_TOKEN_FILE`
automatically when the worker pod has the
`azure.workload.identity/use=true` label and the proper SA annotation.

### Test user

Provision (or re-use) a test user in the smoke tenant. Two
considerations:

- **MFA / Conditional Access**. If the tenant requires MFA on every
  sign-in, the device-code flow blocks during the smoke run waiting
  on a phone prompt. Either: (a) add the test user to a CA-policy
  exclusion group for the smoke run window; (b) use a tenant where
  the test user's CA policy permits a longer session token lifetime;
  (c) use the `--auth from-env` mode and pre-stage tokens in your
  fork's CI secrets.
- **Token leak hygiene**. The test user's tokens never leave memory.
  The driver logs `upn`, `objectId`, and `mode` only — never the
  raw access tokens.

### Repository CI service principal (only for the workflow scaffold)

Federated-credential trust on the repo's CI service principal:
configure `azure/login@v2` to OIDC-exchange the GitHub `id-token`.
Required for the `Acquire AKS credentials` step. Without this, the
workflow fails fast at the `Azure login` step.

## Running the smoke

Local maintainer machine (interactive device-code, default):

```bash
npx pilotswarm smoke <stamp> --profile obo
```

CI / unattended (pre-staged tokens via env):

```bash
OBO_SMOKE_USER_ADMISSION_TOKEN="<jwt>" \
OBO_SMOKE_USER_DOWNSTREAM_TOKEN="<jwt>" \
npx pilotswarm smoke <stamp> --profile obo --auth from-env
```

The driver:

1. Loads `deploy/envs/local/<stamp>/.env` and validates preflight
   keys.
2. Acquires user access tokens (admission + downstream) via MSAL
   device-code OR reads them from env.
3. Calls `GET <portal>/api/health`.
4. Inspects the worker deployment via `kubectl` (skipped if no
   `K8S_CONTEXT` in the stamp env — `whoami` success implicitly
   proves worker readiness).
5. Drives `createSession` → `sendMessage("Run obo_smoke_whoami")` →
   waits for the `tool.execution_complete` event and asserts the
   tool returned `mode: "obo_ok"`.
6. Repeats for `obo_smoke_force_reauth`; asserts the tool outcome is
   `interaction_required` with `reasonCode: "reauth_required"`.
7. Cancels the smoke session and emits a JSON pass record on stdout.

### Output

**Pass:**

```json
{
  "pass": true,
  "profile": "obo",
  "stamp": "chkrawps10",
  "timestamp": "2026-06-09T...Z",
  "steps": [
    { "name": "portal-health", "ok": true, "result": { "ok": true } },
    { "name": "worker-ready", "ok": true, "result": { "deployment": "...", "ready": 1, "total": 1 } },
    { "name": "session-create", "ok": true, "result": "<session-id>" },
    { "name": "whoami", "ok": true, "result": { "mode": "obo_ok", "backend": "fic", "graphUpn": "...", "principalEmail": "..." } },
    { "name": "force-reauth", "ok": true, "result": { "outcome": "interaction_required", "reasonCode": "reauth_required" } },
    { "name": "cleanup", "ok": true, "result": { "cancelled": true } }
  ]
}
```

**Fail:**

```json
{
  "pass": false,
  "profile": "obo",
  "stamp": "chkrawps10",
  "timestamp": "...",
  "failedStep": "whoami",
  "reasonCode": "whoami_principal_only",
  "message": "obo_smoke_whoami returned mode=principal_only ..."
}
```

### Exit codes

- `0` — pass.
- `1` — a profile step failed (see `failedStep` + `reasonCode`).
- `2` — preflight failure (stamp env missing keys; CLI args invalid).

## Authoring a new profile

Drop a new file at `packages/cli/src/smoke/profiles/<name>.js`
exporting a default object:

```js
const profile = {
    name: "<name>",
    async run({ ctx, step }) {
        await step("my-check", async () => {
            // ctx provides:
            //   stamp, stampEnv, portalBaseUrl,
            //   portalRpc { rpc(method, params), health(), baseUrl },
            //   tokens { admissionToken, downstreamToken, downstreamExpiresAt },
            //   kubeContext, namespace, runKubectl,
            //   log, httpFetch
            //
            // step(name, fn) records the step in the result;
            // throw a regular Error to fail with reasonCode 'step_failed',
            // or attach `err.reasonCode` to a thrown error to set a
            // structured reason code.
        });
        return { whatever: "you want in result" };
    },
};
export default profile;
```

Then add the profile to the `PROFILES` map in
`packages/cli/src/smoke/cli.js`. No other plumbing required.

## Workflow scaffold

`.github/workflows/live-smoke-obo.yml` ships **disabled-by-default**
in the sense that it has no automatic triggers — only
`workflow_dispatch`. Operators trigger it manually after deploying a
target stamp.

Required repo secrets:

| Secret | Purpose |
|---|---|
| `AZURE_CLIENT_ID` | CI service principal client-id (federated-credential trust target) |
| `AZURE_TENANT_ID` | Azure tenant id of the SP |
| `AZURE_SUBSCRIPTION_ID` | Subscription that hosts the AKS cluster |
| `OBO_SMOKE_USER_ADMISSION_TOKEN` | Freshly-acquired test-user portal admission JWT (rotate before each run) |
| `OBO_SMOKE_USER_DOWNSTREAM_TOKEN` | Freshly-acquired test-user downstream JWT (rotate before each run) |

The workflow runs the same `pilotswarm smoke` driver as the
local-maintainer flow, but always with `--auth from-env`. The two
`OBO_SMOKE_USER_*_TOKEN` secrets must be rotated by an operator
immediately before triggering — Entra access tokens typically expire
in ~60 minutes.

## Repeatability invariants (MUST stay true under refactors)

These invariants are pinned by tests in `packages/sdk/test/local/`:

- **Handler-time env reads.** The smoke plugin reads `process.env`
  inside the tool handler on every invocation, never at module load.
  This is the only safe pattern for a plugin that ships in the
  production image with `OBO_SMOKE_ENABLED=false` for non-smoke
  stamps. (`obo-smoke-plugin-loadable.test.js`)

- **FIC token-file re-read on every acquisition.** The
  `clientAssertion` callback re-reads `AZURE_FEDERATED_TOKEN_FILE`
  every call, never caches the contents at CCA-construction time.
  AKS workload-identity rotates the projected SA token on a schedule;
  caching would break ~60 minutes after a worker pod starts.
  (`obo-smoke-auth-backend.test.js`)

- **FIC precedence when both backends are configured.** The plugin
  always prefers the FIC backend when `AZURE_FEDERATED_TOKEN_FILE` is
  present; the client secret is logged-once as ignored. This means a
  single per-stamp `.env` can carry both env shapes without
  surprising the operator. (`obo-smoke-auth-backend.test.js`)

- **Driver fails fast at preflight when `OBO_SMOKE_ENABLED=false` or
  `OBO_ENABLED=false`** rather than running a session that's
  guaranteed to fail downstream. Saves a session-cleanup cycle on
  the worker. (`obo-smoke-driver.test.js`)

- **No ROPC.** The driver acquires user tokens via device-code or
  reads them from env. Resource-owner password credentials is
  Microsoft-deprecated for SFI compliance and never reintroduced.
  (`auth.js`)

- **Workflow trigger surface stays narrow.** No `push`,
  `pull_request`, or `schedule` triggers ever land on
  `live-smoke-obo.yml` — `workflow_dispatch` only.
  (`deploy/scripts/test/live-smoke-workflow.test.mjs`)

## Cross-references

- [`docs/operations/obo-kek-runbook.md`](./obo-kek-runbook.md) — KEK
  rotation runbook, AKV provisioning specifics.
- [`examples/obo-smoke/SMOKE_CHECKLIST.md`](../../examples/obo-smoke/SMOKE_CHECKLIST.md)
  — manual operator checklist (still the source of truth for the
  one-time AAD app provisioning steps and the post-smoke token leak
  scan).
- [`examples/obo-smoke/README.md`](../../examples/obo-smoke/README.md)
  — plugin reference, env tuple, mode matrix.
- Spec FR-025 / FR-026 / FR-027 / FR-028 — the four requirements
  the live-smoke harness implements.
