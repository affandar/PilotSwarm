# Entra ID Auth + API Gateway — Implementation Plan

## Problem

PilotSwarm has zero authentication. Clients connect directly to the database. There's no user identity, no access control, and no role-based visibility. We need:

- **Entra ID authentication** (MSAL PKCE for browser, device-code for CLI)
- **Role-based authorization** (owner / admin / user)
- **Pluggable provider layer** with an authenticated gateway for remote deployments

## Roles

| Capability | Owner | Admin | User |
|---|---|---|---|
| See all sessions (incl. other users') | ✅ | ❌ | ❌ |
| See system agents | ✅ | ✅ | ❌ |
| See own sessions | ✅ | ✅ | ✅ |
| Create/use sessions | ✅ | ✅ | ✅ |
| Delete any session | ✅ | ❌ | ❌ |
| Delete own session | ✅ | ✅ | ✅ |
| Read all facts | ✅ | ❌ | ❌ |
| Read shared facts | ✅ | ✅ | ✅ |
| Read own facts | ✅ | ✅ | ✅ |
| See promoted skills | ✅ | ✅ | ✅ |
| Manage users / assign roles | ✅ | ❌ | ❌ |
| Make admins | ✅ | ❌ | ❌ |
| Make co-owners | ✅ | ❌ | ❌ |

## Approach

**Hybrid auth**: Entra ID provides identity + default roles (via App Roles). A local `users` table allows owners to override/promote roles from PilotSwarm itself.

**Effective role** = max(Entra App Role, local DB role override).

## Architecture

The key insight is a **provider abstraction** inside the SDK. `PilotSwarmClient` and `ManagementClient` don't talk to duroxide/CMS/facts directly — they go through a `PilotSwarmProvider` interface. Two implementations:

```
                        ┌─────────────────────────────────────────────────┐
                        │           PilotSwarmProvider (interface)        │
                        ├────────────────────┬────────────────────────────┤
                        │   LocalProvider    │     GatewayProvider        │
                        │  (thick / direct)  │    (thin / HTTP)           │
                        ├────────────────────┼────────────────────────────┤
                        │ duroxide Client    │                            │
                        │ CMS (sqlx)         │    ──── HTTP/SSE ────▶    │
                        │ FactsStore (sqlx)  │                            │
                        │ ArtifactStore      │                            │
                        │   ▼                │         ▼                  │
                        │ PostgreSQL         │   Gateway (Express)        │
                        │                    │     JWT verify + RBAC      │
                        │                    │     LocalProvider           │
                        │                    │       ▼                    │
                        │                    │     PostgreSQL             │
                        └────────────────────┴────────────────────────────┘

Thick (local dev / co-located):
  CLI/Portal → PS Client → LocalProvider → PG

Thin (AKS / multi-user):
  CLI/Portal → PS Client → GatewayProvider ──HTTP──▶ Gateway → LocalProvider → PG

Worker (always thick — trusted backend):
  Worker → LocalProvider → PG (direct, no auth layer)
```

### What changes vs. what stays the same

- **PilotSwarmClient / ManagementClient**: API stays identical. They receive a `PilotSwarmProvider` instead of constructing their own duroxide Client + CMS + facts.
- **Worker**: Always uses `LocalProvider`. It's trusted infrastructure with direct DB access.
- **Gateway** (`packages/gateway`): An Express server that wraps a `LocalProvider` with Entra ID JWT auth + RBAC. Exposes HTTP/SSE endpoints matching the provider interface.
- **GatewayProvider**: A thin HTTP client implementing `PilotSwarmProvider`. No DB deps — just `fetch()`.
- **Config**: Thick mode uses a PG connection string (as today). Thin mode uses a gateway URL + Entra credentials.

## PilotSwarmProvider Interface

Extracted from current `PilotSwarmClient` and `ManagementClient` infrastructure calls. This is the complete client-side surface. (Worker-side operations like session dehydrate/hydrate/checkpoint are NOT included — the worker stays thick.)

### Orchestration Operations (currently duroxide Client)

```ts
interface PilotSwarmProvider {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // --- Orchestration ---
  startOrchestration(
    orchestrationId: string,
    name: string,
    input: unknown,
    version: string,
  ): Promise<void>;

  cancelOrchestration(
    orchestrationId: string,
    reason: string,
  ): Promise<void>;

  deleteOrchestration(
    orchestrationId: string,
    purge: boolean,
  ): Promise<void>;

  getOrchestrationInfo(
    orchestrationId: string,
  ): Promise<OrchestrationInfo | null>;

  // --- Status ---
  getStatus(
    orchestrationId: string,
  ): Promise<OrchestrationStatus>;

  waitForStatusChange(
    orchestrationId: string,
    afterVersion: number,
    pollIntervalMs: number,
    timeoutMs: number,
  ): Promise<OrchestrationStatus>;

  // --- Messaging ---
  enqueueEvent(
    orchestrationId: string,
    queue: string,
    payload: string,
  ): Promise<void>;

  // --- KV ---
  getValue(
    orchestrationId: string,
    key: string,
  ): Promise<string | null>;

  // --- CMS: Sessions ---
  createSession(
    sessionId: string,
    opts: { model?: string; parentSessionId?: string; isSystem?: boolean },
  ): Promise<void>;

  updateSession(
    sessionId: string,
    updates: SessionUpdates,
  ): Promise<void>;

  getSession(
    sessionId: string,
  ): Promise<SessionRow | null>;

  listSessions(): Promise<SessionRow[]>;

  softDeleteSession(sessionId: string): Promise<void>;

  getSessionEvents(
    sessionId: string,
    afterSeq?: number,
    limit?: number,
  ): Promise<SessionEvent[]>;

  // --- Facts ---
  readFacts(
    query: ReadFactsQuery,
    access?: FactAccess,
  ): Promise<{ count: number; facts: FactRecord[] }>;

  storeFact(input: StoreFactInput): Promise<StoreFactResult>;

  deleteFact(input: DeleteFactInput): Promise<DeleteFactResult>;

  deleteSessionFacts(sessionId: string): Promise<number>;

  // --- Artifacts ---
  uploadArtifact(
    sessionId: string,
    filename: string,
    content: string,
    contentType?: string,
  ): Promise<string>;

  downloadArtifact(
    sessionId: string,
    filename: string,
  ): Promise<string>;

  listArtifacts(sessionId: string): Promise<string[]>;

  deleteArtifacts(sessionId: string): Promise<number>;

  // --- Models ---
  listModels(): ModelSummary[];
  getDefaultModel(): string | undefined;
  normalizeModel(ref?: string): string | undefined;
}
```

### Notes on the interface

- **Artifact ops are client-facing only**: `uploadArtifact`, `downloadArtifact`, `listArtifacts`, `deleteArtifacts`. Session state operations (dehydrate, hydrate, checkpoint) remain worker-internal — the worker always uses `LocalProvider` and its own `SessionBlobStore`.
- **Facts**: Currently `PilotSwarmClient` only calls `deleteSessionFacts()` and `initialize()`/`close()`. But for the gateway to serve fact browsing (portal/CLI viewing facts), we include `readFacts`, `storeFact`, `deleteFact` in the provider. `ManagementClient` or a new thin surface on `PilotSwarmClient` will expose these.
- **Models**: Currently loaded from a local JSON file. In `LocalProvider`, this stays as-is. In `GatewayProvider`, model queries go over HTTP to the gateway (which loads from its own config).
- **KV**: Only `getValue` is needed client-side. `setValue` is orchestration-internal (done inside the generator function via `ctx.setValue`).
- **No `setValue`**: The orchestration sets KV values. Clients only read them.

## Phases

### Phase 0 — PilotSwarmProvider Interface & LocalProvider

Extract the provider interface from existing code. This is a pure refactor — no new features, no behavior changes.

1. **Define `PilotSwarmProvider` interface** in `src/provider.ts`
2. **Implement `LocalProvider`** — wraps existing duroxide `Client`, `PgSessionCatalogProvider`, `PgFactStore`, `SessionBlobStore`, `ModelProviderRegistry`. Straight delegation.
3. **Refactor `PilotSwarmClient`** — replace direct `duroxideClient` / `_catalog` / `_factStore` fields with a single `provider: PilotSwarmProvider`. All existing calls route through it.
4. **Refactor `ManagementClient`** — same treatment.
5. **Config**: `LocalProvider` takes the same PG connection string + schemas as today. `PilotSwarmClient({ store: "postgresql://..." })` continues to work unchanged by constructing a `LocalProvider` internally.
6. **Verify**: All existing tests pass with no behavior change.

### Phase 1 — Database: User & Ownership Model

Add identity columns to the data layer.

- **New table: `pilotswarm_auth.users`**
  - `id` TEXT PK (Entra OID)
  - `email` TEXT NOT NULL
  - `display_name` TEXT
  - `role` TEXT NOT NULL DEFAULT 'user' (owner | admin | user)
  - `role_source` TEXT NOT NULL DEFAULT 'entra' (entra | local)
  - `created_at` TIMESTAMPTZ
  - `updated_at` TIMESTAMPTZ

- **Add `owner_id` to `copilot_sessions.sessions`**
  - Nullable TEXT, references Entra OID
  - Existing sessions get NULL (treated as unowned / owner-visible only)

- **Add `owner_id` to `pilotswarm_facts.facts`**
  - Nullable TEXT, references Entra OID
  - Existing facts keep NULL

- **Scoped queries on `LocalProvider`**: `listSessions()`, `getSession()`, `readFacts()` gain optional auth context (`userId` + `role`) to filter visibility. Owner sees all; admin sees own + system; user sees own only.

### Phase 2 — Gateway Package

New `packages/gateway/` — an Express server that wraps `LocalProvider` with auth + RBAC.

- **`packages/gateway/package.json`** — deps: express, jose, cors, helmet
- **`packages/gateway/src/server.ts`** — Express app with middleware chain
- **`packages/gateway/src/middleware/auth.ts`** — Entra ID JWT validation using `jose` (JWKS from `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`). Extracts OID, email, app roles from token claims.
- **`packages/gateway/src/middleware/rbac.ts`** — Hybrid role resolution: effective role = max(Entra App Role, local DB override). `requireRole()` middleware. Injects auth context into provider calls.
- **`packages/gateway/src/routes/`** — REST endpoints that 1:1 map to `PilotSwarmProvider` methods:

#### Sessions
| Method | Path | Provider Method | Auth |
|--------|------|-----------------|------|
| GET | `/api/sessions` | `listSessions()` | All (filtered by role) |
| POST | `/api/sessions` | `createSession()` | All |
| GET | `/api/sessions/:id` | `getSession()` | Own or owner |
| DELETE | `/api/sessions/:id` | `softDeleteSession()` | Own or owner |
| PATCH | `/api/sessions/:id` | `updateSession()` | Own or owner |
| POST | `/api/sessions/:id/cancel` | `cancelOrchestration()` | Own or owner |
| POST | `/api/sessions/:id/messages` | `enqueueEvent()` | Own or owner |
| GET | `/api/sessions/:id/events` | `getSessionEvents()` | Own or owner |
| GET | `/api/sessions/:id/events/stream` | SSE poll of `getSessionEvents()` | Own or owner |
| GET | `/api/sessions/:id/status` | `getStatus()` | Own or owner |
| POST | `/api/sessions/:id/status/wait` | `waitForStatusChange()` | Own or owner |
| GET | `/api/sessions/:id/kv/:key` | `getValue()` | Own or owner |
| GET | `/api/sessions/:id/orchestration` | `getOrchestrationInfo()` | Own or owner |
| POST | `/api/sessions/:id/orchestration` | `startOrchestration()` | Own or owner |
| DELETE | `/api/sessions/:id/orchestration` | `deleteOrchestration()` | Owner |

#### Facts
| Method | Path | Provider Method | Auth |
|--------|------|-----------------|------|
| GET | `/api/facts` | `readFacts()` | All (scoped by role) |
| POST | `/api/facts` | `storeFact()` | All (own scope) |
| DELETE | `/api/facts/:scopeKey` | `deleteFact()` | Own or owner |
| DELETE | `/api/facts/session/:sessionId` | `deleteSessionFacts()` | Own or owner |

#### Artifacts
| Method | Path | Provider Method | Auth |
|--------|------|-----------------|------|
| GET | `/api/sessions/:id/artifacts` | `listArtifacts()` | Own or owner |
| GET | `/api/sessions/:id/artifacts/:filename` | `downloadArtifact()` | Own or owner |
| POST | `/api/sessions/:id/artifacts/:filename` | `uploadArtifact()` | Own or owner |
| DELETE | `/api/sessions/:id/artifacts` | `deleteArtifacts()` | Own or owner |

#### Models
| Method | Path | Provider Method | Auth |
|--------|------|-----------------|------|
| GET | `/api/models` | `listModels()` | All |
| GET | `/api/models/default` | `getDefaultModel()` | All |
| GET | `/api/models/normalize` | `normalizeModel()` | All |

#### Knowledge
| Method | Path | Auth |
|--------|------|------|
| GET | `/api/knowledge` | All (shared facts only) |

#### User Management (Owner only)
| Method | Path | Auth |
|--------|------|------|
| GET | `/api/auth/me` | All |
| GET | `/api/users` | Owner |
| PATCH | `/api/users/:id/role` | Owner |

#### Health
| Method | Path | Auth |
|--------|------|------|
| GET | `/api/health` | None |

### Phase 3 — GatewayProvider

Implement `GatewayProvider` — the thin HTTP client for `PilotSwarmProvider`.

- **`src/gateway-provider.ts`** — implements `PilotSwarmProvider` using `fetch()` calls to the gateway endpoints.
- **No database dependencies** — only `fetch`. This is what makes the thin client truly thin.
- **Token management**: Takes an `accessToken` (or token-getter callback) for Bearer auth.
- **SSE for events**: `getSessionEvents()` can use the SSE stream endpoint for real-time events.
- **`waitForStatusChange()`**: Long-poll via `POST /api/sessions/:id/status/wait` instead of local duroxide polling.
- **Config**: `GatewayProvider({ gatewayUrl: "https://...", getAccessToken: () => "..." })`
- **Client integration**: `PilotSwarmClient({ provider: new GatewayProvider({...}) })` or auto-detect via config: if `store` is a URL like `https://...`, construct `GatewayProvider`; if it's a PG connection string, construct `LocalProvider`.

### Phase 4 — Portal Integration (Browser Auth)

Update `packages/portal` to use MSAL.js PKCE + GatewayProvider.

- Add `@azure/msal-browser` to portal
- Login page / redirect flow
- Store access token in memory (not localStorage)
- Portal creates `PilotSwarmClient` with `GatewayProvider` pointed at the gateway
- Portal WebSocket auth: token on connect
- Remove direct PTY spawn for unauthenticated connections

### Phase 5 — CLI Integration (Device-Code Flow)

Update `packages/cli` to authenticate via device-code flow.

- Add `@azure/msal-node` to CLI
- `pilotswarm login` / `pilotswarm logout` commands
- Device-code flow: display URL + code, user authenticates in browser
- Token cache at `~/.pilotswarm/auth.json`
- CLI creates `PilotSwarmClient` with `GatewayProvider` when configured for remote
- Fallback: `LocalProvider` for local dev (PG connection string in env)

### Phase 6 — Tests & Documentation

- **Provider contract tests**: Shared test suite that both `LocalProvider` and `GatewayProvider` must pass. Write once, run against both implementations.
- **Gateway endpoint tests**: Mocked Entra tokens, RBAC matrix verification.
- **Existing tests**: Must pass unchanged (they use `LocalProvider` path).
- **Docs**: Entra app registration guide, env vars, role setup, deployment.
- **Deploy**: Update `deploy-aks.sh` to include gateway container.

## Open Questions

- Token refresh strategy for long-lived CLI sessions? (MSAL handles refresh tokens, but we need graceful 401 → re-auth.)
- Rate limiting on the gateway?
- Should the gateway support WebSocket transport in addition to HTTP/SSE? (For lower-latency event streaming.)
- Session ownership for system agents — unowned, visible per role rules?

## Key Dependencies

- `jose` — JWT validation (lighter than passport-azure-ad)
- `@azure/msal-browser` — browser PKCE flow
- `@azure/msal-node` — CLI device-code flow
- `express` — already in portal, reuse pattern
- `helmet` + `cors` — security defaults

## Config

### Thick (local dev)
```
PS_STORE=postgresql://localhost:5432/pilotswarm
# No auth needed — LocalProvider, direct DB
```

### Thin (AKS / remote)
```
PS_GATEWAY_URL=https://pilotswarm-gateway.example.com
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<app-registration-client-id>
AZURE_AUDIENCE=api://<client-id>
```

### Gateway server
```
PS_STORE=postgresql://db:5432/pilotswarm
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<app-registration-client-id>
AZURE_AUDIENCE=api://<client-id>
GATEWAY_PORT=8080
GATEWAY_CORS_ORIGIN=https://portal.example.com
```
