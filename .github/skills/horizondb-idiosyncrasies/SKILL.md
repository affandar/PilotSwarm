---
name: horizondb-idiosyncrasies
description: Work with Azure HorizonDB (preview) — its AI/embedding features, extension allow-listing, AGE/pgvector/pg_durable quirks, and the connection/TLS gotchas discovered while bringing up the horizon-facts incubator. Use when connecting to a HorizonDB cluster, enabling extensions, writing AGE Cypher, wiring in-DB embeddings via pg_durable df.http(), or debugging "extension not allow-listed" / "access to library not allowed" / "self-signed certificate" / Cypher syntax errors.
---

# HorizonDB Idiosyncrasies

Azure HorizonDB is a managed, preview Postgres-17 service (a.k.a. OrionDB
internally). It bundles AI/graph/vector/durable-execution extensions but locks
them behind an allow-list and several managed-PG restrictions that differ from
vanilla Postgres. This skill captures the verified facts and the workarounds.

> Reference implementation: `incubator/horizon-facts/` — a HorizonDB-only
> enhanced facts interface. Its integration suite (`test/integration/`) runs
> live against a HorizonDB cluster and exercises every capability below.

## Quick reference

| Symptom | Cause | Fix |
| --- | --- | --- |
| `self-signed certificate in certificate chain` | pg v8 treats `sslmode=require` as `verify-full` | append `uselibpqcompat=true` to the connection string |
| `extension "X" is not allow-listed for "azure_pg_admin" users` | empty/insufficient `azure.extensions` on the parameter group | add X to `azure.extensions` on a custom parameter group, attach to cluster |
| `access to library "age" is not allowed` | `age` is in `shared_preload_libraries`; explicit `LOAD 'age'` is forbidden | tolerate that error — the library is already preloaded |
| `syntax error at or near "WHERE"` from `cypher_parser.c` | AGE doesn't support `any(x IN list WHERE pred)` | use `size([x IN list WHERE pred]) > 0` |
| `schema "..." already exists` creating an AGE graph | graph name collides with an existing schema (`create_graph` makes a schema) | give the graph a name distinct from every other schema |
| `relation "<label>" already exists` (`42P07`) **or** `duplicate key … "pg_class_relname_nsp_index"` (`23505`) under concurrent graph writes | AGE creates a label's backing table lazily on first `CREATE`/`MERGE`; concurrent first-references race the DDL (two detection points) | re-run the same idempotent statement — the label now exists (see §3 concurrency) |
| `cannot cast type agtype to jsonb` | `agtype` has no jsonb cast | `RETURN` scalars/`label()`/`type()`, parse client-side |
| `ECONNRESET` / `Connection terminated unexpectedly` mid-workload | HorizonDB resets idle pooled TLS connections | guard + bounded retry on a **fresh** connection (§1.1) |
| AGE writes are 600 ms–2 s each under concurrency | small connection pool → ops queue (connection-queue wait, not query cost) | raise `poolMax` for the parallelism (default now 16, `HORIZON_POOL_MAX`); per-connection AGE setup; fewer round-trips per upsert (§3 performance) |

## 1. Connection & TLS

HorizonDB requires SSL. The cluster's certificate chain is **not** in Node's
default trust store, and modern `pg` (v8+) / `pg-connection-string` treat
`sslmode=require` as `verify-full`, so a plain `?sslmode=require` URL fails with:

```
CONN FAIL: self-signed certificate in certificate chain
```

**Fix:** append `uselibpqcompat=true`, which restores libpq semantics where
`require` means *encrypt but don't verify the CA*:

```
postgresql://USER:PW@<cluster>.<id>.<region>.horizondb.azure.com:5432/postgres?sslmode=require&uselibpqcompat=true
```

For production trust verification, install the Azure CA bundle and use
`sslmode=verify-full` with an explicit `ca`. For dev/test against preview
clusters, `uselibpqcompat=true` is the pragmatic path. The horizon-facts test
harness normalizes this automatically — see `normalizeDbUrl()` in
`incubator/horizon-facts/test/integration/_db.mjs`.

