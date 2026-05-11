# PilotSwarm Web API Control Plane

> **Status:** Proposal  
> **Date:** 2026-05-10  
> **Goal:** Keep direct SDK access as the backward-compatible default, add a config-selected web provider that talks to the portal-hosted Web API in Phase 1, and prove that path with a focused client/management E2E suite.

---

## Summary

PilotSwarm currently has a clean SDK boundary, but remote UI surfaces still need a Node process that can reach the same PostgreSQL and Azure storage resources as the runtime. The portal already contains an Express/RPC/WebSocket bridge, and the shared UI already talks through a transport interface, but that server is packaged as the portal host rather than as a reusable product API.

This proposal introduces two built-in public SDK provider modes and exposes the first Web API host through the existing portal server:

- `PilotSwarmClient` and `PilotSwarmManagementClient` support a direct provider for local/server-side use.
- `PilotSwarmClient` and `PilotSwarmManagementClient` support a web provider for API-backed remote use.
- If `provider` is omitted, SDK clients use direct mode. Existing `{ store }` callers remain backward compatible.
- Direct mode uses PostgreSQL, duroxide, facts, model config, and artifact/session storage directly.
- Web mode calls the portal-hosted Web API over HTTPS and WebSocket.
- The portal-hosted Web API authenticates and authorizes requests using the portal's current auth stack, then delegates to locally instantiated direct providers.
- It is configured with real PostgreSQL and Azure connection settings on the server side.
- It supports `none` auth for local/private deployments and Entra ID auth for shared deployments.
- Portal-hosted Web API is the only Phase 1 API host. Standalone `pilotswarm-api` packaging can be a later extraction if the route surface stabilizes.
- Remote app clients can use web mode so those callers no longer need direct datastore access.
- Getting-started examples, trusted server-side apps, and local tests can keep using direct mode for the smallest possible setup.

API key issuance, external secret management, and customer-facing secret vault features are intentionally out of scope for this proposal. The service may consume secrets from environment variables, Kubernetes secrets, or managed identity, but it will not add a new API-key or secret-management product surface in this phase.

---

## Problem

Today there are four overlapping access patterns:

1. SDK apps instantiate `PilotSwarmClient` and `PilotSwarmManagementClient` directly.
2. The native TUI uses `NodeSdkTransport`, which directly owns SDK clients and therefore needs datastore configuration.
3. The portal serves a browser API, but the portal server itself is the API host and still owns direct SDK/datastore access.
4. The MCP server creates shared `PilotSwarmClient`, `PilotSwarmManagementClient`, `PgFactStore`, and model/agent catalogs from `--store`/`DATABASE_URL`, so MCP clients indirectly require the same backend database reachability.

That works for local development and small deployments, but it makes the remote boundary blurry:

- Browser and CLI clients cannot safely receive database or Azure storage connection strings.
- Portal and TUI remote mode need a shared auth and authorization point.
- MCP clients should not need a PilotSwarm MCP process that holds database and storage credentials just to expose session/fact/model tools.
- New integrations need a stable HTTP contract instead of importing Node SDK classes.
- The existing portal RPC surface is useful, but it is portal-shaped rather than a canonical PilotSwarm API.

The desired end state has two clear paths: direct mode for trusted local/server-side callers, and web mode through a trusted API host for browser, remote, shared, or credential-sensitive callers. Phase 1 uses the portal as that API host.

---

## Non-Goals

- Do not replace `PilotSwarmClient` or `PilotSwarmManagementClient` as the canonical implementation.
- Do not put workers behind the Web API. Workers remain trusted backend runtime components connected to duroxide/CMS/facts/blob storage directly.
- Do not add API-key issuance, API-key storage, or secret-management APIs in this phase.
- Do not require auth in local/private deployments.
- Do not remove direct `PilotSwarmClient` or direct `PilotSwarmManagementClient` construction for trusted local/server-side use.
- Do not make the portal or TUI import internal SDK modules.
- Do not expose arbitrary third-party provider injection yet. The only public SDK provider modes are the built-in `direct` and `web` modes.

---

## Current Architecture

The current portal already contains the seed of this design:

```text
Browser Portal
    |
    | HTTP / WebSocket
    v
Portal Server
    |
    | PortalRuntime
    v
NodeSdkTransport
    |
    +--> PilotSwarmClient
    +--> PilotSwarmManagementClient
    +--> Artifact store
    |
    v
PostgreSQL / Azure Storage / Worker fleet
```

The TUI remote path is separate:

```text
Native TUI
    |
    | in-process transport calls
    v
NodeSdkTransport
    |
    +--> PilotSwarmClient
    +--> PilotSwarmManagementClient
    +--> Artifact store
    |
    v
PostgreSQL / Azure Storage / Worker fleet
```

This means the portal and remote TUI both ultimately need a trusted Node process with direct backend access. The proposed API makes that trusted process explicit, reusable, and independently deployable.

