# OBO Smoke Plugin

Reference plugin that exercises the **User OBO Propagation** feature
end-to-end without any external consumer being present. It is the
release-gate vehicle for the `pilotswarm-sdk` OBO surface
(see [`SMOKE_CHECKLIST.md`](./SMOKE_CHECKLIST.md)).

Two tools:

| Tool | What it proves |
|------|----------------|
| `obo_smoke_whoami` | The worker-side lookup `getUserContextForSession()` returns the portal-bound principal and, when env-configured, the worker can perform a real Microsoft Graph On-Behalf-Of round-trip. |
| `obo_smoke_force_reauth` | The structured `interaction_required` outcome flows through SDK → orchestration → portal subscription, the portal renders a re-auth affordance, and the next RPC observes the fresh downstream token. |

## Smoke image variant

Default worker images do not contain this plugin directory. AKS smoke
stamps must build the worker with `--variant smoke`, which selects the
Dockerfile's `runtime-smoke` target and copies the plugin to
`/app/packages/obo-smoke-plugin`. A default image with a mistaken
`PLUGIN_DIRS=/app/packages/obo-smoke-plugin` entry fails closed at
startup because the directory is absent.

This package also serves as a reference architecture for downstream
in-process tool plugins: declare tools in `plugin.json`, export
`registerTools(worker)`, and let the worker plugin loader register the
tools at startup.

## Visibility: handler registration vs. name declaration

The worker plugin contract has two halves and **both are required** for a
tool to actually appear in a session's LLM toolset:

1. **Handler registration** — `plugin.json.tools` points at a `tools.js`
   that exports `registerTools(worker)`. The plugin loader auto-invokes
   it at `worker.start()` and inserts the handlers into the worker's
   internal tool registry.
2. **Name declaration** — a `default.agent.md` overlay (or any other
   loaded `.agent.md` / `tools.json`) lists the tool names in its
   `tools:` frontmatter. The session manager auto-attaches those names
   to every session's effective tool list via the canonical
   `appDefaultToolNames` path.

Registering handlers without declaring names produces a runtime that
holds callable code nobody can reach — chat sessions never see the
tool, and `worker.start()` emits a warning to flag the gap. This plugin
ships [`agents/default.agent.md`](./agents/default.agent.md) precisely
to satisfy the second half of the contract; copy that pattern in your
own plugin.

## Install

This plugin loads through the worker's standard plugin contract — no
direct imports required. Point the worker at this directory via
`PLUGIN_DIRS` (env) or the `pluginDirs` constructor option, and the
worker will auto-register the plugin's tools at `start()`:

```js
import { PilotSwarmWorker } from "pilotswarm-sdk";

const worker = new PilotSwarmWorker({
    // …other options…
    pluginDirs: ["packages/obo-smoke-plugin"],
});
await worker.start();
```

Or via env (the canonical AKS/Docker path):

```bash
PLUGIN_DIRS=/app/packages/obo-smoke-plugin
```

The provisioning script
[`deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1`](../../deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1)
emits this `PLUGIN_DIRS` line in its setup paste-block alongside the
smoke AAD app's tenant/client/scope env keys.

Direct programmatic registration is also supported for unit-test
contexts that bypass the plugin loader:

```js
import { registerTools } from "pilotswarm-obo-smoke-plugin";
registerTools(worker);
```

| Env present | Selected backend | Notes |
|---|---|---|
| `WORKLOAD_IDENTITY_CLIENT_ID` only | **`fic`** | Production-shape; MSI-as-FIC through the worker UAMI. |
| `OBO_SMOKE_WORKER_APP_CLIENT_SECRET` only | **`client-secret`** | Local-developer path. |
| Both | **`fic`** (precedence) | Secret logged once as ignored. |
| Neither | _structured `serviceUnavailable` outcome_ | Plugin module load itself never throws. |

Then it branches on the user-context lookup + access-token presence:

| Lookup result | Backend selected? | `accessToken` present? | `mode` returned |
|---|---|---|---|
| `null` | — | — | `no_user_context` |
| present | no | — | `serviceUnavailable({ reasonCode: "smoke_misconfigured" })` |
| present | yes | no | `principal_only` (reason: token absent) |
| present | yes | yes, OBO + Graph succeed | `obo_ok` |
| present | yes | yes, OBO or Graph failed | `obo_failed` (reason included) |

Required env (common to both backends):

- `OBO_SMOKE_WORKER_APP_TENANT_ID`
- `OBO_SMOKE_WORKER_APP_CLIENT_ID`
- `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE` (e.g.
  `https://graph.microsoft.com/User.Read`)

Backend-specific:

- `OBO_SMOKE_WORKER_APP_CLIENT_SECRET` — client-secret backend only.
- `WORKLOAD_IDENTITY_CLIENT_ID` — FIC backend; the worker UAMI client id.
  The plugin uses `ManagedIdentityCredential` to obtain a UAMI token for
  `api://AzureADTokenExchange/.default` and supplies it to MSAL as the
  worker app's `client_assertion`.
- `AZURE_AUTHORITY_HOST` — optional override of the MSAL authority
  host (defaults to `https://login.microsoftonline.com`).

These env keys are **deliberately** namespaced separately from any
production OBO env vars and **MUST NOT** be added to `.env.example`
or to any auto-load path used by a non-smoke worker.

## How `obo_smoke_force_reauth` works

It always returns
`interactionRequired({ reasonCode: "reauth_required", message: "Smoke tool: forcing re-auth path" })`
and has no side effects. Run it twice in a session:

1. First call: portal shows the re-auth banner. User re-authenticates.
2. Second call: same return — but the maintainer can confirm via
   trace logs that the portal RPC carried a fresh downstream token
   between the two calls.

## Notes

- **Tokens are never logged.** The plugin returns metadata only —
  `upn`, `objectId`, and a `hasAccessToken` boolean indicator. The
  underlying access token is held only on the per-call stack frame
  and discarded when the handler returns.
- **No persistent state.** The plugin allocates nothing at module
  load; every state read happens inside the handler.
- **Repeatable smoke driver.** See
  [`docs/operations/live-smoke.md`](../../docs/operations/live-smoke.md)
  for the `pilotswarm smoke <stamp> --profile obo` harness that
  drives these tools end-to-end against a deployed stamp.