### 1.1 Idle pooled connections get reset — guard + retry on a fresh connection

HorizonDB (preview) intermittently drops **idle pooled TLS connections**. Under a
sustained workload this surfaces two ways:

- an **uncaught** `error` event on a checked-out client (`ECONNRESET`) — this
  crashes a long-running Node process unless you attach a pool/client `error`
  handler;
- a **rejected** query (`ENOTCONN` / `EPIPE` / `Connection terminated
  unexpectedly`) from `pool.query`.

Neither partially commits, so re-running on a **fresh** connection is safe.
Pattern (see `incubator/horizon-facts/src/db-retry.ts`):

- `pool.on("error", …)` and a process-level guard that swallow **only** this
  transient socket class;
- a bounded retry (`withDbRetry`) that re-acquires a connection and re-runs.

**Keep two retry classifiers distinct** — they target different recovery actions:

| Classifier | Matches | Retry action |
| --- | --- | --- |
| `isTransientDbError` | `ECONNRESET`/`ENOTCONN`/`EPIPE`/`Connection terminated` + pg `08xxx`/`57P0x` | re-run on a **fresh** connection |
| `isLabelCreationRaceError` | `42P07` **or** `23505` on a `pg_catalog` index (`pg_class_*`/`pg_type_*`/`pg_namespace_*`) | re-run the **same** statement (AGE label race, §3) |

Do **not** lump the label race into the connection regex, and do **not** retry a
bare `23505` — a unique violation on a *user* constraint is a real error; only
the **system-catalog** index variant is the label race.

## 2. Extension allow-list (the #1 blocker)

HorizonDB rejects `CREATE EXTENSION` unless the extension name is in the
`azure.extensions` server parameter, even for the admin user:

```
ERROR: extension "vector" is not allow-listed for "azure_pg_admin" users
        in Azure Database for PostgreSQL  (SQLSTATE 0A000)
```

The **default parameter group** (`default_pg17`) ships with `azure.extensions`
**empty** — only `plpgsql` is installed. The extensions exist on the image
(check `pg_available_extensions`), they're just not allowed yet.

### Available AI/graph extensions (PG17 image, verified 2026-06)

| Extension | Version | Purpose |
| --- | --- | --- |
| `vector` (pgvector) | 0.8.0 | embedding storage + HNSW ANN |
| `age` (Apache AGE) | 1.6.0 | property graph + Cypher |
| `pg_durable` | 0.2.1 | durable execution + `df.http()` for in-DB HTTP |
| `pg_textsearch` | 1.3.0-dev | ranked lexical search |
| `azure_ai` | 2.2.1 | native in-DB model inference (Azure-managed) |
| `pg_diskann` | 0.7.1 | disk-based ANN index (azure.extensions ONLY — NOT preloadable) |

### Enabling extensions

You **cannot** set `azure.extensions` per-session. You must create a custom
**parameter group**, set the allow-list (and `shared_preload_libraries` for
preload-required extensions), and attach it to the cluster. Attaching triggers a
**cluster restart** (~2 min downtime) when `shared_preload_libraries` changes.

**Preload requirements:** `age` and `pg_durable` must be in
`shared_preload_libraries`. `vector` and `pg_textsearch` only need to be in
`azure.extensions`. `pg_diskann` is `azure.extensions`-ONLY — it is **rejected**
in `shared_preload_libraries` (HorizonDB's allowed preload set is fixed and does
not include it), yet works without preloading.

#### Via ARM (az rest)

