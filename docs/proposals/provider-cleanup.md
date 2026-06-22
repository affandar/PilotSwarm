# Provider Cleanup Proposal

## Goal

Make storage/provider configuration understandable, testable, and extensible without building a plugin framework.

PilotSwarm currently has several storage-shaped concerns:

1. CMS session catalog
2. Duroxide orchestration store
3. FactStore
4. EnhancedFactStore APIs
5. GraphStore

The simplified model groups these into two provider axes:

1. **RuntimeStorageProvider** - owns PilotSwarm runtime storage: session catalog, the one active facts store, optional enhanced facts surface, and optional graph store.
2. **DuroxideStorageProvider** - owns duroxide's orchestration/event/timer store.

Duroxide stays separate because it is a different runtime engine with its own native provider construction, auth behavior, and replay/history constraints. The session catalog folds into runtime storage because it is PilotSwarm's runtime state, not a separate provider axis.

There is no first-class **profile** concept. `.env` or explicit options are shredded into a resolved `StorageConfig`, then the selected providers are called with that resolved config. Named profiles can exist later as a convenience preset, but they should expand before provider resolution and should not become a runtime abstraction.

## Naming Rules

Use these words consistently:

- **Store**: a live object used by runtime code, such as `FactStore`, `EnhancedFactStore`, or `GraphStore`.
- **Provider**: an object that creates live stores for one provider axis.
- **StorageConfig**: the resolved config produced from `.env` and explicit options.
- **RuntimeStorageConfig**: the `StorageConfig.runtime` section passed to `RuntimeStorageProvider`.
- **DuroxideStorageConfig**: the `StorageConfig.duroxide` section passed to `DuroxideStorageProvider`.

Avoid extra `Factory` names. A provider is already the factory for its storage axis. Keep method names precise: if a method creates a `SessionCatalog`, call it `createSessionCatalog()`.

`SessionCatalogProvider` should be renamed to `SessionCatalog` as part of this cleanup. The object is the live CMS/session-catalog store; it is not itself a provider under the new naming convention. The PostgreSQL implementation should similarly become `PgSessionCatalog` rather than `PgSessionCatalogProvider`.

## Visual Model

```text
.env / explicit options
        |
        v
+------------------------+
| resolveStorageConfig() |
+------------------------+
        |
        v
StorageConfig
        |
        +-----------------------------+
        |                             |
        v                             v
storage.runtime                  storage.duroxide
RuntimeStorageConfig             DuroxideStorageConfig
        |                             |
        v                             v
RuntimeStorageProvider           DuroxideStorageProvider
        |                             |
        |                             +-----------------------------+
        |                                                           |
        v                                                           v
+----------------------+                              Duroxide provider/client
| createSessionCatalog |                              orchestration history,
+----------------------+                              timers, events, leases
        |
        v
SessionCatalog
CMS sessions/events/state


RuntimeStorageProvider
        |
        v
+-----------------+
| createFactStore |
+-----------------+
        |
        v
FactStore  <--------------------------------+
base facts, crawl queue, cleanup, stats     |
        |                                   |
        | same object, narrowed only        |
        v                                   |
+-----------------------+                   |
| getEnhancedFactStore()|-------------------+
+-----------------------+
        |
        v
EnhancedFactStore
search, similar facts, embedder lifecycle


RuntimeStorageProvider
        |
        v
+------------------+
| createGraphStore |
+------------------+
        |
        v
GraphStore
nodes, edges, graph search, evidence reconciliation
```

Key lifecycle rule:

```text
createFactStore() allocates.
getEnhancedFactStore() narrows the same object.
createGraphStore() allocates separately because GraphStore is not a FactStore subtype.
```

## Provider Contracts

### Provider `id`

Every provider has an `id`. It is the stable registry key selected by config:

```text
postgres
horizondb
mem0
cosmosdb
```

Canonical provider ids for this proposal:

| Axis | Provider id | Meaning |
| --- | --- | --- |
| runtime | `postgres` | Stock PostgreSQL runtime storage: `PgSessionCatalog`, `PgFactStore`, no graph. |
| runtime | `horizondb` | Azure HorizonDB-backed runtime storage through `@pilotswarm/horizon-store`. Use the full `horizondb` id; `horizon` is misleading and should not be accepted as canonical. |
| runtime | `mem0` | Hypothetical managed-memory provider backed by Mem0 APIs, likely composing CMS/duroxide through PostgreSQL. |
| runtime | `cosmosdb` | Hypothetical Azure Cosmos DB runtime provider, using NoSQL/vector surfaces and optionally Gremlin graph. |
| duroxide | `postgres` | Duroxide PostgreSQL storage provider. |

Do not use capability-shaped ids such as `vector`, `graph`, `enhanced`, or `hdb-full`. Provider ids name the adapter/product family, not a selected feature set.

Rules for `id`:

- lower-case, stable, and package-owned
- not a URL, display name, tenant name, or version
- used for registry lookup, validation, logs, diagnostics, and test selection
- safe to show in errors and docs

Capabilities still describe optional surfaces (`enhancedFactStore`, `graphStore`, `embeddingSupport`). Live object presence still decides which tools light up.

### RuntimeStorageProvider

Runtime storage owns PilotSwarm's runtime-facing stores:

- CMS session catalog
- one active facts store
- optional enhanced facts interface on that same facts store
- optional graph store

```ts
interface RuntimeStorageProvider {
  id: string;

  capabilities: {
    enhancedFactStore?: true;
    graphStore?: true;
    embeddingSupport?: true;
  };

  createSessionCatalog(args: RuntimeStorageConfig): Promise<SessionCatalog>;

  /**
   * Canonical facts constructor.
   *
   * Returns the one active facts store for this runtime. The returned object may
   * be a plain FactStore or an EnhancedFactStore, but callers always receive it
   * first as the base FactStore.
   */
  createFactStore(args: RuntimeStorageConfig): Promise<FactStore>;

  /**
   * Optional narrowing hook.
   *
   * Must not allocate a second store. It returns the same object, typed as
   * EnhancedFactStore, when this provider's fact store supports the enhanced
   * facts APIs.
   */
  getEnhancedFactStore?(store: FactStore): EnhancedFactStore | undefined;

  /**
   * Optional graph constructor.
   *
   * Graph is separate because GraphStore is not a subtype of FactStore.
   */
  createGraphStore?(args: RuntimeStorageConfig): Promise<GraphStore | undefined>;
}
```

The base `FactStore` schema owns the crawl queue. Crawl receipt columns/procs such as `last_crawled_at`, `readUncrawledFacts()`, and `markFactsCrawled()` are not enhanced-facts features. Enhanced stores inherit or implement them because they are also fact stores. A graph harvester may consume the crawl queue even when the active facts store is plain PostgreSQL.

Provider capabilities are for validation and useful startup errors. Runtime behavior should be driven by the live objects:

- base fact tools use the `FactStore`
- enhanced search/embedder tools light up when `getEnhancedFactStore()` returns an object, or when `isEnhancedFactStore(factStore)` succeeds
- graph tools light up when `createGraphStore()` returns a `GraphStore`

### DuroxideStorageProvider

Duroxide storage owns only duroxide's orchestration store provider.

```ts
interface DuroxideStorageProvider {
  id: string;

  createDuroxideProvider(args: DuroxideStorageConfig): Promise<unknown>;
}
```

The built-in duroxide provider is `postgres`, wrapping the existing duroxide PostgreSQL provider construction.

The object returned by `createDuroxideProvider()` is the concrete provider object consumed by duroxide itself. Startup wires it into both sides of the duroxide API surface:

```ts
const duroxideProviderInstance = await duroxideProvider.createDuroxideProvider(storage.duroxide);

const duroxideClient = new Client(duroxideProviderInstance);
const runtime = new Runtime(duroxideProviderInstance, runtimeOptions);
```

The client uses it for orchestration control-plane operations such as start, enqueue, status, and history reads. The runtime uses the same provider type for orchestration workers, activity dispatch, timers, leases, and history writes. The provider-cleanup layer should not wrap or reinterpret duroxide history; it only centralizes provider creation and schema/url/auth selection before handing the provider to duroxide.

## Storage Config Shape

`StorageConfig` is the resolved, process-local shape. Providers receive this shape; they do not read `process.env`.

