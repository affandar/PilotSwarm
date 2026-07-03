# Web API Control Plane — Implementation Notes

> **Status:** In progress (branch `feature/web-api-control-plane`)
> **Implements:** [pilotswarm-web-api](../proposals/pilotswarm-web-api.md)
> **Date:** 2026-07-02

## What ships

- `packages/api-client` — new `pilotswarm-api-client` package. Isomorphic (browser + Node),
  plain ESM, zero dependencies, no build step. Three modules:
  - `src/protocol.js` — **the operations table**: one entry per API operation
    (name, HTTP method, path template, param placement/types). The operation
    names are exactly the portal RPC dispatcher's method names, so the table
    is simultaneously the REST contract, the client surface, and the docs
    source. Also exports the error envelope helpers and WS vocabulary.
  - `src/api-client.js` — `ApiClient`: typed low-level client. `call(name, params)`
    resolves the operation, builds the request, unwraps the `{ ok, result }`
    envelope, and maps 401/403 to the `onUnauthorized`/`onForbidden` callbacks.
    Owns the `/api/v1/ws` WebSocket (subscribe/resubscribe/backoff) and the
    raw artifact download route. `fetch`/`WebSocket` are injectable for tests.
  - `src/http-api-transport.js` — `HttpApiTransport`: the full ui-core transport
    surface over `ApiClient`. Environment conveniences (save-to-disk, open-in-app)
    are constructor-injectable; the browser portal and the TUI supply their own.
- **Portal** mounts `/api/v1` + `/api/v1/ws` beside the existing routes:
  - `packages/portal/api/router.js` builds the Express router *from the
    operations table*; every generated route delegates to the existing
    `runtime.call(name, params, req.auth)` dispatcher. Bespoke routes:
    `health`, `auth/config`, `auth/me`, `bootstrap`, artifact binary download.
  - `packages/portal/api/ws.js` — shared WS connection handler used by both
    `/portal-ws` (legacy, keeps `theme`) and `/api/v1/ws`.
  - The legacy `/api/rpc` + `/portal-ws` stay mounted through the same
    dispatcher for a deprecation window; the browser portal itself now runs
    on `/api/v1`.
- **SDK**: `new PilotSwarmClient({ apiUrl, getAccessToken? })` and
  `new PilotSwarmManagementClient({ apiUrl, getAccessToken? })` are the
  **public, supported modes**. Direct `{ store }` construction still works but
  is `@internal` — used by workers, the portal host, and tests only. The seam
  is a constructor-return: when `apiUrl` is present the constructor returns a
  web implementation backed by `pilotswarm-api-client`; the direct code path
  is untouched. Web-mode methods without an API equivalent throw
  `WEB_MODE_UNSUPPORTED` errors naming the operation.
- **TUI**: `pilotswarm remote --api-url https://…` (or `PILOTSWARM_API_URL`)
  runs the full TUI over the API with zero backend credentials. Auth is
  discovered from `GET /api/v1/auth/config`: `none` starts immediately;
  `entra` runs the msal-node **interactive browser flow** (auth code + PKCE, loopback redirect) before the TUI renders — device code is a `--device-code` fallback, since corporate Conditional Access commonly blocks it,
  with a per-API-origin token cache at `~/.config/pilotswarm/auth/`.
  `pilotswarm auth login|status|logout --api-url <url>` manage the cache.
  `--store` remote mode remains for operators (internal/testing).
- **Tests**: unit suites in `packages/api-client/test` and
  `packages/portal/test` (node --test); E2E in
  `packages/sdk/test/local/webapi-e2e.test.js` + `webapi-transport.test.js`
  (vitest, real Postgres, real portal server on an ephemeral port, embedded
  workers) driving the SDK **web providers** and `HttpApiTransport` —
  including one real model turn.

## Notable decisions / deviations from the proposal

- **REST routes are generated** from the operations table rather than written
  per-route; `runtime.call` remains the single behavior point. This is the
  "handler layer stays boring" requirement taken literally.