```bash
SUB=<subscription-id>; RG=<resource-group>; API=2026-01-20-preview
CLUSTER=<cluster-name>; PG=<cluster>-ext

# 1. Create the parameter group (sparse list merges into ~426 defaults).
#    NOTE: top-level "location" is REQUIRED or you get LocationRequired.
cat > /tmp/pg-body.json <<EOF
{
  "location": "<region>",
  "properties": {
    "description": "Enable AI/graph extensions",
    "pgVersion": "17",
    "parameters": [
      { "name": "azure.extensions",          "value": "age,azure_ai,pg_durable,pg_textsearch,vector" },
      { "name": "shared_preload_libraries",  "value": "age,pg_durable,pg_textsearch" }
    ]
  }
}
EOF
az rest --method put \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.HorizonDb/parameterGroups/$PG?api-version=$API" \
  --headers "Content-Type=application/json" --body @/tmp/pg-body.json

# 2. Poll until properties.provisioningState == "Succeeded".

# 3. Attach to the cluster (triggers restart). PATCH only the parameterGroup ref.
cat > /tmp/cluster-patch.json <<EOF
{ "properties": { "parameterGroup": {
  "id": "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.HorizonDb/parameterGroups/$PG" } } }
EOF
az rest --method patch \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.HorizonDb/clusters/$CLUSTER?api-version=$API" \
  --headers "Content-Type=application/json" --body @/tmp/cluster-patch.json

# 4. Poll the cluster: properties.state goes Updating -> Succeeded.
#    (provisioningState may be empty in steady state; key off `state`.)
```

Notes:
- The platform **re-injects its own system preload libs** (`azure`,
  `orion_storage`, `pg_availability`, `pg_qs`, `pgms_stats`,
  `pgms_wait_sampling`) on top of yours — you only list the extras.
- The default group `default_pg17` is **not** an ARM resource (GET returns
  ResourceNotFound). Discover existing user groups with:
  `az graph query -q "resources | where type =~ 'microsoft.horizondb/parametergroups'"`.
- A good template to clone from is any working group that already enables these
  (e.g. a `fts-age-pgts` style group in the same subscription).

### Verify after restart

```js
await pool.query(`show shared_preload_libraries`);      // includes age,pg_durable,pg_textsearch
await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
await pool.query(`CREATE EXTENSION IF NOT EXISTS age`);
await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_durable`);
// df.http() should now exist:
await pool.query(`select proname from pg_proc
                  where proname='http' and pronamespace::regnamespace::text='df'`);
