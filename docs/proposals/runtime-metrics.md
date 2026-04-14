# Proposal: Runtime Metrics

**Status:** Draft  
**Date:** 2026-04-10

## Problem

PilotSwarm captures rich per-session data (token usage, turns, events, duroxide counters) but none of it is exposed as proper metrics. There is no durable telemetry pipeline, no time-series aggregation, and no way to wire an external dashboard. Operators must query Postgres or read logs to answer basic questions like "what's my total token spend?" or "how many sessions are active right now?"

## Goals

1. Emit metrics from the worker process using the OpenTelemetry Metrics SDK.
2. Export metrics via OTLP using standard OpenTelemetry environment variables and a vendor-neutral collector pipeline.
3. Cover five metric domains: **LLM / session**, **agent tree**, **duroxide runtime**, **session persistence**, and **knowledge pipeline**.
4. Keep the hot path (turn execution) low overhead — counters/histograms are updated inline, not reconstructed at export time.
5. Zero-config local development by default, with standard OTel env vars enabling OTLP export in AKS.
6. Preserve backend flexibility: Prometheus/Mimir, Azure Monitor, or any OTLP-capable downstream system behind a Collector.

## Design

### Library choice

Use the OpenTelemetry JavaScript Metrics SDK with an OTLP metrics exporter and a `PeriodicExportingMetricReader`.

Recommended package set:

- `@opentelemetry/api`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/exporter-metrics-otlp-proto`

Recommended transport: **OTLP `http/protobuf`** to an in-cluster OpenTelemetry Collector.

Why this design:

- OTel is the most portable choice if we want one instrumentation surface for metrics now and traces/logs later.
- OTLP is the standard protocol in the OTel ecosystem and is supported by the Collector and many backends directly.
- A Collector absorbs batching, retries, auth, routing, and backend-specific export logic so workers stay simple.

The Collector is the recommended production receiver. Workers should emit OTLP to the Collector, and the Collector should export to the actual metrics backend.

### Metric Domains

The `Labels` column below maps directly to **OpenTelemetry metric attributes**. The metric names stay stable regardless of downstream backend.

The derived query examples later in this document are written in **PromQL** because Prometheus-compatible backends remain a strong default for Grafana dashboards even when instrumentation/export uses OpenTelemetry.

#### 1. LLM / Session Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `pilotswarm_sessions_total` | Counter | `state` (running, completed, failed, cancelled) | CMS state transitions |
| `pilotswarm_sessions_active` | Gauge | `agent_id`, `is_system` | CMS active count |
| `pilotswarm_turns_total` | Counter | `session_id`, `agent_id` | Incremented in `runTurn` activity |
| `pilotswarm_turn_duration_seconds` | Histogram | `agent_id`, `model` | Wall-clock time of each `runTurn` call |
| `pilotswarm_llm_active_seconds` | Counter | `model`, `agent_id` | Cumulative LLM processing time (measured inside `ManagedSession.runTurn` from send → final delta) |
| `pilotswarm_tokens_input_total` | Counter | `agent_id`, `model` | `assistant.usage` event `inputTokens` |
| `pilotswarm_tokens_output_total` | Counter | `agent_id`, `model` | `assistant.usage` event `outputTokens` |
| `pilotswarm_tokens_total` | Counter | `agent_id`, `model` | Sum of input + output tokens per usage event. Overall token spend across all sessions when aggregated. |
| `pilotswarm_tokens_session_total` | Counter | `session_id`, `agent_id`, `model` | Per-session token spend (input + output). Use for per-session cost attribution. High cardinality — see Label Cardinality section. |
| `pilotswarm_tokens_cache_read_total` | Counter | `agent_id`, `model` | `assistant.usage` event `cacheReadTokens` |
| `pilotswarm_tokens_cache_write_total` | Counter | `agent_id`, `model` | `assistant.usage` event `cacheWriteTokens` |
| `pilotswarm_context_utilization` | Gauge | `session_id`, `agent_id`, `model` | `SessionContextUsage.utilization` |
| `pilotswarm_context_compactions_total` | Counter | `session_id`, `agent_id` | Incremented on each compaction event |

#### 2. Agent / Sub-Agent Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `pilotswarm_agents_spawned_total` | Counter | `agent_id`, `parent_agent_id` | `spawn_agent` tool execution |
| `pilotswarm_agents_active` | Gauge | `agent_id` | CMS sessions with non-null `agent_id` in running state |
| `pilotswarm_agent_tree_depth` | Histogram | — | Depth of parent chain at spawn time |
| `pilotswarm_agent_session_turns` | Histogram | `agent_id` | `current_iteration` at session completion (turns-per-session distribution) |
| `pilotswarm_tool_calls_total` | Counter | `tool_name`, `agent_id` | `tool.execution_start` events |
| `pilotswarm_tool_errors_total` | Counter | `tool_name`, `agent_id` | `tool.execution_error` events |
| `pilotswarm_tool_duration_seconds` | Histogram | `tool_name` | Delta between `tool.execution_start` and `tool.execution_complete` |

#### 3. Duroxide Runtime Metrics

Sourced from `duroxideClient.getSystemMetrics()`, `runtime.metricsSnapshot()`, and `duroxideClient.getQueueDepths()`. Collected on a periodic poll (default 15s), not per-scrape.

| Metric | Type | Source |
|--------|------|--------|
| `duroxide_instances_total` | Gauge (with `status` label: running, completed, failed, suspended, terminated) | `JsSystemMetrics` |
| `duroxide_executions_total` | Counter | `JsSystemMetrics.totalExecutions` |
| `duroxide_history_events_total` | Counter | `JsSystemMetrics.totalEvents` |
| `duroxide_orch_starts_total` | Counter | `JsMetricsSnapshot.orchStarts` |
| `duroxide_orch_completions_total` | Counter | `JsMetricsSnapshot.orchCompletions` |
| `duroxide_orch_failures_total` | Counter (with `category` label: application, infrastructure, configuration, poison) | `JsMetricsSnapshot` |
| `duroxide_activity_success_total` | Counter | `JsMetricsSnapshot.activitySuccess` |
| `duroxide_activity_errors_total` | Counter (with `category` label: application, infrastructure, configuration, poison) | `JsMetricsSnapshot` |
| `duroxide_queue_depth` | Gauge (with `queue` label: orchestrator, worker, timer) | `JsQueueDepths` |
| `duroxide_dispatcher_items_fetched_total` | Counter (with `dispatcher` label: orchestrator, worker) | `JsMetricsSnapshot` |
| `duroxide_continue_as_new_total` | Counter | `JsMetricsSnapshot.orchContinueAsNew` |
| `duroxide_suborchestration_calls_total` | Counter | `JsMetricsSnapshot.suborchestrationCalls` |
| `duroxide_provider_errors_total` | Counter | `JsMetricsSnapshot.providerErrors` |

#### 4. Session Persistence Metrics

Measures Copilot session footprint on worker disk and the warm/cold lifecycle of session state.

Important distinction:

- `SessionMetadata.sizeBytes` already records the compressed `.tar.gz` snapshot size.
- If we want the actual **on-disk Copilot session footprint**, we should also measure the uncompressed local session directory size before dehydrate/checkpoint and after hydrate.

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `pilotswarm_session_local_state_size_bytes` | Gauge | `session_id`, `agent_id` | Last observed uncompressed size of the local Copilot session directory on worker disk. Measure by walking the session directory during checkpoint/dehydrate and after hydrate. Set to `0` after successful dehydrate because local files are removed. |
| `pilotswarm_session_snapshot_size_bytes` | Gauge | `session_id`, `agent_id` | Last observed compressed snapshot size (`.tar.gz`). Source of truth is tar size during checkpoint/dehydrate or `SessionMetadata.sizeBytes` from the durable snapshot. |
| `pilotswarm_session_dehydrations_total` | Counter | `session_id`, `agent_id`, `reason` | Incremented on successful `dehydrateSession` activity completion. |
| `pilotswarm_session_hydrations_total` | Counter | `session_id`, `agent_id` | Incremented on successful `hydrateSession` activity completion. |
| `pilotswarm_session_lossy_handoffs_total` | Counter | `session_id`, `agent_id`, `cause` | Incremented when dehydrate fails because local session state is missing and the runtime falls back to fresh-session replay. |
| `pilotswarm_sessions_dehydrated_active` | Gauge | `agent_id` | Current count of sessions that have a durable snapshot and are not currently warm on local disk. Derived from blob/session inventory on a periodic collector. |

#### 5. Knowledge Pipeline Metrics

Measures the effectiveness and cost of the shared facts/skills system. Without these, the knowledge pipeline runs blind — no visibility into whether curated skills are consumed, whether intake volume justifies the FM's curation cycles, or whether the injected index is worth its token cost.

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `pilotswarm_facts_intake_total` | Counter | `agent_id`, `topic` | Incremented in `store_fact` handler when key starts with `intake/` |
| `pilotswarm_facts_skills_active` | Gauge | — | Count of non-aged-out skills in the facts table. Updated by periodic poll or FM cycle. |
| `pilotswarm_facts_asks_open` | Gauge | — | Count of asks with `status=open`. Updated by periodic poll or FM cycle. |
| `pilotswarm_facts_promotions_total` | Counter | — | Incremented when FM writes to `skills/` (new skill or version bump). Detected in `store_fact` handler when `agentIdentity=facts-manager` and key starts with `skills/`. |
| `pilotswarm_facts_rejections_total` | Counter | — | Incremented when FM deletes an intake as noise (delete from `intake/` by FM). |
| `pilotswarm_facts_skill_reads_total` | Counter | `skill_key`, `agent_id` | Incremented in `read_facts` handler when a task agent reads from `skills/` with a specific key (read-through, not index injection). |
| `pilotswarm_facts_index_injections_total` | Counter | `agent_id` | Incremented each time `loadKnowledgeIndex` activity runs and returns skills/asks. |
| `pilotswarm_facts_index_skills_count` | Histogram | — | Number of skills in the injected index per load. Tracks index growth over time. |
| `pilotswarm_facts_index_asks_count` | Histogram | — | Number of open asks in the injected index per load. |
| `pilotswarm_facts_index_tokens` | Histogram | — | Estimated token count of the injected skill+ask blocks per turn. Measures the token cost of the knowledge pipeline. |
| `pilotswarm_facts_corroboration_total` | Counter | `skill_key` | Incremented when FM updates a skill's `evidence_count` (corroborating intake incorporated). |
| `pilotswarm_facts_aged_out_total` | Counter | — | Incremented when FM marks a skill as `status: aged-out`. |

#### 6. Process Metrics

Process/runtime measurements should be emitted as OTel instruments instead of relying on a Prometheus-specific runtime collector.

Recommended split:

- **Worker-process metrics in app code** as ObservableGauges / Histograms:
    - resident memory
    - heap used / heap total
    - event loop lag
    - active handles
    - process CPU time
- **Node/host metrics in the Collector** using the Collector's host-level receivers when needed.

This keeps worker instrumentation focused on PilotSwarm behavior and avoids mixing node-level host monitoring concerns into the app process.

### Computed / Derived Metrics (at query time)

These are not stored as raw metrics — they're computed in the downstream metrics backend. The examples below assume Prometheus/Mimir-style querying via PromQL.

| Insight | PromQL |
|---------|--------|
| **Turns/sec** | `rate(pilotswarm_turns_total[5m])` |
| **Avg turns per session** | `pilotswarm_turns_total / pilotswarm_sessions_total{state="completed"}` or use `pilotswarm_agent_session_turns` histogram |
| **Overall token spend** | `sum(pilotswarm_tokens_total)` — total tokens consumed across all sessions, models, agents |
| **Token spend by model** | `sum by (model)(pilotswarm_tokens_total)` — breakdown by model |
| **Token spend by agent** | `sum by (agent_id)(pilotswarm_tokens_total)` — breakdown by agent type |
| **Token spend per session** | `sum by (session_id)(pilotswarm_tokens_session_total)` — per-session cost attribution |
| **Token rate (tokens/sec)** | `rate(pilotswarm_tokens_total[5m])` — aggregate throughput |
| **Token rate by model** | `sum by (model)(rate(pilotswarm_tokens_total[5m]))` — per-model throughput |
| **Token rate by agent** | `sum by (agent_id)(rate(pilotswarm_tokens_total[5m]))` — which agents consume the most tokens per second |
| **Input/output ratio** | `rate(pilotswarm_tokens_input_total[5m]) / rate(pilotswarm_tokens_output_total[5m])` — high ratios may indicate large context injection or prompt bloat |
| **LLM active ratio** | `rate(pilotswarm_llm_active_seconds[5m])` (fraction of wall time spent in LLM) |
| **Cache hit ratio** | `rate(pilotswarm_tokens_cache_read_total[5m]) / rate(pilotswarm_tokens_input_total[5m])` |
| **Avg turn latency** | `rate(pilotswarm_turn_duration_seconds_sum[5m]) / rate(pilotswarm_turn_duration_seconds_count[5m])` |
| **Error rate** | `rate(duroxide_orch_failures_total[5m]) / rate(duroxide_orch_starts_total[5m])` |
| **Queue saturation** | `duroxide_queue_depth{queue="worker"} > 0` for alerting |
| **Hydration rate** | `rate(pilotswarm_session_hydrations_total[5m])` — how often cold sessions are being restored |
| **Dehydration rate** | `rate(pilotswarm_session_dehydrations_total[5m])` — how often warm sessions are being archived off worker disk |
| **Persistence churn by agent** | `sum by (agent_id)(rate(pilotswarm_session_hydrations_total[5m]) + rate(pilotswarm_session_dehydrations_total[5m]))` |
| **Current warm session footprint** | `sum by (session_id, agent_id)(pilotswarm_session_local_state_size_bytes)` |
| **Snapshot footprint** | `sum by (session_id, agent_id)(pilotswarm_session_snapshot_size_bytes)` |
| **Compression ratio** | `pilotswarm_session_snapshot_size_bytes / pilotswarm_session_local_state_size_bytes` — useful for storage planning |
| **Knowledge index token overhead** | `avg(pilotswarm_facts_index_tokens)` — avg tokens added per turn by skill/ask injection |
| **Intake→promotion rate** | `rate(pilotswarm_facts_promotions_total[1h]) / rate(pilotswarm_facts_intake_total[1h])` |
| **Skill utilization** | `rate(pilotswarm_facts_skill_reads_total[1h])` grouped by `skill_key` — which skills agents actually read |

### Architecture

```
┌─────────────────────────────────────────────────┐
│                PilotSwarmWorker                  │
│                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐ │
│  │Orchestr- │  │ManagedSession│  │  Duroxide  │ │
│  │  ation   │──│  .runTurn()  │  │  Runtime   │ │
│  └────┬─────┘  └──────┬───────┘  └─────┬─────┘ │
│       │               │                │        │
│       │  record metrics │  record metrics│        │
│       ▼               ▼                ▼        │
│  ┌─────────────────────────────────────────────┐│
│  │        OpenTelemetry MeterProvider          ││
│  │   (counters, gauges, histograms, views)     ││
│  └──────────────────┬──────────────────────────┘│
│                     │                           │
│  ┌──────────────────▼──────────────────────────┐│
│  │  OTLP Metric Exporter + Periodic Reader     ││
│  │      http/protobuf to Collector             ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
                      │
                      ▼
        OpenTelemetry Collector
                      │
                      ▼
    Prometheus/Mimir/Azure Monitor
              │
              ▼
           Grafana
