# Upgrading the named-agent handoff contract

The repair activates durable-session orchestration **1.0.77**. It needs a
**drain-first worker replacement**, not an ordinary overlapping rollout with
pre-repair workers. No PilotSwarm table migration or session-history rewrite is
required. Existing sessions and their data remain intact.

## Why worker order matters

The 1.0.74 orchestration and all its generator helpers are frozen. Its existing
activity descriptors remain unchanged, including untagged activities already in
the queue. Repaired workers keep the legacy activity registrations so they can
finish these histories using corrected runtime handlers. The locally checkpointed
1.0.75 is frozen too; its legacy capability-selector activity remains registered
for replay. Version 1.0.76 is retained unchanged as well. Active 1.0.77 keeps
the selector removed from spawning and adds the child-cleanup wakeup fix. Tool schemas and
live handlers reject stale `required_tool` calls with instructions to discover
a named agent. Definition-level startup requirements remain supported.

New 1.0.77 handoffs schedule these separate activities with the routing tag
`pilotswarm.agent-handoff.v2`:

| Previous activity | New activity |
| --- | --- |
| `resolveAgentConfig` | `resolveAgentConfigV2` |
| `spawnChildSession` | `spawnChildSessionV2` |
| `runTurn` | `runTurnV3` |
| `runTurn2` | `runTurnEpochV3` |

Repaired workers accept ordinary untagged work plus this tag using Duroxide's
`workerTagFilter: { defaultAnd: ["pilotswarm.agent-handoff.v2"] }`. A legacy worker
using Duroxide's default filter cannot dequeue tagged work. Activity names alone
are not a routing guarantee. Workers configured with an unrestricted `any` tag
filter must not share this queue during the transition.

Tags do not retroactively protect queued 1.0.74 activities. They also do not
upgrade old orchestration dispatchers, nor old inline spawning code inside an
already-running turn. Therefore all incompatible runtimes must finish or stop
before repaired workers start processing. This includes embedded/onebox workers
and independently launched SDK runtimes, not only the worker Deployment.

## Deployment sequence

1. Build and validate the repaired image before touching the running cluster.
   Retain the current image, deployment configuration, and normal backup policy.
2. Pause new session admission and worker autoscaling for the cutover. Keep the
   portal on the prior image until workers have been replaced; it must not start
   1.0.77 histories while old dispatchers are still polling.
3. Drain all old workers using their existing graceful shutdown path. Check
   in-flight activity completion and durable snapshot commits, and verify the
   old processes have exited. Stop their orchestration pollers as well as their
   activity pollers. Queued work is left in the durable store.
4. Allow expired worker/session ownership leases to become claimable. In the
   tested Duroxide runtime the session ownership lease is approximately **30
   seconds after its last renewal**. This is separate from PilotSwarm's one-hour
   session *idle-retention* setting. Graceful runtime shutdown does not guarantee
   an immediate unlock. Inspect lease expiry read-only when necessary; do not
   delete session rows, clear history, or force-update ownership timestamps.
5. Start repaired workers. Verify that they register frozen 1.0.74 through 1.0.76, active 1.0.77, and both
   old/new activity handlers, advertise readiness, and resume queued sessions.
   Existing histories keep replaying their frozen code; their normal
   continue-as-new boundary targets 1.0.77.
6. Upgrade the portal/session-creating processes, restore admission and normal
   worker replicas/autoscaling, and verify a named spawn, an unnamed spawn,
   static/published named-agent discovery, and a resumed pre-cutover session.

New 1.0.77 starts and continue-as-new targets are fixed in code. There is no
process-local environment flag that changes scheduling decisions during replay.
The worker activation step is the cutover; it must be performed consistently.

## Package refresh and a queued first turn

A child's startup requirement is copied from the selected named-agent definition
when it is spawned. It remains part of that queued bootstrap request. Refreshing
the package later updates the authorized prompt, tool declarations, handlers and
MCP configuration at a turn boundary, but does not silently substitute a new
startup obligation for work already queued.

If the original required startup tool is no longer available in the child's
final runtime tool set before its first turn, the child fails before inference
instead of starting without its required initialization. Restore that capability or deliberately spawn a new
child using the revised definition. If the original startup tool is still
available, including through a platform default, the queued child must invoke
it even when the newly published agent specifies a different startup tool. This design pins package identity and the
queued startup obligation, not an immutable package version or its handlers.

## Rollback

Before any repaired worker or client runs, reverting the prepared image is an
ordinary deployment rollback. **After 1.0.77 histories exist, retain workers that
understand 1.0.77 and its activity tag.** Rolling every worker back to 0.5.64 is not
safe: old code cannot service the new contract. A rollback then requires a
forward-compatible repair retaining the versioned handlers; the portal can be
rolled back separately only if it remains API-compatible. Do not downgrade or
rewrite stored orchestration versions to make an old worker accept them.

## Parent-requested child cleanup

Inline and durable complete/cancel/delete commands stamp the requesting parent's
session ID. A 1.0.77 child validates that origin against its direct parent and
retains it while descendants drain, including across continue-as-new. Its
terminal acknowledgement becomes a `session.child_cleanup_completed` audit
event on the parent, without queuing another model prompt. Explicit agent waits
and parent shutdown still observe completion through status polling. Status
probes keep the last child answer when the probe returns an orchestration exit
marker such as `done`.

External termination and actual child work updates retain their notifications.
An empty Copilot response with a query error remains an error; this fix removes
a proven unnecessary wakeup rather than accepting empty responses generally.
Children executing older frozen versions retain the old notification behavior
until their normal version boundary. Already queued acknowledgements and
previously failed sessions are not rewritten or automatically cleared.

## Regression evidence

`packages/sdk/test/unit/agent-handoff-routing.test.mjs` pins the frozen generator
tree and the serialized legacy proxy descriptors. It checks all new critical
activities carry the capability tag and keeps session affinity on both ordinary
and fresh-epoch turns.

`packages/sdk/test/local/agent-handoff-routing.test.js` uses actual Duroxide and
isolated PostgreSQL schemas, without model calls. It verifies that an aggressively
polling old worker cannot steal tagged work, work stays pending without a capable
worker, concurrent handoffs reach only capable workers, session affinity survives
worker replacement and lease expiry with one-hour idle retention, and a frozen
named-child handoff replays without spawning the child twice.

`packages/sdk/test/local/child-cleanup.test.js` covers all three cleanup commands
through the real inline bridge and durable control path, runtime-owned origin,
external/malformed commands, restart state, audit failure, mixed results and
status polling. The batching suite verifies explicit waits and parent shutdown
without a cleanup prompt. The inline-control suite verifies that empty responses
on both user requests and actionable internal prompts still fail. These and the
existing notification/wait suites passed 185 focused tests; 36 routing/version
checks, nine snapshot/version checks and the SDK build passed. The full provider gate remains stopped
at the user's request and must pass before release.