```

## 3. Apache AGE quirks

### Don't `LOAD 'age'` when it's preloaded

On vanilla Postgres you must `LOAD 'age'` per session. On HorizonDB `age` is in
`shared_preload_libraries`, so it's already loaded and an explicit `LOAD` is
**rejected**:

```
ERROR: access to library "age" is not allowed
```

Make the load tolerant — attempt it (for portability to vanilla PG) but swallow
that one error:

```ts
async function loadAge(client: any): Promise<void> {
  try { await client.query(`LOAD 'age'`); }
  catch (err: any) {
    if (!/access to library "age" is not allowed/i.test(String(err?.message ?? ""))) throw err;
    // already preloaded via shared_preload_libraries — nothing to do
  }
}
```

Still run `SET search_path = ag_catalog, "$user", public` on every AGE session.

### Graph name must differ from every schema name

`SELECT create_graph('g')` creates a **Postgres schema** named `g`. If you also
have a facts/data schema named `g`, you get `schema "g" already exists`. Always
use distinct names (e.g. data schema `hf_test_<r>`, graph `hf_graph_<r>`).

### Cypher: no `any(... WHERE ...)`

AGE 1.6.0's Cypher parser rejects the list predicate `any(x IN list WHERE pred)`
with `syntax error at or near "WHERE"` (`cypher_parser.c`). Use the
list-comprehension + `size()` form instead:

```cypher
-- BROKEN on AGE:
WHERE any(a IN e.aliases WHERE toLower(a) CONTAINS 'tgl')
-- WORKS:
WHERE size([a IN e.aliases WHERE toLower(a) CONTAINS 'tgl']) > 0
```

`UNWIND ... WITH x WHERE ...` also works. When in doubt, probe syntax against a
throwaway graph before committing to a query shape.

### Other AGE limitations to design around

- Avoid `startNode()` / `endNode()` / `UNWIND` over variable-length paths. For
  neighbourhood edges, collect node keys first, then match edges with
  `WHERE a.entity_key IN [...] AND b.entity_key IN [...]`.
- Cypher cannot be parameterized through pg bind params — values are inlined
  into the `cypher('graph', $$ ... $$)` literal. Use a strict escaping helper
  (see `cypherStr` / `cypherStrList` / `cypherNum` in horizon-facts `sql-util.ts`)
  and never interpolate untrusted text without it.
- `agtype` has **no cast to `jsonb`** (`cannot cast type agtype to jsonb`). Don't
  return a whole node/edge and cast it — `RETURN` the scalars you need, or
  `label(x)` / `type(r)`, and parse the agtype scalars client-side.

### AGE concurrency: lazy label creation races (SQLSTATE 42P07)

AGE creates a label's backing **table** *lazily* — on the first `CREATE`/`MERGE`
that references a label that doesn't exist yet. That internal check-then-`CREATE
TABLE` is **not atomic and not serialized**. Any concurrent writer (a
connection-per-call pool, or an LLM agent issuing parallel tool calls) that
races the *first* reference to the same label hits the collision in **one of two
forms**, depending on where the duplicate is detected:

```
relation "GraphNode" already exists                                  -- 42P07 duplicate_table
duplicate key value violates unique constraint "pg_class_relname_nsp_index"  -- 23505 unique_violation
```

The `42P07` form is caught at the relation level; the `23505` form fires when two
`CREATE TABLE` for the same label race into the **`pg_class` system catalog**
before either registered. **Both are the same race** and both **abort the whole
statement** (the MERGE/CREATE persisted nothing). Errors are **front-loaded** —
they cluster on the first touch of each label, then disappear once the backing
tables exist.

> ⚠️ The `23505` form is easy to miss: the "already exists" text is in
> `err.detail`, **not** `err.message` (the message is "duplicate key value …").
> A message-only regex will silently let it through. Key off the SQLSTATE +
> the catalog constraint name (`pg_class_*` / `pg_type_*` / `pg_namespace_*`).

**Do not "fix" this in a migration by pre-creating labels.** In an open graph the
label set (node kinds, edge predicates) is owned by the *application/agent layer*,
not infrastructure — it's unbounded and unknowable at migrate time. Pre-creating
a fixed set only masks the case you thought of.

**Correct, label-agnostic fix:** the statement is idempotent, so on the label
race, **re-run the same statement** — the label now exists and the re-run
succeeds. Match **both** manifestations, and for `23505` retry **only** when the
violated constraint is a system catalog index (never a user constraint):

```ts
const CATALOG_RACE_CONSTRAINT = /pg_(class|type|namespace)_/i;
function isLabelCreationRaceError(err: any): boolean {
  if (String(err?.code) === "42P07") return true;                     // duplicate_table
  if (String(err?.code) === "23505") {                                // unique_violation…
    const c = String(err?.constraint ?? ""), m = String(err?.message ?? "");
    if (CATALOG_RACE_CONSTRAINT.test(c) || CATALOG_RACE_CONSTRAINT.test(m)) return true;  // …on a pg_catalog index
  }
  return /already exists/i.test(String(err?.message ?? ""));
}
```

Implement it at the single point where Cypher is executed, so it covers every
label automatically:

```ts
// in the one cypher(client, query) helper:
const { rows } = await withDbRetry(
  "graph_label_race",
  () => client.query(sql),
  { isRetryable: isLabelCreationRaceError });   // 42P07 OR 23505-on-catalog