```

### Export Topology

Each worker exports OTLP metrics on an interval. The workers are **not** scraped directly in the default design.

Recommended AKS topology:

1. Each worker sends OTLP metrics to an in-cluster OpenTelemetry Collector Service.
2. The Collector batches, retries, enriches, and exports metrics to the chosen backend.
3. Grafana queries that backend.
4. Optional: the backend remote-writes to long-term storage.

Recommended default for this repo: **OTLP push to a Collector**.

- It removes the question of "who polls every worker endpoint?"
- It avoids per-worker scrape configuration entirely.
- It gives us one integration point for Prometheus-compatible backends, Azure Monitor, or future vendor changes.
- It positions the repo to add traces and logs later without another telemetry migration.

Prometheus pull remains an **optional compatibility mode** later via either:

- the Collector exposing Prometheus-format metrics, or
- Prometheus receiving OTLP directly, or
- an OTel Prometheus exporter endpoint for local debugging.

If no Collector or OTLP-capable backend is deployed in AKS, **the worker exports go nowhere**. Instrumentation alone does not create storage or dashboards.

Important constraint: **the Collector is not a generic query API**. OpenTelemetry gives us an instrumentation model and an export protocol, but it does not define a standard backend query surface equivalent to PromQL. If we ever wanted management APIs to read from the telemetry pipeline directly, that would require a backend-specific query adapter.

For the simplified proposal, we avoid that entirely for management APIs: workers write **per-session metric summaries into the catalog**, and `PilotSwarmManagementClient` computes fleet views as SQL aggregates over those catalog rows. OTel remains the export path for dashboards, alerting, and long-term time-series analysis.

### Environment Topologies

The diagrams below show both planes:

- **Control/runtime path** — sessions, workers, PostgreSQL, blob/session state
- **Observability path** — OTel export, Collector, metrics backend

#### 1. Local Source Setup

This is the contributor/developer path described by `./run.sh local`: TUI local mode with 4 local workers, PostgreSQL local or remote, and repo-local session state under `.tmp/`.

Recommended observability stance:

- simplest local dev: `OTEL_METRICS_EXPORTER=console` or `none`
- recommended local observability testing: run a local Collector and point OTLP at `http://localhost:4318`