The MCP server is another direct-access surface today:

```text
MCP client
  |
  | stdio or HTTP /mcp
  v
pilotswarm-mcp-server
  |
  +--> PilotSwarmClient
  +--> PilotSwarmManagementClient
  +--> PgFactStore
  +--> local model/agent catalog
  |
  v
PostgreSQL / Azure Storage / Worker fleet
```

Under this proposal, the MCP server can stay direct for trusted local use or become an API consumer for remote/shared use.

---

## Proposed Architecture

The public SDK remains the surface. Provider selection is a built-in SDK mode switch, not an arbitrary plugin system.

```text
Application code
  |
  v
PilotSwarmClient
  |
  +--> provider: direct
  |       |
  |       v
  |   ClientDirectProvider
  |       |
  |       v
  |   PostgreSQL / duroxide / CMS / facts
  |
  +--> provider: web
          |
          v
      ClientWebProvider
          |
          | HTTPS / WebSocket
          v
        Portal Server /v1 API
          |
          | auth / authorization
          v
      ClientDirectProvider
          |
          v
      PostgreSQL / duroxide / CMS / facts
```

```text
Application code
  |
  v
PilotSwarmManagementClient
  |
  +--> provider: direct
  |       |
  |       v
  |   ManagementDirectProvider
  |       |
  |       v
  |   PostgreSQL / duroxide / CMS / facts / artifact store / model registry
  |
  +--> provider: web
          |
          v
      ManagementWebProvider
          |
          | HTTPS / WebSocket
          v
        Portal Server /v1 API
          |
          | auth / authorization
          v
      ManagementDirectProvider
          |
          v
      PostgreSQL / duroxide / CMS / facts / artifact store / model registry
```

At the deployment level:

```text
                         +----------------------+
                         |  Browser Portal      |
                         +----------+-----------+
                                    |
                                    | HTTPS / WebSocket
                                    v
+----------------------+  HTTPS  +--+-------------------+
| SDK web clients      +--------> | Portal Server        |
| remote API mode      |          |                      |
+----------------------+          | Auth                 |
                                  | Authorization        |
+----------------------+  HTTPS  | Request validation   |
| Custom integrations  +--------> | /v1 provider host    |
+----------------------+          | Streaming gateway    |
                                  +----------+-----------+
                                             |
                                             | direct provider calls
                                             v
                                  +----------+-----------+
                                  | ClientDirectProvider |
                                  | ManagementDirectProv |
                                  +----------+-----------+
                                             |
                                             | trusted backend credentials
                                             v
                                  +----------+-----------+
                                  | PostgreSQL           |
                                  | duroxide             |
                                  | CMS                  |
                                  | facts                |
                                  +----------+-----------+
                                             |
                                             v
                                  +----------+-----------+
                                  | Worker fleet         |
                                  | PilotSwarmWorker     |
                                  | Copilot SDK          |
                                  | Azure Blob/session   |
                                  | artifact storage     |
                                  +----------------------+
```

In Phase 1, the portal server is the hosted direct-provider boundary. It does not reimplement orchestration behavior. It authenticates network requests, authorizes the operation, calls the same direct provider implementation used by trusted local SDK clients, and serializes the result back to web-provider SDK clients.

---

## Runtime Components

```text
packages/sdk/src/providers/
  client-provider.ts
  client-direct-provider.ts
  client-web-provider.ts
  management-provider.ts
  management-direct-provider.ts
  management-web-provider.ts
packages/sdk/src/api/
  protocol.ts
  client.ts
  management.ts
  types.ts
packages/portal/
  server.js
  runtime.js
  auth/
  api/
    routes/
      bootstrap.js
      sessions.js
      events.js
      management.js
      artifacts.js
      facts.js
      catalogs.js
      models.js
      users.js
```

The provider interfaces are internal SDK contracts. They are not exported as an open extension mechanism in this phase. Public construction selects between the built-in direct and web modes:

```ts
// Default mode: direct, preserving today's { store } SDK shape.
const defaultClient = new PilotSwarmClient({ store });
const defaultManagement = new PilotSwarmManagementClient({ store });

// Explicit direct mode: same behavior, clearer intent.
const directClient = new PilotSwarmClient({
  provider: "direct",
  store,
});
const directManagement = new PilotSwarmManagementClient({
  provider: "direct",
  store,
});

// Web mode: portal-hosted API, no database or storage credentials in the caller.
const client = new PilotSwarmClient({
  provider: "web",
  apiUrl: "https://portal.example.com",
  getAccessToken,
});
const management = new PilotSwarmManagementClient({
  provider: "web",
  apiUrl: "https://portal.example.com",
  getAccessToken,
});
```

Exact option names can be settled during implementation. Required behavior: if `provider` is omitted, assume direct mode for backward compatibility. Supplying `apiUrl` without `provider: "web"` can either imply web mode or raise a helpful configuration error, but existing `{ store }` callers must continue working. Browser clients must use web mode.