```ts
interface StorageConfig {
  runtime: RuntimeStorageConfig;
  duroxide: DuroxideStorageConfig;
}

interface RuntimeStorageConfig {
  provider: string;

  /** Default URL for runtime stores unless a more specific URL is set. */
  url: string;

  /** Optional override for SessionCatalog. Defaults to url. */
  sessionCatalogUrl?: string;

  /** Optional override for FactStore. Defaults to url. */
  factStoreUrl?: string;

  cmsSchema?: string;
  factsSchema?: string;

  embedding?: EmbeddingEndpointConfig;

  graph?: {
    enabled: boolean;
    url?: string;
    schema?: string;
    registrySchema?: string;
    namespaceCacheTtlMs?: number;
  };

  /** Provider-specific options that do not belong in the common shape. */
  providerOptions?: Record<string, unknown>;

  useManagedIdentity?: boolean;
  aadDbUser?: string;
}

interface DuroxideStorageConfig {
  provider: string;
  url: string;
  schema?: string;
  useManagedIdentity?: boolean;
  aadDbUser?: string;
  providerOptions?: Record<string, unknown>;
}
```

Resolution:

```ts
const storage = resolveStorageConfig({ env: process.env, options });

const runtimeProvider = getRuntimeStorageProvider(storage.runtime.provider);
const duroxideProvider = getDuroxideStorageProvider(storage.duroxide.provider);

const sessionCatalog = await runtimeProvider.createSessionCatalog(storage.runtime);
await sessionCatalog.initialize();

const factStore = await runtimeProvider.createFactStore(storage.runtime);
await factStore.initialize();

const enhancedFactStore =
  runtimeProvider.getEnhancedFactStore?.(factStore)
  ?? (isEnhancedFactStore(factStore) ? factStore : undefined);

const graphStore = storage.runtime.graph?.enabled
  ? await runtimeProvider.createGraphStore?.(storage.runtime)
  : undefined;
await graphStore?.initialize();

const duroxideProviderInstance = await duroxideProvider.createDuroxideProvider(storage.duroxide);
```

The same `StorageConfig` must be threaded through worker, client, management client, and activity-created internal clients. No call site should independently infer facts/CMS/graph locations after resolution.

## Configuration

### Default PostgreSQL

Stock local and deploy flows stay boring. If no provider env vars are set, the default is PostgreSQL for both runtime storage and duroxide storage.

```bash
DATABASE_URL=postgresql://...

# Optional; default values shown.
PILOTSWARM_RUNTIME_PROVIDER=postgres
PILOTSWARM_RUNTIME_URL=$DATABASE_URL
PILOTSWARM_CMS_SCHEMA=copilot_sessions
PILOTSWARM_FACTS_SCHEMA=pilotswarm_facts

PILOTSWARM_DUROXIDE_PROVIDER=postgres
PILOTSWARM_DUROXIDE_URL=$PILOTSWARM_RUNTIME_URL
PILOTSWARM_DUROXIDE_SCHEMA=ps_duroxide
```

Resolved result:

```text
runtime.provider = postgres
runtime.url      = DATABASE_URL
duroxide.provider = postgres
duroxide.url      = DATABASE_URL
duroxide.schema   = ps_duroxide
```

### HorizonDB Runtime Storage

HorizonDB is selected by choosing the runtime provider directly. There is no named profile.

```bash
DATABASE_URL=postgresql://... # optional fallback for local mixed setups

PILOTSWARM_RUNTIME_PROVIDER=horizondb
PILOTSWARM_RUNTIME_URL=postgresql://...

# Optional split URLs when auth/TLS/database placement differs by surface.
PILOTSWARM_SESSION_CATALOG_URL=
PILOTSWARM_FACTSTORE_URL=

PILOTSWARM_CMS_SCHEMA=copilot_sessions
PILOTSWARM_FACTS_SCHEMA=horizon_facts

PILOTSWARM_GRAPH_ENABLED=1
PILOTSWARM_GRAPH_URL=
PILOTSWARM_GRAPH_SCHEMA=horizon_graph
PILOTSWARM_GRAPH_REGISTRY_SCHEMA=horizon_graph_registry

PILOTSWARM_EMBED_URL=
PILOTSWARM_EMBED_MODEL=
PILOTSWARM_EMBED_DIM=
PILOTSWARM_EMBED_API_KEY=
PILOTSWARM_EMBED_API_KEY_HEADER=
PILOTSWARM_EMBED_BEARER=

PILOTSWARM_DUROXIDE_PROVIDER=postgres
PILOTSWARM_DUROXIDE_URL=$PILOTSWARM_RUNTIME_URL
PILOTSWARM_DUROXIDE_SCHEMA=ps_duroxide
```

