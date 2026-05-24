# SigNoZ Observability And Metrics

This document describes the intended SigNoZ/OpenTelemetry architecture for
PilotSwarm, the telemetry signals implemented by the current observability PR,
what is still missing, and the next metrics to add.

Status: this is an implementation note for the PR based on #29, currently
rebased as #39. It documents the net result after the cleanup commit that
removes the `pilotswarm.stuck_activities` metric.

## Goals

PilotSwarm needs two complementary observability surfaces:

1. Durable management data for product UI, agent-tuner investigations, and
   exact per-session reads.
2. Time-series telemetry for operational dashboards, alerting, and historical
   trend analysis.

The management path should keep using CMS-backed APIs such as
`PilotSwarmManagementClient`. The SigNoZ path should receive OpenTelemetry
traces and metrics from workers over OTLP.

## Intended Architecture

```text
PilotSwarm worker process
  |
  | Node preload: scripts/otel/register.mjs
  |
  | Custom spans:
  | - worker.bootstrap
  | - session.turn
  | - session.hydration
  | - session.dehydration
  |
  | Auto-instrumentation:
  | - Node runtime/library spans and metrics where enabled by OTel packages
  |
  v
OpenTelemetry SDK for Node.js
  |
  | OTLP HTTP trace export
  | OTLP HTTP metric export
  |
  v
SigNoZ OTLP ingest / OpenTelemetry Collector
  |
  v
SigNoZ storage and query layer
  |
  v
SigNoZ UI
  - Services: pilotswarm-worker
  - Traces: session.turn, session.hydration, session.dehydration
  - Metrics explorer: Node auto-instrumentation and future custom metrics
  - Dashboards and alerts: future work
```

The worker process should be the source of application-level telemetry because
it owns the Copilot SDK session, tool execution, hydration/dehydration, and the
duroxide runtime process.

## Implemented In The Current PR

### OTel Bootstrap

Implemented in `scripts/otel/register.mjs`.

| Capability | Status | Notes |
| --- | --- | --- |
| Node OTel SDK startup | Implemented | Starts `NodeSDK` when required env vars are present. |
| OTLP trace exporter | Implemented | Sends to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`. |
| OTLP metric exporter | Implemented | Sends to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`. |
| Node auto-instrumentation | Implemented | Uses `getNodeAutoInstrumentations()`. |
| Resource detection | Implemented | Uses `getResourceDetectors()`. |
| Bootstrap span | Implemented | Emits `worker.bootstrap` when SDK startup succeeds. |
| Optional debug logging | Implemented | `OTEL_LOG_LEVEL=debug`. |
| Graceful SDK shutdown | Implemented | Runs on `SIGTERM` and `beforeExit`. |

Current bootstrap env vars:

| Env var | Status | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Required | Base OTLP endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Required today | Header string parsed as `key=value,key2=value2`. Needed for SigNoZ Cloud ingestion keys, but should become optional for self-hosted SigNoZ. |
| `OTEL_SERVICE_NAME` | Optional | Defaults to `pilotswarm-service`. Recommended value: `pilotswarm-worker`. |
| `OTEL_LOG_LEVEL` | Optional | Set to `debug` for OTel diagnostics. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Optional | Metric export interval in ms. Defaults to `30000`. |

The root `npm run worker` script preloads the bootstrap:

```bash
node --env-file=.env.remote --import ./scripts/otel/register.mjs packages/sdk/examples/worker.js
```

### Custom Trace Spans

Implemented in `packages/sdk/src/session-proxy.ts` and
`scripts/otel/register.mjs`.

| Span | Tracer | Scenario |
| --- | --- | --- |
| `worker.bootstrap` | `pilotswarm-bootstrap` | Confirms the OTel bootstrap ran successfully. |
| `session.turn` | `pilotswarm-turns` | One worker turn, including model, token, tool, result, and worker attributes. |
| `session.dehydration` | `pilotswarm-lifecycle` | One dehydrate activity, including reason, result, snapshot size, and lossy handoff status. |
| `session.hydration` | `pilotswarm-lifecycle` | One hydrate activity, including success/error result. |

### Custom Metrics

No custom OTel metric instruments remain in the net PR after the cleanup commit.

The original #29 branch added `pilotswarm.stuck_activities`, but that metric was
removed because it queried the Postgres implementation tables inside duroxide
directly. Duroxide is provider-based, so PilotSwarm should not depend on the
`duroxide.worker_queue` table shape. Queue-depth telemetry should come from
duroxide's own metrics surface or management API.

The PR still creates an OTLP metric exporter and enables Node auto-instrumented
metrics. Those metric names and label sets are owned by the OpenTelemetry
instrumentation packages, not by PilotSwarm.

## Implemented Signal Spec

### `worker.bootstrap`

