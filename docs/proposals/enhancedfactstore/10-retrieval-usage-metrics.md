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
- Do not expose these APIs as general agent tools unless the same lineage/tuner
  gating used by existing inspect tools is preserved.

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
| `graph.node_loaded` | `graph_neighbourhood` and direct node-key graph searches | Count explicit node anchor loads. |

`graph.searched` already exists today in a coarse form. Extend its payload and
aggregation rather than replacing it.

### Count-Only Payloads

Payloads may include:

- operation name
- namespace filter
- requested mode or graph search kind
- limit/depth/k/minScore/minConfidence values
- result count
- elapsed duration in milliseconds
- caller session id and agent id when already available
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
  "queryHash": "sha256:...",
  "queryPreview": "optional bounded preview",
  "mode": "hybrid",
  "namespace": "corpus/pgsql-hackers",
  "tags": ["patch"],
  "limit": 20,
  "resultCount": 12,
  "durationMs": 44,
  "toolVersion": 1
}
```

`queryPreview` is optional. If included, cap it tightly, for example 160
characters. If we want the strictest privacy posture, store only `queryHash` and
omit the preview.

Example `graph.searched` for node search:

```json
{
  "operation": "search_nodes",
  "namespace": "corpus/pgsql-hackers",
  "kind": "person",
  "hasNameLike": true,
  "nameLikeHash": "sha256:...",
  "seedCount": 0,
  "depth": null,
  "limit": 20,
  "resultCount": 8,
  "durationMs": 31,
  "toolVersion": 1
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
  "toolVersion": 1
}
```

Example `graph.node_loaded`:

```json
{
  "nodeKey": "person:alvaro-herrera",
  "namespace": "corpus/pgsql-hackers",
  "operation": "neighbourhood",
  "durationMs": 63,
  "toolVersion": 1
}
```

### What Counts As A Specific Node Load

A specific graph node is considered loaded when the caller supplies an exact node
key and the tool uses it as an anchor:

- `graph_neighbourhood({ nodeKey })`
- `graph_search_nodes({ seeds: [...] })` when a seed is interpreted as a node key
  by the graph provider or clearly has node-key shape
- future exact-node load tools, if added

A fuzzy node search by `kind` / `nameLike` counts as `graph.searched`, but does
not emit `graph.node_loaded`, because no specific node was requested.

### Edge Search Detail

For edges, store the requested shape, not the returned edge identities:

- `predicateKey` or bounded/hash-normalized `predicate`
- `fromKey`, if supplied
- `toKey`, if supplied
- namespace
- minConfidence
- result count

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
    nodeKey: string;
    namespace: string | null;
    operation: RetrievalOperation;
    loads: number;
    firstLoadedAt: Date;
    lastLoadedAt: Date;
}

export interface GraphEdgeSearchUsageRow {
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
  opts?: { since?: Date; limit?: number }
): Promise<RetrievalUsageResult<GraphNodeUsageRow>>;

getSessionGraphEdgeSearchUsage(
  sessionId: string,
  opts?: { since?: Date; limit?: number }
): Promise<RetrievalUsageResult<GraphEdgeSearchUsageRow>>;
```

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

Add tuner-only tools, following the existing `read_session_skill_usage` shape:

- `read_session_retrieval_usage(session_id, since_iso?)`
- `read_session_tree_retrieval_usage(session_id, since_iso?)`
- `read_fleet_retrieval_usage(since_iso?, include_deleted?)`
- `read_session_graph_node_usage(session_id, since_iso?, limit?)`
- `read_session_graph_edge_search_usage(session_id, since_iso?, limit?)`

Non-tuner sessions should not receive these tools unless we intentionally decide
that lineage-scoped retrieval usage is safe for normal agents. The first version
should be tuner-only.

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

Update `graph-tools.ts`:

- Expand existing `recordSearch` to include `operation`, namespace, duration,
  result counts, and sanitized request shape.
- Emit `graph.node_loaded` for exact node anchors.
- Do not include returned node/edge arrays in events.

Sanitization helpers:

- `hashText(value: string): string` for free-text queries/predicates if we avoid
  storing raw query text.
- `boundedPreview(value: string, max = 160): string | undefined` if we choose to
  include preview text.
- `normalizeNamespace(value): string | null` so aggregation groups `default`,
  empty, and null consistently.

### 2. CMS Migration

Add a new CMS migration, for example `0014_retrieval_usage_procs` or the next
available version.

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_<schema>_events_retrieval_usage
  ON <schema>.session_events (session_id, created_at DESC)
  WHERE event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched', 'graph.node_loaded');

CREATE INDEX IF NOT EXISTS idx_<schema>_events_graph_node_usage
  ON <schema>.session_events ((data->>'nodeKey'), created_at DESC)
  WHERE event_type = 'graph.node_loaded';
```

Stored procedures:

- `cms_get_session_retrieval_usage(p_session_id, p_since)`
- `cms_get_session_tree_retrieval_usage(p_session_id, p_since)`
- `cms_get_fleet_retrieval_usage(p_since, p_include_deleted)`
- `cms_get_session_graph_node_usage(p_session_id, p_since, p_limit)`
- `cms_get_session_graph_edge_search_usage(p_session_id, p_since, p_limit)`

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
- Event payloads must stay small and deterministic in shape. Cap optional preview
  fields, cap tag arrays if needed, and never include result arrays.
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

- Add tuner-only tools inside the existing tuner-tool branch.
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
- CMS aggregation returns per-session counts from seeded events.
- Graph node usage aggregates exact node anchors.
- Graph edge search usage aggregates predicate/from/to request shapes.
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

## Open Questions

1. Should free-text queries be stored as bounded previews, hashes only, or both?
   Recommendation: hash plus optional bounded preview for local/dev; hash-only if
   tenant privacy is a concern.
2. Should ordinary agents be allowed to read lineage-scoped retrieval usage, or
   should this remain agent-tuner-only? Recommendation: tuner-only first.
3. Should per-node usage include exact `nodeKey` strings? Recommendation: yes,
   because node keys are already explicit request inputs and are necessary for
   the requested "which nodes were loaded" view.
4. Should edge usage aggregate raw `predicate` text or only `predicateKey`?
   Recommendation: prefer `predicateKey`; hash raw `predicate` when no key is
   supplied.