### Configuration Examples

#### 1. Simplest Getting Started: Direct Client + Direct Worker

One Node.js process owns both the worker and direct SDK client. This is the smallest local trusted setup and does not require the API server.

```js
import { PilotSwarmClient, PilotSwarmWorker } from "pilotswarm-sdk";

const store = process.env.DATABASE_URL;

const worker = new PilotSwarmWorker({
  store,
  githubToken: process.env.GITHUB_TOKEN,
  blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
});
await worker.start();

const client = new PilotSwarmClient({
  provider: "direct",
  store,
});
await client.start();

const session = await client.createSession();
const answer = await session.sendAndWait("Say hello from direct mode.", 300_000);
console.log(answer);

await session.destroy();
await client.stop();
await worker.stop();
```

#### 2. Direct Management Client

Trusted server-side tooling can use direct management access without the API.

```js
import { PilotSwarmManagementClient } from "pilotswarm-sdk";

const mgmt = new PilotSwarmManagementClient({
  provider: "direct",
  store: process.env.DATABASE_URL,
});
await mgmt.start();

const sessions = await mgmt.listSessions();
console.log(sessions.map((session) => session.sessionId));

await mgmt.stop();
```

#### 3. Portal-Hosted Web API + Web Client

In Phase 1, the portal is the only Web API host. The portal process owns backend credentials and exposes `/v1` plus `/v1/ws`.

```bash
npx pilotswarm-web --env .env.remote
```

The app only receives the portal/API URL and optional access-token callback:

```js
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
  provider: "web",
  apiUrl: process.env.PILOTSWARM_PORTAL_URL,
  getAccessToken: async () => process.env.PILOTSWARM_ACCESS_TOKEN,
});
await client.start();

const session = await client.createSession();
const answer = await session.sendAndWait("Say hello through the portal Web API.", 300_000);
console.log(answer);
```

#### 4. Later API Hosts

Standalone `pilotswarm-api` and worker-embedded API hosting are useful future packaging options, but they are not part of Phase 1. Phase 1 proves the provider contract against the portal-hosted API first.

#### 5. TUI Modes

```bash
# Trusted local mode: direct provider, smallest setup.
pilotswarm local --store "$DATABASE_URL"

# Remote/shared mode: web provider through the portal-hosted API.
pilotswarm remote --api-url https://portal.example.com
```

#### 6. MCP Modes

```bash
# Trusted local MCP mode: direct provider and local facts store.
pilotswarm-mcp --store "$DATABASE_URL"

# Remote/shared MCP mode: portal Web API-backed sessions, management, facts, and catalogs.
pilotswarm-mcp --api-url https://portal.example.com
```

### SDK Provider Behavior

The public SDK classes preserve their existing method names and delegate to the selected built-in provider:

```text
PilotSwarmClient
  |
  +--> ClientDirectProvider
  |       - create/resume/list/delete sessions
  |       - start orchestration and enqueue durable messages
  |       - read CMS events for subscriptions and catch-up
  |
  +--> ClientWebProvider
      - create/resume/list/delete sessions over /v1 HTTP
      - send messages over /v1 HTTP
      - session events over WebSocket or SSE
      - no direct PostgreSQL, duroxide, facts, or storage access in the caller
```

```text
PilotSwarmManagementClient
  |
  +--> ManagementDirectProvider
  |       - list/get/rename/cancel/delete sessions
  |       - orchestration status and execution history
  |       - fleet/user/session stats
  |       - model metadata
  |       - user profile settings
  |       - artifacts
  |
  +--> ManagementWebProvider
      - same operations over /v1 HTTP
      - no direct PostgreSQL, duroxide, facts, or storage access in the caller
```

The direct providers should be mostly an extraction of today's client and management internals. They are used both by direct-mode SDK clients and by `ApiRuntime`.

### `ApiRuntime`

`ApiRuntime` owns process-local direct providers:

```text
ApiRuntime
    |
    +--> ClientDirectProvider
    |       - createSession
    |       - createSessionForAgent
    |       - resumeSession
    |       - listSessions
    |       - session.send
    |       - session.on via event replay/streaming
    |
    +--> ManagementDirectProvider
    |       - getSession/listSessions
    |       - rename/cancel/delete/complete
    |       - stats/facts/skill usage
    |       - model listing
    |       - user profile settings
    |
    +--> ArtifactStore
            - list/download/upload/delete artifacts
```

`ApiRuntime` should be long-lived and started once per process. It should eagerly initialize the management direct provider and lazily resume client direct-provider session handles as needed for send operations.

### API Handler Layer

The handler layer is a thin mapping from validated API commands to direct provider calls. It should be intentionally boring:

```text
HTTP request
    |
    v
validate params
    |
    v
authorize operation
    |
    v
call ClientDirectProvider or ManagementDirectProvider
    |
    v
serialize result
```

