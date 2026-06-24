# Retrieval Usage Metrics - Enhanced Facts And Graph

## Summary

Add count-only usage metrics for enhanced fact retrieval and graph retrieval. The
runtime should record how often a session searches facts, asks for similar facts,
searches graph nodes/edges, and loads graph neighbourhoods. Operators and the
agent-tuner should be able to answer:

- How many fact searches did this session perform?
- How many graph searches did this session perform?
- Which graph operation types were used: node search, edge search, neighbourhood?
- Which namespaces were queried?
- Which node keys were explicitly searched as node-key seeds?
- Which specific graph node keys were explicitly loaded as anchors?
- Which edge predicates or endpoint keys were searched?

The metric payloads must not capture returned nodes, returned edges, returned
facts, fact values, graph properties, or result objects. Store counts and request
shape only.

## Goals

- Reuse the existing base fact-store usage pattern: durable `session_events`
  emitted at tool boundaries and aggregated later through CMS stored procedures.
- Count enhanced fact and graph retrieval calls per session, tree, and fleet.
- Support raw timeline forensics for the agent-tuner without persisting returned
  data.
- Keep the first implementation bounded and cheap enough for busy sessions.
- Degrade gracefully when enhanced facts or graph are not configured.
- Preserve ACL/privacy expectations: usage metrics can reveal request shapes and
  identifiers, but never result payloads.
- Keep storage growth proportional to retrieval tool calls, not result counts.

## Non-Goals

- Do not persist returned node keys, returned edge keys, returned fact scope keys,
  fact values, graph node properties, or graph edge properties.
- Do not add provider-specific telemetry tables in HorizonDB for this feature.
- Do not count low-level provider calls that bypass PilotSwarm tools.
- Do not backfill historical sessions. Pre-feature sessions will simply have no
  retrieval-usage events.
- Do not expose fleet-wide APIs as normal agent tools. Session/tree inspection
  tools must preserve the same lineage/tuner gating used by existing inspect
  tools.

## Existing Pattern To Follow

Skill usage already follows the desired architecture:

1. Tool/runtime emits durable events into `copilot_sessions.session_events`.
2. CMS migrations add partial indexes and stored procedures over those events.
3. `SessionCatalogProvider` and `PilotSwarmManagementClient` expose typed reads.
4. Agent-tuner inspect tools wrap the management/catalog APIs.

For learned skills, `read_facts` emits one `learned_skill.read` event per tool
call that touches `skills/*`. The aggregation procedures group by event type and
request identity rather than storing every returned fact. Retrieval usage should
copy that shape.

Existing size controls for this pattern:

- **One compact event per tool call.** Learned-skill usage does not emit one row
  per returned fact; it records the request shape and `matchCount` only.
- **Partial indexes.** Skill usage adds a partial `session_events` index only for
  `skill.invoked` / `learned_skill.read`, so common transcript events do not bloat
  the usage index.
- **Bounded reads.** Event inspection APIs page by `seq` and the graph-search
  timeline reader scans a bounded latest page.
- **Session cleanup.** Soft-deleting a session marks `sessions` and
  `session_metric_summaries` deleted; facts cleanup deletes session-scoped facts.
  Raw `session_events` remain diagnostic/audit rows until event-log pruning.
- **Event-log pruning.** Resource Manager exposes `purge_old_events`, which
  deletes `session_events` older than a caller-specified age (default 24h,
  minimum 60m), followed by `compact_database` / `VACUUM ANALYZE` when needed.
  That pruning removes skill-usage and future retrieval-usage raw events together.

## Functionality

### Event Types

Emit these count-only events from SDK tool wrappers:

| Event Type | Tool(s) | Purpose |
|---|---|---|
| `facts.searched` | `facts_search` | Count enhanced fact search calls. |
| `facts.similar` | `facts_similar` | Count nearest-neighbour expansion from a known fact. |
| `skills.searched` | `search_skills` | Count semantic/hybrid learned-skill search calls. |
| `graph.searched` | `graph_search_nodes`, `graph_search_edges`, `graph_neighbourhood` | Count graph retrieval calls and preserve request shape. |
| `graph.node_searched` | `graph_search_nodes` with exact node-key seeds | Count explicit node-key searches. |
| `graph.node_loaded` | `graph_neighbourhood` and future exact node-load tools | Count explicit node anchor loads. |

