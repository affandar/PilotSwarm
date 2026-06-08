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
into a non-smoke worker by importing the module). It branches as
follows:

| Lookup result | `OBO_SMOKE_WORKER_APP_*` set? | `accessToken` present? | `mode` returned |
|---|---|---|---|
| `null` | — | — | `no_user_context` |
| present | no (any var missing) | — | `principal_only` (lists missing vars) |
| present | yes | no | `principal_only` (reason: token absent) |
| present | yes | yes, OBO exchange + Graph succeed | `obo_ok` |
| present | yes, OBO exchange or Graph failed | yes | `obo_failed` (reason included) |

Required env (all four for the real-OBO path):

- `OBO_SMOKE_WORKER_APP_TENANT_ID`
- `OBO_SMOKE_WORKER_APP_CLIENT_ID`
- `OBO_SMOKE_WORKER_APP_CLIENT_SECRET`
- `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE` (e.g.
  `https://graph.microsoft.com/User.Read`)

These env keys are **deliberately** namespaced separately from any
production OBO env vars and **MUST NOT** be added to `.env.example`
or to any auto-load path used by a non-smoke worker (Spec Phase-5
Changes Required).

## How `obo_smoke_force_reauth` works

It always returns
`interactionRequired({ reasonCode: "reauth_required", message: "Smoke tool: forcing re-auth path" })`
and has no side effects. Run it twice in a session:

1. First call: portal shows the re-auth banner. User re-authenticates.
2. Second call: same return — but the maintainer can confirm via
   trace logs that the portal RPC carried a fresh downstream token
   between the two calls.

## Notes

- **Why local-developer uses a confidential client + secret** — AKS
  workload-identity Federated Identity Credentials (FIC) are not
  available on a local maintainer machine. The FIC binding is
  validated downstream by consumers (e.g., Waldemort) in their own
  deploy stack and is **out of scope** for the smoke plugin per Spec
  FR-015.
- **Tokens are never logged.** The plugin returns metadata only —
  `upn`, `objectId`, and a `hasAccessToken` boolean indicator. The
  underlying access token is held only on the per-call stack frame
  and discarded when the handler returns.
- **No persistent state.** The plugin allocates nothing at module
  load; every state read happens inside the handler.