- `POST …/messages/send-and-wait` is **not** a route. The SDK web client
  implements `sendAndWait` as `send` + status polling (the proposal already
  recommended that for UIs); a long-poll `GET …/status/wait` route exists.
- Four thin methods were added to `NodeSdkTransport`/`PortalRuntime` to
  complete SDK web parity: `getSessionStatus`, `waitForStatusChange`,
  `getLatestResponse`, `sendSessionEvent` (all existing
  management/session-handle capabilities, newly exposed).
- `PUT /api/v1/me/github-copilot-key` with `key: null` clears the key
  (no separate DELETE route).
- Artifact upload rides the JSON envelope (base64 for binary) with the same
  2 MB limit the legacy RPC had; the binary **download** route streams.
- Facts/skills routes (MCP web mode) and the standalone `pilotswarm-api`
  host remain future work (proposal Phase 4).
- The TUI sign-in runs before the Ink app starts (opens the browser; plain
  terminal output + best-effort browser open), not as an Ink modal. A 401
  mid-session surfaces a clear "run `pilotswarm auth login`" error.

## Known limitations of web mode

- Model-listing methods (`listModels`, `getModelsByProvider`, `getDefaultModel`)
  are **async** in web mode (they hit the API) but keep the direct client's
  synchronous type signatures via the constructor-return cast — always
  `await` them. The ui-core transport getters stay synchronous (served from
  the cached bootstrap), so the UIs are unaffected.
- `createSession` in web mode accepts only `{ model, reasoningEffort, groupId }`;
  worker-side options (`tools`, `systemMessage`, hooks, `toolNames`,
  sub-agent fields) are rejected or ignored — those configure a co-located
  worker and have no meaning across the API. Agent-bound sessions use
  `createSessionForAgent`.
- A handful of low-level management methods are direct-mode only and throw
  `WEB_MODE_UNSUPPORTED` (command plumbing, graph/retrieval usage stats,
  session dumps, embedder status, model-credential checks).

## Hardening (post-review)

An adversarial review pass drove these fixes, all covered by tests:

- **Path traversal:** the filesystem artifact store now sanitizes the
  `sessionId` segment (not just the filename) and asserts the resolved path
  stays within the artifact dir; the router also rejects id path params that
  contain separators or `..` before dispatch.
- **Long-poll correctness:** `waitForStatusChange` returns the current status
  on timeout instead of throwing a 500; the web session wait loop propagates
  permanent (4xx) errors, falls back to a status read on transient faults to
  detect terminal state, and defaults `sendAndWait` to 300 s (not infinite).
- **Stale responses:** web sessions seed their turn-tracking cursors from the
  live status before the first send, so a resumed session (or a
  `createSessionForAgent` bootstrap turn) never returns a prior turn's answer.
- **Event delivery:** live WS pushes are buffered during the initial catch-up
  fetch (no dropped history), and a reconnect re-runs the `afterSeq` catch-up
  so events missed during an outage are replayed. The WS reconnect loop
  survives a `getAccessToken` rejection.
- **Error envelope:** 500s return a generic message (no connection-string /
  path leaks) while 4xx keep their actionable text; body-parser failures
  (413 / malformed JSON) map to the envelope.
- **Portability:** `ApiClient` avoids `URLSearchParams.size` (Safari 16).

## Deployment

The API is the portal process — **no infra changes to ingress**. The three
deploy Dockerfiles (portal, worker, starter) and the npm publish workflow were
updated to include the new `pilotswarm-api-client` workspace package and the
portal `api/` directory. The existing ingress
routes `/` (prefix) to portal:3001 with 3600 s WS timeouts, which covers
`/api/v1` and `/api/v1/ws`; readiness stays `/api/health`. Verified against
both the pilotswarm and waldemort GitOps trees (AGIC + NGINX edges). TUI
users of a deployment need exactly one value: the portal URL.
