# Mid-Session Model Switch

## Summary

Allow a session to change its model (and reasoning effort) at a turn boundary, while
it stays alive. Two triggers:

- **User**: an operator switches the model from the portal/CLI/API.
- **Self**: the running turn switches its own model via a tool call.

The switch never affects an in-flight turn; it applies on the next turn. To make this
correct for cost/token reporting, per-turn metrics become the source of truth for
model attribution, so a single session can be attributed across multiple models.

## Goals

- Change a live session's model at a durable turn boundary, via user or tool call.
- Attribute tokens to the model that actually ran each turn.
- Add no extra DB round trips on the normal turn path.

## Non-Goals

- Changing the model mid-turn.
- Native TUI keybinding for switching (shared command path only; binding optional later).
- Cross-model cost normalization or pricing.

System sessions are switchable too; the switch applies through `restartSystemSession`
(carry the new model/effort into the restart input) rather than the live continue-as-new path.

## Behavior

- A switch is a no-op for the currently executing turn.
- Idle session: applies to the next user/system/cron turn.
- Running session: durably queued, applied after the current turn ends or suspends.
- Waiting / input-required / cron: applies on the next resumed turn.
- Emits `session.model_changed` (old/new model, old/new reasoning effort, source, effective turn).
- Command response is boundary-explicit, e.g. `applies on next turn`.

## Data Model

| Store | Grain | Role |
| --- | --- | --- |
| `sessions` | per session | current effective model + reasoning effort (routing/display) |
| `session_metrics` | per session | total counters, snapshots, hydration/dehydration (rename of `session_metric_summaries`) |
| `session_turn_metrics` | per turn | immutable token/model attribution per turn |

`model` and `reasoning_effort` are stored separately. Only stats read paths project the
combined label (`provider:model:reasoning_effort`). `session_metrics.model` may stay as a
compatibility label but is no longer used for token-by-model attribution.

## Feature: Switch Path

1. Reuse and harden the orchestration `set_model` command; do not add a side channel.
2. Carry `model` and optional `reasoningEffort`.
3. Validate via a worker/session-manager activity before mutating config:
   - model normalizes to a configured provider/model id
   - reasoning effort is supported by that model, or null
   - on switch with no effort, use target default, else clear effort
4. Update orchestration config + `sessions.model` / `sessions.reasoning_effort` together.
5. Recycle any warm `CopilotSession` whose model/effort changed, so the next
   `SessionManager.getOrCreate(...)` rebuilds `sessionConfig`.
6. Continue-as-new so the new config is the durable input for future turns.

### API / Tools

- `PilotSwarmSession.setModel(model, opts?)`, `PilotSwarmClient.setSessionModel(id, model, opts?)`.
- `PilotSwarmManagementClient.setSessionModel(...)` = `sendCommand` + response wait.
- CLI/portal transport `setSessionModel(id, { model, reasoningEffort })`.
- LLM tool `set_session_model` (exact ids from `list_available_models`), same boundary ack.

## Feature: UX

Switching a live session is distinct from new-session model selection.

Shared:

- Header/details show current model via `model:reasoning` label.
- "Switch Model" action on non-group sessions, including system sessions; reuse model + reasoning pickers in switch mode.
- Preselect current model/effort; confirm copy states "applies next turn".
- Status after submit: `Next turn will use <model:effort>`.
- Stats panes break tokens down by full model id (`provider/model/reasoning`); each effort variant is its own row with per-bucket turn count, fed from `session_turn_metrics`.

Portal:

- Keep `New + Model` intact; add an active-session model action in the header/action bar.
- Pending model-change badge while busy until `session.model_changed`/response confirms.
- Turn-completion divider shows the model the turn actually used (see below).

TUI:

- Shared controller/transport so the TUI can adopt without a backend change.
- No native keybinding initially; if added, sync binding + hints + docs + copilot-instructions.

## Metrics Foundation

One post-turn writeback (`cms_complete_turn_writeback`) replaces per-`assistant.usage`
summary writes + post-turn `updateSession`. Per turn it atomically: updates `sessions`
state, increments `session_metrics` totals, inserts one `session_turn_metrics` row, and
records `session.turn_completed` with the metric payload. Runtime accumulates into
`turnTelemetry`, then calls writeback once at the existing barrier with the turn-boundary
`model`/`reasoningEffort`. Net DB writes drop.

Turn payload (row + event): `session_id`, `agent_id`, `model`, `reasoning_effort`,
`turn_index`, `started_at`/`ended_at`/`duration_ms`, token + tool counters, `tool_names`,
`result_type`/`error_message`, `worker_node_id` (= `worker.config.workerNodeId`, same id
given to Duroxide `Runtime`). No prompts/content in the table. `session.turn_completed`
keeps legacy `iteration` and gains the scalar metrics + `toolNames`.

By-model stats read from `session_turn_metrics`, grouped by `model + reasoning_effort`,
`COUNT(DISTINCT session_id)` for sessions, `COUNT(*)` for turn count, `started_at` for
windows. Snapshot/hydration stay on `session_metrics`. Never sum tokens across both tables.

## Migrations & Schema

Single new CMS migration (next 4-digit version), with `NNNN_diff.md` companion. Idempotent.

### Rename

```sql
ALTER TABLE SCHEMA.session_metric_summaries RENAME TO session_metrics;   -- when old exists, target absent
```