Emitted once when `scripts/otel/register.mjs` successfully starts the OTel SDK.

| Attribute | Type | Description |
| --- | --- | --- |
| `service.name` | string | Configured service name. |
| `telemetry.bootstrap` | boolean | Always `true`; marks successful bootstrap. |

Scenarios covered:

- Verify the worker process actually loaded the OTel bootstrap.
- Confirm SigNoZ ingestion works before waiting for a real session turn.
- Check service naming and resource attribution in SigNoZ.

Limitations:

- It is not a worker startup duration span. It is a marker span.
- It is only emitted if the bootstrap has endpoint/header env vars and starts.

### `session.turn`

Emitted around `runTurn` execution in the worker activity.

Initial attributes:

| Attribute | Type | Description |
| --- | --- | --- |
| `pilotswarm.session_id` | string | Session id. High cardinality; useful for trace investigation, not long-retention metrics labels. |
| `pilotswarm.turn_index` | number | Turn index, default `0`. |
| `pilotswarm.bootstrap` | boolean | Whether this is a bootstrap turn. |
| `pilotswarm.retry_count` | number | Retry count for the turn, default `0`. |
| `pilotswarm.nesting_level` | number | Sub-agent nesting level, default `0`. |
| `pilotswarm.has_parent_session` | boolean | Whether the session has a parent. |
| `pilotswarm.parent_session_id` | string | Parent session id, when present. |
| `pilotswarm.required_tool` | string | Required tool name, when present. |
| `pilotswarm.model` | string | Configured model, when present. |
| `pilotswarm.reasoning_effort` | string | Configured reasoning effort, when present. |
| `pilotswarm.worker_node_id` | string | Worker node id, when present. |

Final attributes:

| Attribute | Type | Description |
| --- | --- | --- |
| `pilotswarm.model_summary` | string | Model provider summary from the session manager. |
| `pilotswarm.tokens_input` | number | Input token delta observed during this turn. |
| `pilotswarm.tokens_output` | number | Output token delta observed during this turn. |
| `pilotswarm.tokens_cache_read` | number | Cache-read token delta observed during this turn. |
| `pilotswarm.tokens_cache_write` | number | Cache-write token delta observed during this turn. |
| `pilotswarm.tool_calls` | number | Count of `tool.execution_start` events during the turn. |
| `pilotswarm.tool_errors` | number | Count of failed `tool.execution_complete` events during the turn. |
| `pilotswarm.tool_names` | string | Comma-joined sorted tool names observed during the turn. |
| `pilotswarm.turn_result` | string | Final `TurnResult.type`, when a result exists. |

Error behavior:

- Exceptions are recorded on the span with `recordException` and status `ERROR`.
- A final `TurnResult` of type `error` also marks the span `ERROR`.

Scenarios covered:

- Turn latency by model, worker, parent/child status, and nesting level.
- Turn error rate by model, worker, and required tool.
- Per-turn token usage and cache behavior.
- Per-turn tool call and tool error visibility.
- Sub-agent turn behavior through nesting and parent attributes.
- Routing diagnostics by `pilotswarm.worker_node_id`.

Limitations:

- Token fields are per-turn deltas even though the names do not include
  `_delta`. Dashboards should treat them as turn-local values.
- `pilotswarm.tool_names` is a comma-separated string. A future change should
  use a string-array attribute if supported cleanly by the backend.
- This is a trace span, not a metrics histogram. Latency is queryable from span
  duration, but no custom histogram is exported yet.

### `session.dehydration`

Emitted around the dehydrate activity.

Initial attributes:

| Attribute | Type | Description |
| --- | --- | --- |
| `pilotswarm.session_id` | string | Session id. |
| `pilotswarm.dehydration_reason` | string | Dehydrate reason, default `unknown`. |
| `pilotswarm.worker_node_id` | string | Worker node id. |

Result attributes:

| Attribute | Type | Description |
| --- | --- | --- |
| `pilotswarm.dehydration_result` | string | `completed`, `lossy_handoff`, or `error`. |
| `pilotswarm.lossy_handoff` | boolean | `true` when the worker lost local session state before dehydrate completed. |
| `pilotswarm.snapshot_size_bytes` | number | Snapshot size after successful dehydrate, when available. |

Error behavior:

- Missing local session state marks the span as `ERROR` with result
  `lossy_handoff` and records the existing lossy handoff CMS event.
- Other failures record the exception, set result `error`, and mark the span
  `ERROR`.

Scenarios covered:

- Dehydrate latency and error rate.
- Lossy handoff detection.
- Snapshot size distribution.
- Dehydrate reason analysis.
- Worker-local lifecycle diagnostics.

Limitations:

- Snapshot size is read from the session store only on successful dehydrate and
  only when available.
