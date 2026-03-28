---
name: investigate-duroxide-runtime
description: Investigate live Duroxide orchestration behavior, session-affined activities, worker routing, hydration/dehydration, and AKS log/DB evidence. Use when tracing which pod ran a session activity, why warm state was missing, or whether a failure was caused by affinity loss, explicit dehydration, or a worker crash.
---

# Investigate Duroxide Runtime

Use this skill when the problem is a live runtime or forensics issue, not a pure replay-code audit.

Typical cases:
- a session failed with missing resumable state
- an activity appears to have landed on the wrong worker
- you need to tell orchestration placement apart from session activity placement
- you need evidence for crash vs affinity miss vs explicit dehydrate
- child updates or queued messages are arriving after a session already failed

If the issue is a deterministic replay bug caused by orchestration code shape, use the sibling skill [`.github/skills/debug-orchestration/SKILL.md`](../debug-orchestration/SKILL.md).

## Core Rule

When warm in-memory Copilot state matters, **compare session-affined activity placement, especially `runTurn`**.

Do **not** use orchestration-start placement as affinity evidence. Orchestration executions are stateless and may move between pods by design.

The important question is:

`Which pod ran the relevant session activity for this execution?`

## Canonical Targets

- AKS context: `toygres-aks`
- Namespace: `copilot-runtime`
- Worker deployment: `copilot-runtime-worker`

## Canonical Files

- Orchestration: `packages/sdk/src/orchestration.ts`
- Session-affined activity registration: `packages/sdk/src/session-proxy.ts`
- Warm session lookup / hydrate logic: `packages/sdk/src/session-manager.ts`
- Session tool flow: `packages/sdk/src/managed-session.ts`
- Remote reset script: `scripts/db-reset.js`
- Hydration spot-check helper: `scripts/db-check-hydration.js`

## Canonical Tables

- `duroxide.instances`
- `duroxide.executions`
- `duroxide.history`
- `copilot_sessions.sessions`

If you are unsure about columns, inspect `information_schema.columns` first instead of guessing.

## What To Prove

Try to answer these in order:

1. What is the exact `session_id` and `instance_id`?
2. What is the CMS-visible failure or wait state?
3. Which pod ran the relevant `runTurn` activity?
4. Was there an explicit `dehydrate`, `hydrate`, or `checkpoint` before the failure?
5. Is there evidence of a pod restart or previous-container crash on that same pod?
6. Did the session become terminal and then continue receiving queued messages?

## Investigation Workflow

1. Pin the identifiers.
   - Session ID from CMS / TUI.
   - Instance ID is usually `session-<session_id>`.

2. Read the CMS row first.
   - Inspect `state`, `current_iteration`, `updated_at`, `last_error`, and `wait_reason`.
   - This tells you whether the user-visible failure matches runtime evidence.

3. Inspect Duroxide persistence.
   - Query `duroxide.instances` for the instance row.
   - Query `duroxide.executions` ordered by `execution_id`.
   - Query `duroxide.history` ordered by `created_at, event_id`.
   - Absence of history can itself be evidence; do not assume every failure leaves rows there.

4. Inspect worker pod health.
   - Check pod restarts:
     ```bash
     kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker -o wide
     ```
   - If a suspect pod has restarts, inspect previous logs too:
     ```bash
     kubectl logs -n copilot-runtime pod/<pod-name> --previous
     ```

5. Collect cross-pod log evidence.
   - Search all worker pods, not just one chosen by `deployment/...` logs.
   - Look for:
     - `[runTurn] session=<id>`
     - `invoking ManagedSession.runTurn for <id>`
     - `ManagedSession.runTurn completed for <id>`
     - `fatal missing session state`
     - `dehydrating session`
     - `hydrate=true` / `hydrate=false`
     - `Dropping orphan queue messages`

6. Compare the right things.
   - Compare the prior turn's `runTurn` activity pod to the failing turn's `runTurn` activity pod.
   - Do **not** compare orchestration-start pod to activity pod and call that an affinity failure.

7. Check for explicit dehydration.
   - Look for orchestration traces like:
     - `[orch] dehydrating session`
     - `reason=cron`
     - `reason=idle`
     - `reason=timer`
     - `reason=input_required`
   - Look for corresponding `dehydrateSession`, `hydrateSession`, or `checkpointSession` activity traces if present.
   - If none exist for that session before failure, do not claim it was explicitly dehydrated.

