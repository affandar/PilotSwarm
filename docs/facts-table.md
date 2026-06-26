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

Shared facts whose keys start with `intake/` also wake the Facts Manager after
the write commits. Session-scoped `intake/*` facts and shared non-intake facts do
not enqueue a wake-up; the 6-hour Facts Manager maintenance cron is the fallback
for missed or unavailable reactive wake-ups.

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

Stores or upserts one fact, or a batch of facts. Session-scoped by default.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes, unless `facts` is set | Fact identifier (e.g., `baseline/tps`) |
| `value` | any | yes, unless `facts` is set | JSON-serializable value |
| `tags` | string[] | no | Tags for filtering |
| `shared` | boolean | no | `true` for cross-session shared fact (default: `false`) |
| `facts` | `{ key, value, tags?, shared? }[]` | no | Batch ingestion form. When present, top-level `key` / `value` are ignored. |

**Behavior:**
- Uses `ON CONFLICT (scope_key) DO UPDATE` — calling `store_fact` with the same key overwrites the previous value.
- The session ID and agent ID are automatically populated from the calling context.
- Returns `{ key, shared, scope: "shared" | "session", stored: true }`.
- Batch form returns `{ stored, facts: [...] }` with the same per-fact result shape.

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
| `accessible` | Caller's own session facts + spawn-tree facts (every other session under the same root: ancestors, descendants, siblings, cousins) + all globally-shared facts |
| `shared` | Only globally-shared facts |
| `session` | Only the caller's own session-scoped facts |
| `descendants` | Same spawn-tree visibility as `accessible`, kept as an explicit family-tree view |

**Visibility Rules:**

- Session-scoped facts are visible to every session in the same **spawn tree** — the caller's session, every ancestor on the way up to the root, and every descendant of that root (i.e. siblings and cousins, not just children/grandchildren). The `session_id` parameter is spawn-tree-aware: when a caller passes `session_id=<other>` and `<other>` belongs to the same spawn tree, that session's session-scoped facts become visible. Sessions outside the spawn tree remain inaccessible.
- When `scope=descendants`, the handler resolves the entire spawn tree (root + all descendants of root) and includes those session IDs in the visibility set. It is functionally equivalent to `accessible` today and kept as an explicit family-tree view.
- Lineage / spawn-tree resolution uses the CMS `parent_session_id` tree: the worker walks up to the root ancestor, then expands via the same recursive CTE the sweeper uses for cleanup.

### `delete_fact`

Deletes a fact by exact key, or deletes matching keys when explicitly requested.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Fact key to delete |
| `shared` | boolean | no | `true` to delete the shared fact; `false` (default) to delete the caller's session-scoped fact |
| `pattern` | boolean | no | Must be `true` to treat `key` as a pattern. Supports `*` globs and SQL `%` wildcards. |
| `scope` | string | no | Pattern-delete scope: `session`, `shared`, or `all`. `all` is Facts Manager only. |

**Returns:** `{ key, shared, deleted: boolean }`.

For pattern deletes, returns `{ keyPattern, scope, deleted }`. Pattern deletes are opt-in so a key like `a/b/*` is literal unless `pattern=true`. Ordinary task agents can only delete facts they own; the Facts Manager can use `scope="all"` for shared and session cleanup.

## Scoping and Lifecycle

### Session-Scoped Facts (default)

- Visible to the owning session via `scope=session`, and to every session in the same spawn tree via `scope=accessible`, `scope=descendants`, or `session_id=<tree-member>`.
- Not visible outside the spawn tree.
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
- Session-scoped by default, use `shared=true` only for cross-spawn-tree or global knowledge.
- Read relevant facts before resuming long-running or multi-agent work.
- Respond to user "remember" / "forget" requests via facts tools immediately.
- During multi-agent work, use `read_facts(session_id=<tree-member>)` or `scope=descendants` to pull facts from peers and descendants in the same spawn tree.

## Enhanced Facts & Knowledge Graph (optional)