Resolved result:

```text
runtime.provider       = horizondb
runtime.url            = PILOTSWARM_RUNTIME_URL
runtime.sessionCatalogUrl = PILOTSWARM_SESSION_CATALOG_URL ?? runtime.url
runtime.factStoreUrl      = PILOTSWARM_FACTSTORE_URL ?? runtime.url
runtime.graph.url         = PILOTSWARM_GRAPH_URL ?? runtime.url

duroxide.provider = postgres
duroxide.url      = PILOTSWARM_DUROXIDE_URL ?? runtime.url
duroxide.schema   = ps_duroxide
```

For the current HorizonDB implementation:

- `createSessionCatalog()` returns `PgSessionCatalog` pointed at `sessionCatalogUrl ?? url`.
- `createFactStore()` returns `HorizonDBFactStore` pointed at `factStoreUrl ?? url`.
- `getEnhancedFactStore()` returns that same `HorizonDBFactStore` object.
- `createGraphStore()` returns `HorizonDBGraphStore` when `graph.enabled` is true.
- `DuroxideStorageProvider` remains `postgres` unless duroxide itself gains a HorizonDB-specific path.

### Duroxide Schema Default And Migration

New deployments should default duroxide's schema to `ps_duroxide`, not `duroxide`. HorizonDB can contain a `duroxide` schema owned by `pg_durable`; using `ps_duroxide` avoids a confusing and potentially hazardous name collision.

There are two important cases:

1. **Fresh install / pg_durable already owns `duroxide`.** This is not a PilotSwarm schema migration. Leave the pg_durable-owned `duroxide` schema alone and create PilotSwarm's orchestration schema as `ps_duroxide` from the beginning.
2. **Legacy PilotSwarm install created `duroxide` before pg_durable existed.** In this case pg_durable installation would fail while PilotSwarm owns a conflicting `duroxide` schema. Rename PilotSwarm's schema to `ps_duroxide`; because pg_durable is not installed yet in this case, there should be no pg_durable interference during the rename.

Existing PilotSwarm deployments need an explicit migration plan. They must not silently split orchestration history across both schemas.

Startup safety rule: when the configured/default target is `ps_duroxide`, the PostgreSQL duroxide provider preflights the database before connecting. If it finds a legacy PilotSwarm-owned `duroxide` schema with known duroxide history tables and no `ps_duroxide` schema, startup refuses with an actionable error instead of letting duroxide auto-create an empty `ps_duroxide` schema. If `duroxide` is owned by the `pg_durable` extension, the preflight treats it as extension-owned and leaves it alone.

Possible rollout shape:

1. Ship code that understands `PILOTSWARM_DUROXIDE_SCHEMA` and can point at either `duroxide` or `ps_duroxide`.
2. For existing deployments, keep `PILOTSWARM_DUROXIDE_SCHEMA=duroxide` until a migration window.
3. During migration, stop or drain workers, acquire a DB-level migration lock, and run `ALTER SCHEMA duroxide RENAME TO ps_duroxide` inside a transaction. The SDK exposes this as `migrateLegacyDuroxideSchema(pool, options)` for directed operational scripts/tests; worker startup must not auto-rename schemas. The repo wrapper is `scripts/migrate-duroxide-schema.mjs` after building the SDK.
4. In the same migration window, install a guard so old PilotSwarm workers cannot recreate a new `duroxide` schema. Preferred shape: an event trigger that rejects `CREATE SCHEMA duroxide` from the PilotSwarm runtime role. The guard is role-scoped so pg_durable/admin roles can still create or use their own `duroxide` schema. If event triggers are unavailable in the target database, the rename remains committed and the guard install reports a `guardError`; operators should then use role/privilege controls that make the old schema creation path fail loudly.
5. Roll all workers with new code/config pointing at `ps_duroxide`.
6. Install or enable pg_durable after the PilotSwarm-owned `duroxide` schema has moved, if that was the blocker.
7. Remove the old-worker guard only after verifying no old workers or tools are still targeting `duroxide`. If pg_durable needs to create/use its own `duroxide` schema, the guard must either allow the extension/admin role or be removed after old workers are gone.