The handler layer should not read or write CMS directly. New product capabilities should be added to the SDK provider-backed client or management surface first, then exposed through the API.

---

## API Surface

The stable external API should be versioned under `/v1`. The existing portal-style RPC endpoint can remain as a compatibility shim during migration.

### Bootstrap and Auth

```text
GET  /v1/health
GET  /v1/bootstrap
GET  /v1/auth/config
GET  /v1/auth/me
```

`/v1/bootstrap` returns connection-independent UI metadata:

- auth context
- default model
- models grouped by provider
- creatable agents
- session creation policy
- worker/log availability summary
- API version

### Client Surface

```text
GET    /v1/sessions
POST   /v1/sessions
POST   /v1/sessions/for-agent
GET    /v1/sessions/:sessionId
DELETE /v1/sessions/:sessionId

POST   /v1/sessions/:sessionId/messages
POST   /v1/sessions/:sessionId/messages/send-and-wait
POST   /v1/sessions/:sessionId/answers
POST   /v1/sessions/:sessionId/events
POST   /v1/sessions/:sessionId/cancel-pending
```

The API mirrors `PilotSwarmClient` and `PilotSwarmSession` concepts:

- create session
- create session for a named agent
- resume by session id
- list session summaries
- send a prompt
- optionally wait for a turn result
- answer an input-required question
- send a custom event
- cancel pending queued messages
- delete/destroy user sessions

For UI send flows, `POST /v1/sessions/:sessionId/messages` should support an `enqueueOnly` flag and `clientMessageIds`, matching the current shared UI outbox behavior.

### Management Surface

```text
GET    /v1/management/sessions
GET    /v1/management/sessions/:sessionId
PATCH  /v1/management/sessions/:sessionId
POST   /v1/management/sessions/:sessionId/cancel
POST   /v1/management/sessions/:sessionId/complete
DELETE /v1/management/sessions/:sessionId

GET    /v1/management/sessions/:sessionId/status
GET    /v1/management/sessions/:sessionId/orchestration-stats
GET    /v1/management/sessions/:sessionId/execution-history
GET    /v1/management/sessions/:sessionId/events
GET    /v1/management/sessions/:sessionId/events-before

GET    /v1/management/sessions/:sessionId/metric-summary
GET    /v1/management/sessions/:sessionId/tree-stats
GET    /v1/management/sessions/:sessionId/skill-usage
GET    /v1/management/sessions/:sessionId/tree-skill-usage
GET    /v1/management/sessions/:sessionId/facts-stats
GET    /v1/management/sessions/:sessionId/tree-facts-stats

GET    /v1/management/fleet/stats
GET    /v1/management/fleet/skill-usage
GET    /v1/management/users/stats
GET    /v1/management/facts/shared-stats
POST   /v1/management/summaries/prune-deleted

GET    /v1/models
GET    /v1/models/by-provider
GET    /v1/models/default
```

This mirrors the public management client, including observability surfaces used by the portal, TUI, and agent tuner.

### Facts and Catalog Surface

The MCP server currently exposes facts, skills, models, and registered-agent discovery. Once MCP moves off direct datastore access, those operations need API-backed equivalents.

```text
GET    /v1/facts
POST   /v1/facts
DELETE /v1/facts/:namespace/:key

GET    /v1/agents
GET    /v1/skills
```

Facts routes should cover the current MCP `read_facts`, `store_fact`, and `delete_fact` behavior, including shared and session-scoped facts. Agent and skill catalog routes should expose the same plugin-derived catalog currently loaded locally by the MCP server, portal, and worker-side plugin logic.

### User Profile Surface

```text
GET    /v1/me/profile
PATCH  /v1/me/profile/settings
PUT    /v1/me/github-copilot-key
DELETE /v1/me/github-copilot-key
```

These endpoints route to `PilotSwarmManagementClient` user-profile methods. They use the authenticated principal as the user key. In no-auth mode, they use the same local/default principal semantics as the current TUI/portal transport.

### Artifact Surface

```text
GET    /v1/sessions/:sessionId/artifacts
GET    /v1/sessions/:sessionId/artifacts/:filename/meta
GET    /v1/sessions/:sessionId/artifacts/:filename/download
PUT    /v1/sessions/:sessionId/artifacts/:filename
DELETE /v1/sessions/:sessionId/artifacts/:filename
```

Artifact downloads should be proxied through the API service. Clients should not need Azure storage credentials, SAS generation rights, or direct filesystem access.

### Streaming Surface

```text
GET /v1/sessions/:sessionId/events/stream
WS  /v1/ws
```

Two streaming modes are useful:

- SSE for simple session-event subscriptions.
- WebSocket for the portal/TUI shared transport, session events, log tailing, and future bidirectional control messages.

Initial WebSocket message types can match the existing portal transport:

```text
client -> server
  subscribeSession { sessionId }
  unsubscribeSession { sessionId }
  subscribeLogs {}
  unsubscribeLogs {}

server -> client
  ready
  subscribedSession { sessionId }
  sessionEvent { sessionId, event }
  logEntry { entry }
  error { scope, sessionId, error }
```

---

## Auth Design

The API should reuse the portal's provider-based auth shape and keep it in the SDK API server modules or a shared SDK-internal module. This auth provider model is separate from the SDK data-plane provider switch: auth can remain provider-based (`none`, `entra`, future identity providers), while the public SDK data plane supports the built-in `direct` and `web` providers.

```text
Incoming request
    |
    v
extract bearer token
    |
    v
+-------------------+
| Auth provider     |
| none              |
| entra             |
+---------+---------+
          |
          v
+-------------------+
| normalized        |
| principal         |
+---------+---------+
          |
          v
+-------------------+
| authorization     |
| policy            |
+---------+---------+
          |
          v
direct provider call
```

### No-Auth Mode

No-auth mode is for local, single-user, or privately networked deployments.

Behavior:

- Auth provider id is `none`.
- No bearer token is required.
- Requests receive a synthetic local principal.
- Authorization admits the caller with the same capabilities as other admitted callers in this phase.

Recommended default for local development: no-auth is enabled. Recommended default for shared/private networks: require Entra ID.

### Entra ID Mode

Entra ID mode should mirror the portal's current `jose`-based JWT validation:

```text
Authorization: Bearer <access-token>
    |
    v
validate issuer = https://login.microsoftonline.com/<tenant>/v2.0
validate audience = configured client id
load signing keys from tenant JWKS
normalize claims into UserPrincipal
apply API authorization policy
```

Configuration:

```text
PILOTSWARM_API_AUTH_PROVIDER=entra
PILOTSWARM_API_AUTH_ENTRA_TENANT_ID=<tenant-id>
PILOTSWARM_API_AUTH_ENTRA_CLIENT_ID=<client-id>
PILOTSWARM_API_AUTHZ_ADMIN_GROUPS=<email-or-group-list>
PILOTSWARM_API_AUTHZ_USER_GROUPS=<email-or-group-list>
PILOTSWARM_API_AUTHZ_DEFAULT_ROLE=user
```

For compatibility, the API can initially accept the existing `PORTAL_AUTH_*` variables as aliases, but canonical new configuration should use `PILOTSWARM_API_AUTH_*`.

### Authorization Model

Keep the API on the same security model the portal uses today: authentication plus group/email allowlist admission. The authorization engine can still return a role label (`anonymous`, `user`, or `admin`) for display and future use, but this proposal does not introduce different route permissions for admins versus users.

Behavior:

- No-auth mode admits unauthenticated callers when `allowUnauthenticated` is enabled.
- Entra mode requires a valid token.
- If no admin/user allowlists are configured, any successfully authenticated Entra principal is admitted with the default role label.
- If allowlists are configured, the principal email must match either the admin or user allowlist.
- Once admitted, callers have the same API capabilities in this phase.
- Session owner metadata is still recorded for filtering, attribution, profile settings, and future policy work.

Session owner metadata should use the existing `SessionOwnerInfo` shape:

```text
provider
subject
email
displayName
```

In Entra mode, session creation attaches the authenticated owner. In no-auth mode, the API uses the same synthetic local/default principal semantics as the current portal/TUI path.

### Entra ID from the TUI

The browser portal can use MSAL redirect/popup flows because it runs in a browser. The native TUI cannot use that exact browser runtime, so remote API mode needs a CLI-friendly token acquisition path.

Recommended first implementation: OAuth 2.0 device-code flow.

```text
Native TUI
  |
  | GET /v1/auth/config
  v
Portal Server /v1 API
  |
  | returns tenant id, client id, authority, scopes
  v
Native TUI
  |
  | starts device-code auth
  | shows: open browser + enter code
  v
User completes Entra sign-in in browser
  |
  v
Native TUI receives access token
  |
  | Authorization: Bearer <token>
  v
Portal Server /v1 API
  |
  | validates token with jose/JWKS
  | applies current admission policy
  v
direct provider call
```

Implementation notes:

- The TUI should fetch public auth config from the API before starting auth.
- For Entra, the TUI can use `@azure/msal-node` with device-code flow.
- The TUI should cache refreshable auth state in the user's PilotSwarm config directory, not in the workspace, and it must not store API backend credentials.
- WebSocket connections should pass the same access token using the existing bearer-token or WebSocket-subprotocol pattern.
- When the API returns `401`, the TUI should prompt sign-in or refresh the token. When it returns `403`, the TUI should show the admission failure reason from the API.
- A later convenience mode can reuse Azure CLI credentials if available, but device-code flow should be the canonical first path because it does not assume `az` is installed.

---

## Configuration

The API service owns all sensitive backend connection settings.

