# Proposal: Runtime Metrics

**Status:** Draft  
**Date:** 2026-04-10

## Problem

PilotSwarm captures rich per-session data (token usage, turns, events, duroxide counters) but none of it is exposed as proper metrics. There is no `/metrics` endpoint, no time-series aggregation, and no way to wire an external dashboard. Operators must query Postgres or read logs to answer basic questions like "what's my total token spend?" or "how many sessions are active right now?"

## Goals

1. Expose a Prometheus-compatible `/metrics` HTTP endpoint from the worker process.
2. Use **standard Node.js libraries only** — no OpenTelemetry SDK, no vendor agents.
3. Cover three metric domains: **LLM / session**, **agent tree**, and **duroxide runtime**.
4. Keep the hot path (turn execution) allocation-free — counters/gauges are updated inline, not computed on scrape.
5. Zero config for local dev (metrics server off by default), single env var to enable for AKS.

## Design

### Library choice

[`prom-client`](https://github.com/siimon/prom-client) (MIT, 14M weekly downloads) — the de-facto Prometheus client for Node.js. Exposes a registry with `.metrics()` that returns the text exposition format. No native addons, no OTel dependency.

A lightweight built-in HTTP server (`node:http`) serves `GET /metrics` on a configurable port (default `9090`). This avoids adding Express or Fastify as a dependency.

### Metric Domains

#### 1. LLM / Session Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `pilotswarm_sessions_total` | Counter | `state` (running, completed, failed, cancelled) | CMS state transitions |
| `pilotswarm_sessions_active` | Gauge | `agent_id`, `is_system` | CMS active count |
| `pilotswarm_turns_total` | Counter | `session_id`, `agent_id` | Incremented in `runTurn` activity |
| `pilotswarm_turn_duration_seconds` | Histogram | `agent_id`, `model` | Wall-clock time of each `runTurn` call |
| `pilotswarm_llm_active_seconds` | Counter | `model`, `agent_id` | Cumulative LLM processing time (measured inside `ManagedSession.runTurn` from send → final delta) |
| `pilotswarm_tokens_input_total` | Counter | `session_id`, `agent_id`, `model` | `assistant.usage` event `inputTokens` |
| `pilotswarm_tokens_output_total` | Counter | `session_id`, `agent_id`, `model` | `assistant.usage` event `outputTokens` |
| `pilotswarm_tokens_cache_read_total` | Counter | `model` | `assistant.usage` event `cacheReadTokens` |
| `pilotswarm_tokens_cache_write_total` | Counter | `model` | `assistant.usage` event `cacheWriteTokens` |
| `pilotswarm_context_utilization` | Gauge | `session_id` | `SessionContextUsage.utilization` |
| `pilotswarm_context_compactions_total` | Counter | `session_id` | Incremented on each compaction event |

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

#### 4. Process Metrics

`prom-client` includes a `collectDefaultMetrics()` call that auto-registers Node.js process metrics:

- `process_cpu_seconds_total`
- `process_resident_memory_bytes`
- `nodejs_heap_size_total_bytes` / `nodejs_heap_size_used_bytes`
- `nodejs_eventloop_lag_seconds`
- `nodejs_active_handles_total`
- GC pause durations

These come free with one line of code.

### Computed / Derived Metrics (at query time)

These are not stored as raw metrics — they're computed in Prometheus/Grafana using PromQL:

| Insight | PromQL |
|---------|--------|
| **Turns/sec** | `rate(pilotswarm_turns_total[5m])` |
| **Avg turns per session** | `pilotswarm_turns_total / pilotswarm_sessions_total{state="completed"}` or use `pilotswarm_agent_session_turns` histogram |
| **Token spend per session** | `pilotswarm_tokens_input_total + pilotswarm_tokens_output_total` grouped by `session_id` |
| **Token rate (tokens/sec)** | `rate(pilotswarm_tokens_output_total[5m])` |
| **LLM active ratio** | `rate(pilotswarm_llm_active_seconds[5m])` (fraction of wall time spent in LLM) |
| **Cache hit ratio** | `rate(pilotswarm_tokens_cache_read_total[5m]) / rate(pilotswarm_tokens_input_total[5m])` |
| **Avg turn latency** | `rate(pilotswarm_turn_duration_seconds_sum[5m]) / rate(pilotswarm_turn_duration_seconds_count[5m])` |
| **Error rate** | `rate(duroxide_orch_failures_total[5m]) / rate(duroxide_orch_starts_total[5m])` |
| **Queue saturation** | `duroxide_queue_depth{queue="worker"} > 0` for alerting |

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
│       │  inc counters  │  inc counters  │        │
│       ▼               ▼                ▼        │
│  ┌─────────────────────────────────────────────┐│
│  │          prom-client Registry               ││
│  │  (counters, gauges, histograms)             ││
│  └──────────────────┬──────────────────────────┘│
│                     │                           │
│  ┌──────────────────▼──────────────────────────┐│
│  │   node:http server  GET /metrics  :9090     ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
                      │
                      ▼
              Prometheus scrape
                      │
                      ▼
                   Grafana
```

### Implementation Plan

#### Phase 1 — Core counters (MVP)

1. Add `prom-client` dependency.
2. Create `src/metrics.ts`:
   - Singleton registry with all counters/gauges/histograms defined above.
   - `startMetricsServer(port)` — starts `node:http` server, returns `{ close() }`.
   - `getMetrics()` — returns registry in Prometheus text format (for testing without HTTP).
3. Instrument `ManagedSession.runTurn()`:
   - Before/after timing → `pilotswarm_turn_duration_seconds`.
   - Increment `pilotswarm_turns_total`.
   - On `assistant.usage` event → increment token counters.
   - Track LLM active time (first `assistant.delta` to last `assistant.delta`).
4. Instrument session lifecycle in CMS provider:
   - `createSession()` → increment `pilotswarm_sessions_total{state="created"}`.
   - `updateSession({ state })` → update `pilotswarm_sessions_active` gauge.
5. Instrument `spawn_agent` handler → increment `pilotswarm_agents_spawned_total`.
6. Wire `worker.ts` to call `startMetricsServer()` when `METRICS_PORT` env var is set.

#### Phase 2 — Duroxide metrics collector

7. Add a periodic collector (every 15s) in `worker.ts` that calls:
   - `duroxideClient.getSystemMetrics()` → update `duroxide_instances_*` gauges.
   - `runtime.metricsSnapshot()` → update all `duroxide_*` counters (converting absolute snapshots to monotonic counters via delta tracking).
   - `duroxideClient.getQueueDepths()` → update `duroxide_queue_depth` gauges.
8. Enable `prom-client` default metrics for process-level stats.

#### Phase 3 — Tool & agent instrumentation

9. Instrument tool execution events → `pilotswarm_tool_calls_total`, `pilotswarm_tool_duration_seconds`.
10. On session completion, observe `current_iteration` into `pilotswarm_agent_session_turns` histogram.
11. Track sub-agent tree depth at spawn time.

#### Phase 4 — AKS / Grafana integration

12. Add Prometheus `ServiceMonitor` or pod annotation (`prometheus.io/scrape: "true"`, `prometheus.io/port: "9090"`) to `deploy/k8s/worker-deployment.yaml`.
13. Ship a starter Grafana dashboard JSON (in `deploy/grafana/`) with panels for token spend, turns/sec, active sessions, queue depth, and error rate.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `METRICS_PORT` | (unset = disabled) | Port for the `/metrics` HTTP endpoint. Set to `9090` to enable. |
| `METRICS_DUROXIDE_POLL_MS` | `15000` | How often to poll duroxide for runtime metrics. |
| `METRICS_DEFAULT_LABELS` | (none) | Comma-separated `key=value` pairs added to all metrics (e.g. `env=prod,cluster=aks-1`). |

### Label Cardinality

`session_id` labels are used on a few select metrics (token counters, context utilization) where per-session breakdown is essential. For high-session-count deployments, these can be dropped by configuration or replaced with `agent_id`-only aggregation. The Prometheus remote-write or recording-rule layer can pre-aggregate before long-term storage.

All histogram buckets use prom-client defaults (tailored to latency in seconds) unless overridden.

### What This Doesn't Cover

- **Distributed tracing** (OpenTelemetry spans) — out of scope, can layer on later.
- **Log-based metrics** (parsing duroxide trace logs) — structured metrics are preferred.
- **Push-based export** (StatsD, OTLP push) — pull-based Prometheus is sufficient for AKS.
- **Multi-worker aggregation** — each worker exposes its own `/metrics`; Prometheus handles federation.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **OpenTelemetry SDK** | Industry standard, auto-instrumentation | Heavy dependency tree (~40 packages), complex config, overkill for current scale |
| **Custom JSON endpoint** | Zero deps | Not scrapeable by Prometheus, must build own aggregation |
| **StatsD/Graphite push** | Real-time | Requires a StatsD daemon, UDP unreliable, less ecosystem support in K8s |
| **prom-client** (chosen) | Lightweight, Prometheus-native, one dependency, huge ecosystem | Pull-only (fine for K8s) |

## Dependencies

- `prom-client` (npm) — single production dependency added.
- No changes to duroxide.
- No changes to the Copilot SDK.