```text
 Developer Terminal
 ./run.sh local
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ TUI Local Mode                                              │
│ - terminal UI                                               │
│ - management surface                                        │
│ - 4 local workers                                           │
│ - OTel MeterProvider + OTLP exporter                        │
└──────────────┬───────────────────────────┬──────────────────┘
         │                           │
      control/runtime path        observability path
         │                           │
         ▼                           ▼
      ┌─────────────────┐         ┌──────────────────┐
      │ PostgreSQL      │         │ OTel Collector   │  optional
      │ local or remote │         │ localhost:4318   │  for local metrics work
      └────────┬────────┘         └────────┬─────────┘
         │                           │
         ▼                           ▼
      ┌─────────────────┐         ┌──────────────────┐
      │ .tmp/session-   │         │ Prometheus /     │  optional
      │ state/store     │         │ Grafana / other  │  backend on laptop
      │ .tmp/artifacts  │         │ OTLP-capable dst │
      └─────────────────┘         └──────────────────┘
```

Operational notes:

- This mode is best for validating instrumentation correctness and per-session UI surfaces.
- The TUI should read exact session stats from the management surface, not from PromQL.
- If no local Collector is running, local dev should degrade cleanly rather than block runtime use.

#### 2. Starter Docker Quickstart

The current starter appliance is a single multi-process container: portal, SSH daemon, two workers, and embedded PostgreSQL when `DATABASE_URL` is not provided.

