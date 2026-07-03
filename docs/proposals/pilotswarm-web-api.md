# PilotSwarm Web API Control Plane

> **Status:** Implemented (2026-07-02) — see [`docs/proposals-impl/web-api-implementation.md`](../proposals-impl/web-api-implementation.md) for what shipped and the deviations: routes are generated from a shared operations table; there is no send-and-wait route; SDK web mode is the only supported public client mode (direct `{ store }` construction became internal, which goes beyond this plan); and the TUI device-code prompt renders before the Ink app rather than as an Ink modal.  
> **Date:** 2026-06-11 · **Refreshed:** 2026-06-27 (re-validated against v0.3.0)  
> **Goal:** Give PilotSwarm a versioned Web API hosted by the portal server, keep direct SDK access as the backward-compatible default, and move the TUI and the browser portal onto that API so neither needs direct PostgreSQL or Azure access. The API supports the portal's existing `none` and `entra` auth modes, and the TUI gets a first-class sign-in design for both.

> **Refresh note (2026-06-27):** This note predates the implementation, which has since landed on branch `feature/web-api-control-plane` — `packages/api-client/` now exists and the portal serves `/api/v1` + `/api/v1/ws` alongside the legacy surface. The "Current Architecture" section below describes the pre-implementation state and is kept for context. The only drift since the original draft is the RPC dispatch list growing by two observability methods (`getFleetRetrievalUsage`, `getFactsTombstoneStats`), now folded into the Management Surface for parity. The v0.3.0 crawler/harvester work (crawler role, bundled default-agent tier, KB advertisement) is orthogonal — it adds agents and facts surfaces but does not change the transport seam this proposal rides.

---

## Summary

PilotSwarm has a clean SDK boundary, but every UI surface still needs a Node process that can reach the same PostgreSQL and Azure storage as the runtime. The portal already contains an Express/RPC/WebSocket bridge, and the shared UI already talks through a transport interface — but that server is packaged as the portal host rather than as a reusable product API, and the TUI bypasses it entirely.

This proposal:

- Mounts a versioned, documented Web API at `/api/v1` (HTTP) and `/api/v1/ws` (WebSocket) inside the existing portal server. The portal process is the sole API host until the contract stabilizes — same deployment, same TLS, same auth stack. Route handlers delegate to the portal's existing runtime; no orchestration behavior is reimplemented.
- Adds an isomorphic `pilotswarm-api-client` package: a typed protocol client plus an `HttpApiTransport` that implements the same transport surface `ui-core` already consumes from `NodeSdkTransport` and `BrowserPortalTransport`.
- Adds built-in SDK provider modes: `PilotSwarmClient` / `PilotSwarmManagementClient` accept `provider: "direct"` (default — today's `{ store }` behavior, unchanged) or `provider: "web"` (`apiUrl` + optional `getAccessToken`), the latter built on `pilotswarm-api-client`.
- Migrates the TUI: `pilotswarm remote --api-url https://…` runs the full TUI over the API with **no database or storage credentials in the process**, in both no-auth and Entra ID modes. Entra sign-in uses the OAuth device-code flow with a persistent MSAL token cache.
- Migrates the browser portal's data layer from the ad-hoc `/api/rpc` + `/portal-ws` surface onto the same `/api/v1` protocol, after which `/api/rpc` and `/portal-ws` are retired.
- Lays the groundwork for follow-on consumers: MCP web mode and a standalone `pilotswarm-api` host reuse the same protocol client and routes later (Delivery Plan, Phase 4).
- Authenticates with the portal's current stack: `none` for local/private deployments, Entra ID (jose JWT validation, app roles, email allowlists) for shared deployments.

API key issuance, external secret management, and per-route RBAC are out of scope. The server consumes secrets from env/K8s/managed identity exactly as it does today.

---

## Problem

Today there are four overlapping access patterns:

1. SDK apps instantiate `PilotSwarmClient` and `PilotSwarmManagementClient` directly with a connection string.
2. The native TUI uses `NodeSdkTransport` (`packages/cli/src/node-sdk-transport.js`), which owns SDK clients directly and therefore needs `DATABASE_URL` — in *both* its `local` and `remote` modes. "Remote" today means "the database is remote," not "the access is brokered."
3. The portal serves the browser through `/api/rpc` + `/portal-ws`, but that surface is portal-shaped, unversioned, and undocumented as a product API. The portal server itself owns direct SDK/datastore access via `PortalRuntime` → `NodeSdkTransport` (which the portal imports from `pilotswarm-cli/portal` — an inverted dependency worth fixing eventually).
4. The MCP server creates shared `PilotSwarmClient`, `PilotSwarmManagementClient`, `PgFactStore`, and model/agent catalogs from `--store`/`DATABASE_URL`, so MCP clients indirectly require backend database reachability.

Consequences:

- Browser and CLI clients cannot safely receive database or Azure storage connection strings, so the TUI cannot be handed to users of a shared deployment at all today.
- Portal and TUI need a shared auth and authorization point; only the portal has one.
- New integrations need a stable HTTP contract instead of importing Node SDK classes.

The desired end state has two clear paths: **direct mode** for trusted local/server-side callers, and **web mode** through a trusted API host for browser, remote, shared, or credential-sensitive callers.

---

## Non-Goals

- Do not replace `PilotSwarmClient` or `PilotSwarmManagementClient` as the canonical implementation.
- Do not put workers behind the Web API. Workers remain trusted backend runtime components connected to duroxide/CMS/facts/blob storage directly.
- Do not add API-key issuance, API-key storage, or secret-management APIs.
- Do not introduce per-route RBAC (admitted callers share the same capabilities; the role label is recorded and displayed). The owner/admin/user capability matrix sketched in `entra-auth-gateway.md` remains future work.
- Do not require auth in local/private deployments.
- Do not remove direct `{ store }` construction for trusted local/server-side use, and do not change the TUI's direct `local` mode — it stays the smallest getting-started path.
- Do not rename `PORTAL_AUTH_*` env vars while the API is portal-hosted.
- Do not expose third-party provider injection. The only public SDK data-plane modes are the built-in `direct` and `web`.

---

## Current Architecture

A precise picture of what exists today, since the design leans on all of it.

**Portal server** (`packages/portal/server.js`):

```text
GET  /api/health            public; readiness probe target
GET  /api/portal-config     public; portal branding + auth config
GET  /api/auth-config       public; auth provider public config (MSAL clientId/authority/redirectUri)
GET  /api/auth/me           authed; principal + authorization context
GET  /api/bootstrap         authed; mode, workerCount, logConfig, defaultModel,
                            modelsByProvider, creatableAgents, sessionCreationPolicy, auth
POST /api/rpc               authed; { method, params } -> { ok, result | error }
GET  /api/sessions/:sessionId/artifacts/:filename/download   authed; binary
GET  /api/sessions/:sessionId/artifacts/:filename/meta       authed
GET  /api/portal-assets/:assetName                           public
GET  /^\/(?!api\/).*/       SPA fallback -> dist/index.html
WS   /portal-ws             authed at upgrade; close 4401/4403 on failure
```

The RPC dispatcher (`packages/portal/runtime.js`) routes ~55 method names to `NodeSdkTransport`, injecting the authenticated principal per request (`normalizeSessionOwner` / `requireUserPrincipal`). The WebSocket vocabulary is `subscribeSession`/`unsubscribeSession`/`subscribeLogs`/`unsubscribeLogs` (client→server) and `ready`/`subscribedSession`/`sessionEvent`/`subscribedLogs`/`logEntry`/`error` (server→client), plus a portal-only `theme`/`themeAck` nicety.

**Auth stack** (`packages/portal/auth/`):

- Providers `none` and `entra`, selected by `PORTAL_AUTH_PROVIDER` (plugin-supplied auth config is consulted next), else inferred to `entra` when either `PORTAL_AUTH_ENTRA_TENANT_ID` or `PORTAL_AUTH_ENTRA_CLIENT_ID` is set; the entra provider itself stays disabled unless both are present.
- Entra validation: `jose.jwtVerify` against the tenant JWKS, issuer `https://login.microsoftonline.com/<tenant>/v2.0`, audience = client id (`auth/providers/entra.js`).
- Authorization engine (`auth/authz/engine.js`): if the token carries a `roles` claim, map app roles `admin`/`user` (admin precedence, deny if neither matches); else email allowlists (`PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS`); else `PORTAL_AUTHZ_DEFAULT_ROLE`. Returns `{ allowed, role, reason, matchedGroups }`.
- Token extraction: `Authorization: Bearer` header, else WebSocket subprotocol list `["access_token", <token>]` (`auth/index.js`).
- Browser sign-in: `@azure/msal-browser` popup/redirect, login scopes `openid profile`, access token for scope `` `${clientId}/.default` `` (`packages/portal/src/auth/providers/entra.js`).

**Shared UI / transports:**

- `ui-core`'s `PilotSwarmUiController` takes `{ store, transport }` and duck-types the transport, with capability checks (e.g. it falls back when `listSessionsPage` is absent) — `packages/ui-core/src/controller.js`.
- `NodeSdkTransport` (~80 methods, 55 of which the portal RPC dispatcher consumes by name) is the direct implementation used by the TUI and, via `PortalRuntime`, by the portal server.
- `BrowserPortalTransport` (`packages/portal/src/browser-transport.js`) implements the same surface over `/api/rpc` + `/portal-ws`, constructed with `{ getAccessToken, onUnauthorized, onForbidden }`. This is the proof that the transport seam supports a remote protocol; the API client below generalizes it.

**TUI** (`packages/cli`): `pilotswarm local|remote`, flags `-s/--store`, `-e/--env`, `-p/--plugin`, `-w/--worker`, `-n/--workers`, `-c/--context`, `--namespace`, `--label`, `-m/--model`, `--system`. Remote mode sets `WORKERS=0` and tails logs via kubectl/K8s configuration. User identity is the synthetic `LOCAL_DEFAULT_USER_PRINCIPAL` (`{ provider: "local", subject: "default" }`). UI preferences persist to `~/.config/pilotswarm/config.json` (XDG).

**Deployment:** the portal runs on AKS (port 3001, optional in-process TLS), via legacy `deploy/k8s/portal-deployment.yaml` or the GitOps path `deploy/gitops/portal/`, which composes edge (AFD/AppGw or private NGINX) and TLS (Let's Encrypt or AKV) components into three shipped overlays: `afd-letsencrypt`, `afd-akv`, and `private-akv`. The GitOps deployment probes `/api/health`. The browser portal's WebSocket traffic already rides these ingress paths (`/portal-ws`), so `/api/v1/ws` inherits the same story.

---

## Proposed Architecture

The public SDK remains the surface. Provider selection is a built-in SDK mode switch, not a plugin system.

```text
Application code
  |
  v
PilotSwarmClient / PilotSwarmManagementClient
  |
  +--> provider: direct (default; today's { store } path, unchanged)
  |       |
  |       v
  |   PostgreSQL / duroxide / CMS / facts / artifact store
  |
  +--> provider: web
          |
          v
      pilotswarm-api-client          (isomorphic: fetch + WebSocket)
          |
          | HTTPS /api/v1  +  WS /api/v1/ws
          v
      Portal Server
          |
          | auth (none | entra) -> authorization -> principal injection
          v
      PortalRuntime -> NodeSdkTransport
          |
          v
      PostgreSQL / duroxide / CMS / facts / Azure Blob
          |
          v
      Worker fleet
```

UI surfaces converge on the same protocol:

```text
Native TUI ----------------+
  (HttpApiTransport)       |
                           +--> /api/v1 + /api/v1/ws --> Portal Server --> backend
Browser Portal ------------+
  (HttpApiTransport)       |
                           |
SDK web mode / MCP web ----+
  (pilotswarm-api-client)
```

Why the UIs ride `HttpApiTransport` instead of consuming the SDK clients in web mode: first, the browser cannot import the SDK at all — it is Node-only — and carving a browser-safe SDK entry point is far more invasive than one small isomorphic protocol package. Second, the UIs were never written against the clients: `ui-core` consumes the transport interface, which composes clients + artifacts + log tailing + bootstrap/catalog + auth context, and much of that surface (`getAuthContext`, `startLogTail`, `getWorkerCount`, `listCreatableAgents`, `getSessionCreationPolicy`) has no SDK-client equivalent — "use the clients directly" would still need the composition layer the transport already is. Third, the SDK's session-handle model (`sendAndWait`, per-session `.on()`, resume/poll) is shaped for app code that owns a few sessions, while the UI needs view models, paged event reads, and one multiplexed socket subscribing to many sessions — `NodeSdkTransport` already performs that adaptation, and `HttpApiTransport` maps it 1:1 onto routes rather than rebuilding it atop remote client handles. The two façades still share everything that matters: `HttpApiTransport` and the SDK web providers are thin skins over the same `pilotswarm-api-client` protocol module. App code that wants a client gets exactly that — `new PilotSwarmClient({ provider: "web", apiUrl })`.

The portal server is the hosted boundary. It does not reimplement orchestration behavior: it authenticates the request, authorizes the operation, calls the same runtime used today, and serializes the result. The handler layer stays intentionally boring:

```text
HTTP request -> validate params -> authenticate -> authorize -> runtime call -> serialize
```

New product capabilities are added to the SDK/transport surface first, then exposed through the API. Route handlers never read or write CMS directly.

### Packaging

```text
packages/api-client/                 NEW  isomorphic; zero Node-only deps
  src/protocol.ts                    route paths, request/response types, error envelope
  src/api-client.ts                  typed low-level client (fetch + WS, token callback)
  src/http-api-transport.ts          ui-core transport surface over the API
packages/portal/
  server.js                          mounts /api/v1 + /api/v1/ws beside existing routes
  api/
    routes/                          bootstrap, sessions, management, groups, artifacts,
                                     models, profile, system
    ws.js                            /api/v1/ws handler (same vocabulary as /portal-ws)
packages/sdk/
  src/providers/                     provider seam inside the public clients
    client-web-provider.ts           thin wrapper over pilotswarm-api-client
    management-web-provider.ts       thin wrapper over pilotswarm-api-client
packages/cli/
  src/http-transport-host.js         wires HttpApiTransport + auth into the TUI
  src/auth/device-code.js            msal-node device-code + token cache
```

Why a separate `api-client` package rather than protocol types inside the SDK: the SDK is Node-only (Node ≥ 24; duroxide, pg, Azure SDK, and OTel dependencies) and not browser-safe, while the browser portal must consume the same protocol. `pilotswarm-api-client` runs in browsers and Node without bundler gymnastics — `fetch`/`WebSocket` from the global environment, injectable for tests; no `pg`, no `duroxide`, no `fs`. The SDK's `provider: "web"` mode depends on it (plain dependency; the api-client must never import the SDK).

Deliberately **not** part of this design: extracting `ClientDirectProvider`/`ManagementDirectProvider` out of the SDK clients before mounting the API. The portal's `PortalRuntime` + `NodeSdkTransport` already compose clients, management, artifacts, logs, and per-request principal injection — the API mounts over that working runtime. Provider extraction (and fixing the portal→cli package inversion) is folded into the standalone-API extraction (Delivery Plan, Phase 4), where it pays for itself. This keeps the first phase a mounting-and-contract exercise rather than a refactor of working internals.

### SDK Provider Selection

```ts
// Default mode: direct, preserving today's { store } shape. Unchanged behavior.
const client = new PilotSwarmClient({ store });
const mgmt = new PilotSwarmManagementClient({ store });

// Explicit direct mode: same behavior, clearer intent.
new PilotSwarmClient({ provider: "direct", store });

// Web mode: portal-hosted API; no database or storage credentials in the caller.
new PilotSwarmClient({
  provider: "web",
  apiUrl: "https://portal.example.com",
  getAccessToken,           // optional; omit for no-auth deployments
});
new PilotSwarmManagementClient({ provider: "web", apiUrl, getAccessToken });
```

Resolution rules:

- `provider` explicit → it wins; `"direct"` requires `store`, `"web"` requires `apiUrl`, otherwise a configuration error.
- `provider` omitted: `store` present → direct; `apiUrl` present → web; both present → configuration error (ambiguous); neither → error (same as today's missing-store failure).
- Option name is `apiUrl` (not `portalUrl`/`baseUrl`): the host happens to be the portal for now, but the contract is the API.
- The SDK package stays Node-only. Browser callers use `pilotswarm-api-client` directly; there is no browser-safe SDK entry point.

---

## API Surface

Versioned under `/api/v1`, mounted beside the existing portal routes. The prefix is `/api/v1` rather than `/v1` because the portal's SPA fallback serves `index.html` for every GET that does not start with `/api/` — `/api/v1` slots into the existing exclusion, and it keeps one API prefix family alongside the boring-ui adapter's planned `/api/v1/agent/pi-chat/*` namespace.

The existing `/api/rpc` + `/portal-ws` surface remains as a compatibility shim until the browser portal migrates, then is retired.

The route surface below is complete against the current RPC dispatch list (`packages/portal/runtime.js`) plus the SDK client/management surface — i.e., everything `ui-core` needs. The dispatch list is the ground truth for what the UIs require; full parity is what lets the TUI and portal switch transports with zero feature loss. That includes recently added product surfaces that are easy to overlook: session groups, paginated session listing, child outcomes, system-session restart, execution-history export, top-event-emitter queries, and the v0.3.0 retrieval/facts observability stats (`getFleetRetrievalUsage`, `getFactsTombstoneStats`). (The deferred system-tooling methods noted under Management are SDK-only and not on the dispatch list.)

### Bootstrap, Auth, System

```text
GET  /api/v1/health                 public; { ok, started, mode, apiVersion }
GET  /api/v1/auth/config            public; { provider, displayName, allowUnauthenticated,
                                              client: { clientId, authority, redirectUri } | null }
GET  /api/v1/auth/me                authed; { principal, authorization }
GET  /api/v1/bootstrap              authed; mode, workerCount, logConfig, defaultModel,
                                    modelsByProvider, creatableAgents,
                                    sessionCreationPolicy, auth context, apiVersion
GET  /api/v1/system/workers         authed; { workerCount }          (live value)
GET  /api/v1/system/log-config      authed; { available, source }
```

`/api/v1/auth/config` reuses the providers' existing `getPublicConfig()`; the browser-specific `redirectUri` field is included and simply ignored by CLI clients.

### Client Surface (sessions and messaging)

```text
GET    /api/v1/sessions                          list session summaries
POST   /api/v1/sessions                          create session
POST   /api/v1/sessions/for-agent                create session for a named agent
GET    /api/v1/sessions/:sessionId               session info
DELETE /api/v1/sessions/:sessionId               delete/destroy session

POST   /api/v1/sessions/:sessionId/messages                  send prompt
                                                 body: { prompt, enqueueOnly?, clientMessageIds?, ... }
POST   /api/v1/sessions/:sessionId/messages/send-and-wait    long-poll convenience; timeout capped (≤300s)
POST   /api/v1/sessions/:sessionId/answers                   answer input-required
POST   /api/v1/sessions/:sessionId/events                    send custom event
POST   /api/v1/sessions/:sessionId/cancel-pending            cancel queued messages by clientMessageIds
```

`POST …/messages` supports `enqueueOnly` and `clientMessageIds`, matching the shared UI outbox behavior. `send-and-wait` exists for scripting convenience; UIs and the SDK web provider should prefer `send` + event streaming (the web provider's `sendAndWait` may be implemented as send + WS wait internally).

### Management Surface

```text
GET    /api/v1/management/sessions               list; paging via listSessionsPage options
                                                 (limit, includeDeleted, cursor — opaque, encodes
                                                  { updatedAt, sessionId }; no params = listSessions)
GET    /api/v1/management/sessions/:sessionId
PATCH  /api/v1/management/sessions/:sessionId    { title } rename
POST   /api/v1/management/sessions/:sessionId/cancel
POST   /api/v1/management/sessions/:sessionId/complete
DELETE /api/v1/management/sessions/:sessionId
POST   /api/v1/management/sessions/:sessionId/restart-system     restartSystemSession
POST   /api/v1/management/sessions/:sessionId/export-execution-history
                                                 server-side export -> artifact; returns artifact meta

GET    /api/v1/management/sessions/:sessionId/status
GET    /api/v1/management/sessions/:sessionId/status/wait        long poll over waitForStatusChange (optional, Phase 1)
GET    /api/v1/management/sessions/:sessionId/orchestration-stats
GET    /api/v1/management/sessions/:sessionId/execution-history?executionId=…
GET    /api/v1/management/sessions/:sessionId/latest-response
GET    /api/v1/management/sessions/:sessionId/events?afterSeq=…&limit=…
GET    /api/v1/management/sessions/:sessionId/events-before?beforeSeq=…&limit=…

GET    /api/v1/management/sessions/:sessionId/metric-summary
GET    /api/v1/management/sessions/:sessionId/tree-stats
GET    /api/v1/management/sessions/:sessionId/skill-usage?since=…
GET    /api/v1/management/sessions/:sessionId/tree-skill-usage?since=…
GET    /api/v1/management/sessions/:sessionId/facts-stats
GET    /api/v1/management/sessions/:sessionId/tree-facts-stats
GET    /api/v1/management/sessions/:sessionId/child-outcomes      list outcomes for a parent
GET    /api/v1/management/child-outcomes/:childSessionId          single child outcome

GET    /api/v1/management/session-groups
POST   /api/v1/management/session-groups
PATCH  /api/v1/management/session-groups/:groupId
DELETE /api/v1/management/session-groups/:groupId
GET    /api/v1/management/session-groups/:groupId/sessions
POST   /api/v1/management/session-groups/:groupId/assign          { sessionIds }
POST   /api/v1/management/session-groups/:groupId/cancel          { reason? }
POST   /api/v1/management/session-groups/:groupId/complete        { reason? }
POST   /api/v1/management/session-groups/move                     { groupId | null, sessionIds }
                                                                  (null target = ungroup)

GET    /api/v1/management/fleet/stats?since=…&includeDeleted=…
GET    /api/v1/management/fleet/skill-usage?since=…
GET    /api/v1/management/fleet/retrieval-usage?since=…&includeDeleted=…
GET    /api/v1/management/users/stats?since=…
GET    /api/v1/management/facts/shared-stats
GET    /api/v1/management/facts/tombstone-stats?ttlSeconds=…
GET    /api/v1/management/events/top-emitters?since=…&limit=…
POST   /api/v1/management/summaries/prune-deleted                 { olderThan }

GET    /api/v1/models
GET    /api/v1/models/by-provider
GET    /api/v1/models/default
GET    /api/v1/agents                                             creatable agents
GET    /api/v1/session-creation-policy
```

Deliberately not exposed yet: `sendCommand`/`getCommandResponse` (system tooling; add under `/api/v1/management/sessions/:sessionId/commands` when a remote consumer exists) and `dumpSession` (debug; future admin-gated route). These are SDK-only surfaces today — none of them is on the portal RPC dispatch list.

### User Profile Surface

```text
GET    /api/v1/me/profile
PATCH  /api/v1/me/profile/settings
PUT    /api/v1/me/github-copilot-key
DELETE /api/v1/me/github-copilot-key
```

These route to the management client's user-profile methods, keyed by the authenticated principal. In no-auth mode the server applies its synthetic `none/unknown` principal (see [Auth Design](#auth-design)), so profiles and session ownership are shared by every no-auth API caller — browser and TUI alike.

### Artifact Surface

```text
GET    /api/v1/sessions/:sessionId/artifacts
GET    /api/v1/sessions/:sessionId/artifacts/:filename/meta
GET    /api/v1/sessions/:sessionId/artifacts/:filename/download    binary stream
PUT    /api/v1/sessions/:sessionId/artifacts/:filename             body = content; Content-Type honored
DELETE /api/v1/sessions/:sessionId/artifacts/:filename
```

Downloads and uploads are proxied through the API host; clients never see Azure credentials or SAS URLs. Uploads enforce a size limit (`413` on exceed). Local conveniences (`saveArtifactDownload` to the exports dir, `openPathInDefaultApp`) remain client-side in the TUI transport host, layered on the download route.

### Facts and Catalog Surface (ships with MCP web mode)

```text
GET    /api/v1/facts          POST /api/v1/facts          DELETE /api/v1/facts/:namespace/:key
GET    /api/v1/skills
```

Covers MCP `read_facts`/`store_fact`/`delete_fact` (shared and session-scoped) and the plugin-derived skill catalog, so a remote MCP process needs no datastore access. Agent catalogs are already covered by `/api/v1/agents`.

### Streaming Surface

```text
WS /api/v1/ws
```

Same message vocabulary as today's `/portal-ws` (proven against the shared UI and AFD ingress):

```text
client -> server: subscribeSession { sessionId } | unsubscribeSession { sessionId }
                  | subscribeLogs {} | unsubscribeLogs {}
server -> client: ready | subscribedSession { sessionId } | sessionEvent { sessionId, event }
                  | subscribedLogs | logEntry { entry } | error { scope, sessionId?, error }
```

The portal-only `theme`/`themeAck` message stays on `/portal-ws` and dies with it; it is not part of the product API.

Auth at upgrade: `Authorization: Bearer` header or subprotocol list `["access_token", <token>]` (Node clients can send headers; browsers use the subprotocol — both already supported by the portal's `extractToken`). Close codes `4401`/`4403` on failure, matching today.

Correctness comes from CMS event replay: WebSocket delivery is an acceleration path. Clients must catch up via `GET …/events?afterSeq=` after reconnect. SSE is deferred until an external integration asks for it.

Logs are the exception to the replay rule: `subscribeLogs` is a live tail over the server's existing log source (in-cluster pod streams, `kubectl logs -f`, or a `PILOTSWARM_LOG_DIR` file tail — whichever the host resolves), normalized to `logEntry` records and ref-counted per subscriber. There is no history, query, or reconnect catch-up — lines missed while disconnected are gone from this surface. This API is an operator convenience for the UI log panes, not the observability story (metrics/traces stay on the OTel/SigNoz path). One consequence worth naming: a TUI in API mode needs no kubectl or kubeconfig — the API host, already in-cluster, does the tailing.

---

## Auth Design

The API reuses the portal's provider-based auth stack as-is — same middleware, same providers, same authorization engine, same env vars. The auth-provider model (`none`, `entra`, future IdPs) is orthogonal to the SDK data-plane mode switch (`direct`/`web`).

```text
request -> extract bearer (header | WS subprotocol)
        -> auth provider (none | entra) -> normalized principal
        -> authz engine (roles claim -> allowlists -> default role) -> { allowed, role, reason }
        -> route handler with principal injection
```

### No-Auth Mode

For local, single-user, or privately networked deployments. Provider id `none`; no token required; requests get the portal's synthetic no-auth principal — `{ provider: "none", subject: "unknown", displayName: "Unknown User" }` — and `PORTAL_AUTH_ALLOW_UNAUTHENTICATED` governs admission (default true for `none`). All no-auth API callers therefore share one identity, exactly as the no-auth browser portal behaves today.

Note that direct local mode is a *different* identity: `NodeSdkTransport` defaults to `LOCAL_DEFAULT_USER_PRINCIPAL` (`local/default`). That split between API-brokered and direct access exists today and this proposal does not change it. Recommended default for anything shared: Entra.

### Entra ID Mode

Server-side validation is unchanged (jose, issuer `https://login.microsoftonline.com/<tenant>/v2.0`, audience = client id, tenant JWKS). Configuration is today's portal config:

```text
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>
PORTAL_AUTHZ_ADMIN_GROUPS / PORTAL_AUTHZ_USER_GROUPS / PORTAL_AUTHZ_DEFAULT_ROLE
```

A future standalone `pilotswarm-api` host can introduce `PILOTSWARM_API_AUTH_*` names with `PORTAL_AUTH_*` aliases; while the API is portal-hosted, renaming is churn without value.

**Token shape contract:** all clients — browser MSAL, TUI device code, SDK callers — request scope `` `${clientId}/.default` ``, yielding v2 access tokens whose audience is the app's client id, which is exactly what the server validates. The portal and TUI share one app registration; the TUI is the same public client using the device-code grant.

### Authorization Model

The same admission model the portal applies today, including app roles:

1. Token carries a `roles` claim → map app roles `admin`/`user` (case-insensitive, admin precedence; deny if roles are present but neither matches). Recommended for IT-managed tenants together with `appRoleAssignmentRequired=true` (see `docs/portal-entra-app-roles.md`).
2. Else, if email allowlists are configured → principal email must match the admin or user list.
3. Else → `PORTAL_AUTHZ_DEFAULT_ROLE` (default `user`).

Once admitted, callers have the same API capabilities; the role label is recorded and surfaced. Session creation attaches the authenticated `SessionOwnerInfo` (`provider`, `subject`, `email`, `displayName`); no-auth attaches the synthetic `none/unknown` principal.

---

## TUI Design (API Mode, No-Auth and Entra)

### Mode and Transport Selection

```bash
# Trusted local mode — unchanged, direct, embedded workers:
pilotswarm local --store "$DATABASE_URL"

# Remote via Web API (new; no DB/storage credentials in the process):
pilotswarm remote --api-url https://portal.example.com
# or: PILOTSWARM_API_URL=https://portal.example.com pilotswarm remote

# Remote via direct DB (today's behavior, kept during transition):
pilotswarm remote --store "$DATABASE_URL"
```

Rules:

- In `remote` mode, `--api-url`/`PILOTSWARM_API_URL` selects `HttpApiTransport`; `--store`/`DATABASE_URL` selects `NodeSdkTransport`. Both present → hard error (ambiguous). The `.env.remote` file (loaded by default in remote mode, or any file via `-e/--env`) keeps working for either variable.
- `--api-url` in `local` mode is an error; `local` stays the smallest direct path.
- K8s log-tail flags (`-c/--context`, `--namespace`, `--label`) are direct-remote-only; in API mode log tailing arrives over the WebSocket (`subscribeLogs`) from the server, which already runs in-cluster. Passing them with `--api-url` warns and ignores.
- Worker flags are meaningless in API mode (`WORKERS=0` enforced); `-w/--worker` is local-only already.
- Once API mode has baked, direct-DB `remote` can be deprecated — kept behind `--store` indefinitely for operators, with docs steering to `--api-url`.

`HttpApiTransport` (from `pilotswarm-api-client`) implements the full ui-core transport surface over `/api/v1` + `/api/v1/ws`, mirroring `BrowserPortalTransport`'s constructor contract: `{ apiUrl, getAccessToken, onUnauthorized, onForbidden }`. Local-machine conveniences (artifact export to `EXPORTS_DIR`, open-in-default-app) live in a thin CLI-side wrapper, implemented over the API download routes.

### Auth Bootstrap Flow

```text
pilotswarm remote --api-url <url>
  |
  | GET /api/v1/auth/config            (public, no token)
  v
provider = "none"  ------------------> start TUI immediately; no token callback;
  |                                    server applies its synthetic no-auth principal
provider = "entra"
  |
  | load MSAL cache for this API origin from disk
  | acquireTokenSilent(account, [`${clientId}/.default`])
  v
silent success -> start TUI with getAccessToken wired to MSAL
silent failure -> device-code sign-in (below) -> then start TUI
```

The TUI never takes tenant/client ids from local config — it always discovers them from `/api/v1/auth/config`, so a deployment can rotate app registrations without breaking clients.

### Entra Device-Code Sign-In

Canonical flow: OAuth 2.0 device code via `@azure/msal-node` `PublicClientApplication` — it assumes nothing about the machine (no `az`, no browser required on the same host).

```text
TUI                                   msal-node                        User
 |  acquireTokenByDeviceCode            |                                |
 |  scopes: [`${clientId}/.default`]    |                                |
 |------------------------------------->|                                |
 |   deviceCodeCallback({ userCode,     |                                |
 |     verificationUri, message })      |                                |
 |<-------------------------------------|                                |
 |  render full-screen Ink dialog:      |                                |
 |    "Visit <verificationUri>          |                                |
 |     and enter code ABCD-EFGH"        |                                |
 |  best-effort: open URL in default    |                                |
 |  browser (existing helper); Esc      |                                |
 |  cancels                             |                                |
 |                                      |   user signs in + consents     |
 |                                      |<-------------------------------|
 |   AuthenticationResult               |                                |
 |<-------------------------------------|                                |
 |  persist MSAL cache; proceed         |                                |
```

Implementation notes:

- **UX:** the device-code prompt renders *inside* the TUI (Ink modal with the verification URL, the code, and a spinner), not as raw stdout — the alternate screen is already active. Cancel (Esc) aborts the pending request and exits with a clear message. On success the modal closes and the normal splash continues.
- **App registration:** the existing portal app registration gains "Allow public client flows" = Yes (device-code grant). `deploy/scripts/auth/Setup-PortalAuth.ps1` and the `pilotswarm-portal-app-reg` skill must be updated to set it. No new app registration; the shared client id keeps the token audience aligned with server validation.
- **Headless/pre-provisioning commands:**

  ```bash
  pilotswarm auth login  --api-url <url>     # run device-code now, persist cache
  pilotswarm auth status --api-url <url>     # show signed-in account + token expiry + role
  pilotswarm auth logout --api-url <url>     # drop cached account/tokens for that origin
  ```

  The TUI triggers the same login lazily, so `auth login` is optional.
- **Future convenience:** reuse Azure CLI credentials when present (timing open — see Open Questions). Device code stays canonical.

### Token Cache and Refresh

- MSAL-node cache serialized via an `ICachePlugin` to `~/.config/pilotswarm/auth/<sanitized-api-origin>.json` (same XDG root as `config.json`), `0600`, directory `0700`. Keying by API origin lets one machine hold sign-ins for several deployments.
- MSAL handles refresh-token rotation; `getAccessToken` runs `acquireTokenSilent` per call (MSAL caches in memory; this is cheap) and falls back per the failure flow below.
- Plaintext-on-disk matches the Azure CLI's Linux posture; OS-keychain integration is a future enhancement, not a gate. The cache never contains PilotSwarm backend credentials — only the user's own Entra tokens.
- `auth logout` deletes the origin's cache file and removes the account from MSAL state.

### Failure Handling

```text
HTTP 401        -> acquireTokenSilent(forceRefresh) -> retry once
                -> still 401 -> surface sign-in dialog (device code) -> retry
HTTP 403        -> show admission reason from error envelope (allowlist/app-role denial);
                   no retry loop; suggest `pilotswarm auth status`
WS close 4401   -> refresh token -> reconnect -> resubscribe -> catch up via events?afterSeq=
WS close 4403   -> as HTTP 403
network errors  -> existing reconnect/backoff behavior from BrowserPortalTransport, reused
```

Tokens are validated at WS upgrade only (matching today's server); expiry mid-connection does not drop the socket. Every (re)connect uses a fresh token. The transport resubscribes its active sessions/logs after reconnect and relies on `afterSeq` catch-up for losslessness.

### Identity Semantics

- **No-auth API mode:** the server assigns the synthetic `none/unknown` principal, so TUI-created and browser-created sessions in a no-auth deployment share one owner. Sessions created in direct (`--store`) modes carry `local/default` instead — a TUI moving from direct-remote to API mode creates *new* sessions under the API identity while old ones keep theirs; the owner filter surfaces both. A one-time re-owning script is possible but out of scope here.
- **Entra API mode:** sessions are owned by the signed-in principal; the TUI gains the same "my sessions" semantics the portal has. Profile settings and the per-user GitHub Copilot key ride the `/api/v1/me/*` routes.
- The TUI never sends a client-asserted identity; the principal is always derived server-side from the request's auth context.

---

## Portal Migration

```text
Before:  Browser -> BrowserPortalTransport -> /api/rpc + /portal-ws -> PortalRuntime
After:   Browser -> HttpApiTransport (pilotswarm-api-client) -> /api/v1 + /api/v1/ws -> same runtime
```

- `BrowserPortalTransport` is replaced by (or becomes a thin shim over) `HttpApiTransport`; the MSAL `getAccessToken` callback and `onUnauthorized`/`onForbidden` wiring carry over unchanged.
- `/api/rpc` and `/portal-ws` are retired after a bake period; `/api/bootstrap`, `/api/auth-config`, `/api/auth/me`, and the artifact routes fold into their `/api/v1` equivalents (old paths can 308 or alias during the bake).
- **Interplay with `boring-ui-migration.md`:** that proposal keeps the Express server and adds a `PiChatSessionService` adapter under `/api/v1/agent/pi-chat/*` for the chat pane, while its custom panels consume the transport data layer. The two compose: panels move from `/api/rpc` to `pilotswarm-api-client` (this proposal), the chat pane uses the boring adapter, and both live under the one `/api/v1` prefix. The `/api/v1/agent/` namespace is reserved for that adapter. If boring-ui proceeds, the portal-migration phase here shrinks to "panels/data layer use api-client" and the legacy renderer's transport swap may be skipped on the way out.

---

## Configuration

Server side (portal process — unchanged set, listed for completeness):

```text
DATABASE_URL, PILOTSWARM_CMS_FACTS_DATABASE_URL,
PILOTSWARM_DUROXIDE_SCHEMA / _CMS_SCHEMA / _FACTS_SCHEMA,
AZURE_STORAGE_CONNECTION_STRING | PILOTSWARM_BLOB_ACCOUNT_URL + PILOTSWARM_USE_MANAGED_IDENTITY,
PILOTSWARM_DB_AAD_USER, MODEL_PROVIDERS_PATH, PLUGIN_DIRS, WORKERS,
PORT, TLS_CERT_PATH / TLS_KEY_PATH, PORTAL_TUI_MODE,
PORTAL_AUTH_* / PORTAL_AUTHZ_*   (as today)
```

Client side (TUI API mode, SDK web mode):

```text
PILOTSWARM_API_URL=https://<portal-host>
# everything else (auth provider, tenant, client id) is discovered from /api/v1/auth/config
```

No portal, TUI, or browser client requires PostgreSQL or Azure storage credentials in API mode.

---

## Deployment Topology

Unchanged from the portal's current deployment — the API *is* the portal process:

```text
Ingress (AFD or private LB, TLS per existing GitOps overlays)
   |
   v
Portal Server (port 3001)
   static UI  +  /api/* (existing)  +  /api/v1 + /api/v1/ws (new)
   |
   +-- direct runtime calls (PortalRuntime/NodeSdkTransport)
   v
PostgreSQL (duroxide/CMS/facts)        Azure Blob (artifacts/session state)
   |
   v
PilotSwarmWorker replicas
```

No new Dockerfile, Deployment, or ingress rule. Readiness stays `/api/health`. `/api/v1/ws` follows the same ingress path `/portal-ws` rides today. A standalone `pilotswarm-api` binary (same routes, no static UI) remains a later extraction once the contract stabilizes.

---

## Error Model

All `/api/v1` JSON responses use a predictable envelope:

```json
{ "ok": false, "error": { "code": "SESSION_NOT_FOUND", "message": "Session was not found." } }
```

```text
400 invalid request / validation     401 missing or invalid token
403 authenticated but not admitted   404 session/artifact/resource not found
409 terminal session / lifecycle conflict
413 payload too large                429 (reserved; no limiter in Phase 1)
500 unexpected server error          503 runtime not started / backend unavailable
```

`403` bodies include the authz engine's `reason` so clients (TUI dialog, browser banner) can show *why* admission failed. The legacy `/api/rpc` keeps its current `{ ok, result, error: string }` shape until retirement.

---

## Delivery Plan

### Phase 1 — API host, protocol client, contract proof

1. Mount `/api/v1` routes and `/api/v1/ws` in `packages/portal/server.js`, handlers delegating to the existing `PortalRuntime` (auth middleware, principal injection, and WS vocabulary reused verbatim).
2. Create `packages/api-client` with `protocol.ts` (single source of route/request/response types), the typed `ApiClient`, and `HttpApiTransport`.
3. Add SDK `provider: "direct" | "web"` selection with the resolution rules above; web providers are thin wrappers over the api-client. `{ store }` callers and all existing direct-mode tests remain untouched.
4. Tests: auth unit tests (none admits without token; entra rejects missing/invalid; authz maps roles/allowlists), route handler tests (validation, owner attachment, error envelope), and a focused E2E suite (vitest) that boots the portal server in no-auth mode against Postgres and drives representative `PilotSwarmClient` + `PilotSwarmManagementClient` web-mode flows: create, send, wait via WS, read events, list/get/rename/cancel/complete/delete, groups, pagination, artifacts round-trip, profile.
5. Document the API (route reference + auth modes) under `docs/`.

### Phase 2 — TUI API mode (no-auth + Entra)

1. `remote --api-url` / `PILOTSWARM_API_URL` wiring; transport selection rules and flag validation as specified.
2. CLI-side transport host: `HttpApiTransport` + local conveniences (artifact export dir, open-in-app) over API downloads.
3. Auth: `/api/v1/auth/config` discovery; msal-node device-code module; MSAL disk cache (`~/.config/pilotswarm/auth/`); Ink sign-in modal; `pilotswarm auth login|status|logout`; 401/403/4401/4403 handling per the failure table.
4. App registration: enable public-client flows in `Setup-PortalAuth.ps1` + the app-reg skill; document.
5. E2E: TUI controller smoke over the API in no-auth mode (real server, real Postgres); Entra path covered by unit tests with a stubbed token endpoint plus one manual checklist against a real tenant.

### Phase 3 — Portal browser migration

1. Swap `BrowserPortalTransport` internals to `pilotswarm-api-client` (or replace outright) behind a server flag for instant rollback.
2. Fold bootstrap/auth/artifact legacy routes into `/api/v1` aliases; bake; retire `/api/rpc` + `/portal-ws`.
3. Coordinate with the boring-ui effort so its panels adopt the api-client rather than `/api/rpc` (see interplay note above).

### Phase 4 — Programmatic consumers and extraction (later)

- MCP web mode (`--api-url`), backed by the same api-client, plus the facts/skills routes above. The facts/graph data-plane this needs is specified in [facts-graph-web-api](./facts-graph-web-api.md).
- Extract direct providers into the SDK, fix the portal→cli dependency inversion, and package a standalone `pilotswarm-api` host if a deployment needs API-without-portal. Introduce `PILOTSWARM_API_AUTH_*` env names (with `PORTAL_AUTH_*` aliases) only at this point.

---

## Relationship to Other Proposals

- **`entra-auth-gateway.md`** — superseded in part. Its gateway/provider concept is realized here (portal-hosted API + api-client instead of a new gateway process); its owner/admin/user RBAC capability matrix and local role-override table remain future work on top of this API's authz seam.
- **`boring-ui-migration.md`** — complementary; shares the `/api/v1` prefix (adapter reserved at `/api/v1/agent/`), and its panels become api-client consumers in the portal-migration phase.
- **`docs/portal-entra-app-roles.md`** — implemented; reflected in the authorization model here.
- **`session-owner-association-and-filtering.md`** — implemented; this API preserves its owner semantics in both auth modes.

---

## Design Decisions

- **Route prefix `/api/v1`**, not `/v1`: the SPA fallback only excludes `/api/` paths, and one API prefix family is easier to reason about at the ingress. WS at `/api/v1/ws`.
- **Provider selection:** explicit `provider` wins; otherwise inferred (`store` → direct, `apiUrl` → web); both → error. Option name: `apiUrl`.
- **Browser bundles:** the SDK stays Node-only; browsers use `pilotswarm-api-client`. No browser-safe SDK entry point.
- **Phase 1 hosts the API over the existing runtime** rather than extracting providers first — mounting and contract, not refactoring.
- **SSE deferred:** WebSocket only, until an external integration asks.
- **Env naming:** keep `PORTAL_AUTH_*` while the API is portal-hosted.
- **TUI Entra acquisition:** device code via msal-node, same app registration with public-client flows enabled — same token audience, zero server-side changes.
- **Management E2E scope:** reads plus the full mutation set (rename/cancel/complete/delete, groups) — the routes are thin and the TUI needs them all anyway.

---

## Open Questions

- Should the TUI offer Azure CLI credential reuse (`az` token) as a convenience in Phase 2, or strictly later?
- OS keychain for the MSAL cache (macOS Keychain / libsecret) — worth a small native dep, or keep `0600` files?
- Should `send-and-wait`'s long-poll cap be configurable per deployment, or fixed at 300s?
- When `/api/rpc` retires, do any plugins or external scripts depend on it? (Inventory needed during the Phase 3 bake.)
- Rate limiting / payload caps beyond the artifact `413` — needed before exposing a deployment beyond a private network?

---

## Recommendation

Mount `/api/v1` + `/api/v1/ws` inside the portal over the existing runtime, ship the isomorphic `pilotswarm-api-client` with `HttpApiTransport`, and add the SDK `provider: "web"` mode as a thin wrapper — proving the contract with a no-auth E2E suite (Phase 1). Then deliver the headline product change: `pilotswarm remote --api-url` with no-auth pass-through and Entra device-code sign-in (Phase 2), followed by the browser portal's transport swap and `/api/rpc` retirement (Phase 3). Direct mode stays the default and the getting-started path throughout; standalone API packaging, MCP web mode, and provider extraction follow once the contract has real consumers.