Fresh databases should never create the old `duroxide` schema unless explicitly requested for backwards compatibility.

### Legacy Env Aliases

The resolver should keep old env names as aliases during migration:

```text
HORIZON_DATABASE_URL        -> PILOTSWARM_FACTSTORE_URL only
HORIZON_FACTS_SCHEMA        -> PILOTSWARM_FACTS_SCHEMA
HORIZON_GRAPH_DATABASE_URL  -> PILOTSWARM_GRAPH_URL and enables graph
HORIZON_GRAPH_SCHEMA        -> PILOTSWARM_GRAPH_SCHEMA
HORIZON_GRAPH_REGISTRY_SCHEMA -> PILOTSWARM_GRAPH_REGISTRY_SCHEMA
HORIZON_NAMESPACE_CACHE_TTL_MS -> PILOTSWARM_GRAPH_NAMESPACE_CACHE_TTL_MS
HORIZON_EMBED_*             -> PILOTSWARM_EMBED_*
enhancedFactsDatabaseUrl    -> runtime.factStoreUrl with runtime.provider=horizondb
factsProvider="horizon"     -> runtime.provider=horizondb
graphDatabaseUrl            -> runtime.graph.url and enables graph
```

Precedence should be explicit:

```text
direct options > PILOTSWARM_* env > legacy HORIZON_* env > DATABASE_URL defaults
```

`horizonConfigFromEnv()` can remain temporarily as a compatibility wrapper over `resolveStorageConfig()` or over a helper that returns the runtime subset.

Legacy `HORIZON_DATABASE_URL` is facts-only compatibility. It must not relocate CMS or duroxide off `DATABASE_URL`; operators who want all runtime surfaces on HorizonDB must opt in with `PILOTSWARM_RUNTIME_URL` and, if desired, `PILOTSWARM_DUROXIDE_URL`.

## Provider Examples

### `postgres` RuntimeStorageProvider

```text
id: postgres
capabilities: {}

createSessionCatalog() -> PgSessionCatalog
createFactStore()      -> PgFactStore
getEnhancedFactStore() -> undefined
createGraphStore()     -> undefined / absent
```

This is the default local and CI runtime provider.

### `horizondb` RuntimeStorageProvider

```text
id: horizondb
capabilities:
  enhancedFactStore: true
  graphStore: true
  embeddingSupport: true

createSessionCatalog() -> PgSessionCatalog pointed at HorizonDB/runtime URL
createFactStore()      -> HorizonDBFactStore, returned as FactStore
getEnhancedFactStore() -> same HorizonDBFactStore object, narrowed
createGraphStore()     -> HorizonDBGraphStore when graph config is enabled
```

This provider can run all PilotSwarm runtime surfaces against one HorizonDB database with separate schemas, or split CMS/facts/graph across URLs when needed.

### Hypothetical `mem0` RuntimeStorageProvider

Mem0 is a managed memory layer for AI agents with hosted memory storage, search, reranking, and governance. It is not a natural CMS or duroxide backend. A minimal PilotSwarm integration should therefore be a composed runtime provider:

```text
id: mem0
capabilities:
  enhancedFactStore: true
  embeddingSupport: true # hosted by Mem0, not PilotSwarm's durable embed loop

createSessionCatalog() -> PgSessionCatalog, using sessionCatalogUrl ?? url
createFactStore()      -> Mem0FactStore, backed by Mem0 memory add/search/update/delete APIs
getEnhancedFactStore() -> Mem0FactStore if it implements the enhanced/search surface
createGraphStore()     -> undefined / absent

duroxide provider      -> postgres
```

The `Mem0FactStore` adapter would map PilotSwarm facts to Mem0 memories:

```text
scopeKey   -> stable memory id or metadata key
sessionId  -> metadata/session namespace
agentId    -> metadata/agent namespace
tags       -> metadata filters
value      -> memory content/payload
etag       -> provider-managed version or adapter-side version
```

