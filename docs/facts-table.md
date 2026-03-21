# Facts Table — Design Specification

## Overview

The facts table is a durable structured-memory layer for PilotSwarm agents. It provides a PostgreSQL-backed key/value store that agents can use for session-scoped working memory and cross-session shared knowledge. Facts survive process restarts and are automatically cleaned up when sessions are deleted.

## Motivation

LLM conversations are lossy — context windows are finite, chat history can be truncated, and agent sessions may be replayed on different workers after a crash. Agents need a reliable way to persist:

- user instructions and preferences
- task state, checkpoints, and resumable progress
- identifiers, URLs, configuration values, baselines
- cross-agent handoff state

The facts table provides this as a first-class, always-available tool for every session.

## Architecture

```
                        ┌────────────────────────────────┐
                        │        PilotSwarmWorker         │
                        │  ┌──────────────────────────┐  │
                        │  │   SessionManager          │  │
                        │  │   ┌────────────────────┐  │  │
                        │  │   │  ManagedSession     │  │  │
┌──────────┐            │  │   │  ┌──────────────┐  │  │  │
│ LLM Turn │──calls──►  │  │   │  │ fact tools   │──┼──┼──┼──► PgFactStore ──► PostgreSQL
│          │            │  │   │  │ store/read/  │  │  │  │        │
│          │            │  │   │  │ delete       │  │  │  │        ▼
└──────────┘            │  │   │  └──────────────┘  │  │  │   pilotswarm_facts.facts
                        │  │   └────────────────────┘  │  │
                        │  └──────────────────────────┘  │
                        └────────────────────────────────┘

┌──────────────────┐
│ PilotSwarmClient │
│  factStore ──────┼──► PgFactStore (used by client.deleteSession for cleanup)
└──────────────────┘

┌──────────────────┐
│ Sweeper Agent    │
│  cleanup_session │──► factStore.deleteSessionFactsForSession (descendant cleanup)
└──────────────────┘
```

### Component Responsibilities

| Component | Role |
|-----------|------|
| `PgFactStore` | PostgreSQL-backed implementation of the `FactStore` interface. Handles connection pooling, schema creation, and all CRUD operations. |
| `createFactTools()` | Factory that produces three Copilot SDK `Tool` objects (`store_fact`, `read_facts`, `delete_fact`) wired to a `FactStore`. |
| `SessionManager` | Owns the `FactStore` instance and injects fact tools into every `ManagedSession`'s tool set. |
| `PilotSwarmWorker` | Creates and initializes the `PgFactStore` during `start()`, then passes it to `SessionManager` and sweeper tools. |
| `PilotSwarmClient` | Creates its own `PgFactStore` for client-side cleanup (e.g., `deleteSession` removes session facts). |
| `cleanup_session` (sweeper) | Deletes session-scoped facts for the root session and all descendants during cleanup. |

## Database Schema

### Table: `{schema}.facts`

```sql
CREATE TABLE IF NOT EXISTS pilotswarm_facts.facts (
    id          BIGSERIAL PRIMARY KEY,
    scope_key   TEXT NOT NULL UNIQUE,
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    agent_id    TEXT,
    session_id  TEXT,
    shared      BOOLEAN NOT NULL DEFAULT FALSE,
    transient   BOOLEAN NOT NULL DEFAULT FALSE,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT (shared AND transient))
);
```

### Column Semantics

| Column | Purpose |
|--------|---------|
| `scope_key` | Composite uniqueness key. `shared:<key>` for shared facts, `session:<sessionId>:<key>` for session-scoped facts. Ensures one fact per key per scope. |
| `key` | Human-readable fact identifier (e.g., `baseline/tps`, `infra/server/fqdn`). |
| `value` | JSON-serializable payload stored as JSONB. |
| `agent_id` | Optional provenance — which agent stored the fact. |
| `session_id` | The session that owns the fact. `NULL` is technically possible for shared facts but the storing session's ID is still recorded. |
| `shared` | `true` = globally visible across all sessions. `false` = session-scoped, only visible to the owning session. |
| `transient` | Mutually exclusive with `shared` (enforced by CHECK constraint). Session-scoped facts are transient; shared facts are not. |
| `tags` | Array of string tags for categorized querying (e.g., `["build", "ci"]`). Uses GIN index for array containment queries. |

### Indexes

- `idx_*_facts_key` — B-tree on `key`
- `idx_*_facts_tags` — GIN on `tags` (supports `@>` containment)
- `idx_*_facts_session` — B-tree on `session_id`
- `idx_*_facts_agent` — B-tree on `agent_id`
- `idx_*_facts_shared` — B-tree on `shared`
- `idx_*_facts_transient` — B-tree on `transient`

### Schema Configuration

The schema name defaults to `pilotswarm_facts` and is configurable via `factsSchema` on both `PilotSwarmWorkerOptions` and `PilotSwarmClientOptions`. Tests use isolated schemas (`pilotswarm_facts_it_<timestamp>_<random>`) for parallel test execution.

## Tool API

### `store_fact`