`graph.searched` already exists today in a coarse form. Extend its payload and
aggregation rather than replacing it.

Events are stamped by the existing CMS event path: `recordEvents(sessionId, ...)`
stores the owning `session_id`, `seq`, `created_at`, and optional
`worker_node_id`. The payload may include `callerAgentId` for convenience, but
aggregations should join to `sessions.agent_id` for authoritative agent identity.
Do not duplicate `sessionId` in `data` unless it is needed for an external export
format.

### Count-Only Payloads

Payloads may include:

- operation name
- namespace filter
- bounded request text previews, capped at 80 characters
- requested mode or graph search kind
- limit/depth/k/minScore/minConfidence values
- result count
- elapsed duration in milliseconds
- caller agent id when already available; session id is already the CMS event row
- explicit anchor identifiers supplied by the caller, such as `nodeKey`,
  `fromKey`, `toKey`, `predicateKey`, or `scopeKey`

Payloads must not include:

- returned node keys
- returned edge keys
- returned fact scope keys
- fact values
- graph node or edge properties
- full result objects
- embeddings or semantic vectors

There must be exactly one usage event per retrieval tool invocation. A search
that returns 500 graph nodes still records one event with `resultCount: 500`, not
500 rows. A neighbourhood call that returns 100 nodes and 200 edges records one
`graph.searched` event with `nodeCount`, `edgeCount`, and `resultCount`; it may
also record one `graph.node_loaded` event for the explicit anchor node, but never
one event per returned node or edge.

Example `facts.searched`:

```json
{
  "operation": "facts_search",
  "queryPreview": "bounded to 80 chars",
  "mode": "hybrid",
  "namespace": "corpus/pgsql-hackers",
  "tags": ["patch"],
  "limit": 20,
  "resultCount": 12,
  "durationMs": 44,
  "callerAgentId": "researcher"
}
```

`queryPreview` is clipped raw query text, capped at 80 characters. Do not add
`queryHash` in Phase 1; hashing creates a second lookup vocabulary without an
immediate product use. If a future privacy review decides previews are too much,
drop the preview rather than adding hashes by default.

Example `graph.searched` for node search:

```json
{
  "operation": "search_nodes",
  "namespace": "corpus/pgsql-hackers",
  "kind": "person",
  "nameLikePreview": "alvaro herrera",
  "seedCount": 0,
  "nodeKeySeedCount": 0,
  "depth": null,
  "limit": 20,
  "resultCount": 8,
  "durationMs": 31,
  "callerAgentId": "researcher"
}
```

Example `graph.searched` for neighbourhood:

```json
{
  "operation": "neighbourhood",
  "namespace": "corpus/pgsql-hackers",
  "nodeKey": "person:alvaro-herrera",
  "depth": 2,
  "resultCount": 42,
  "nodeCount": 18,
  "edgeCount": 24,
  "durationMs": 63,
  "callerAgentId": "researcher"
}
```

Example `graph.node_loaded`:

```json
{
  "nodeKey": "person:alvaro-herrera",
  "namespace": "corpus/pgsql-hackers",
  "operation": "neighbourhood",
  "durationMs": 63,
  "callerAgentId": "researcher"
}
```

Do not include `toolVersion` in Phase 1. The event type plus payload keys are the
schema. If a later event schema needs an incompatible change, introduce a new
event type or add a `schemaVersion` field at that time.

### What Counts As A Specific Node Load

A specific graph node is considered loaded when the caller supplies an exact node
key and the tool uses it as an anchor:

- `graph_neighbourhood({ nodeKey })`
- future exact-node load tools, if added

Node-key searches are tracked separately from loads:

- `graph_search_nodes({ seeds: [...] })` emits `graph.node_searched` for each
  exact node-key seed supplied by the caller, plus the aggregate
  `graph.searched` event. This answers "which node keys did the session search
  for?" without implying the node was loaded as a neighbourhood anchor.