This would likely light up enhanced search and similarity APIs, but it should not expose PilotSwarm's durable embedder lifecycle unless Mem0 offers equivalent start/stop/status semantics. If the current `EnhancedFactStore` remains too broad for Mem0, split the enhanced surface into sharper capability interfaces before adding this provider, for example `SearchableFactStore` and `EmbeddableFactStore`.

Example env:

```bash
DATABASE_URL=postgresql://... # CMS + duroxide fallback

PILOTSWARM_RUNTIME_PROVIDER=mem0
PILOTSWARM_RUNTIME_URL=$DATABASE_URL
PILOTSWARM_SESSION_CATALOG_URL=$DATABASE_URL

PILOTSWARM_MEM0_API_URL=https://api.mem0.ai
PILOTSWARM_MEM0_API_KEY=...
PILOTSWARM_MEM0_PROJECT_ID=...

PILOTSWARM_DUROXIDE_PROVIDER=postgres
PILOTSWARM_DUROXIDE_URL=$DATABASE_URL
```

### Hypothetical `cosmosdb` RuntimeStorageProvider

Azure Cosmos DB has two relevant surfaces:

- Cosmos DB for NoSQL supports integrated vector storage/search with vector policies, vector indexes, and `VectorDistance` queries.
- Cosmos DB for Apache Gremlin supports managed property graph storage and traversal.

Cosmos DB for PostgreSQL is on a retirement path and should not be the target for new provider work. Duroxide should remain on the separate `postgres` provider unless duroxide itself gains a first-class Cosmos backend.

A Cosmos runtime provider could look like this:

```text
id: cosmosdb
capabilities:
  enhancedFactStore: true
  graphStore: true
  embeddingSupport: true # if the adapter embeds via configured embedding endpoint

createSessionCatalog() -> CosmosSessionCatalog on a NoSQL container
createFactStore()      -> CosmosFactStore on a NoSQL container
getEnhancedFactStore() -> CosmosFactStore if vector search is configured
createGraphStore()     -> CosmosGremlinGraphStore when graph config is enabled

duroxide provider      -> postgres
```

The facts adapter would store the fact payload and vector in the same document. Similarity search would use Cosmos DB NoSQL vector search with a container vector policy and vector index. Graph storage would be a separate Gremlin surface, because Cosmos NoSQL vector search and Gremlin graph traversal are different APIs.

Example env:

```bash
DATABASE_URL=postgresql://... # duroxide fallback if needed

PILOTSWARM_RUNTIME_PROVIDER=cosmosdb
PILOTSWARM_RUNTIME_URL=https://<account>.documents.azure.com:443/

PILOTSWARM_COSMOS_DATABASE=pilotswarm
PILOTSWARM_COSMOS_SESSION_CONTAINER=sessions
PILOTSWARM_COSMOS_FACTS_CONTAINER=facts
PILOTSWARM_COSMOS_KEY=...

PILOTSWARM_EMBED_URL=https://...
PILOTSWARM_EMBED_MODEL=text-embedding-3-small
PILOTSWARM_EMBED_DIM=1536

PILOTSWARM_GRAPH_ENABLED=1
PILOTSWARM_GRAPH_URL=wss://<account>.gremlin.cosmos.azure.com:443/
PILOTSWARM_COSMOS_GRAPH_DATABASE=pilotswarm
PILOTSWARM_COSMOS_GRAPH=knowledge

PILOTSWARM_DUROXIDE_PROVIDER=postgres
PILOTSWARM_DUROXIDE_URL=$DATABASE_URL
```

This example is useful because it proves why the two-axis model matters: CosmosDB may own the PilotSwarm runtime stores, while duroxide still uses PostgreSQL.

## Registry Shape

Registries are small, static, in-process maps from provider `id` to provider object. They are not plugin discovery, not database tables, and not a runtime service. They let `resolveStorageConfig()` select providers by stable string ids while keeping provider construction explicit and reviewable.

Rules:

- one registry per provider axis
- keys are provider `id` values
- values are provider objects imported by the SDK or host
- unknown ids fail fast during startup
- tests can register fakes through a test-only registry helper or direct resolver injection
- no npm package scanning or implicit provider loading