```text
DATABASE_URL=<postgres-url-for-duroxide>
PILOTSWARM_CMS_FACTS_DATABASE_URL=<optional-postgres-url-for-cms-facts>
PILOTSWARM_DUROXIDE_SCHEMA=duroxide
PILOTSWARM_CMS_SCHEMA=copilot_sessions
PILOTSWARM_FACTS_SCHEMA=pilotswarm_facts

AZURE_STORAGE_CONNECTION_STRING=<optional-blob-connection-string>
PILOTSWARM_BLOB_CONTAINER=<container-name>
PILOTSWARM_BLOB_ACCOUNT_URL=<managed-identity-blob-account-url>
PILOTSWARM_USE_MANAGED_IDENTITY=false
PILOTSWARM_DB_AAD_USER=<optional-aad-db-user>

MODEL_PROVIDERS_PATH=<optional-model-provider-config-path>
PLUGIN_DIRS=<optional-plugin-dirs>
WORKERS=0

PILOTSWARM_API_AUTH_PROVIDER=none
PILOTSWARM_API_AUTH_ALLOW_UNAUTHENTICATED=true
```

Clients should receive only:

```text
PILOTSWARM_API_URL=https://<api-host>
PILOTSWARM_API_AUTH_PROVIDER=none|entra
PILOTSWARM_API_AUTH_PUBLIC_CONFIG=<served by /v1/auth/config>
```

No portal, TUI, or browser client should require direct PostgreSQL or Azure storage credentials in API mode.

---

## Phase 1 Deployment Topology

```text
        +----------------------+
        | Ingress / TLS        |
        +----------+-----------+
           |
           v
        +----------+-----------+
        | Portal Server        |
        | static UI + /v1 API  |
        | /v1/ws               |
        +----+------------+----+
         |            |
         | direct provider calls
         v            v
        +--------+--+      +--+----------------+
        | PostgreSQL|      | Azure Blob        |
        | duroxide  |      | artifacts/session |
        | CMS/facts |      | state             |
        +-----+-----+      +-------------------+
          |
          v
     +--------+---------+
     | PilotSwarmWorker |
     | replicas: N      |
     +------------------+
```

In Phase 1, the Web API is not a standalone deployment and is not worker-hosted. The portal server mounts `/v1` and `/v1/ws` beside the existing portal endpoints. This reuses the portal's current Express/WebSocket server, auth providers, plugin context, and deployment path.

### Phase 1 Packaging Recommendation

Keep API protocol/client pieces in the core SDK package, but host the server routes inside `pilotswarm-web` for Phase 1.

Recommended Phase 1 packaging:

- Add web-provider clients and shared protocol types under `packages/sdk/src/api/` or `packages/sdk/src/providers/`.
- Mount `/v1` and `/v1/ws` from `packages/portal/server.js`.
- Reuse the portal's current auth provider and admission model.
- Reuse or extract direct-provider logic so portal route handlers call the same direct implementation used by direct SDK mode.
- Do not add a standalone `pilotswarm-api` bin, Dockerfile, or Kubernetes Deployment in Phase 1.
- Do not add worker-hosted API mode in Phase 1.

Later extraction remains straightforward: a future `pilotswarm-api` binary can import the same route/runtime helpers and run without serving the portal UI.

---

## Phase 1 Implementation Plan

Phase 1 should be a focused compatibility-preserving slice: direct mode remains default, the portal exposes the first Web API host, and the SDK web provider proves the remote contract against that portal-hosted API.

### Scope

- Extract today's direct client/management internals into internal `ClientDirectProvider` and `ManagementDirectProvider` modules.
- Add shared web-provider protocol/client types under the SDK.
- Mount Phase 1 `/v1` routes from the portal server, backed by direct providers.
- Reuse the portal auth provider code and current allowlist admission model.
- Add a portal-side API runtime backed by direct providers.
- Add the minimal `/v1` routes needed for SDK client and management E2E coverage: sessions, messages, events, management session reads/updates, models/bootstrap, and WebSocket session-event subscription.
- Add `/v1/ws` for session events and logs.
- Add built-in public `ClientWebProvider` and `ManagementWebProvider` that speak the `/v1` Web API protocol.
- Add explicit `provider: "direct" | "web"` selection. If `provider` is omitted, use direct mode for backward compatibility.
- Keep public direct `{ store }` construction for trusted Node.js callers and getting-started examples.
- Keep worker/backend runtime construction direct where required; workers remain trusted backend components.
- Keep existing direct-mode test suites unchanged.
- Add a focused web-provider E2E suite that starts the portal server and covers representative `PilotSwarmClient` and `PilotSwarmManagementClient` flows.
- Defer portal UI transport migration, TUI web mode, MCP web mode, standalone `pilotswarm-api`, and worker-hosted API mode until after the portal-hosted API contract is proven.

### Internal Design