For metrics, the cleanest shape is **one extra Collector container on the same Docker network**. Keep the starter appliance focused on PilotSwarm itself rather than baking Grafana/Prometheus into the image.

```text
 Browser Portal                    SSH TUI
 http://localhost:3001      ssh -p 2222 pilotswarm@localhost
     │                                 │
     └──────────────┬──────────────────┘
              ▼
      ┌───────────────────────────────────────────────┐
      │ pilotswarm-starter container                  │
      │                                               │
      │  portal process                               │
      │  worker-a                                     │
      │  worker-b                                     │
      │  sshd                                         │
      │  embedded PostgreSQL or external DATABASE_URL │
      │  /data volume: session-state, artifacts       │
      │  OTel OTLP export -> http://otel-collector:4318 │
      └──────────────────────┬────────────────────────┘
                 │ docker network
                 ▼
             ┌──────────────────────┐
             │ otel-collector       │
             │ companion container  │
             └──────────┬───────────┘
                  │
              ┌─────────┴─────────┐
              ▼                   ▼
         Prometheus / Mimir     Grafana optional
         or other local backend for quick demos
```

Operational notes:

- This keeps the quickstart path simple: one app container plus one observability container if you want metrics.
- If the starter runs without the companion Collector, use `console` or `none` locally rather than pretending metrics are collected.
- Portal and SSH TUI still consume curated management APIs, not raw metrics endpoints.

#### 3. AKS Production Setup

This is the production multi-node shape: dedicated worker pods, PostgreSQL, Azure Blob for dehydration/artifacts, and a cluster-level Collector pipeline.

```text
              Control / Runtime Plane

   Browser Portal / TUI / SDK Clients
            │
            ▼
      ┌───────────────────────────────┐
      │ Portal pod(s) / app clients   │
      │ management APIs for UI        │
      └──────────────┬────────────────┘
            │
            ▼
      ┌───────────────────────────────┐
      │ Azure PostgreSQL              │
      │ - duroxide schema             │
      │ - copilot_sessions            │
      │ - facts / mgmt summaries      │
      └──────────────┬────────────────┘
            │
      ┌───────────┴───────────┐
      ▼                       ▼
┌──────────────────┐    ┌─────────────────────┐
│ AKS worker pods  │    │ Azure Blob Storage  │
│ N replicas       │    │ dehydrated sessions │
│ run LLM turns    │    │ artifacts           │
└──────────────────┘    └─────────────────────┘


              Observability Plane

┌──────────────────┐
│ worker pods      │
│ OTLP export      │
└────────┬─────────┘
      ▼
┌───────────────────────────────┐
│ OTel Collector deployment     │
│ - otlp receiver               │
│ - batch / memory_limiter      │
│ - resource enrichment         │
└──────────────┬────────────────┘
         │
      ┌────────┴───────────────┐
      ▼                        ▼
┌───────────────┐      ┌────────────────┐
│ Prom/Mimir    │  or  │ Azure Monitor  │
│ backend       │      │ backend        │
└──────┬────────┘      └────────┬───────┘
    ▼                        ▼
           Grafana
```