```ts
const runtimeStorageProviders = {
  postgres: postgresRuntimeStorageProvider,
  horizondb: horizondbRuntimeStorageProvider,
  // hypothetical future providers:
  mem0: mem0RuntimeStorageProvider,
  cosmosdb: cosmosRuntimeStorageProvider,
};

const duroxideStorageProviders = {
  postgres: postgresDuroxideStorageProvider,
};
```

There is no registry for `FactStoreProvider`, `EnhancedFactStoreProvider`, or `GraphStoreProvider`. Those are runtime-provider responsibilities.

## Test Structure

Separate build phases from provider/config tests and SDK behavior tests.

```text
Build
  SDK TypeScript
  mcp-server TypeScript

Always-on unit tests
  storage config resolver
  provider registry lookup
  runtime provider contract with stubs/mocks
  duroxide provider contract with stubs/mocks
  existing DB-less unit suites

Default integration tests
  deploy-scripts
  mcp-server unit
  full SDK local suite on default postgres runtime storage

Provider-specific integration tests
  HorizonDB runtime provider live integration, gated on HorizonDB env
  HorizonDB graph/facts provider package integration
  future Mem0 integration, gated on Mem0 env
  future CosmosDB integration, gated on Cosmos env

SDK storage smoke tests
  one or two end-to-end SDK smokes per non-default runtime provider
```

### Resolver Tests

`storage-config.test.js` should be pure and DB-less. It is the main regression wall against config drift.

Suggested cases:

```text
default env resolves postgres runtime + postgres duroxide from DATABASE_URL
PILOTSWARM_RUNTIME_PROVIDER selects the runtime provider
PILOTSWARM_DUROXIDE_PROVIDER selects the duroxide provider
runtime URL defaults from DATABASE_URL
duroxide URL defaults from runtime URL
sessionCatalogUrl and factStoreUrl override runtime URL independently
graph enabled requires or derives graph URL
embedding requires URL + model + dim
legacy HORIZON_* aliases map correctly
new PILOTSWARM_* vars win over legacy aliases
enhancedFactsDatabaseUrl/factsProvider compatibility maps to horizondb runtime
graphDatabaseUrl compatibility enables graph
graph schema collision is detected when provider needs distinct facts/graph schemas
missing required provider-specific env gives a useful error
providers do not read process.env directly
```

### Runtime Provider Contract Tests

These should assert lifecycle and identity rules without needing a live provider.

```text
createFactStore is the only facts allocator
getEnhancedFactStore never opens a second pool or initializes a second store
getEnhancedFactStore returns the same object when enhanced facts are supported
getEnhancedFactStore returns undefined for plain PgFactStore
createGraphStore is skipped when graph is disabled
createGraphStore returns undefined or a GraphStore when graph is enabled
provider capabilities match returned surfaces for validation/error messages
```

Important identity assertion:

```ts
const factStore = await provider.createFactStore(args);
const enhanced = provider.getEnhancedFactStore?.(factStore);

if (enhanced) {
  expect(enhanced).toBe(factStore);
}
```

### Duroxide Provider Contract Tests

Keep these separate from runtime storage.

```text
postgres duroxide provider uses connectWithSchema for password URLs
postgres duroxide provider uses connectWithSchemaAndEntra for MI mode
schema defaults to ps_duroxide
unsupported URL shapes fail clearly
runtime provider selection does not affect duroxide provider selection
```

### Provider Live Integration Tests

Provider live tests are opt-in and should run after the fast unit/config layer.

```text
horizondb runtime provider initializes catalog + fact store
horizondb createFactStore returns an object accepted as FactStore
horizondb getEnhancedFactStore returns the same object
horizondb enhanced search/similar works
horizondb embedder status/control works when embedding env is present
horizondb graph initializes and round-trips evidence when graph env is present
```

Future provider suites would follow the same shape:

```text
mem0 provider maps facts to memories and searches by metadata
mem0 provider does not expose durable embedder lifecycle unless the adapter implements it
cosmosdb provider initializes NoSQL containers and vector policy expectations
cosmosdb provider runs vector search with TOP N / VectorDistance
cosmosdb graph provider initializes Gremlin graph and round-trips nodes/edges
```

### SDK Storage Smoke Tests

The full SDK suite should not multiply across every provider by default. Use the full suite for the default PostgreSQL runtime. For non-default providers, run small storage smokes that prove the integration is wired end-to-end.