8. Classify the outcome conservatively.
   - `explicit dehydrate`: only if there is a direct trace or durable evidence
   - `affinity miss`: only if the session-affined activity landed on a different pod than the previous warm `runTurn`
   - `same-pod warm-state miss`: if the failing `runTurn` landed on the same pod but still could not find the session
   - `pod crash / restart`: only if the same pod shows restart evidence or previous-container logs line up with the timing

## Useful Commands

### Cross-pod activity search

```bash
for p in $(kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker -o name); do
  echo "=== ${p##*/} ==="
  kubectl logs -n copilot-runtime "$p" --since=12h | \
    rg -n "\\[runTurn\\] session=<SESSION_ID>|invoking ManagedSession.runTurn for <SESSION_ID>|ManagedSession.runTurn completed for <SESSION_ID>|fatal missing session state|dehydrating session|Dropping orphan queue messages"
done
```

### Previous logs for a restarted pod

```bash
kubectl logs -n copilot-runtime pod/<pod-name> --previous | \
  rg -n "<SESSION_ID>|fatal missing session state|dehydrating session"
```

### CMS + Duroxide DB query

```bash
node --env-file=.env.remote - <<'NODE'
const { Client } = require('pg');
(async () => {
  const sessionId = '<SESSION_ID>';
  const instanceId = `session-${sessionId}`;
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const cms = await c.query(`
    select session_id, state, current_iteration, created_at, updated_at, last_error, wait_reason
    from copilot_sessions.sessions
    where session_id = $1
  `, [sessionId]);

  const inst = await c.query(`
    select *
    from duroxide.instances
    where instance_id = $1
  `, [instanceId]);

  const execs = await c.query(`
    select *
    from duroxide.executions
    where instance_id = $1
    order by execution_id
  `, [instanceId]);

  const hist = await c.query(`
    select *
    from duroxide.history
    where instance_id = $1
    order by created_at, event_id
  `, [instanceId]);

  console.log('CMS', JSON.stringify(cms.rows, null, 2));
  console.log('INST', JSON.stringify(inst.rows, null, 2));
  console.log('EXECS', JSON.stringify(execs.rows, null, 2));
  console.log('HIST', JSON.stringify(hist.rows, null, 2));

  await c.end();
})();
NODE
```

### Schema inspection when columns are uncertain

```bash
node --env-file=.env.remote - <<'NODE'
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = await c.query(`
    select table_schema, table_name, column_name, data_type
    from information_schema.columns
    where table_schema in ('duroxide', 'copilot_sessions')
    order by table_schema, table_name, ordinal_position
  `);
  for (const row of rows.rows) {
    console.log(`${row.table_schema}.${row.table_name}\t${row.column_name}\t${row.data_type}`);
  }
  await c.end();
})();
NODE
```

## Interpretation Guide

### Evidence for affinity miss

- Failing turn's `runTurn` activity is on pod `B`
- prior warm turn's `runTurn` activity was on pod `A`
- there is no explicit dehydrate/checkpoint/hydrate before the handoff

### Evidence against explicit dehydrate

- no `[orch] dehydrating session` trace for that session
- no `dehydrateSession` / `hydrateSession` / `checkpointSession` trace
- no matching durable history evidence

### Evidence for crash / restart

- same suspect pod shows restart timing that lines up with the failure
- `kubectl logs --previous` contains the session or surrounding runtime failure
- the pod that previously ran the warm `runTurn` no longer has continuity around the failure window

### Terminal-orphan pattern

If the session is already failed or completed and later logs show:

`Dropping orphan queue messages — events enqueued before orchestration started are not supported`

that usually means children or other senders kept enqueueing to a dead parent after the parent became terminal.

### Benign `completion from different execution` warnings

If runtime logs show:

`completion from different execution`

do not treat that warning alone as an incident.

This commonly appears when a session has already continued-as-new or moved to a newer execution and a late completion from the prior execution arrives afterward. It is useful context for timing analysis, but it is usually benign unless it is paired with dropped work, a failed execution, or a user-visible regression.

## Rules

- Do not infer affinity failure from orchestration-start placement.
- Do not infer crash from an unrelated pod restart elsewhere in the deployment.
- Do not claim explicit dehydrate without direct evidence.
- Do not alarm on `completion from different execution` by itself; explain it as late prior-execution completion noise unless stronger evidence says otherwise.
- Prefer exact session IDs, execution IDs, and pod names in the write-up.
- If evidence is incomplete, say exactly what is proven and what remains inference.
