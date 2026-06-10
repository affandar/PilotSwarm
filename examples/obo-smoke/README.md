# OBO Smoke Plugin

Reference plugin that exercises the **User OBO Propagation** feature
end-to-end without any external consumer being present. It is the
release-gate vehicle for the `pilotswarm-sdk` OBO surface
(see [`SMOKE_CHECKLIST.md`](./SMOKE_CHECKLIST.md), Spec FR-018).

Two tools:

| Tool | What it proves |
|------|----------------|
| `obo_smoke_whoami` | The worker-side lookup `getUserContextForSession()` returns the portal-bound principal (SC-001) and, when env-configured, the worker can perform a real Microsoft Graph On-Behalf-Of round-trip (SC-007). |
| `obo_smoke_force_reauth` | The structured `interaction_required` outcome flows through SDK → orchestration → portal subscription, the portal renders a re-auth affordance, and the next RPC observes the fresh downstream token (SC-008 / FR-011 / SC-006). |

## Install

This is a workspace example — no separate npm install is required when
working in the PilotSwarm monorepo. From any worker entry that already
depends on `pilotswarm-sdk`:

```js
import { PilotSwarmWorker } from "pilotswarm-sdk";
import { registerOboSmokeTools } from "../../examples/obo-smoke/index.js";

const worker = new PilotSwarmWorker({ /* … */ });
registerOboSmokeTools(worker);
await worker.start();
```

Or, if you want to build the tool array yourself:

```js
import { buildOboSmokeTools } from "../../examples/obo-smoke/index.js";
worker.registerTools(buildOboSmokeTools());
```

## How `obo_smoke_whoami` decides what to do

The tool reads `process.env` **at every invocation** (never at module
import time, so contributors cannot accidentally bake smoke creds
into a non-smoke worker by importing the module).

It auto-selects between two OBO backends (FR-025):

| Env present | Selected backend | Notes |
|---|---|---|
| `AZURE_FEDERATED_TOKEN_FILE` only | **`fic`** | Production-shape; AKS workload-identity. |
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
- `AZURE_FEDERATED_TOKEN_FILE` — FIC backend; auto-set inside AKS pods
  with the workload-identity webhook.
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

- **Backend auto-selection (FR-025).** The plugin selects
  between AKS workload-identity FIC and a confidential-client +
  client-secret at handler-call time, with FIC winning precedence.
  Local developers configure `OBO_SMOKE_WORKER_APP_CLIENT_SECRET`;
  AKS pods automatically take the FIC path via
  `AZURE_FEDERATED_TOKEN_FILE`. Both backends route through
  `@azure/msal-node`'s `acquireTokenOnBehalfOf` so the OBO request
  shape matches the production-shape MSAL path consumers (ExampleApp,
  etc.) actually use.
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