```

Safe because each `cypher()` call is its own autocommit statement (a prior
failure doesn't poison the connection) and all graph writes are idempotent MERGE.

> **Ask of AGE/HorizonDB:** make first-reference label creation atomic
> (advisory-lock or true `CREATE TABLE IF NOT EXISTS` semantics) so callers don't
> have to retry DDL races on the hot path.

### AGE concurrency: no unique constraints → MERGE can duplicate

AGE vertices/edges have **no unique indexes/constraints**, so a naive
`MERGE (f:Fact {scope_key}) MERGE (e)-[:EVIDENCED_BY]->(f)` can, under
concurrency, create **duplicate** `:Fact` anchors; a later MERGE then binds every
duplicate and multiplies edges. Use read-decide-write instead: check whether the
edge already exists, bind exactly one anchor (`WITH … LIMIT 1`), and only create
when none exists (see `linkEvidenceAnchor` in `graph-queries.ts`).

### AGE performance: write latency = round-trips × RTT

On a remote cluster, AGE write latency is dominated by the **number of round
trips**, not query cost. Measured in a 119-fact agent harvest:

| op | p50 | why |
| --- | --- | --- |
| `graph_upsert_edge` | ~610 ms | endpoint check + existing-edge read + create/reinforce = 3+ statements |
| `graph_upsert_node` | ~730 ms | existence read + create/update + per-evidence anchor link |
| single stored proc (`facts_mark_crawled`) | ~67 ms | one round trip |

A single round trip to the remote cluster is ~45–100 ms, so a multi-statement
upsert is a half-second of pure latency. **The agent-driven harvest is too noisy
to measure tuning changes** (every run issues a different number of calls with
different concurrency; unrelated ops like `facts_similar` swing 5× between runs
from DB contention). Use a **deterministic microbenchmark** instead — see
`incubator/horizon-facts/eval/bench-graph.mjs`, which drives a fixed set of
upserts directly (no LLM) and reports clean p50/p95 plus the RTT and
`age-prep` primitives.

Three compounding causes and their fixes, **biggest lever first**:

1. **Connection-pool starvation (the dominant cost).** The harvester fires graph
   tool calls in **parallel**, but a small pool serializes them — the measured
   per-op p50 is then mostly **connection-queue wait**, not work. Deterministic
   sweep (80 nodes + 80 edges, concurrency 8):

   | `poolMax` | node wall | node p50 | edge wall |
   | --- | --- | --- | --- |
   | 3 (old default) | 6017 ms | 407 ms | 4517 ms |
   | 8 | 3415 ms | 224 ms | 1997 ms |
   | 16 | 1506 ms | 97 ms | 2669 ms |

   Pool 3→8 is **~45–55% faster**; 3→16 is **~75% faster** on nodes. The
   "round-trips/op" estimate (`p50 / RTT`) collapses from ~9 to ~2 as the pool
   grows — proving the apparent "9 round trips" was queue wait; the real work is
   ~2 round trips (existence-check + create). **Fix:** size the pool for the
  expected parallelism. horizon-facts now defaults `poolMax` to **16** (was 3),
   overridable via `HORIZON_POOL_MAX` — bounded by the cluster's
   `max_connections`.

### Migration locking: keep the global lock narrow

The Horizon facts migrator uses a per-schema advisory lock for ordinary schema
migrations. Only database-global DDL (for example `CREATE EXTENSION` and AGE
`ag_catalog.create_graph`) should take the global Horizon DDL lock, and it
should be transaction-scoped (`pg_try_advisory_xact_lock`) so an idle pooled
connection cannot retain it after the protected transaction ends. Do not wrap the
entire per-schema migration run in a session-level global lock; concurrent SDK
`--with-horizondb` tests create many isolated `ps_test_facts_*` schemas and a
broad global lock becomes a suite-wide bottleneck or stale-lock failure.

2. **Per-checkout session setup.** Running `LOAD 'age'` (a wasted *failed* round
   trip when preloaded) + `SET search_path` on every graph-op checkout adds ~2
   round trips (measured `age-prep` p50 ≈ 93 ms). **Fix:** do AGE session setup
   **once per physical connection** — horizon-facts caches prepared connections
   in a `WeakSet<client>` in `GraphQueries` (a reset connection yields a new
   client object → re-prepared automatically). Measured **~17–18% faster** per
   op. A pg-pool `connect`-event handler is the equivalent if you don't hold a
   client wrapper:

   ```ts
   pool.on("connect", (client) => {
     client.query("LOAD 'age'").catch(() => {});              // tolerate preloaded
     client.query(`SET search_path = ag_catalog, "$user", public`).catch(() => {});
   });
   ```

3. **Multi-statement upserts.** Collapse existence-check + write into a single
   `MERGE … ON CREATE SET … ON MATCH SET …` where it's race-safe, and batch
   independent upserts. Fewer statements = fewer round trips.

> **Ask of AGE:** the `cypher()` SRF wrapper carries per-call overhead; a way to
> issue multiple graph mutations per round trip (or a lighter write path) would
> materially help write-heavy workloads.

## 4. AI / embeddings — two paths

HorizonDB offers **two** ways to generate embeddings in-database. Pick based on
what your cluster allows and where the model lives.

### Path A — `pg_durable` `df.http()` (external endpoint) ✅ verified working

`pg_durable` exposes `df.http(url, method, body, headers jsonb, timeout_seconds)`
for durable HTTP calls from inside the database. This is the supported in-DB HTTP
primitive on HorizonDB — **`pgsql-http` (the `http` extension) is NOT available**;
only `azure_ai` and `pg_durable` ship.

`incubator/horizon-facts/sql/006_embeddings_http.sql` + `src/http-embedding.ts`
implement this end-to-end (verified against the live cluster, embedding real
1536-dim vectors). The hard-won mechanics:

**1. `df.http()` is a durable FUTURE, not a synchronous call.** It returns a
node descriptor (`{"node_type":"HTTP",...}`), not the response. You run it via
`df.start(fut, label, database)` → instance id, then poll
`df.wait_for_completion(iid, timeout)` and read `df.result(iid)`:

```sql
v_iid := df.start(df.http(url,'POST',body,headers,30), 'hz-embed', NULL);
COMMIT;                                  -- ⚠️ see (2)
PERFORM df.wait_for_completion(v_iid, 40);
v_res := df.result(v_iid);               -- text JSON, see (3)
```

**2. Must COMMIT between start and wait → use a PROCEDURE, not a function.** The
`pg_durable` worker runs the instance in its OWN connection and can't see the
instance row until the enqueuing transaction commits. So you cannot
`df.start` + `df.wait_for_completion` inside one SQL function (functions can't
commit and would deadlock until timeout). Drive it from a **plpgsql PROCEDURE**
that `COMMIT`s after `df.start`. A `FOR row IN SELECT … LOOP … COMMIT … END LOOP`
with commits inside works on HorizonDB's PG17.

**3. `df.result()` shape:** text JSON with keys
`{ok, body, status, headers, duration_ms}`. `body` is the raw response string.
For an AOAI embeddings response:
`(((df.result(iid)::jsonb->>'body')::jsonb->'data'->0->'embedding')::text)::vector`.
Check `(res::jsonb->>'ok')::boolean` first.

**4. `df.http()` enforces an Azure egress ALLOW-LIST.** Only approved Azure
service domains are permitted. The Azure AI Foundry **unified** host
`*.services.ai.azure.com` is **BLOCKED** — the instance fails with
`"... is not in the allowed endpoint list. Only requests to approved Azure
service domains are permitted."` The **classic Azure OpenAI host
`*.openai.azure.com`** points at the same deployment and **IS allowed**.
`setupHttpEmbedding` auto-rewrites the host (`toAllowlistedAzureHost`). The
`cognitiveservices.azure.com` host also works. (The Node fallback uses Node
fetch and works with either host.)