Operational notes:

- This is where OTel pays off most: one instrumentation model, one Collector, backend flexibility.
- TUI/Portal fleet rollups should come from catalog aggregate queries over per-session metric summaries.
- Exact per-session operational state should come from the same catalog-backed management surface.

### Implementation Plan

#### Phase 1 — OTel bootstrap

1. Add OTel metric dependencies:
   - `@opentelemetry/api`
   - `@opentelemetry/sdk-metrics`
   - `@opentelemetry/resources`
   - `@opentelemetry/semantic-conventions`
   - `@opentelemetry/exporter-metrics-otlp-proto`
2. Create `src/otel-metrics.ts`:
   - `MeterProvider` bootstrap
   - metric instrument definitions
   - OTel `View` definitions for histogram bucket boundaries
   - `startOtelMetrics()` / `shutdownOtelMetrics()` lifecycle helpers
3. Wire `worker.ts` to start OTel metrics during worker boot with resource attributes such as:
   - `service.name=pilotswarm-worker`
   - `service.instance.id=$POD_NAME`
   - deployment environment / cluster labels from env
4. Use `PeriodicExportingMetricReader` with OTLP `http/protobuf` exporter, honoring standard OTel env vars.

#### Phase 2 — Core PilotSwarm metrics

5. Instrument `ManagedSession.runTurn()`:
   - Before/after timing → `pilotswarm_turn_duration_seconds`.
   - Increment `pilotswarm_turns_total`.
   - On `assistant.usage` event → increment token counters.
   - Track LLM active time (first `assistant.delta` to last `assistant.delta`).
6. Instrument session lifecycle in CMS provider:
   - `createSession()` → increment `pilotswarm_sessions_total{state="created"}`.
   - `updateSession({ state })` → update `pilotswarm_sessions_active` gauge.
7. Instrument `spawn_agent` handler → increment `pilotswarm_agents_spawned_total`.
8. Add ObservableGauges for process/runtime values (RSS, heap usage, event-loop lag, active handles).
9. Instrument session persistence lifecycle:
   - In checkpoint/dehydrate paths, walk the local session directory and set `pilotswarm_session_local_state_size_bytes` before archiving.
   - In checkpoint/dehydrate paths, set `pilotswarm_session_snapshot_size_bytes` from tar size / `SessionMetadata.sizeBytes`.
   - On successful `dehydrateSession`, increment `pilotswarm_session_dehydrations_total` and set local-state size to `0`.
   - On successful `hydrateSession`, increment `pilotswarm_session_hydrations_total` and re-measure local-state size after extraction.
   - On lossy handoff fallback, increment `pilotswarm_session_lossy_handoffs_total`.
   - Persist those per-session cumulative values into a catalog-backed summary row (for example `session_metric_summaries`) so management APIs can read exact per-session state without querying the telemetry backend.
10. Extend the catalog provider with aggregate reads over per-session metric summaries:
    - `getSessionPersistenceStats(sessionId)`
    - `getFleetPersistenceStats()` using `SUM` / `COUNT` / `GROUP BY agent_id`
    - `getFleetTokenStats()` using `SUM` / `GROUP BY agent_id, model`
    - Keep these as point-in-time totals and counts; do not require a time-series backend for management views.

#### Phase 3 — Duroxide metrics collector

11. Add a periodic collector (every 15s) in `worker.ts` that calls:
   - `duroxideClient.getSystemMetrics()` → update `duroxide_instances_*` gauges.
   - `runtime.metricsSnapshot()` → update all `duroxide_*` counters (converting absolute snapshots to monotonic counters via delta tracking).
   - `duroxideClient.getQueueDepths()` → update `duroxide_queue_depth` gauges.

#### Phase 4 — Tool & agent instrumentation

12. Instrument tool execution events → `pilotswarm_tool_calls_total`, `pilotswarm_tool_duration_seconds`.
13. On session completion, observe `current_iteration` into `pilotswarm_agent_session_turns` histogram.
14. Track sub-agent tree depth at spawn time.

