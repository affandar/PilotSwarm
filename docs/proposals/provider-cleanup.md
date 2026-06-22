# Provider Cleanup Proposal

## Goal

Make storage/provider configuration understandable and extensible without building a large plugin framework.

PilotSwarm currently has five provider-shaped slots:

1. Core CMS provider
2. Duroxide provider
3. Base FactStore provider
4. EnhancedFactStore provider
5. GraphStore provider

Slots 1-3 are runtime-critical and are all PostgreSQL-compatible schemas today. Slots 4-5 are optional knowledge surfaces that can be implemented by different providers. HorizonDB should be treated as one provider profile that can fill all five slots, not as special-case code scattered through the SDK and test runner.

## Current State

The SDK already has higher-level interfaces:

- `SessionCatalogProvider` for CMS
- Duroxide runtime configuration for orchestration state
- `FactStore` / `EnhancedFactStore`
- `GraphStore`

The main gap is construction and configuration. Production code still directly constructs `PgSessionCatalogProvider`, `PgFactStore`, and the hard-coded HorizonDB enhanced/graph constructors from `@pilotswarm/horizon-store`. The test runner also knows about `HORIZON_*` directly.

## Proposed Shape

Use three small provider contracts, not one universal plugin abstraction.

### RuntimeStorageProvider

Owns the runtime-critical PostgreSQL-compatible layer:

- CMS catalog
- Duroxide store config
- Base FactStore

```ts
interface RuntimeStorageProvider {
  id: string;
  kind: "postgres-compatible";
  capabilities: {
    cms: true;
    duroxide: true;
    baseFacts: true;
  };
  createCmsCatalog(args: RuntimeStoreArgs): Promise<SessionCatalogProvider>;
  createDuroxideStoreConfig(args: RuntimeStoreArgs): DuroxideStoreConfig;
  createBaseFactStore(args: RuntimeStoreArgs): Promise<FactStore>;
}
```

The built-in `postgres` provider uses existing implementations:

- `PgSessionCatalogProvider`
- Duroxide PostgreSQL store configuration
- `PgFactStore`

The `horizondb` runtime provider can initially delegate to the same PostgreSQL-compatible implementations, with provider-specific URL/TLS normalization only where needed.

### EnhancedFactProvider

Owns optional search/similarity/embedder/crawl-queue capabilities:

```ts
interface EnhancedFactProvider {
  id: string;
  capabilities: {
    search: boolean;
    similar: boolean;
    embedder: boolean;
    crawlQueue: boolean;
  };
  createEnhancedFactStore(args: EnhancedFactStoreArgs): Promise<EnhancedFactStore>;
}
```

The shipped HorizonDB implementation wraps `HorizonDBFactStore`.

### GraphProvider

Owns optional graph capabilities:

```ts
interface GraphProvider {
  id: string;
  capabilities: {
    graph: true;
    namespaces: boolean;
  };
  createGraphStore(args: GraphStoreArgs): Promise<GraphStore>;
}
```

The shipped HorizonDB implementation wraps `HorizonDBGraphStore`.

## Provider Profiles

A provider profile composes the slots.

### `pg-stock`

```text
runtime.provider = postgres
runtime.url      = DATABASE_URL
enhancedFacts    = absent
graph            = absent
```

Result:

- CMS: `PgSessionCatalogProvider`
- Duroxide: PostgreSQL store
- Base facts: `PgFactStore`
- Enhanced facts: none
- Graph: none

### `horizondb-full`

```text
runtime.provider       = horizondb
runtime.url            = HORIZONDB_CORE_DATABASE_URL ?? HORIZONDB_DATABASE_URL
enhancedFacts.provider = horizondb
enhancedFacts.url      = HORIZONDB_FACTS_DATABASE_URL ?? HORIZONDB_DATABASE_URL
graph.provider         = horizondb
graph.url              = HORIZONDB_GRAPH_DATABASE_URL ?? HORIZONDB_DATABASE_URL
```

Result:

- CMS: `PgSessionCatalogProvider` on HorizonDB
- Duroxide: PostgreSQL-compatible store on HorizonDB
- Base facts: `PgFactStore` on HorizonDB
- Enhanced facts: `HorizonDBFactStore`
- Graph: `HorizonDBGraphStore`