**5. Grant HTTP usage:** `SELECT df.grant_usage(current_user, true, false);`
(the `true` = include_http). Idempotent.

**6. Recurring / cron embedder via `df.loop` (sub-minute cadence).** pg_durable
exposes futures combinators — `df.seq(a,b)` (THEN), `df.loop(body)`,
`df.sleep(seconds)`, `df.sql(query)`, `df.race`, `df.if*`, plus `df.cancel`,
`df.signal`, `df.wait_for_schedule(cron_expr)`. They serialize to a node tree
(`{"node_type":"LOOP","left_node":{...}}`) and you launch with `df.start`. For a
**self-perpetuating recurring job** at a fixed interval, wrap a sleep+work
sequence in a loop:

```sql
-- every N seconds, embed any changed facts (the loop is pure scheduling; the
-- per-fact df.http embedding lives in the CALLed procedure → "nested" durability)
SELECT df.start(
  df.loop(df.seq(df.sleep(5::bigint), df.sql('CALL "schema".embed_new_facts_durable(128, NULL)'))),
  'hz-embed-cron:schema', NULL);
```

- `df.wait_for_schedule` takes a real cron expression but only **minute**
  granularity — for sub-minute ticks (e.g. every 5s) you MUST use `df.sleep`.
- A loop calling a procedure that itself starts `df.http` instances works fine
  (verified): the loop ticks, the proc runs nested durable HTTP per fact, the
  pg_durable worker handles both. The loop instance stays `pending`/`running`.
