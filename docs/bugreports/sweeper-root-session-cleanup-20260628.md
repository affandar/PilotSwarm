# Sweeper cleanup deletes live root sessions when stale children share a parent

**Date observed:** 2026-06-28 05:14 UTC  
**Product area:** PilotSwarm SDK / Sweeper Agent / session cleanup  
**Severity:** High - live long-running watcher/crawler roots were soft-deleted  
**Environment:** Waldemort live cluster, `pilotswarm-sdk@0.3.0`, Duroxide orchestration `durable-session-v2` version `1.0.54`

## Summary

The Sweeper Agent deleted live or scheduled root sessions after `scan_completed_sessions` returned stale child sessions grouped under those roots. The scan output did not identify the roots themselves as terminal/stale. The Sweeper model collapsed child candidates to their parent root sessions, then called `cleanup_session` on the roots. `cleanup_session` accepted those root IDs and soft-deleted the root plus all descendants because it only verified that the target existed and was not a system session.

This caused the visible disappearance of the `Crawler Groups` group and also deleted an active M64 R2D watcher root.

## Impact

At least these root sessions were soft-deleted by Sweeper:

| Session | Title | State before delete | Result |
|---|---|---|---|
| `90f23f00-c78b-4af7-b742-18e6efc32b04` | `Generic Crawler: MySQL Crawler` | CMS `idle`; had active `cron_at` schedule | Deleted root + 6 descendants |
| `a1bc569d-8592-49c1-b725-acea06abe0f8` | `R2D EV2 Risk Corpus Crawler: EV2 PR scan quiet` | CMS `idle`; had active `cron` schedule | Deleted root + 22 descendants in the direct cleanup result; 34 total tree rows were deleted/hidden |
| `613eeaf7-15ee-4ee0-b63a-aa9a6b5b3d17` | `Mad-Eye Moody - R2D Train Watcher: M64 Watcher` | CMS `running`; had active `cron` schedule and events during the deletion window | Deleted root + 35 descendants |
| `b1c247fb-580c-4c2e-b4ec-534d3ab6b5ef` | `Sherlock - HDB Engineer: Continuous PR Analysis - v2 - O47` | CMS `idle` | Deleted root + descendants |
| `f49ae796-88d0-478b-ad07-0160c2c86d45` | `R2D watcher probe spawned` | Duroxide `NotFound` | Deleted root |

`Crawler Groups` group `e06c6708-5136-4b0e-8876-973ae80fb65c` after cleanup:

```text
total_members: 41
visible_members: 0
visible_active_members: 0
deleted_members: 41
```

## Evidence

Sweeper session:

```text
bdad2272-ef7e-08bd-e02d-9b6476966c3e
Sweeper Agent
```

At `2026-06-28T05:13:26Z`, Sweeper ran:

```json
scan_completed_sessions({ "graceMinutes": 5, "includeOrphans": true })
```

The scan found 68 candidates. Grouping by `parentSessionId` showed:

```text
parentSessionId=613eeaf7... count=35 statuses={Completed:19, NotFound:16}
parent/root state: running

parentSessionId=a1bc569d... count=8 statuses={Completed:4, NotFound:4}
parent/root state: idle

parentSessionId=90f23f00... count=5 statuses={NotFound:2, zombie:3}
parent/root state: idle
```

The root sessions themselves were not scan candidates; they appeared only as parent metadata on stale child candidates.

At `2026-06-28T05:14:06Z`, Sweeper called `cleanup_session` on root IDs:

```json
cleanup_session({"sessionId":"613eeaf7-15ee-4ee0-b63a-aa9a6b5b3d17","reason":"scheduled stale session cleanup"})
cleanup_session({"sessionId":"a1bc569d-8592-49c1-b725-acea06abe0f8","reason":"scheduled stale session cleanup"})
cleanup_session({"sessionId":"90f23f00-c78b-4af7-b742-18e6efc32b04","reason":"scheduled stale session cleanup"})
cleanup_session({"sessionId":"b1c247fb-580c-4c2e-b4ec-534d3ab6b5ef","reason":"scheduled stale session cleanup"})
cleanup_session({"sessionId":"f49ae796-88d0-478b-ad07-0160c2c86d45","reason":"scheduled stale session cleanup"})
```