- Fact scopeKey seeds do not emit `graph.node_searched`, because they are fact
  anchors, not graph node keys.

A fuzzy node search by `kind` / `nameLike` counts as `graph.searched`, but does
not emit `graph.node_loaded`, because no specific node was requested.

### Edge Search Detail

For edges, store the requested shape, not the returned edge identities:

- `predicateKey`
- `fromKey`, if supplied
- `toKey`, if supplied
- namespace
- minConfidence
- result count

If a caller supplies raw `predicate` without `predicateKey`, the tool should
normalize it the same way graph writes/search already do and persist only the
normalized `predicateKey` when available. Do not persist raw predicate text in
the metric payload.

This supports questions such as "how often did this session search DEPENDS_ON
edges?" without persisting every matched edge.

## API Changes

### Types

Add public SDK types similar to skill usage:

```ts
export type RetrievalSurface = "facts" | "skills" | "graph";
export type RetrievalOperation =
    | "facts_search"
    | "facts_similar"
    | "search_skills"
    | "graph_search_nodes"
    | "graph_search_edges"
    | "graph_neighbourhood";

export interface RetrievalUsageRow {
    /** Computed aggregate row, not a stored row. */
    surface: RetrievalSurface;
    operation: RetrievalOperation;
    namespace: string | null;
    calls: number;
    totalResults: number;
    avgResults: number;
    totalDurationMs: number | null;
    avgDurationMs: number | null;
    firstUsedAt: Date;
    lastUsedAt: Date;
}

export interface GraphNodeUsageRow {
    /** Computed aggregate for exact node-key searches or exact node loads. */
    nodeKey: string;
    namespace: string | null;
    operation: RetrievalOperation;
    kind: "searched" | "loaded";
    count: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface GraphEdgeSearchUsageRow {
    /** Computed aggregate for requested edge-search shapes. */
    predicateKey: string | null;
    fromKey: string | null;
    toKey: string | null;
    namespace: string | null;
    calls: number;
    totalResults: number;
    firstSearchedAt: Date;
    lastSearchedAt: Date;
}

export interface RetrievalUsageResult<T> {
    enabled: boolean;
    reason?: string;
    rows: T[];
}
```

### Management Client

The `Retrieval*Row` and `Graph*Row` types are not tables. They are aggregate
result rows computed on demand by CMS stored procedures over raw
`session_events`, the same way skill-usage rows are computed today. `firstUsedAt`
/ `lastUsedAt` and `firstSeenAt` / `lastSeenAt` are for recency UX and reports:
sorting hot/recent namespaces, answering "when did this session last touch this
graph/fact surface?", and distinguishing current heat from historical usage in
fleet summaries.

Add read-only methods to `PilotSwarmManagementClient`:

```ts
getSessionRetrievalUsage(
  sessionId: string,
  opts?: { since?: Date }
): Promise<RetrievalUsageResult<RetrievalUsageRow>>;

getSessionTreeRetrievalUsage(
  sessionId: string,
  opts?: { since?: Date }
): Promise<{
  rootSessionId: string;
  perSession: Array<{ sessionId: string; agentId: string | null; rows: RetrievalUsageRow[] }>;
  rolledUp: RetrievalUsageRow[];
  totalCalls: number;
}>;

getFleetRetrievalUsage(
  opts?: { since?: Date; includeDeleted?: boolean }
): Promise<{ enabled: boolean; reason?: string; windowStart: number | null; rows: Array<RetrievalUsageRow & { agentId: string | null; sessionCount: number }> }>;

getSessionGraphNodeUsage(
  sessionId: string,
  opts?: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: "searched" | "loaded" }
): Promise<RetrievalUsageResult<GraphNodeUsageRow>>;

getSessionGraphEdgeSearchUsage(
  sessionId: string,
  opts?: { since?: Date; limit?: number }
): Promise<RetrievalUsageResult<GraphEdgeSearchUsageRow>>;

getFleetGraphNodeUsage(
  opts?: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: "searched" | "loaded" }
): Promise<{ enabled: boolean; reason?: string; windowStart: number | null; rows: Array<GraphNodeUsageRow & { agentId: string | null; sessionCount: number }> }>;
```