- Track/stop by a **stable label** (e.g. `hz-embed-cron:<schema>`): look it up in
  `df.instances` (PK column is `id`, plus `label`, `status`, `created_at`;
  terminal statuses are `completed`/`cancelled`/`failed`, active are
  `pending`/`running`). Make `start` idempotent by reusing any non-terminal
  instance with that label; `stop` = `df.cancel(id, reason)`.

**7. Embedding is a PROVIDER-INTERNAL lifecycle, not a contract method.**
PilotSwarm only knows the `EnhancedFactStore` interface; its sole embedding
responsibility is passing the endpoint config. *How/when* embeddings are produced
is the provider's private business. The HorizonDB provider exposes only a
lifecycle on `HorizonFactStore` (`src/horizon-store.ts`):
- `configureEmbedder(endpoint)` — write/replace the `embedding_config` row (with
  the df.http allow-list host rewrite).
- `startEmbedder({ intervalSeconds = 5, batch = 128 })` — launch the durable
  df.loop cron; idempotent; returns `EmbedderStatus { running, instanceId?, status? }`.
- `stopEmbedder()` — `df.cancel` the loop.
- `embedderStatus()` — derived `{ running }` (no df leakage in the shape).

Callers **never** trigger embedding or wait on a df instance — they write facts
and observe the **outcome** (vector present / semantic search returns the fact).

The two `@internal` methods `_embedPendingNode()` and `_embedNewFactsInDbOnce()`
are **NOT production paths** — they are sanity checks for the df.http path:
`_embedPendingNode` posts the *identical* request df.http builds (same headers/
body, read from `embedding_config`) via Node fetch, so it validates the request
shape against a Node-reachable stub; `_embedNewFactsInDbOnce` is a one-shot
synchronous trigger of the same procedure the cron CALLs. Both are exercised only
by the **provider's own** integration tests (`test/integration/http-embeddings.test.mjs`),
which legitimately assert on df internals because they test the *mechanism*.
PilotSwarm-level tests must stay outcome-only and never reference df.

Other constraints:
- Store the source-content hash alongside the vector so re-embeds only happen
  when content changes (`last_embedded_hash IS DISTINCT FROM content_hash`).
- `df.instances` (with your `label`) is the audit trail that a durable HTTP call
  actually ran; it's global, not schema-scoped.
- Inspect failures via `df.instance_nodes(iid, 1)` → the node `status`/`result`.

### Path B — `azure_ai` (Azure-managed inference)

`azure_ai` is HorizonDB's native model-management/inference extension. It wires
embeddings/completions to Azure-managed model endpoints from inside the DB
(no external HTTP plumbing). Cluster-side feature gating (`aiModelManagement`)
may need to be enabled before it works. Prefer this when you want managed,
in-region inference and don't want to operate your own endpoint.