- Counters are still maintained through CMS summaries, not custom OTel counters.

### `session.hydration`

Emitted around the hydrate activity.

Initial attributes:

| Attribute | Type | Description |
| --- | --- | --- |
| `pilotswarm.session_id` | string | Session id. |
| `pilotswarm.worker_node_id` | string | Worker node id. |

Result attributes:

| Attribute | Type | Description |
| --- | --- | --- |
| `pilotswarm.hydration_result` | string | `completed` or `error`. |

Error behavior:

- Hydrate failures record the exception and mark the span `ERROR`.

Scenarios covered:

- Hydrate latency and error rate.
- Worker handoff diagnostics.
- Session recovery path visibility.

Limitations:

- Hydration counters are still maintained through CMS summaries, not custom
  OTel counters.

## Implemented Versus Missing

| Area | Implemented | Missing |
| --- | --- | --- |
| Local OTel bootstrap | Root `npm run worker` preloads `scripts/otel/register.mjs`. | Deployment worker image and start scripts do not preload it yet. |
| Trace export | OTLP HTTP trace exporter. | Env plumbing in deploy manifests/secrets. |
| Metric export | OTLP HTTP metric exporter and Node auto-instrumentation. | PilotSwarm-owned custom metric instruments. |
| Turn telemetry | `session.turn` spans with model, token, tool, worker, result attributes. | Turn latency histogram, token counters, tool counters. |
| Lifecycle telemetry | `session.hydration` and `session.dehydration` spans. | Lifecycle counters/histograms. |
| Queue health | Removed from this PR. | Bridge duroxide queue-depth metrics or expose via provider-safe management API. |
| SigNoZ dashboards | None. | Dashboard definitions, alert definitions, query recipes. |
| Operator docs | This document. | Environment-specific deployment guide and screenshots. |
| Agent tuner access | CMS summaries still exist for some data. | New OTel-derived or queue-health signals exposed through `PilotSwarmManagementClient` and tuner inspect tools. |

## Current Deployment Gap

The current deployment path does not yet load the OTel bootstrap:

- `deploy/Dockerfile.worker` starts `node packages/sdk/examples/worker.js`.
- `deploy/bin/start-worker.sh` starts `node packages/sdk/examples/worker.js`.
- The worker image does not copy `scripts/otel/register.mjs` today.
- Kubernetes and Bicep config do not wire `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_HEADERS`, or `OTEL_SERVICE_NAME`.

Until those are wired, this PR can be tested with the root `npm run worker`
path, but production worker pods will not emit the new custom spans.

## Recommended SigNoZ Views

Once deployed, use these starting points in SigNoZ:

| Question | View / Query Starting Point |
| --- | --- |
| Is the worker exporting telemetry? | Search traces for `worker.bootstrap`; service should appear as `pilotswarm-worker` if `OTEL_SERVICE_NAME` is set. |
| How long do turns take? | Trace explorer, span name `session.turn`, group by `pilotswarm.model` and `pilotswarm.worker_node_id`. |
| Which turns fail? | Span status `ERROR`, span name `session.turn`, filter by `pilotswarm.turn_result`. |
| Are tools failing? | Span name `session.turn`, filter `pilotswarm.tool_errors > 0`, inspect `pilotswarm.tool_names`. |
| Are hydrations failing? | Span name `session.hydration`, status `ERROR` or `pilotswarm.hydration_result = error`. |
| Are dehydrations lossy? | Span name `session.dehydration`, `pilotswarm.dehydration_result = lossy_handoff`. |
| Are snapshots growing? | Span name `session.dehydration`, chart `pilotswarm.snapshot_size_bytes`. |

## Next Steps To Complete The Rollout

1. Copy `scripts/otel/register.mjs` into the worker image.
2. Preload the bootstrap in the real worker deployment path:

   ```bash
   node --import ./scripts/otel/register.mjs packages/sdk/examples/worker.js
   ```

3. Add deployment configuration for:

   ```text
   OTEL_EXPORTER_OTLP_ENDPOINT=https://<signoz-otlp-endpoint>
   OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=<key>
   OTEL_SERVICE_NAME=pilotswarm-worker
   OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.namespace=pilotswarm
   ```

4. Make `OTEL_EXPORTER_OTLP_HEADERS` optional so self-hosted SigNoZ can run
   without fake headers.
5. Move OTel dependencies into `packages/sdk/package.json` if the SDK package
   imports `@opentelemetry/api` in published code.
6. Add dashboard definitions or documented SigNoZ query recipes.
7. Add alerts for turn failures, lossy handoffs, lifecycle failures, and queue
   backlog.
8. Expose operator-grade signals through `PilotSwarmManagementClient` and tuner
   inspect tools when the signal is useful for autonomous investigations.