The base facts table above is always present. Two **optional, independently
injected** providers extend it. They are wired through config only — code that
uses `store_fact` / `read_facts` / `delete_fact` is unchanged whether or not they
are present. See [Configuration](./configuration.md#enhanced-facts--knowledge-graph-optional)
for the worker/client knobs, and [Deploying a Knowledge Harvester](./harvester-deployment.md)
to run ingestion as a dedicated service over a shared HorizonDB.

### Two orthogonal axes

| Axis | Provider | Lights up |
|------|----------|-----------|
| **Facts capability** | `EnhancedFactStore` (HorizonDB: pgvector + pg_textsearch + pg_durable) | `facts_search`, `facts_similar`, `search_skills` |
| **Graph presence** | `GraphStore` (Apache AGE) | `graph_search_nodes`, `graph_search_edges`, `graph_neighbourhood`, + graph writes and crawler crawl/reconcile surface |

They are **independent**: an enhanced fact store with no graph gets search tools
but no graph tools; a base fact store with a graph gets the full graph surface
but no search tools. Graph tools key off **graph presence alone**
(`graphDatabaseUrl` set / `!!graphStore`) — never the facts capability. The
runtime asks `isEnhancedFactStore(store)` once at boot and threads the answer
through; it never sniffs per turn.

```typescript
// Capability descriptor the runtime reads to gate enhanced tools.
interface FactsCapabilities { search: boolean; embedder: boolean; }
```

`facts_search` / `facts_similar` / `search_skills` register only when the store
is an `EnhancedFactStore` **and** `capabilities.search` is true. The embedder
only affects semantic ranking and prompt wording — with `embedder: false`,
search still registers and runs in lexical/hybrid mode.

When a batch embed fails, the durable embedder marks those rows with its internal
retry marker and retries them one by one before selecting fresh batch work. When
a single row still cannot be embedded, it records a numeric internal
`last_embed_error` on that fact and continues with later rows. A subsequent
content change clears the error, putting the row back into normal batched
embedding. Store users do not need to read this field; it is embedder state.
Known internal codes are:

| Code | Meaning |
|------|---------|
| `1001` | Input too large for the embedding model. |
| `1400` | Provider rejected the row/request as bad input. |
| `1401` | Provider authentication failed. |
| `1403` | Provider authorization failed. |
| `1429` | Provider rate limited the row request. |
| `1500` | Provider/server returned a 5xx response. |
| `1901` | Provider returned a malformed embedding payload. |
| `9999` | Unknown terminal embedding failure. |

### Enhanced retrieval replaces the capped skills push

On a base store, the framework injects a capped slice of curated skills into the
system prompt every turn. On an enhanced store that push is **dropped**; instead
the agent gets a dedicated `search_skills` tool and is instructed to call it at
the start of every turn with a task-derived query. Same per-turn DB cost, but it
returns *ranked relevant* skills instead of an arbitrary slice, and the agent can
also retrieve its own past `intake/*` observations via `facts_search`.

### The knowledge graph

The graph stores **ids + structure only** — never fact values or ACLs. Nodes
(`kind`, `name`, `aliases`) and edges (free-text `predicate`, `confidence`,
`observations`) carry optional **evidence**: fact `scopeKey` pointers that anchor
a node/edge to the facts that justify it. Resolving evidence back to fact values
is a tool-layer composition across the two separate providers:

```
graph_search_nodes(...) -> node.evidence (scopeKeys) -> read_facts({ scopeKeys })
```

- **Seeds pivot.** A query seeded with a fact `scopeKey` pivots into the graph via
  the `EVIDENCED_BY` anchor; a node-key seed expands directly.
- **Reinforcement.** Re-asserting the same `(fromKey, predicate, toKey)` does not
  duplicate — it bumps `observations` and combines confidence (noisy-OR) only
  when **new** evidence is supplied; same-evidence replays are harmless no-ops.

### The crawl queue (crawler work queue)

Every base fact carries a `scopeKey` and a `last_crawled_at` stamp. Facts with
`last_crawled_at IS NULL` (new or edited since the last crawl) are the
**crawler work queue**:

- `facts_read_uncrawled({ keyPrefix?, namespace?, limit? })` — returns queued facts,
  each with its `scopeKey` + `etag` receipt (and `deletedAt` when the fact is a
  tombstone). `keyPrefix` is a literal key prefix; `namespace` remains a deprecated
  alias for the same read filter.
- `facts_set_crawled({ scopeKeys: [{ scopeKey, etag }], crawled?: true })` — stamps
  processed facts as incorporated so they leave the queue. Include `etag` to make each
  entry conditional; omit it only for an intentional stomp. A skipped entry means the
  fact was already in the target state, changed since your read (etag mismatch), or no
  longer exists.
- `facts_set_crawled({ keyPrefix, crawled })` — flips a whole literal prefix. Use
  `crawled:false` to requeue a prefix for recrawl; `crawled:true` is a coarse flush and
  skips tombstones, which should be reconciled with `graph_remove_evidence` and marked
  by `scopeKeys`.

### The crawler role

Active graph harvesting is **app-specific** (deciding *what* to crawl and *how* to
extract entities/edges is domain knowledge PilotSwarm cannot supply generically),
but the **tools** are shipped by PilotSwarm:

- An **app crawler agent** (an agent the operator marks with `crawler: true`; legacy
  `harvester: true` remains an alias) is the active crawler — it is granted the crawl queue,
  graph evidence reconciliation, namespace archive, broad corpus fact access, and app-specific
  extraction guidance.
- The **`facts-manager`** holds the same crawler tools but is **dormant** — not
  prompted to crawl, so nothing is harvested out of the box. It additionally gets
  read-only `graph_stats` to *report* on graph size / last-crawled time.
- A crawler should **resolve before it creates**: `graph_search_nodes` by
  `nameLike` first, then `graph_upsert_node` with the source fact's `scopeKey` as
  evidence — this is what makes reinforcement dedup work.
- Graph tools accept the same `namespace` concept as the crawl/search tools.
  `namespace: "corpus/acme"` matches graph nodes/edges stamped exactly with
  `corpus/acme` and descendants such as `corpus/acme/services`. Use the same
  namespace string for `facts_read_uncrawled({ keyPrefix })`, `facts_search`,
  `graph_search_*`, `graph_upsert_*`, `graph_neighbourhood`, `graph_stats`,
  merge, and delete operations so a crawler can discover or maintain one
  corpus/domain without enumerating seed nodes first.

### Access control (evidence is ACL-filtered, topology is shared)

Graph **topology** (which nodes/edges exist, how they connect) is shared across
all readers. Graph **evidence arrays** are ACL-filtered per caller exactly like
facts: a reader sees only the evidence `scopeKey`s it could read via `read_facts`
(its own session, its spawn-tree lineage, and shared facts). An inaccessible fact
seed is treated as unknown — indistinguishable from a non-existent seed, so it is
not an existence oracle.

Graph reads use the **same lineage resolver as `read_facts`**: the runtime threads
the caller's `AccessContext` (`readerSessionId` + granted lineage `sessionIds`,
self-excluded and deduped) into every graph read. A reader with no lineage sees
its own session only — never an unrestricted/wildcard scope.