Rename dependent indexes/SP refs to `session_metrics`. New code/docs use that name; TS
`SessionMetrics` / `upsertSessionMetrics`.

### Columns + indexes

```sql
ALTER TABLE SCHEMA.session_turn_metrics ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

-- keep: (session_id, turn_index DESC), (started_at DESC)
CREATE INDEX ... ON session_turn_metrics(session_id, model, reasoning_effort);
CREATE INDEX ... ON session_turn_metrics(model, reasoning_effort, started_at DESC);
CREATE INDEX ... ON session_turn_metrics(agent_id, model, reasoning_effort, started_at DESC);
```

### Stored procedures

- `cms_complete_turn_writeback(...)` — new; updates `sessions`, increments `session_metrics`, inserts `session_turn_metrics`, records `turn_completed`. One atomic body.
- `cms_insert_turn_metric(...)` — add `p_reasoning_effort`.
- `cms_get_session_turn_metrics` / `cms_get_hourly_token_buckets` / `cms_prune_turn_metrics` — re-point to renamed table; add reasoning_effort to outputs.
- `cms_get_session_tree_stats_by_model`, `cms_get_fleet_stats_by_agent`, `cms_get_user_stats_by_model` — read tokens from `session_turn_metrics`, group by model+effort, `COUNT(DISTINCT session_id)` sessions + `COUNT(*)` turn count per bucket. Snapshot/hydration still from `session_metrics`.
- `cms_create_session` / `cms_update_session` — write renamed table; keep `session_metrics.model` as compatibility label only.

### Backfill (in migration SQL, not a script)

One `legacy_summary` `session_turn_metrics` row per nonzero `session_metrics` row: its
model/effort, `turn_index 0`, summary timestamps, token totals. Guard with `NOT EXISTS`
so retries don't duplicate.

### Catalog/API

`CompleteTurnWritebackInput` + `completeTurnWriteback()` on `SessionCatalog`/`PgSessionCatalogProvider`;
`reasoningEffort` on `InsertTurnMetricInput`/`TurnMetricRow`/mappers; tree/fleet/user
by-model results carry provider/model/reasoning + per-bucket turn count.

## Portal Sequence Divider

`session.turn_completed` already maps in the sequence selector. Portal-only: render it as
an expandable turn-finish divider from event data (no extra fetch); TUI keeps the compact
`turn N done` line.

- Collapsed: turn n, model label, result, duration, in/out tokens.
- Expanded: model+effort, timings, all token counters, cache ratio, tools, worker, error.
- Legacy events (iteration only) render without details.

## Test Plan

Use default model except where a test is explicitly about switching/multi-model. No
retries, no sleeps. Each block names where it lives.

### 1. Migration + catalog (`test/local/cms-turn-metrics.integration.test.js`)

- After `initialize()`: `session_metrics` exists, `session_metric_summaries` does not; the three new indexes exist; `session_turn_metrics.reasoning_effort` exists.
- `insertTurnMetric` round-trips `reasoningEffort`; `getSessionTurnMetrics` returns it.
- `getHourlyTokenBuckets` aggregates after the signature change.
- Re-running migrations is a no-op (rename + backfill idempotent; no dup `legacy_summary` rows).

### 2. Backfill (same file)

- Seed a `session_metrics` row (nonzero tokens, model `A:high`, no turn rows) → migration inserts one `turn_index 0` `legacy_summary` row with matching tokens/model/effort and summary timestamps.
- Zero-token summary → no row. Existing turn rows → not duplicated.

### 3. Writeback SP (new `test/local/turn-writeback.test.js`)

- `completeTurnWriteback` once: `sessions` state/`last_active_at`/`current_iteration`/`last_error`/`wait_reason` set; `session_metrics` tokens incremented; exactly one `session_turn_metrics` row with model+effort; one `session.turn_completed` with the metric payload.
- No per-`assistant.usage` summary write needed for totals; verify only one writeback per turn.
- Error/lock-timeout turns store `result_type`/`error_message`.

### 4. By-model aggregates (`session-stats.test.js`)

- One session, turns on `A:high` then `B:medium` → two buckets, per-bucket tokens + turn count; session total = A+B.
- Tree/fleet/user split correctly; one session in two buckets → `COUNT(DISTINCT session_id)` not inflated.
- Change `sessions.model` after turns → historical buckets unchanged. `since` filters on `started_at`.

### 5. Switch core (`model-selection.test.js`)

- `setModel` updates `sessions.model`/effort; emits `session.model_changed`; continues-as-new.
- Switch mid-turn applies only to the next turn (verify via turn-metric model). Idle/waiting → next turn uses new model.
- Invalid model and unsupported effort rejected; config unchanged. Warm `CopilotSession` rebuilt next turn.
- LLM `set_session_model` tool: stub/handler schema in sync; rejects non-exact ids.

### 6. System session (`system-agents.test.js`)

- Switch on a system session routes through `restartSystemSession` with new model/effort; post-restart turns run on it; pre-restart turn metrics retain old model.

### 7. UX (`packages/ui-core` selector + portal)

- Switch action on non-group sessions incl. system; picker opens in switch mode, preselected; submit calls `setSessionModel`, not create.
- Stats pane: rows by `provider/model/reasoning` with turn count; portal divider collapsed/expanded fields; legacy `iteration`-only event safe; TUI keeps `turn N done`.