## Metrics To Add Next

### Duroxide Queue Metrics

Duroxide already exposes queue depths as provider-safe signals:

- `duroxide_worker_queue_depth`
- `duroxide_orchestrator_queue_depth`
- `Client::get_queue_depths()` / Node `client.getQueueDepths()`

Next step: bridge those into the OTel pipeline without reading provider tables
directly from PilotSwarm.

Candidate metrics:

| Metric | Type | Labels | Scenario |
| --- | --- | --- | --- |
| `duroxide_worker_queue_depth` | gauge | `worker_node_id`, `deployment.environment` | Worker backlog and capacity planning. |
| `duroxide_orchestrator_queue_depth` | gauge | `deployment.environment` | Orchestrator backlog. |
| `duroxide_timer_queue_depth` | gauge | `deployment.environment` | Timer backlog and wake-up pressure. |
| `pilotswarm_worker_queue_stale_depth` | gauge | threshold, deployment labels | Count visible queue work older than a provider-defined threshold. This should be added to duroxide's management/provider layer first. |

### Turn Metrics

The current PR has turn data on spans. Add metrics when dashboards need cheap
time-window aggregation without scanning traces.

| Metric | Type | Labels | Scenario |
| --- | --- | --- | --- |
| `pilotswarm_turn_duration_ms` | histogram | `model`, `agent_id`, `result`, `required_tool` | Latency SLOs and regression detection. |
| `pilotswarm_turns_total` | counter | `model`, `agent_id`, `result` | Turn throughput and failure rate. |
| `pilotswarm_turn_tokens_input_total` | counter | `model`, `agent_id` | Token spend trends. |
| `pilotswarm_turn_tokens_output_total` | counter | `model`, `agent_id` | Token spend trends. |
| `pilotswarm_turn_tokens_cache_read_total` | counter | `model`, `agent_id` | Cache effectiveness. |
| `pilotswarm_turn_tokens_cache_write_total` | counter | `model`, `agent_id` | Cache write cost. |

Avoid `session_id` labels on long-retention metrics by default. Keep
`session_id` on spans and CMS management reads where high-cardinality lookup is
expected.

### Tool Metrics

| Metric | Type | Labels | Scenario |
| --- | --- | --- | --- |
| `pilotswarm_tool_calls_total` | counter | `tool_name`, `agent_id`, `model` | Tool usage patterns. |
| `pilotswarm_tool_errors_total` | counter | `tool_name`, `agent_id`, `model`, `error_type` | Tool failure alerts. |
| `pilotswarm_tool_duration_ms` | histogram | `tool_name`, `agent_id` | Slow tool investigation. |

### Lifecycle Metrics

| Metric | Type | Labels | Scenario |
| --- | --- | --- | --- |
| `pilotswarm_hydrations_total` | counter | `result`, `worker_node_id` | Hydration reliability. |
| `pilotswarm_dehydrations_total` | counter | `reason`, `result`, `worker_node_id` | Dehydrate reliability. |
| `pilotswarm_lossy_handoffs_total` | counter | `reason`, `worker_node_id` | Alert on data-loss risk. |
| `pilotswarm_snapshot_size_bytes` | histogram | `agent_id`, `model` | Snapshot growth and storage pressure. |
| `pilotswarm_hydration_duration_ms` | histogram | `result` | Recovery latency. |
| `pilotswarm_dehydration_duration_ms` | histogram | `reason`, `result` | Shutdown/handoff latency. |

### Worker And Runtime Metrics

| Metric | Type | Labels | Scenario |
| --- | --- | --- | --- |
| `pilotswarm_worker_bootstrap_total` | counter | `worker_node_id`, `version` | Worker restart spikes. |
| `pilotswarm_worker_active_sessions` | gauge | `worker_node_id` | Load distribution. |
| `pilotswarm_worker_run_turn_lock_wait_ms` | histogram | `worker_node_id` | Lock contention. |
| `pilotswarm_worker_dehydrate_inflight` | gauge | `worker_node_id` | Shutdown pressure. |

### Management And Agent-Tuner Surfaces

Some signals should not live only in SigNoZ. If a signal is needed for incident
investigations by the agent tuner, expose it through:

1. Durable storage or bounded provider-safe read API.
2. `PilotSwarmManagementClient`.
3. A tuner inspect tool.

Good candidates:

- Queue depth and stale queue work.
- Recent lossy handoff count.
- Fleet turn failure rate by agent/model.
- Tool failure summaries.
- Hydration/dehydration failure summaries.

## Non-Goals For This PR

- Deploying SigNoZ itself.
- Creating dashboard-as-code artifacts.
- Creating alert-as-code artifacts.
- Replacing CMS metric summaries or management APIs.
- Reading duroxide provider tables directly from PilotSwarm.