Fleet retrieval APIs must support these product questions:

- fleet-wide fact/graph search counts by operation
- top namespaces by call count and result count
- distinct node keys searched over a window
- distinct node keys loaded over a window
- how often a specific node key was searched or loaded over the last N period,
  with `nodeKeyLike` for prefix/substring investigations

### Graceful Unavailable Behavior

These APIs are meaningful only when enhanced fact store tools and/or graph tools
are configured. They should not throw raw provider errors when a capability is
absent.

Recommended management behavior:

- If no `sessionCatalog` is configured, keep current management invariant errors.
- If enhanced facts and graph are both disabled, retrieval usage methods return an
  empty aggregate plus capability metadata:

```ts
{
  enabled: false,
  reason: "enhanced facts and graph are not configured",
  rows: []
}
```

- If enhanced facts are disabled but graph is enabled, fact/skill retrieval rows
  are empty and graph rows are available.
- If graph is disabled but enhanced facts are enabled, graph node/edge usage APIs
  return `{ enabled: false, reason: "graph store is not configured", rows: [] }`
  while fact retrieval usage remains available.

If preserving array return types is more important than metadata, keep the typed
methods as arrays and add `getRetrievalUsageCapabilities()` for callers that need
an explanation. The inspect tools should always return an object with
`enabled`, `reason`, and `rows` for agent ergonomics.

### Inspect Tools

Add inspect tools following the existing `read_session_skill_usage` shape and
lineage gate:

- `read_session_retrieval_usage(session_id, since_iso?)`
- `read_session_tree_retrieval_usage(session_id, since_iso?)`
- `read_fleet_retrieval_usage(since_iso?, include_deleted?)`
- `read_session_graph_node_usage(session_id, since_iso?, limit?)`
- `read_session_graph_edge_search_usage(session_id, since_iso?, limit?)`
- `read_fleet_graph_node_usage(since_iso?, include_deleted?, limit?, node_key_like?, kind?)`

Access follows the existing inspect lineage model:

- Parent/root sessions may read retrieval usage for their descendant sessions.
- The agent-tuner may read any session.
- Other sessions may read only their own session unless a future tool explicitly
  grants broader lineage access.

Unavailable examples:

```json
{
  "enabled": false,
  "reason": "graph store is not configured",
  "rows": []
}
```

```json
{
  "enabled": true,
  "sessionId": "...",
  "rows": [],
  "totalCalls": 0
}
```

## UX Changes

### Agent Tuner

Update the agent-tuner graph-debug guidance so investigations start with
aggregate counts before raw event timelines:

1. `read_session_retrieval_usage` to see fact/skill/graph retrieval counts.
2. `read_session_graph_node_usage` when the question is about specific node
   anchors.
3. `read_session_graph_searches` only when raw chronological query timeline is
   needed.

The tuner should phrase findings in count terms, for example:

> Session X ran 14 graph searches: 9 node searches, 3 neighbourhood loads, and 2
> edge searches. It loaded node `person:alvaro-herrera` twice and searched
> predicate `DEPENDS_ON` once. No returned graph data is stored in the metrics.

### Stats Pane / Portal

Phase 1 should expose only the aggregate, low-cardinality values:

- fact searches
- similar-fact calls
- skill searches
- graph node searches
- graph edge searches
- graph neighbourhood loads
- total graph result count
- top namespaces by call count

Do not render per-node or per-edge tables in the main stats pane initially.
Those belong in tuner/detail tools because cardinality can be high.

### Raw Events

Keep `read_session_graph_searches` as a raw timeline tool, but update its payload
mapping to the new count-only event shape. It should not show returned objects.

## Implementation Details

### 1. Event Emission

Update `facts-tools.ts`:

- Wrap `facts_search` with duration measurement and emit `facts.searched` after
  reserved-prefix post-filtering.
- Wrap `facts_similar` with duration measurement and emit `facts.similar` after
  reserved-prefix post-filtering.