Stores or upserts a fact. Session-scoped by default.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Fact identifier (e.g., `baseline/tps`) |
| `value` | any | yes | JSON-serializable value |
| `tags` | string[] | no | Tags for filtering |
| `shared` | boolean | no | `true` for cross-session shared fact (default: `false`) |

**Behavior:**
- Uses `ON CONFLICT (scope_key) DO UPDATE` — calling `store_fact` with the same key overwrites the previous value.
- The session ID and agent ID are automatically populated from the calling context.
- Returns `{ key, shared, scope: "shared" | "session", stored: true }`.

### `read_facts`

Reads facts visible to the calling session.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key_pattern` | string | no | Key pattern with `%` or `*` wildcards |
| `tags` | string[] | no | All listed tags must be present |
| `session_id` | string | no | Provenance filter by source session |
| `agent_id` | string | no | Provenance filter by source agent |
| `limit` | number | no | Max rows (default: 50) |
| `scope` | string | no | `accessible` (default), `shared`, `session`, or `descendants` |

**Scope Semantics:**

| Scope | Returns |
|-------|--------|
| `accessible` | Caller's own session facts + all shared facts |
| `shared` | Only shared facts |
| `session` | Only the caller's own session-scoped facts |
| `descendants` | Caller's own session facts + shared facts + all facts from descendant sessions (children, grandchildren, etc.) |

**Visibility Rules:**

- The `session_id` parameter is lineage-aware. When a caller passes `session_id=<child>` and the child is a verified descendant (via the CMS `parent_session_id` tree), the child's session-scoped facts become visible. Non-descendant sessions' private facts remain inaccessible.
- When `scope=descendants`, the handler resolves all descendant session IDs via `getDescendantSessionIds()` and includes them in the visibility set.
- Lineage verification uses the same recursive CTE (`parent_session_id` tree) that the sweeper uses for cleanup.

### `delete_fact`

Deletes a fact by key.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Fact key to delete |
| `shared` | boolean | no | `true` to delete the shared fact; `false` (default) to delete the caller's session-scoped fact |

**Returns:** `{ key, shared, deleted: boolean }`.

## Scoping and Lifecycle

### Session-Scoped Facts (default)

- Visible only to the owning session via `scope=accessible` or `scope=session`.
- Automatically deleted when the session is deleted (via `deleteSessionFactsForSession()`).
- Upsert key: `session:<sessionId>:<key>`.

### Shared Facts

- Visible to all sessions via `scope=accessible` or `scope=shared`.
- Persist indefinitely until explicitly deleted with `delete_fact(key, shared=true)`.
- Upsert key: `shared:<key>`.
- Not cleaned up by session deletion or sweeper cleanup.

### Cleanup Flow

1. **`client.deleteSession(sessionId)`** — calls `factStore.deleteSessionFactsForSession(sessionId)` to remove all session-scoped facts.
2. **Sweeper `cleanup_session`** — iterates through `getDescendantSessionIds()` and calls `deleteSessionFactsForSession()` for each descendant, then for the root session.
3. Shared facts are never automatically deleted.

## Integration Points

### Worker Initialization

```
PilotSwarmWorker.start()
  → createFactStoreForUrl(store, factsSchema)
  → factStore.initialize()
  → sessionManager.setFactStore(factStore)
  → createSweeperTools({ ..., factStore })
```

### Session Creation

```
SessionManager.getOrCreate()
  → createFactTools({ factStore })
  → inject into CopilotSession tool set alongside system tools, sub-agent tools, and user tools
```

Facts tools are re-registered on every `runTurn()` call as part of the standard tool set.

### Default Agent Prompt

The `default.agent.md` includes a `## Facts Table` section that instructs the LLM to use facts aggressively for durable memory. Key guidance:

- Treat conversational memory as lossy — write important state to facts.
- Session-scoped by default, use `shared=true` only for cross-session knowledge.
- Read relevant facts before resuming long-running or multi-agent work.
- Respond to user "remember" / "forget" requests via facts tools immediately.
- After sub-agents complete, use `read_facts(session_id=<child>)` or `scope=descendants` to pull their facts.

## Constraints

- **PostgreSQL only.** The `createFactStoreForUrl()` factory rejects non-Postgres URLs. SQLite is not supported for facts.
- **No SQLite fallback.** Unlike the CMS and duroxide stores which support SQLite for local development, facts are Postgres-exclusive.
- **No hard row cap.** `readFacts` defaults to 50 rows per query. Callers can raise the `limit` parameter as needed.
- **No cross-session access for private facts (except descendants).** A session cannot read an unrelated session's non-shared facts. However, parent agents can read their descendants' session-scoped facts via `scope=descendants` or by passing `session_id=<child>` (lineage verified via CMS).

## Public API Exports

From `src/index.ts`:

```typescript
export { PgFactStore, createFactStoreForUrl } from "./facts-store.js";
export type { FactStore, FactRecord, StoreFactInput, ReadFactsQuery, DeleteFactInput } from "./facts-store.js";
export { createFactTools } from "./facts-tools.js";
```

These are available to applications that need direct fact store access outside of the tool layer.