```text
request router
    |
    +--> auth middleware
    |       |
    |       +--> none provider
    |       +--> entra provider
    |
    +--> authorization middleware
    |
    +--> route handler
            |
            v
        ApiRuntime
            |
          +--> ClientDirectProvider
          +--> ManagementDirectProvider
            +--> ArtifactStore
```

### Compatibility Strategy

Phase 1 should not disturb existing local/server-side SDK callers:

- Existing `new PilotSwarmClient({ store })` and `new PilotSwarmManagementClient({ store })` keep using direct mode.
- Existing SDK test suites keep using direct mode.
- The portal can keep its existing `/api/rpc` surface for the browser UI while also mounting the new `/v1` web-provider API.
- The SDK web providers are the first non-browser consumers of `/v1` and `/v1/ws`.
- TUI and MCP remain direct by default in Phase 1. They can adopt web mode later once the SDK web-provider contract is proven.

The portal-hosted API should be stateless and backed by CMS/duroxide/direct providers, so the same route/runtime code can later be extracted into a standalone `pilotswarm-api` process if needed.

### Later Portal UI Migration

```text
Before

Browser
  |
  v
Portal server
  |
  v
NodeSdkTransport
  |
  v
PostgreSQL / Azure

After

Browser
  |
  v
HttpApiTransport
  |
  | uses the same web-provider protocol
  v
Portal Server /v1 API
  |
  v
PostgreSQL / Azure
```

The browser already has a `BrowserPortalTransport` that talks HTTP and WebSocket. In Phase 1, it can keep using the current portal RPC surface while the SDK web provider proves `/v1`. Later, it can become a generic `HttpApiTransport` that targets the same `/v1` protocol as the SDK web providers.

### Later TUI Migration

```text
Before remote TUI

Native TUI
  |
  v
NodeSdkTransport
  |
  v
PostgreSQL / Azure

After remote API TUI

Native TUI
  |
  v
HttpApiTransport
  |
  | uses the same web-provider protocol
  v
Portal Server /v1 API
  |
  v
PostgreSQL / Azure
```

The shared UI controller already depends on a transport-shaped object. Add a Node-compatible `HttpApiTransport` with the same methods as `NodeSdkTransport` and `BrowserPortalTransport`. Internally, it should use the SDK web providers where practical, or at minimum the same `/v1` protocol contract:

- `start` / `stop`
- `getAuthContext`
- `listSessions` / `getSession`
- `createSession` / `createSessionForAgent`
- `sendMessage` / `sendAnswer`
- `renameSession` / `cancelSession` / `completeSession` / `deleteSession`
- `getSessionEvents` / `getSessionEventsBefore`
- `subscribeSession`
- stats, model, artifact, and admin profile methods

The TUI can stay direct in Phase 1. Later, it should support both provider modes. Local trusted mode can keep using direct provider access for the smallest setup. Remote/shared mode should use `HttpApiTransport` and `PILOTSWARM_API_URL` so no database or storage credentials are present in the TUI process.

### Later MCP Server Migration

```text
Before

MCP client
  |
  v
pilotswarm-mcp-server
  |
  +--> PilotSwarmClient({ store })
  +--> PilotSwarmManagementClient({ store })
  +--> PgFactStore
  +--> local model/agent/skill catalogs
  |
  v
PostgreSQL / Azure

After, web mode

MCP client
  |
  v
pilotswarm-mcp-server
  |
  +--> PilotSwarmClient({ apiUrl })
  +--> PilotSwarmManagementClient({ apiUrl })
  +--> facts/catalog API client
  |
  v
Portal Server /v1 API
  |
  v
PostgreSQL / Azure
```

The MCP server can stay direct in Phase 1. Later, it should support both provider modes. Direct mode keeps the current trusted local behavior. Web mode lets a hosted or remote MCP process reach PilotSwarm without database/storage credentials.

MCP transport security remains separate from PilotSwarm API auth. Stdio mode can keep process-level trust. HTTP mode can keep `PILOTSWARM_MCP_KEY` for MCP clients. In web mode, the MCP process itself authenticates to the configured PilotSwarm API host using the deployment's API auth mode, or no-auth in local deployments.

Required MCP changes:

- Add `--api-url` / `PILOTSWARM_API_URL` for web mode while keeping `--store` / `DATABASE_URL` for direct mode.
- Route session/management operations through the selected provider.
- Route facts through `PgFactStore` in direct mode and facts API calls in web mode.
- Route model, skill, and registered-agent catalog reads through local loaders in direct mode and API catalog/bootstrap calls in web mode where possible.
- Keep MCP's external trust boundary explicit: any client admitted to this MCP endpoint still has the endpoint's PilotSwarm scope unless a later MCP-specific per-client authorization model is added.

---

## Request Flow Details

### Create Session