#### Phase 5 — Knowledge pipeline metrics

15. Instrument `store_fact` handler:
    - When key starts with `intake/` → increment `pilotswarm_facts_intake_total` with `agent_id` and topic (second path segment).
    - When `agentIdentity=facts-manager` and key starts with `skills/` → increment `pilotswarm_facts_promotions_total`.
16. Instrument `read_facts` handler:
    - When a non-FM agent reads from `skills/` with a specific key → increment `pilotswarm_facts_skill_reads_total` with `skill_key` and `agent_id`.
17. Instrument `delete_fact` handler:
    - When FM deletes from `intake/` → increment `pilotswarm_facts_rejections_total`.
18. Instrument `loadKnowledgeIndex` activity:
    - Increment `pilotswarm_facts_index_injections_total`.
    - Observe `skills.length` into `pilotswarm_facts_index_skills_count` histogram.
    - Observe `asks.length` into `pilotswarm_facts_index_asks_count` histogram.
    - Estimate token count of the built prompt blocks and observe into `pilotswarm_facts_index_tokens` histogram.
19. Add a periodic collector (every 60s or on FM cycle) that queries the facts table:
    - Count non-aged-out skills → update `pilotswarm_facts_skills_active` gauge.
    - Count open asks → update `pilotswarm_facts_asks_open` gauge.

#### Phase 6 — Collector and backend integration

20. Add an OpenTelemetry Collector deployment/service in `deploy/k8s/` with:
    - OTLP receiver on `4317` / `4318`
    - `batch` and `memory_limiter` processors
    - resource enrichment / attribute processors as needed
    - exporter to the chosen backend
21. Decide backend target explicitly:
    - Prometheus-compatible path: Collector → Prometheus OTLP receiver or `prometheusremotewrite` / Mimir
    - Azure path: Collector → Azure Monitor managed exporter path
22. Ship a starter Grafana dashboard JSON (in `deploy/grafana/`) with panels for:
    - **Token spend**: overall, by model, by agent, per session
    - **Token rate**: aggregate and per-model tokens/sec
    - **Session activity**: turns/sec, active sessions, error rate
    - **Session persistence**: warm local bytes, snapshot bytes, hydration/dehydration rates, lossy handoffs
    - **Knowledge pipeline**: active skills, intake volume, promotion rate, skill read-through heatmap, index token overhead
    - **Duroxide**: queue depth, orchestration starts/completions, failure rate

### TUI / Portal Consumption

Yes — these numbers can be shown in TUI and Portal **without Grafana**.

This simplified proposal uses a single management query model:

1. Workers write **per-session metric summaries** into the catalog.
2. `PilotSwarmManagementClient` exposes both per-session views and fleet aggregates from the catalog.
3. TUI and Portal consume those curated management APIs through the existing transport/RPC layer.
4. OTel remains the export path for Grafana, alerting, and true time-window analysis.

What should **not** happen:

- the UI parsing raw OTLP payloads
- the UI talking to the Collector directly as if it were a query service
- the UI embedding PromQL/Azure query logic itself

Recommended public management methods:

- `getSessionPersistenceStats(sessionId)` — per-session hydration/dehydration counts, last observed local-state size, last snapshot size, lossy handoff count, current warm/dehydrated state.
- `getFleetPersistenceStats()` — aggregate counts by agent, total warm bytes, total snapshot bytes, dehydration/hydration totals.
- `getFleetTokenStats()` — overall token totals and breakdowns by agent/model, aggregated from per-session catalog rows.

Why this is the better UI path:

- TUI and Portal already consume runtime/admin data via the management transport rather than Grafana.
- It gives local, Docker, and AKS the same management query model.
- Fleet-level views become straightforward SQL aggregates over catalog summaries.
- Per-session inspector views want a stable, curated payload, not backend-specific query logic.
- This avoids coupling the UI to PromQL, Azure Monitor query syntax, or Collector internals.

Recommended split of responsibility:

- **Use catalog-backed management data for UI and admin reads**:
    - one session's current persistence state
    - one session's last observed local size / snapshot size
    - one session's exact hydration/dehydration counters
    - one session's lossy handoff details
    - fleet totals by agent and model via `SUM` / `COUNT` / `GROUP BY`
- **Use OTel-backed backends for observability workflows**:
    - Grafana dashboards
    - alerting
    - time-window rates (`rate(...[5m])`)
    - long-term historical analysis

Why not use OTel alone for management views:

- OTel metrics are time-series telemetry, not durable entity records.
- `session_id`-labeled series are the first candidates for cardinality controls and short retention.
- The Collector does not store queryable state.
- There is no vendor-neutral OTel query language the management client can rely on.

So the simplified answer is: **management reads come from catalog summaries, and fleet metrics are just aggregates over those per-session catalog rows**. OTel is still valuable, but as an export/reporting system rather than the management query path.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `OTEL_METRICS_EXPORTER` | `otlp` | Metrics exporter selection. Use `none` to disable or `console` for local debugging. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base OTLP endpoint. Metrics go to `/v1/metrics` unless a signal-specific endpoint is set. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | (unset) | Metrics-specific OTLP endpoint, used as-is when set. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | OTLP transport. Prefer `http/protobuf` for Node workers. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Interval between metric export attempts in milliseconds. |
| `OTEL_METRIC_EXPORT_TIMEOUT` | `30000` | Maximum time allowed for each export attempt in milliseconds. |
| `OTEL_SERVICE_NAME` | `pilotswarm-worker` | Standard OTel service name resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | (none) | Comma-separated resource attributes such as `deployment.environment=prod,k8s.cluster.name=aks-1`. |
| `OTEL_SDK_DISABLED` | `false` | Disable all OTel SDK signals when `true`. |
| `METRICS_DUROXIDE_POLL_MS` | `15000` | How often to poll duroxide for runtime metrics. |

### Label Cardinality

`session_id` labels are used on `pilotswarm_tokens_session_total`, `pilotswarm_context_utilization`, and the session persistence metrics where per-session attribution is essential. All other token metrics use `agent_id` + `model` labels only, keeping cardinality bounded by the number of distinct agent types × models (typically < 50 combinations).

`skill_key` labels on `pilotswarm_facts_skill_reads_total` have cardinality bounded by the number of curated skills (typically < 100). If skill count grows large, this can be replaced with topic-level aggregation (`skill_topic`).

For high-session-count deployments, `session_id`-labeled metrics can be dropped by configuration or replaced with `agent_id`-only aggregation. The Collector and downstream backend should pre-aggregate where possible before long-term retention for dashboarding, while management surfaces continue to read exact per-session summaries from the catalog.

Per-session token attribution and session-persistence gauges are useful, but they are also the metric families most likely to become expensive in long-lived, high-churn clusters. Treat these as operator features, not default forever-retained time series. For long-term audit trails and per-session UI details, the safer source of truth remains CMS/session storage/blob metadata or a management snapshot API.

Do not rely on SDK default histogram buckets for the important distributions. Define OTel `View`s explicitly for turn latency, tool duration, queue depth, and knowledge-index token overhead so dashboards and alerts remain stable across SDK upgrades.

### What This Doesn't Cover

- **Distributed tracing rollout** — OTel makes this easier later, but this proposal is still metrics-first.
- **Log-based metrics** (parsing duroxide trace logs) — structured metrics are preferred.
- **Direct worker-to-vendor export as the default** — possible, but a Collector is the safer operational boundary.
- **Backend lock-in** — the proposal intentionally stops at OTLP + Collector and does not mandate one storage vendor.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **OpenTelemetry SDK + OTLP + Collector** (chosen) | Industry standard, one telemetry model for metrics/traces/logs, vendor-neutral, standard env vars, solves "who polls workers" cleanly | More moving pieces than a single `/metrics` endpoint, requires Collector deployment and configuration |
| **prom-client** | Simple, very common in pure Prometheus stacks, easy local `/metrics` debugging | Prometheus-specific API surface, scrape topology burden remains, weaker path to traces/logs convergence |
| **OTel Prometheus exporter** | Still OTel-instrumented while keeping a scrape endpoint | Reintroduces direct scrape topology and the "who polls every worker?" question |
| **Direct OTLP to backend without Collector** | Fewer components at small scale | Harder to manage retries, auth, routing, batching, and backend swaps in production |
| **Custom JSON endpoint** | Zero deps | Not scrapeable by Prometheus, must build own aggregation |
| **StatsD/Graphite push** | Real-time | Requires a StatsD daemon, UDP unreliable, less ecosystem support in K8s |

## Dependencies

- `@opentelemetry/api`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/exporter-metrics-otlp-proto`
- Optional: OpenTelemetry Collector deployment/config under `deploy/k8s/`
- No changes to duroxide.
- No changes to the Copilot SDK.