### Path C — Node-side fallback (`embedPending()`)

For bootstrapping, clusters without a working in-DB HTTP path, or local tests,
embed from the application: read pending facts, call the embeddings endpoint
from Node, write `vector(dim)` back. Reference: `embedPending()` /
`http-embedding.ts` in horizon-facts. Still requires `vector` to be allow-listed
so the `embedding vector(dim)` column and HNSW index exist.

## 5. pgvector notes

- `CREATE EXTENSION vector` after allow-listing; `vector` 0.8.0 supports `hnsw`
  and `ivfflat` AMs out of the box.
- HNSW index: `USING hnsw (embedding vector_cosine_ops)`.
- **DiskANN is a SEPARATE extension (`pg_diskann`), not pgvector core.** On the
  cluster it shows in `pg_available_extensions` (0.7.1). It is **NOT installed by
  default** and must be allow-listed in `azure.extensions`. **IMPORTANT: unlike
  Azure Flexible Server, HorizonDB does NOT require (and REJECTS) `pg_diskann` in
  `shared_preload_libraries`** — the allowed preload set is fixed
  (`age, auto_explain, azure_storage, pg_cron, pg_durable, pg_partman_bgw,
  pg_prewarm, pg_stat_statements, pg_textsearch, pgaudit, wal2json`); adding
  `pg_diskann` there fails the parameter group with `ParameterValueInvalid`. Put
  `pg_diskann` in `azure.extensions` ONLY — it works without preload (verified
  2026-06 on `waldemort-cms-2`: `CREATE EXTENSION pg_diskann` + `USING diskann
  (embedding vector_cosine_ops)` both succeed). It shares the `vector_cosine_ops`
  opclass and the `<=>` operator with HNSW, so query code is identical.
  horizon-facts selects the AM via `annIndex: "diskann"|"hnsw"|"auto"` (env
  `HORIZON_ANN_INDEX`); `auto` (default) tries diskann and falls back to hnsw
  when it isn't allow-listed (`ensureAnnIndex` in `migrations.ts`).
- A jsonb array text `"[...]"` casts directly to `vector` — handy when parsing
  an embeddings HTTP response: `(emb_json::text)::vector`.
- Embedding dimension must match the endpoint's model exactly, or inserts fail.

## 6. Networking / firewall

- HorizonDB firewall rules live under
  `clusters/{cluster}/pools/{pool}/firewallRules`, but the **pool name is not
  enumerable** via ARM/CLI (no list/read; GET on the collection returns
  MethodNotAllowed). The practical path is the **portal Networking blade** on the
  cluster to add your client IP, or open a broad range temporarily.
- Connections still require the TLS handling from §1 once the firewall is open.

## 7. Working checklist for a fresh cluster

1. Open firewall to your IP (portal Networking blade).
2. Connect with `?sslmode=require&uselibpqcompat=true`; confirm `select version()`.
3. Create + attach a parameter group with `azure.extensions` and
   `shared_preload_libraries` for the extensions you need; wait for the restart.
4. `CREATE EXTENSION` for `vector`, `age`, `pg_durable`, `pg_textsearch` as needed.
5. For AGE: tolerant `LOAD 'age'`, set `search_path`, distinct graph vs schema
   names, avoid `any(... WHERE ...)`.
6. For embeddings: choose `df.http()` (external endpoint reachable from cluster),
   `azure_ai` (managed), or Node-side `embedPending()`; run generation as a
   `pg_durable` activity; hash-guard re-embeds.

## See also

- `incubator/horizon-facts/README.md` — capability overview + design rules
- `incubator/horizon-facts/CRAWLER-SPEC.md` — embedding pipeline + AGE graph contract
- `incubator/horizon-facts/test/integration/` — live HorizonDB tests for all of the above
- repo memory `horizondb-incubator-2026-06-02.md` — the original bring-up notes