Cleanup results included:

```json
{"ok":true,"sessionId":"90f23f00-c78b-4af7-b742-18e6efc32b04","deletedCount":7,"reason":"scheduled stale session cleanup","descendants":6}
{"ok":true,"sessionId":"a1bc569d-8592-49c1-b725-acea06abe0f8","deletedCount":23,"reason":"scheduled stale session cleanup","descendants":22}
{"ok":true,"sessionId":"613eeaf7-15ee-4ee0-b63a-aa9a6b5b3d17","deletedCount":36,"reason":"scheduled stale session cleanup","descendants":35}
```

Sweeper summarized its action as:

```text
Cleanup ran. This sweep at 2026-06-27 22:13 PT found 68 stale sessions collapsing to 5 root sessions, and all 5 roots were cleaned: 613eeaf7, a1bc569d, 90f23f00, b1c247fb, f49ae796.
```

## Root-cause analysis

`scan_completed_sessions` marks individual sessions eligible when:

```text
A. Duroxide status is Completed / Failed / Terminated / NotFound
   and CMS updatedAt is older than graceMinutes

B. session has parentSessionId
   and customStatus.status == "idle"
   and CMS updatedAt is older than graceMinutes

C. includeOrphans=true
   and session has parentSessionId
   and parent is missing from visible CMS session set
   and CMS updatedAt is older than graceMinutes
```

That scan behavior is reasonable for child sessions.

The unsafe behavior was in `cleanup_session`. In `pilotswarm-sdk@0.3.0`, it:

1. read the target CMS session,
2. refused only if target did not exist or was a system session,
3. got all descendants,
4. soft-deleted descendants,
5. deleted descendant facts and Duroxide instances best-effort,
6. soft-deleted the target itself,
7. deleted target facts and Duroxide instance best-effort.

It did not check whether the target itself was returned by `scan_completed_sessions`, was terminal, was stale, was a child, had an active cron, or was a long-running root agent.

The model converted "many stale children under parent X" into "delete parent X", and the tool allowed it.

## Regression hypothesis

`pilotswarm-sdk@0.1.30`, `0.2.2`, and `0.3.0` had identical `sweeper-tools.js` and `system-agents.js` files. The direct regression is not a Sweeper prompt/tool text change.

Recent package updates changed the operational shape:

- `0.2.2` integrated HorizonDB hybrid fact/graph store and related runtime packaging.
- `0.3.0` added/encouraged bundled `generic-crawler`, crawler role propagation, and knowledge-corpus workflows.
- Long-running crawler/watcher roots began spawning many child sessions.
- Sweeper scan output therefore contained dense clusters of stale children with the same `parentSessionId`.
- The Sweeper model chose to collapse those child candidates to parent roots.

## Fixed in 0.3.1

`pilotswarm-sdk@0.3.1` contains a tool-level guardrail fix:

- `cleanup_session` revalidates each target independently before deletion.
- Live root sessions are refused unless their own orchestration is terminal/stale.
- `scan_completed_sessions` explicitly states that `parentSessionId` is diagnostic context only, not a cleanup target.
- `cleanup_session` supports `sessionIds: [...]` batch cleanup for exact child candidates.

## Recommended validation

After upgrading consumers to `pilotswarm-sdk@0.3.1`, validate:

1. `scan_completed_sessions({ graceMinutes: 5, includeOrphans: true })` still returns stale child candidates.
2. `cleanup_session({ sessionId: <live-root-with-cron> })` refuses the target.
3. `cleanup_session({ sessionIds: <exact child candidate ids> })` deletes only those candidates.
4. Long-lived crawler/watcher roots with active cron remain visible and scheduled.