This is the important conceptual cleanup: HorizonDB is just a profile that fills runtime, enhanced facts, and graph slots.

## Configuration

Keep stock PG simple:

```bash
DATABASE_URL=postgresql://...
```

Use provider overlays for non-default profiles:

```bash
PILOTSWARM_PROVIDER_PROFILE=horizondb-full

HORIZONDB_DATABASE_URL=postgresql://...

# Optional split URLs when TLS/auth differs by consumer.
HORIZONDB_CORE_DATABASE_URL=
HORIZONDB_FACTS_DATABASE_URL=
HORIZONDB_GRAPH_DATABASE_URL=

HORIZONDB_CMS_SCHEMA=copilot_sessions
HORIZONDB_DUROXIDE_SCHEMA=duroxide
HORIZONDB_FACTS_SCHEMA=pilotswarm_facts
HORIZONDB_ENHANCED_FACTS_SCHEMA=horizon_facts
HORIZONDB_GRAPH_SCHEMA=horizon_graph

HORIZONDB_EMBED_URL=
HORIZONDB_EMBED_MODEL=
HORIZONDB_EMBED_DIM=
HORIZONDB_EMBED_API_KEY=
```

Keep existing names as aliases during migration:

- `HORIZON_DATABASE_URL` -> `HORIZONDB_FACTS_DATABASE_URL`
- `HORIZON_FACTS_SCHEMA` -> `HORIZONDB_ENHANCED_FACTS_SCHEMA`
- `HORIZON_GRAPH_DATABASE_URL` -> `HORIZONDB_GRAPH_DATABASE_URL`
- `HORIZON_GRAPH_SCHEMA` -> `HORIZONDB_GRAPH_SCHEMA`
- `HORIZON_EMBED_*` -> `HORIZONDB_EMBED_*`

## Test Runner Layout

Separate build phases from test phases.

```text
Build
  SDK TypeScript
  mcp-server TypeScript

Tests
  deploy-scripts
  mcp-server unit
  SDK profile: pg-stock
  SDK profile: horizondb-full
  provider integration: horizondb
```

Suggested commands:

```bash
./scripts/run-tests.sh
./scripts/run-tests.sh --profile=pg-stock
./scripts/run-tests.sh --profile=horizondb-full
./scripts/run-tests.sh --all-profiles
```

Default behavior stays fast and local: `pg-stock` only.

`horizondb-full` runs the full SDK suite with CMS, duroxide, base facts, enhanced facts, and graph all configured for HorizonDB. It also runs the HorizonDB provider integration suite.

## Implementation Steps

1. Add provider contract types for runtime storage, enhanced facts, and graph.
2. Wrap existing PostgreSQL runtime construction in `postgresRuntimeStorageProvider`.
3. Wrap HorizonDB construction in:
   - `horizondbRuntimeStorageProvider`
   - `horizondbEnhancedFactProvider`
   - `horizondbGraphProvider`
4. Add a small static registry for each provider type.
5. Add `resolveStorageProfile(config, env)` and thread it through worker, client, and management-client construction.
6. Update `run-tests.sh` to use provider profiles and to label build vs test phases separately.
7. Keep all existing `HORIZON_*` and `enhancedFactsDatabaseUrl` names as aliases until docs/deploy templates are updated.

## Non-Goals

- No npm auto-discovery.
- No large plugin host.
- No new abstraction over `FactStore`, `EnhancedFactStore`, or `GraphStore`.
- No non-Postgres CMS/duroxide provider until the runtime actually supports one.

## Open Questions

1. Does duroxide's Rust/sqlx PostgreSQL path accept the same HorizonDB URL/TLS shape as node-postgres? If not, `HORIZONDB_CORE_DATABASE_URL` may need a different URL spelling than facts/graph.
2. Should `horizondb-full` use one physical database with separate schemas by default, or separate databases for runtime, facts, and graph?
3. Should provider integration tests run before or after the full SDK profile suite? Running after keeps profile failures closest to the user-facing surface.