- Wrap `search_skills` with duration measurement and emit `skills.searched`.
- Use best-effort `recordEvent`, matching the learned-skill pattern: never fail a
  tool call if telemetry persistence fails.
- Include `queryPreview` clipped to 80 characters; do not include a query hash in
  Phase 1.

Update `graph-tools.ts`:

- Expand existing `recordSearch` to include `operation`, namespace, duration,
  result counts, and sanitized request shape.
- Emit `graph.node_loaded` for exact node anchors.
- Emit `graph.node_searched` for exact graph node-key seeds supplied to
  `graph_search_nodes`.
- Persist `predicateKey` for edge searches; do not persist raw predicate text.
- Do not include returned node/edge arrays in events.

Sanitization helpers:

- `boundedPreview(value: string, max = 80): string | undefined` for fact queries
  and graph `nameLike` previews.
- `normalizeNamespace(value): string | null` so aggregation groups `default`,
  empty, and null consistently.

### 2. CMS Migration

Add a new CMS migration, for example `0014_retrieval_usage_procs` or the next
available version.

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_<schema>_events_retrieval_usage
  ON <schema>.session_events (session_id, created_at DESC)
  WHERE event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched', 'graph.node_searched', 'graph.node_loaded');

CREATE INDEX IF NOT EXISTS idx_<schema>_events_graph_node_usage
  ON <schema>.session_events ((data->>'nodeKey'), created_at DESC)
  WHERE event_type IN ('graph.node_searched', 'graph.node_loaded');
