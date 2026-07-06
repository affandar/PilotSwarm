# MCP ↔ Web API Parity (Full-Fleet Operator Surface)

> **Status:** Implemented (2026-07-05)
> **Date:** 2026-07-05
> **As-built notes:** all seven gap groups shipped in `packages/app/mcp`
> (tools split per group under `src/tools/`, capability plumbing in
> `context.ts`). Deviations from the sketch: `system_message` on
> `create_session` in web mode creates the session and reports
> `system_message_applied: false` (the Web API has no carrier; failing hard
> broke the canonical flow), local model-provider auto-discovery is skipped in
> web mode (deployment is the model-list truth), per-session
> `retrieval_usage` is omitted from `get_session_metrics` (no Web API route —
> fleet-level retrieval usage lives in `get_fleet_overview`), and the server
> now ships MCP `instructions` (boundary, preflight, agent-catalog
> interrogation, repo pointers). Post-ship corrections: create_session's
> worker-claim guard is REMOVED entirely — queue-and-monitor semantics
> (PilotSwarm is durable/async; callers watch session status via
> get_session_detail / get_session_events, no liveness probing); the
> worker-count signal is surfaced as `embedded_workers` (the Web API counts
> portal-embedded workers only; dedicated worker pods report 0). Post-ship
> addition: `debug_session` — the agent-tuner's read-only diagnostic surface
> as one include-driven tool — backed by seven NEW Web API operations
> (session/tree retrieval usage, session/fleet graph node usage, edge-search
> usage, graph searches) that ended the web-management-client's
> "retrieval/graph observability is direct-mode-only" carve-out. Tests:
> `test/unit/registration.unit.mjs`, `test/unit/dispatch.unit.mjs`,
> `test/integration/parity.live.mjs` (runs against base and horizon-enabled
> deployments).
> **Goal:** Let an LLM operator (Claude via MCP) manage the entire PilotSwarm
> fleet with the same reach as the portal UX — the MCP server in Web API mode
> already runs under the deployment's own authz, but exposes only a fraction
> of the operations the API offers. Close the gap.
> **Builds on:** [pilotswarm-web-api](./pilotswarm-web-api.md) (implemented),
> [facts-graph-web-api](./facts-graph-web-api.md) (implemented 2026-07-02 —
> built the facts/graph data-plane *"for the MCP server first"*; this proposal
> is that anticipated consumer), and
> [mcp-server-and-agent](../proposals-impl/mcp-server-and-agent.md) (as-built).

---

## Summary

Scenario: "god-mode" fleet management — an MCP client trusted with the full
scope of the deployment (`--api-url`, portal-equivalent authz). Diffing the
Web API operations table ([docs/api/reference.md](../api/reference.md),
~80 operations) against the MCP server's current surface (20 tools,
15 resources) leaves **7 gap groups**. None require new Web API routes —
every proposed tool maps to an operation that already exists; this is purely
MCP-side wiring in `packages/app/mcp`.

**Boundary unchanged:** sub-agent spawn/message/cancel stay in-loop (they are
not on the Web API either); harvester machinery (`mergeGraphNodes`,
`removeGraphEvidence`) and secret-bearing `configureEmbedder` remain excluded;
`send_command` stays direct-mode-only. God-mode means *full Web API parity*,
not a bypass of those seams.

---

## Gap catalog & proposed tools

### G1 — Capability & identity discovery (prereq for G2/G7)

Nothing today tells an MCP client what this deployment can do or who it is.

| Proposed | Maps to |
|---|---|
| `get_capabilities` tool + `pilotswarm://capabilities` resource | `GET /facts/capabilities`, `GET /auth/me`, `GET /bootstrap` |

Returns `{ mode: "web"|"direct", facts: { search, embedder }, graph, admin,
workers, default_model }`. Two-layer discovery: conditional tool registration
(absent capability ⇒ tool absent from `tools/list`) **plus** this descriptor
for the shape of what's present. `admin` comes from `/auth/me` — the
**[admin]**-tagged operations (embedder start/stop, facts purge, namespace
upsert/delete) 403 for non-admin tokens; surfacing the role lets the client
plan instead of probe.

### G2 — Enhanced facts & graph data-plane

The Web API data-plane exists (facts-graph-web-api, implemented); the MCP
holds `ctx.facts` at the base `FactStore` type and never constructs a graph
store. Register conditionally: enhanced tools iff `isEnhancedFactStore(facts)`,
graph tools iff `createWebGraphStore(api)` returns non-null (web) /
`createGraphStoreForUrl(...)` (direct).