### agent-tuner is strictly read-only

The `agent-tuner` investigator gets **every read tool** — base `read_facts`,
`facts_search` / `facts_similar`, `search_skills`, the graph reads, and
`graph_stats` — with graph reads resolving **unrestricted** (it is the privileged
investigator). It is **never** granted a write, delete, crawl, or mutating control
tool, even if a stale config sets the crawler/legacy harvester flag. The sweeper is unchanged: it
sweeps facts via the existing cascading session delete and never touches graph
nodes.

### Testing

- Provider-level conformance + ACL/crawl/graph semantics: `packages/horizon-store/test/integration/*` (gated on `HORIZON_DATABASE_URL`).
- SDK capability×role tool gating + prompt adaptation (DB-less): [`packages/sdk/test/local/enhanced-tool-gating.test.js`](../packages/sdk/test/local/enhanced-tool-gating.test.js) and [`graph-tools-gating.test.js`](../packages/sdk/test/local/graph-tools-gating.test.js).
- SDK real-provider composition (base PgFactStore + real graph, crawl→harvest→resolve round-trip, gated on `HORIZON_DATABASE_URL`): [`packages/sdk/test/local/enhanced-composition.integration.test.js`](../packages/sdk/test/local/enhanced-composition.integration.test.js).

## Constraints

- **PostgreSQL only.** The `createFactStoreForUrl()` factory rejects non-Postgres URLs. SQLite is not supported for facts.
- **No SQLite fallback.** Unlike the CMS and duroxide stores which support SQLite for local development, facts are Postgres-exclusive.
- **No hard row cap.** `readFacts` defaults to 50 rows per query. Callers can raise the `limit` parameter as needed.
- **No cross-spawn-tree access for private facts.** A session cannot read the session-scoped facts of any session outside its own spawn tree. Within a spawn tree (everything under a common root: ancestors, descendants, siblings, cousins), session-scoped facts are visible via `scope=accessible`, `scope=descendants`, or `session_id=<other-tree-member>`. Spawn-tree membership is verified via the CMS `parent_session_id` chain.

## Public API Exports

From `src/index.ts`:

```typescript
export { PgFactStore, createFactStoreForUrl } from "./facts-store.js";
export type { FactStore, FactRecord, StoreFactInput, ReadFactsQuery, DeleteFactInput } from "./facts-store.js";
export { createFactTools } from "./facts-tools.js";

// Enhanced facts + knowledge graph (optional providers)
export { isEnhancedFactStore, resolveFactsTarget, createGraphStoreForUrl } from "./facts-store.js";
export type { EnhancedFactStore, FactsCapabilities, AccessContext } from "./facts-store.js";
export type { GraphStore } from "./graph-store.js";
export { createGraphTools } from "./graph-tools.js";
```

These are available to applications that need direct fact store access outside of
the tool layer. The concrete enhanced/graph providers ship separately in
`pilotswarm-horizon-store` and are loaded by the worker only when configured.