```

Stored procedures:

- `cms_get_session_retrieval_usage(p_session_id, p_since)`
- `cms_get_session_tree_retrieval_usage(p_session_id, p_since)`
- `cms_get_fleet_retrieval_usage(p_since, p_include_deleted)`
- `cms_get_session_graph_node_usage(p_session_id, p_since, p_limit)`
- `cms_get_session_graph_edge_search_usage(p_session_id, p_since, p_limit)`
- `cms_get_fleet_graph_node_usage(p_since, p_include_deleted, p_limit, p_node_key_like, p_kind)`

All procedures aggregate from `session_events`. No new data table is required for
Phase 1.

Do not add a retrieval-specific fact-store table. These metrics are CMS runtime
observability, not HorizonDB/facts data. If a future implementation needs
long-term aggregates beyond the raw event retention window, add a compact CMS
rollup table keyed by `(session_id, surface, operation, namespace, time_bucket)`;
do not store returned fact/node/edge identities there either.

Grouping rules:

- `surface`: derived from event type (`facts`, `skills`, `graph`).
- `operation`: `data->>'operation'`, with backwards-compatible mapping for old
  `graph.searched.kind` values if present.
- `namespace`: `NULLIF(data->>'namespace', '')`, with `default` normalized as a
  literal display value or NULL consistently across callers.
- `calls`: `COUNT(*)`.
- `totalResults`: sum numeric `resultCount` where present.
- `duration`: sum/avg numeric `durationMs` where present; null if no duration.
- `GraphNodeUsageRow.kind`: derived from event type, `searched` for
  `graph.node_searched` and `loaded` for `graph.node_loaded`.
- `nodeKeyLike`: implemented as a bounded SQL `ILIKE` over `data->>'nodeKey'`.
  Keep it optional and require a `since` window for fleet use.

### 2a. Retention And Size Controls

Retrieval usage must follow the same cleanup model as base fact-store usage
metrics:

- Raw retrieval usage rows live in `copilot_sessions.session_events`.
- They are append-only diagnostic/audit rows, not fact-store content.
- They are removed by the existing Resource Manager `purge_old_events` tool along
  with other CMS events.
- Aggregation APIs should require or strongly encourage `since` / `since_iso` for
  fleet-wide views. Inspect-tool descriptions must tell agents to pass a bounded
  window, mirroring `read_fleet_skill_usage`.
- Partial indexes must cover only the retrieval event types so normal transcript
  traffic does not bloat the retrieval indexes.
- Event payloads must stay small and deterministic in shape. Preview fields are
  capped at 80 characters, tag arrays should be capped if needed, and result
  arrays are never included.
- Per-session aggregate queries can scan all retrieval events for that session;
  fleet aggregate queries should default to a recent window in UI/tuner usage.

If operators need long retention while pruning raw events aggressively, add a
future CMS rollup job/table. The Phase 1 design intentionally keeps no separate
rollup table so cleanup remains one existing event-pruning path.

### 3. TypeScript CMS Layer

Update `cms.ts`:

- Add result interfaces and provider methods.
- Add new stored procedure names to `sqlForSchema()`.
- Add row mappers for retrieval usage rows.
- Keep all SQL calls as `SELECT * FROM schema.proc(...)`.

Update `management-client.ts`:

- Add public methods.
- Include capability metadata or empty-array graceful handling as decided above.

Update `index.ts`:

- Export public retrieval usage types.

### 4. Inspect Tools

Update `inspect-tools.ts`:

- Add inspect tools with the same lineage/tuner authorization used by existing
  session inspection tools.
- Return `{ enabled, reason, rows }` rather than throwing capability errors to
  the agent.
- Update `read_session_graph_searches` to map new `graph.searched` shape.

### 5. Prompt And Skill Updates

Update:

- `packages/sdk/plugins/mgmt/agents/agent-tuner.agent.md`
- `packages/sdk/plugins/mgmt/skills/graph-debug/SKILL.md`
- `docs/agent-tuning-log.md` and `/memories/repo/agent-tuning-log.md` if prompt
  behavior changes materially

Expected prompt guidance:

- Use aggregate retrieval usage first.
- Use raw event timeline only for detailed chronology.
- Metrics are count-only; absence of returned nodes/edges in telemetry is by
  design.

### 6. Tests

Add focused unit/integration tests:

- `facts_search` emits `facts.searched` with result count and no returned facts.
- `facts_similar` emits `facts.similar` with result count and no returned facts.
- `search_skills` emits `skills.searched`.
- `graph_search_nodes` emits count-only `graph.searched`.
- `graph_search_edges` emits count-only `graph.searched` with predicate/endpoint
  request shape.
- `graph_neighbourhood` emits `graph.searched` plus `graph.node_loaded`.
- `graph_search_nodes` with node-key seeds emits `graph.node_searched` for those
  seeds and does not emit `graph.node_loaded`.
- CMS aggregation returns per-session counts from seeded events.
- Graph node usage aggregates exact node searches and exact node loads.
- Graph edge search usage aggregates predicate/from/to request shapes.
- Fleet graph node usage supports `nodeKeyLike`, `kind`, `since`, and bounded
  `limit`.
- Inspect tools return graceful unavailable payloads when graph/enhanced facts are
  absent.

### 7. Migration Diff File

Per repo rules, the CMS migration needs a companion file under
`packages/sdk/src/migrations/NNNN_diff.md` describing:

- new partial indexes
- new stored procedures
- any modified function signatures if we extend existing graph-search reads

## Rollout And Compatibility

- Additive CMS migration only; no orchestration version change.
- Existing sessions continue normally; old sessions have no retrieval metrics.
- Existing `graph.searched` events remain readable. Aggregation should map old
  `kind` to the new `operation` where possible.
- Feature is dormant unless enhanced facts or graph tools are configured and used.
- No returned graph/fact data is persisted, so event volume stays bounded by tool
  call volume.
- Raw retrieval metrics have the same retention behavior as other
  `session_events`: they remain until session-event pruning deletes old rows.

## Decisions

1. Free-text fact queries and graph `nameLike` values are stored only as bounded
  previews clipped to 80 characters. No query hashes in Phase 1.
2. Parent/root sessions may read retrieval usage for child sessions. The
  agent-tuner may read any session. Other sessions are limited to self unless a
  future tool grants broader access.
3. Exact graph node keys supplied by the caller are persisted for usage metrics.
  Node-key searches and node loads are separate event types and aggregate rows.
4. Edge usage aggregates `predicateKey` only. Raw predicate text is not persisted
  in the usage metric payload.