| Proposed | Maps to |
|---|---|
| `search_facts`, `similar_facts` | `POST /facts/search`, `POST /facts/similar` |
| `embedder_status`, `start_embedder` [admin], `stop_embedder` [admin] | `GET/POST /facts/embedder*` |
| `graph_search_nodes`, `graph_search_edges`, `graph_neighbourhood` | `POST /graph/nodes/search`, `/edges/search`, `/neighbourhood` |
| `graph_upsert_node`, `graph_upsert_edge`, `graph_delete_node`, `graph_delete_edge` | `POST /graph/nodes`, `/edges`, `…/delete` |
| `graph_stats` | `GET /graph/stats` |
| `list_graph_namespaces`, `get_graph_namespace`, `upsert_graph_namespace` [admin], `delete_graph_namespace` [admin] | `GET/POST/DELETE /graph/namespaces*` |

New resources: `pilotswarm://graph/stats`, `pilotswarm://graph/namespaces`.

### G3 — Turn & queue control

An operator can currently only kill a whole session (`abort_session`). The
portal can do turn-level surgery.

| Proposed | Maps to |
|---|---|
| `stop_turn` | `POST /management/sessions/:id/stop-turn` — abort the in-flight turn, keep the session |
| `complete_session` | `POST /management/sessions/:id/complete` — mark done (vs cancel) |
| `cancel_pending_messages` | `POST /sessions/:id/cancel-pending` |
| `send_session_event` | `POST /sessions/:id/events` — custom event injection |

Parameter parity on existing tools: `send_message` gains `enqueue_only` +
`client_message_ids` (without ids, `cancel_pending_messages` is unusable);
`switch_model` and `create_session` gain `reasoning_effort`; `create_session`
gains `group_id` and (for-agent) `splash`. **Verify item:** `system_message`
on `create_session` appears to have no Web API carrier (`POST /sessions` body
is `{model, reasoningEffort, groupId}`) — confirm whether it silently drops in
web mode today, then either wire it server-side or document it direct-only.

### G4 — Artifacts (entire category missing)

Agents produce artifacts; the operator managing them can't see any of it.

| Proposed | Maps to |
|---|---|
| `list_artifacts`, `get_artifact` (`include: [meta, text]`) | `GET …/artifacts`, `…/meta`, `…/text` |
| `upload_artifact`, `delete_artifact` | `PUT/DELETE …/artifacts/:filename` |

Binary content stays over HTTP — `get_artifact` returns the
`…/download` URL rather than base64-inflating MCP responses. New resource:
`pilotswarm://sessions/{id}/artifacts`.

### G5 — Session groups (entire category missing)

Groups are the fleet-batching primitive (create N sessions in a group, then
cancel/complete the group as a unit) — exactly the lever a fleet operator
needs.

| Proposed | Maps to |
|---|---|
| `list_session_groups` | `GET /management/session-groups` (+ `GET …/:groupId` sessions via existing list filter) |
| `manage_session_group` with `action: create \| update \| delete \| assign \| move \| cancel \| complete` | the seven `POST/PATCH/DELETE /management/session-groups*` routes |

Consolidated into one action-dispatched write tool to keep tool-count growth
sane (7 routes → 2 tools).

### G6 — Observability & forensics

The biggest count of missing read-only operations. Consolidate by axis rather
than one tool per route:

| Proposed | Maps to |
|---|---|
| `get_session_metrics` — `include: [summary, tokens_by_model, skill_usage, retrieval_usage, facts_stats, orchestration_stats]`, `tree: bool` | `metric-summary`, `tokens-by-model`, `skill-usage`, `tree-skill-usage`, `facts-stats`, `tree-facts-stats`, `orchestration-stats` |
| `get_fleet_overview` — `include: [stats, skill_usage, retrieval_usage, user_stats, top_emitters, shared_facts, tombstones]`, `since` | the seven `GET /management/fleet|users|facts|events/*` reads |
| `list_child_outcomes` / child-outcome detail | `…/:parentSessionId/child-outcomes`, `/management/child-outcomes/:childSessionId` — what did my sub-agents conclude, without dumping transcripts |
| `get_execution_history`, `export_execution_history` | `…/execution-history`, `…/export-execution-history` (export lands as an artifact → G4 retrieves it) |
| Extend `get_session_events` with `before_seq` (history paging) + `event_types` (server-side filter) | `events-before`, `eventTypes` param |
| Extend `list_sessions` with `limit`/`cursor`/`include_deleted` | `GET /management/sessions` (keyset pagination — the current unpaginated list won't scale to fleet size) |

### G7 — Ops preflight & system health

`create_session` already rolls back with `no_worker_claimed` when no worker is
live — but the operator can't check worker liveness *before* acting, and
`list_registered_agents` reads local `--plugin` dirs, which in web mode can
diverge from what the deployment will actually accept.

| Proposed | Maps to |
|---|---|
| `get_system_status` — workers, log config, session-creation policy, creatable agents | `GET /system/workers`, `/system/log-config`, `/session-creation-policy`, `/agents` |
| `restart_system_session` [admin] | `POST /management/sessions/:agentIdOrSessionId/restart-system` — bounce sweeper/resourcemgr |
| `facts_admin` [admin] — `action: purge \| prune_summaries` | `POST /facts/purge`, `/management/summaries/prune-deleted` |
| Fix `list_registered_agents` in web mode to call `GET /agents` (deployment truth), keeping plugin-dir reads for direct mode | `listCreatableAgents` |

**Deferred (out of scope):** current-user profile ops (`/me/*`) — identity
comes from the token, not profile settings; WS streaming (MCP subscription
poller covers change-notification; noted as future work in the original MCP
proposal).

Net tool growth: 20 → ~42 (G2 accounts for 15, all conditionally registered).

---

## Test plans

Infra: unit = `packages/app/mcp/test/unit/*.unit.mjs` (plain node, mocked
`ServerContext`, no DB); integration = `test/integration/*.live.mjs` against a
live deployment via `web-env.mjs` (`npm run test:mcp:integration:all`).

### Unit

- **Registration gating (G1/G2):** mock ctx permutations
  `{enhancedFacts: ±, graph: ±, admin: ±, webMode: ±}` → assert exact
  `tools/list` membership: no enhanced/graph tools on base ctx; no [admin]
  tools for non-admin; `send_command` absent in web mode. The zero-prompts
  fallback invariant in `server.ts` must survive.
- **Capabilities descriptor (G1):** descriptor equals ctx truth for every
  permutation; `graph` flag never derived from the fact store (separate
  injection assertion).
- **Dispatch & schemas (G5/G6):** `manage_session_group` rejects unknown
  `action`; `get_session_metrics`/`get_fleet_overview` map `include[]` →
  exactly the right mgmt calls (spy), unknown include rejected by schema;
  `get_session_events` rejects `after_seq`+`before_seq` together.
- **Error mapping:** 403 from an [admin] route → `isError` with actionable
  text (name the missing role); `GRAPH_UNSUPPORTED` (defensive, should be
  unreachable per the boundary) → `isError`, not a crash; artifact >2 MB
  upload → clear size error.

### Integration (live)

New files, one per group, following `tools.live.mjs` conventions:

- **`capabilities.live.mjs` (G1):** `get_capabilities` flags match
  `GET /facts/capabilities` fetched out-of-band; tool list is consistent with
  flags (graph:false deployment ⇒ zero `graph_*` tools).
- **`facts-graph.live.mjs` (G2):** store→`search_facts` (lexical hit)→
  `similar_facts`→delete; graph round-trip: upsert 2 nodes + edge →
  `graph_search_nodes` → `graph_neighbourhood(depth 1)` contains the edge →
  delete edge/node → `graph_stats` deltas; namespace list/get; embedder
  status (+start/stop iff admin).
- **`turn-control.live.mjs` (G3):** long-running prompt → `stop_turn` →
  session stays alive and accepts the next message; `send_message
  {enqueue_only, client_message_ids}` → `cancel_pending_messages` → message
  never executes; `complete_session` → status `completed`, not `cancelled`.
- **`artifacts.live.mjs` (G4):** upload text + binary(base64) → list →
  meta/text round-trip → download-URL fetch returns bytes → delete → 404.
- **`groups.live.mjs` (G5):** create group → create 2 sessions with
  `group_id` → assign a third → move one out → `complete` group → all member
  sessions completed → delete (must fail non-empty, succeed after ungroup).
- **`observability.live.mjs` (G6):** after a real turn, `get_session_metrics`
  tokens > 0 and tree rollup ≥ self; `get_fleet_overview` counts ≥ known
  created sessions; events `before_seq` pages backward without overlap;
  `event_types` filter returns only matching types; child-outcome listed
  after a spawn-tree run (agent-bound session).
- **`system.live.mjs` (G7):** `get_system_status.workers ≥ 1` before other
  suites run (turn the `no_worker_claimed` failure mode into a preflight
  assertion); creatable agents match `GET /agents`; non-admin token run:
  [admin] tools hidden and raw calls 403.

### Matrix

Run the live suite against three deployment shapes: (a) base (pg facts, no
graph, no-auth), (b) horizon-enabled (search+embedder+graph), (c) Entra
deployment with a non-admin token. (a) proves absence-gating, (b) proves the
full surface, (c) proves the admin seam.