An SDK storage smoke test is not a provider conformance test. Provider conformance lives in provider contract/integration suites. A storage smoke starts the real SDK stack with a resolved `StorageConfig` and verifies that the worker, client, management client, activities, tools, cleanup paths, and optional graph/enhanced surfaces all point at the same resolved stores.

Minimum smoke coverage:

```text
create session
send one turn or use a DB-less management path where possible
store/read a fact
delete/cleanup hits the same facts store
enhanced search tools appear only when getEnhancedFactStore returns an object
graph tools appear only when createGraphStore returns a GraphStore
activity-created internal clients use the same StorageConfig
```

Suggested commands:

```bash
./scripts/run-tests.sh
./scripts/run-tests.sh --runtime-provider=horizondb
./scripts/run-tests.sh --all-runtime-providers
./scripts/run-tests.sh --provider-integration=horizondb
```

Compatibility commands can remain during migration:

```bash
./scripts/run-tests.sh --with-horizondb
./scripts/run-tests.sh --all-providers
```

Default behavior stays fast and local:

```text
./scripts/run-tests.sh
  build once
  run resolver/provider unit tests
  run deploy-scripts and mcp-server tests
  run full SDK suite with postgres runtime storage
  skip live provider integration unless explicitly requested/configured
```

`--all-runtime-providers` should not blindly run the full SDK suite for every provider. It should run:

```text
build once
full SDK suite on postgres runtime storage
provider-specific storage smokes for each configured runtime provider
provider package integration tests when live env exists
combined summary with provider-specific rerun commands
```

## Implementation Steps

1. Add `StorageConfig`, `RuntimeStorageConfig`, and `DuroxideStorageConfig` types.
2. Add `RuntimeStorageProvider` and `DuroxideStorageProvider` contracts.
3. Implement `resolveStorageConfig({ env, options })` with explicit precedence and legacy aliases.
4. Implement `postgresRuntimeStorageProvider`:
  - `createSessionCatalog()` -> `PgSessionCatalog`
   - `createFactStore()` -> `PgFactStore`
   - no enhanced narrowing
   - no graph store
5. Implement `postgresDuroxideStorageProvider` around existing duroxide PostgreSQL construction.
6. Implement `horizondbRuntimeStorageProvider`:
  - `createSessionCatalog()` -> `PgSessionCatalog` pointed at the resolved runtime/catalog URL
   - `createFactStore()` -> `HorizonDBFactStore`
  - `getEnhancedFactStore()` -> same object
   - `createGraphStore()` -> `HorizonDBGraphStore` when enabled
7. Replace worker, client, management-client, and activity internal-client facts/CMS/graph inference with resolved `StorageConfig` threading.
8. Keep compatibility wrappers for `resolveFactsTarget()`, `createFactStoreForUrl()`, `createGraphStoreForUrl()`, and `horizonConfigFromEnv()` until downstream docs/templates are migrated.
9. Update `run-tests.sh` to separate resolver/provider unit tests, default full SDK tests, provider storage smokes, and provider live integration.
10. Update docs, samples, deploy scripts, and builder templates after the compatibility layer is in place.

## Non-Goals

- No npm auto-discovery.
- No large plugin host.
- No first-class profile abstraction.
- No separate provider registries for fact, enhanced-fact, or graph stores.
- No second facts store when enhanced facts are enabled.
- No non-Postgres duroxide provider until duroxide itself supports one.
- No requirement that every runtime provider use one physical backend. A provider may compose backends internally, as long as the resolved provider is the single owner of the runtime storage surface.

## Open Questions

1. Should `EnhancedFactStore` stay as one broad interface, or should it split into narrower capability interfaces such as `SearchableFactStore` and `EmbeddableFactStore` before adding providers like Mem0?
2. Does duroxide's Rust/sqlx PostgreSQL path accept the same HorizonDB URL/TLS shape as node-postgres? If not, `PILOTSWARM_DUROXIDE_URL` may need a different spelling than runtime/facts/graph URLs.
3. Should HorizonDB use one physical database with separate schemas by default, or should docs recommend separate runtime/facts/graph URLs for production isolation?
4. What exact test flag names should replace `--with-horizondb` / `--all-providers` while staying friendly for existing maintainers?