```text
Client
  |
  | POST /v1/sessions
  v
Portal Server /v1 API
  |
  | authenticate principal
  | authorize create
  | attach owner
  v
ClientDirectProvider.createSession
  |
  | write CMS pending row
  v
PostgreSQL CMS
  |
  v
response { sessionId, model, reasoningEffort }
```

### Send Message

```text
Client
  |
  | POST /v1/sessions/:id/messages
  v
Portal Server /v1 API
  |
  | authenticate principal
  | authorize session write
  | resume cached session handle or create handle
  v
ClientDirectProvider.sendMessage
  |
  | ensure orchestration started
  | enqueue durable message event
  v
duroxide / PostgreSQL
  |
  v
Worker runTurn activity
```

### Stream Session Events

```text
Client
  |
  | WS subscribeSession
  v
Portal Server /v1 API
  |
  | authorize session read
  | load last known seq
  | poll/replay CMS events
  | forward newly observed events
  v
Client receives sessionEvent messages
```

Correctness should come from CMS event replay. WebSocket delivery is an acceleration path, not the only source of truth. Clients should still use `getSessionEvents` for catch-up after reconnect.

---

## Error Model

All JSON APIs should return a predictable envelope:

```json
{
  "ok": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session was not found."
  }
}
```

Suggested status mapping:

```text
400 invalid request / validation failure
401 missing or invalid token
403 authenticated but not authorized
404 session/artifact/resource not found
409 terminal session or conflicting lifecycle state
413 payload too large
500 unexpected server error
503 SDK runtime not started or backend unavailable
```

Existing portal compatibility routes can continue returning the current `{ ok, result, error }` shape until the portal migrates.

---

## Testing Plan

Existing tests should keep using direct mode. A new focused web-provider E2E suite should start or target a portal server with `/v1` and `/v1/ws` mounted before constructing web-provider clients.

Add/update tests at these levels:

- Auth unit tests: no-auth accepts no token, Entra rejects missing/invalid tokens, and authz maps principals to roles.
- Direct-provider SDK tests: public `PilotSwarmClient` and `PilotSwarmManagementClient` work with `provider: "direct"` and `{ store }`, preserving the simplest trusted getting-started path.
- Web-provider SDK E2E tests: public `PilotSwarmClient` and `PilotSwarmManagementClient` work with `provider: "web"` and `{ apiUrl }` against the portal-hosted API, serialize and deserialize expected view models, and never require PostgreSQL or Azure storage credentials in the caller.
- API provider-host tests: route validation, endpoint responses for create/send/list/get/rename/cancel/delete-or-complete, owner principal attachment, and event serialization through the portal-hosted direct providers.
- Existing integration smoke tests remain direct by default. Add a small web suite covering: create session, send/wait for a response, read events, list sessions through management, get session through management, rename/cancel/delete or complete a session through management.

Portal UI, TUI, and MCP tests can remain on their current direct paths in Phase 1 unless they are explicitly part of the new web-provider E2E suite.

---

## Phase 1 Delivery Checklist

```text
1. Extract internal ClientDirectProvider and ManagementDirectProvider.
2. Mount the Phase 1 Web API routes inside the portal server.
3. Add /v1 HTTP routes, /v1/ws streaming, and temporary /api/rpc compatibility.
4. Add ClientWebProvider and ManagementWebProvider as public SDK provider modes.
5. Add explicit provider selection and inference from store/apiUrl env/options.
6. Keep existing direct-mode tests and helpers unchanged by default.
7. Add a focused web-provider E2E suite that starts/targets the portal server.
8. Keep portal UI, TUI, MCP, standalone API, and worker-hosted API migration out of Phase 1 unless needed by the E2E harness.
9. Update docs and examples for provider selection and portal-hosted web mode.
```

---

## Open Questions

- Should direct mode be selected explicitly with `provider: "direct"`, inferred from `store`, or both?
- Should web mode be selected explicitly with `provider: "web"`, inferred from `apiUrl`, or both?
- Should the public option be named `apiUrl`, `portalUrl`, or `baseUrl` while Phase 1 is portal-hosted?
- Should direct mode remain available in browser-targeted bundles, or should browser builds hard-error unless `provider: "web"` is used?
- Which management operations belong in the first web E2E suite: rename/cancel/delete/complete, or only read/list plus one mutation?
- Should SSE be supported in addition to WebSocket in the first version, or is WebSocket enough until external integrations ask for SSE?
- When should standalone `pilotswarm-api`, TUI web mode, and MCP web mode move from later work into scope?

---

## Recommendation

Build the SDK provider switch, keep direct mode as the backward-compatible default, and mount the first `/v1` Web API inside the portal. Existing tests stay direct. Add a focused web-provider E2E suite that exercises representative `PilotSwarmClient` and `PilotSwarmManagementClient` flows against the portal-hosted API. Standalone API packaging, TUI web mode, and MCP web mode can follow once that contract is proven.

This keeps the implementation grounded in the current repo while giving PilotSwarm a clean network API for UI clients and future integrations.