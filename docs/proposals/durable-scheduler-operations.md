# Durable scheduler operation state

Status: implementation proposal, draft for adversarial review. No runtime code or deployments are included in this change.

Date: 2026-09-07. Code baseline: `ca3d8b59` plus the existing local 1.0.73 changes. Observed incident: Waldemort CHK orchestration 1.0.72. Implementation must re-check the deployed artifact and reserve a new version; `N` below means that new version, provisionally 1.0.74.

Companion document: [test plan](durable-scheduler-operations-test-plan.md).

## 1. Problem and required behavior

Builder session `33056dd4-e3aa-4aa5-a13c-7810704dece5` had a 60-second cron. Duroxide delivered its tick at 09:47:34.627 PDT, 74 ms after its deadline. PilotSwarm subsequently consumed an old approval-grace item, installed a 30-minute idle hold, and waited on that hold before dispatching the two cron items already in application FIFO. Continue-as-new preserved that state. The portal still showed the configured cron wait.

Related code defects make a branch-local fix insufficient:

- `processTimer` validates cron by configuration presence, not revision; old A can run replacement B and affect B's wall-clock fire count.
- `releaseAffinity` clears an unrelated `activeTimer`; old idle work becomes dangerous if FIFO priority alone is fixed.
- Retry backoff directly awaits a timer and carries the failed prompt above newer input in `decide`.
- `cron`/`cron_at` acknowledge volatile `queuedActions` as scheduled. Several failure returns lose those actions.
- Status publication mixes requested/configured scheduling with actual wait state; readers can move deadlines or merge older cron fields into newer status.

Required outcome: an accepted request is recoverable; applied scheduling is owned by the orchestration; obsolete work cannot change a newer owner; queued instructions are considered before an automatic retry; every observed status describes a committed runtime transition or explicitly says it is stale.

## 2. Scope and decisions

Implement this as one versioned scheduler protocol. Keep the existing model/provider and session snapshot protocols, with a new activity entry point for scheduler-aware turns.

1. **Duroxide KV is canonical for applied scheduler metadata.** It holds schedule revision, occurrence ownership, work/attempt lifecycle, gates, receipt settlements, and migration state. Timer/activity execution remains in Duroxide history and queues.
2. **CMS ingress is canonical only for request acceptance/delivery.** Add a transactional receipt/outbox and an attempt admission record. A running model worker never writes orchestration KV.
3. **Large immutable work payloads live in CMS.** Prompts, attachment references and attribution are not packed into a scheduler KV value. Their stable references live in KV. This avoids Duroxide's 64 KiB per-value limit and preserves the complete retry contract.
4. **Tools acknowledge `pending`, not `scheduled`.** Only orchestration settlement establishes application. No inline self-command wait while `runTurn` is outstanding.
5. **One recurring configuration and one outstanding recurring occurrence per session.** A retry is another attempt of that occurrence, not another scheduled fire.
6. **Keep current interval semantics.** Interval recurrence re-arms after cycle completion and preserves deliberately paused duration during interactive interruption. Ordinary rollover preserves absolute deadlines. Keep current wall-clock missed-occurrence policy; do not add catch-up bursts.
7. **Keep retry exhaustion bounded.** Exhaustion marks work failed and recurrence operationally blocked under the existing pause behavior. Configuration remains visible; no next model wake is fabricated. Changing to continue-after-failed-cycle is outside this release.
8. **No provider schema change for application state.** New CMS tables are application-owned. Provider test instrumentation may be added to establish the commit guarantees on the exact native dependency used by PilotSwarm.

## 3. State schema and storage ownership

Add `packages/sdk/src/orchestration/scheduler-state.ts`, `scheduler-store.ts`, `scheduler-transitions.ts`, `scheduler-dispatch.ts`, and `scheduler-migration.ts`. Keep these inside the versioned orchestration directory so they freeze with the handler.

Proposed types below are implementation contracts; auxiliary metadata may be added without changing their ownership rules.

```ts
type Ref = string;
type Phase = "idle" | "ready" | "admitted" | "running" | "waiting"
  | "retry_wait" | "blocked" | "reconciling";

interface SchedulerStateV1 {
  schemaVersion: 1;
  transition: number;                // increments on each persisted logical transition
  scheduleRevision: number;          // persists even when schedule is null
  schedule: null | {
    revision: number;
    appliedActionId: string;
    definition: IntervalSchedule | WallClockSchedule;
    nextOccurrenceOrdinal: number;
    firesDispatched: number;
  };
  occurrence: null | {
    id: string; scheduleRevision: number; ordinal: number;
    dueAtMs: number; occurrenceKey?: string;
    phase: "armed" | "ready" | "admitted" | "running" | "paused" | "blocked";
    workId?: string;
    pausedRemainingMs?: number;       // only an intentional interval pause
  };
  work: null | {
    id: string; origin: "input" | "cron" | "cron_at" | "wait" | "followup";
    payloadRef: Ref; payloadHash: string;
    phase: Phase;
    attemptOrdinal: number; attemptId?: string;
    failures: number; retryAtMs?: number;
    occurrenceId?: string;
    reconcilesWorkId?: string;
  };
  wait: null | OwnedWait;            // explicit wait, budget, child wait or shutdown
  question: null | { id: string; iteration: number; payloadRef: Ref };
  lease: null | {
    generation: number; ownerWorkId?: string; questionId?: string;
    stage: "input-grace" | "affinity-hold";
    deadlineMs: number;
  };
  leaseGeneration: number;
  attemptOrdinal: number;
  retiredThroughAttemptOrdinal: number;
  cutoff: null | { id: string; stage: "inserting" | "draining" | "sealed" };
  blocker: null | { code: string; ownerId?: string; sinceMs: number };
  migration: null | { sourceVersion: string; state: "reconciling"; evidenceRef: Ref };
}
```

`OwnedWait` contains its own ID, owner work/question/child-set identity, kind, absolute due time or explicit paused duration, and disposition. Child digest accumulation can remain in its existing representation initially, but its due event carries a generation and is included in scheduler readiness/projection. No unowned timer remains in the new handler.

Use these bounded KV keys:

| Key | Contents |
|---|---|
| `scheduler.state` | `SchedulerStateV1`, target <=32 KiB |
| `scheduler.ready` | Small owned event descriptors, <=48 KiB; payloads referenced |
| `scheduler.receipts.0` … `.3` | Recent settled requests, each <=48 KiB |
| `scheduler.retention` | Receipt archive progress and retirement watermarks |

Question bodies and work payloads use immutable references. Do not allocate one KV key per historical attempt or tick. The native dependency currently exports 150 keys and 65,536 bytes per value; account for existing FIFO and command-response keys before enabling the protocol. Check encoded UTF-8 byte size, not JavaScript character count. Admission/backpressure occurs before exceeding a limit. Already accepted ingress requests stay durable and visibly pending when settlement capacity is unavailable; never drop them to make room.

### Single writer and atomic transitions

Only `scheduler-store.ts` calls `ctx.setValue` for these keys. All latest-version helpers call typed transitions; direct assignments to legacy scheduling fields must be eliminated from the new handler. The runtime object contains an in-memory working copy, not another persisted authority.

`commitSchedulerTransition` validates owner IDs and size bounds, increments `transition`, writes changed scheduler/receipt/FIFO keys, and calls the pure scheduling-status projector. Those calls participate in the next Duroxide acknowledgement. It does not perform network I/O or await a CMS event.

An admission transition writes the work/occurrence decision and schedules the corresponding activity in the same acknowledged activation. If hydration, payload preparation, or another activity is required first, expose `admitted`/preparing and retain enough state to resume; do not claim a model activity was scheduled before it was.

A timer is `armed` only when the final projection and native timer/race registration are in the same acknowledged activation. Earlier configuration application may be `pending-arm`. On zero remaining duration, produce owned ready work directly. Native timer IDs may change when a message wins a race; logical occurrence ID and absolute deadline do not.

The history contains the decision; provider KV materialization and custom status are projections of that committed history. Use the public merged KV reader (`kv_store` plus current `kv_delta`), not a raw `kv_store` SQL query, for external state reads.

## 4. Durable ingress and worker attempts

Add `scheduler-ingress.ts`, `scheduler-ingress-pg.ts`, and `scheduler-outbox.ts` outside the orchestration folder. Add the next available CMS migration, not a hard-coded migration number that collides with the pending 0076 work.

### Tables and APIs

| Table | Key fields and constraints |
|---|---|
| `scheduler_attempts` | `(session_id, attempt_id)` primary key; immutable work/ordinal/base revision; worker execution token; state `open/sealed/stop_requested`; last action sequence; recorded terminal outcome |
| `scheduler_requests` | `(session_id, action_id)` primary key; unique `(session_id, attempt_id, action_sequence)` for model requests; canonical payload hash; immutable actor/origin/predecessor; per-session ingress sequence; delivery state/lease/error |
| `scheduler_ingress_heads` | Per-session allocation and delivery lease/cursor, serializes first delivery order |
| `scheduler_work_payloads` | `(session_id, work_id)` primary key; immutable normalized payload/hash and retention reference metadata |
| `scheduler_receipt_archive` | KV-derived terminal receipt, action ID, transition/hash; historical lookup only |

`SchedulerIngressStore` exposes `openAttempt`, `submit`, `sealAttempt`, `requestStop`, `readRequest`, `readAttemptRequests`, `leaseNextDelivery`, `markDelivered`, `putWorkPayload`, and archival operations. All submit/seal/stop operations lock the same attempt row. A submit committed before sealing is in the sealed prefix; a new submit after sealing fails. Duplicate submissions return their existing receipt before testing the closed gate, provided the hash matches.

Request envelope:

```ts
interface SchedulerRequestV1 {
  protocol: 1;
  actionId: string;
  sessionId: string;
  origin: { kind: "model"; workId: string; attemptId: string;
            attemptOrdinal: number; actionSequence: number; toolCallId: string }
        | { kind: "management"; actorId: string; requestId: string };
  expectedScheduleRevision: number;
  predecessorActionId?: string;
  operation: { type: "set_interval"; seconds: number; reason: string }
           | { type: "set_wall_clock"; specification: WallClockSchedule }
           | { type: "cancel_schedule" }
           | { type: "reconcile_schedule"; evidenceRevision: number; definition: Schedule };
}
```

Authorization and origin fields come from the existing trusted session/management context, not model-supplied arguments. Inbound envelopes identify an immutable stored request; application verifies that record and hash rather than trusting arbitrary message text. Invalid or unauthorized requests settle as rejected. The canonical schedule revision used by a tool comes from the admitted turn's scheduler context; the model does not invent it.

### Tool and activity changes

Add `runTurnSchedulerV1` and a corresponding proxy method. It reuses the established turn implementation, including epoch-start behavior, but requires scheduler protocol context: work ID, attempt ID/ordinal, base schedule revision, and payload reference/hash. Existing `runTurn` and `runTurn2` inputs and legacy behavior remain unchanged when the capability is absent.

Extend `TurnOptions.controlToolBridge` with `submitSchedulerRequest` and `getSchedulerRequest`. Preserve Copilot's `invocation.toolCallId`; also allocate an attempt-local ordered action sequence. The bridge atomically persists each request and outbox record before returning:

```json
{"actionId":"...","status":"pending","application":"not_applied"}
```

`cron_at(cancel)` becomes one unified cancel request. New protocol tools never append these requests to volatile `queuedActions`. On normal, error, watchdog, empty response, or stop outcomes, request recovery uses the durable attempt prefix, not whatever action array the model activity happened to return.

### Seal before recovery or retry

The worker opens its admitted attempt before invoking the model. A duplicate activity invocation must not silently start another model execution under an already-open attempt. If a trustworthy completed result exists in the existing snapshot/result protocol, reuse it. Otherwise return `scheduler_recovery_required`; the orchestration seals the old attempt, reconciles receipts, and admits a fresh attempt. A new provider tool-call ID is not proof of a new user intention.

After a turn result/error, before admitting any next model attempt, call the new `sealSchedulerAttempt` activity. It atomically prevents new scheduler requests from that attempt and returns its final action count plus immutable request references. If the worker disappeared without closing its gate, sealing still establishes the boundary. Submission racing seal is decided by their transaction order.

Reconcile the sealed prefix in action-sequence order. Model failure does not revoke already accepted requests. A stopped attempt rejects its unapplied requests. Already applied changes remain applied; stopping cannot undo them. When receipt storage is unavailable, persist a scheduler blocker and service input/control through an interruptible backoff; do not launch a new attempt while the old submission gate is uncertain.

The outbox pump is independent of a model turn and agent cron. It leases one session's next undelivered request, enqueues a `scheduler_request` envelope on the persistent `messages` inbox, then marks delivery. A crash after enqueue creates a duplicate, not a lost request. Duplicate settlement is harmless. Sealed-prefix reconciliation can consume request references directly, so a delayed outbox does not strand a completed turn; later duplicate envelopes return the same settlement.

Queryable acceptance/delivery state comes from ingress. Queryable application state comes from KV (or an archived KV-derived terminal receipt). They have separate freshness/version fields. A runtime pending count means “observed through this cutoff,” not “all requests accepted anywhere.” If the target terminalizes before application, expose `target_terminal` delivery/application-unavailable state; do not leave a permanently misleading pending receipt.

## 5. Applying commands and preventing stale effects

Implement `applySchedulerRequest` in the versioned transition module:

1. If a KV settlement exists, return it unchanged. Same action ID with a different payload is a protocol error.
2. If the request's attempt ordinal is retired, do not apply it as new. Return its archive receipt or a terminal `retired` disposition; never recreate a schedule from a pruned receipt.
3. Validate capability, source, sealed/active attempt policy, and stop/control tombstones.
4. For the first action in a chain, compare `expectedScheduleRevision` to current revision. For successors, require the predecessor to have applied and require its resulting revision still to be current. A rejected predecessor rejects its descendants. A → B in one turn works; A → external cancel → B conflicts.
5. For wall-clock schedules, compute the next occurrence using the existing deterministic activity before committing the application. An activity failure leaves the request pending or rejected under its error policy, never falsely applied.
6. Increment schedule revision for set/cancel/explicit reconciliation, update the accepted definition, invalidate old occurrences and saved interrupted cron state, write the terminal receipt, and publish the committed projection together.

Ordinary recurrence advancement increments occurrence ordinal, not schedule revision. A native timer re-registration or CAN changes neither. The occurrence key includes schedule revision, so A → B → identical A cannot revive the original A.

Every ready timer/digest descriptor has its owner's ID/generation. Validate before any activity, count increment, affinity release, or follow-up. A lease transition only changes its lease. `releaseAffinity` receives the expected lease generation; it no longer clears a work timer as an incidental side effect.

`input-grace` only advances the current question's current lease. Answering, superseding, or starting intervening work invalidates that lease generation. An identical question asked later has another question ID. New ordinary input during grace is eligible immediately.

## 6. Event loop, readiness, and instruction ordering

Refactor the new handler into these phases:

```text
load canonical KV / perform one-time legacy normalization
repeat:
  apply available control and receipt input in bounded pages
  validate delivered owned events; discard only provably stale effects
  advance stopped/sealing/recovery work as needed
  if autonomous work is eligible and no cutoff exists:
      insert a persistent cutoff marker
  drain through the fixed cutoff, including already buffered input
  choose one eligible work item or one state-only transition
  if work chosen: prepare immutable payload, admit, schedule activity
  else: publish the actual gate and wait on messages or earliest owned timer
  perform CAN only with all resume data committed/referenced
```

Add a `postSchedulerCutoff` activity using a stable marker ID. It enqueues into the same `messages` queue. Marker delivery is idempotent. Its first observed occurrence seals the prefix; later duplicates are ignored. The cutoff and its progress survive CAN. Do not continuously move the cutoff under new arrivals.

The guarantee is inbox-position based: all input before the marker, plus already-buffered input, is considered before autonomous work. Input after it is for the next decision, even if it arrives before physical model start. An outbox-accepted but undelivered request is not automatically before the marker. This avoids pretending that a timed peek or a high-watermark read makes activity admission atomic with ingress.

Do not wait on an active lease when local stash, FIFO, carried work, or child digest is runnable. Conversely, a retained item gated on a child, explicit wait, input, provider budget, recovery, or shutdown is not runnable merely because it exists. The selector returns `eligible`, `stale`, or `gated(reason, wake sources)`; all-gated state blocks instead of spinning.

Retries become ordinary owned work with `retryAtMs`. Replace direct blocking timers in generic retry, connection-closed retry, and scheduler-aware hydration retry paths with interruptible scheduler state. Preserve existing retry bounds and error classification. A provider-budget refusal does not consume an attempt or occurrence and does not satisfy required tools.

For a correction before the cutoff, build a reconciliation work payload referencing the failed work and the new input in order. Preserve input IDs, attachment references, sender/authority, and per-work constraints. Do not prepend the old failed instruction as a higher-priority fresh command. Do not force an obsolete per-work required tool into the reconciliation turn; it remains attached to its work and is enforced only if that work continues. Platform constraints remain independent. A status question does not cancel recurrence.

Persist a work payload with `putSchedulerWorkPayload` before removing its source FIFO items. Successful immutable payload creation followed by one KV transition transfers ownership from FIFO to work. Crash before transfer leaves FIFO intact; crash after transfer leaves the durable reference. Payload retries require the same hash. Retain referenced payloads until work/receipt retention permits archival; CAN does not duplicate prompt text as an independent scheduler authority.

### Message provenance and consumption receipts

The related `status?` incident is now confirmed independently of cron: execution 78 consumed client message `msg:1788803026251:y9q5adnh`, merged it after a cross-session update, cleared the FIFO, and scheduled turn 104 with the same ID. The resulting event was classified `system.message` because the combined text began `[SESSION_MESSAGE ...]`. The UI's user-message-only acknowledgement filter left the already-consumed message falsely queued.

The immediate compatibility repair is exact-ID acknowledgement for a persisted system/mixed event carrying client message IDs. It must not use text matching on machine messages or relabel the whole mixed envelope as user-authored. That repair does not require changing the deployed orchestration.

For N, preserve structured provenance in immutable work payloads instead of relying on a concatenated prompt's leading prefix:

```ts
interface SchedulerWorkPayloadV1 {
  schemaVersion: 1;
  segments: Array<
    { kind: "user"; clientMessageIds: string[]; sender: MessageSender;
      text: string; attachments: PromptAttachmentRef[] }
    | { kind: "session_update"; sourceSessionId: string; text: string }
    | { kind: "runtime_context"; text: string }
  >;
  previousFailedWorkRef?: string;
  constraints: Array<{ workId: string; requiredTool?: string }>;
}
```

Capture user segments before adding interruption/resume notes; preserve segment order through batching, retries, child-digest coalescing and CAN. Render model context from these segments, and emit transcript rows from the individual segments. Child/session data retains its source and never becomes user authority merely because it shares a model call. Do not infer missing historical segment boundaries by trimming or substring matching.

Emit a dedicated consumption receipt carrying session/work/attempt IDs and the exact client message IDs at the documented model-dispatch/consumption boundary. Its meaning is delivery to the turn, not successful model completion. Persist it through the same durable result/event protocol as the turn; a UI refresh can reconcile by IDs independently of transcript presentation. Expose admission and consumption separately if they occur at different commits. Retrying a consumed message does not create a new user message or reset its receipt.

The UI must acknowledge the original user bubble and show child context separately when structured segments exist. For legacy mixed events, acknowledge known IDs while keeping the combined text explicitly mixed/system context. This fixes the false single-check indicator without inventing an author for historical text.

### Stop boundary

Keep stop-one-attempt separate from cancel-recurring-schedule. For protocol sessions, look up the admitted/running attempt in authoritative KV, not only CMS's `running` flag. A stop targets that exact attempt ID, closes its ingress gate transactionally, and delivers to `scheduler.stop.<attemptId>`. Old stops cannot kill a new retry that happens to share a model iteration.

If stop is accepted before the worker's admission check, that worker must not start the model. If the model already passed the check, stop is an abort request with the existing best-effort fast path and Duroxide cancellation backstop; committed external effects cannot be undone. `no_active_attempt` does not mean the recurring schedule is cancelled or paused. Report accepted, stopped, or too-late outcomes explicitly. The admission/race implementation must settle requests even when activity completion beats stop.

## 7. Truthful status and receipts

Add a complete `scheduler` object to `SessionStatusSignal` containing schema version, transition, schedule revision/definition, occurrence, actual selected wake (purpose and absolute deadline), work phase, blocker, observed pending count/cutoff, and bounded last-outcome metadata. Keep legacy cron fields as derived configuration metadata.

The projector is pure and does not accept arbitrary overrides for scheduler fields. Every scheduling transition calls it. `get_info`, model listing, and receipt reads do not change execution phase. `session.cron_started` is replaced for new protocol telemetry by requested/applied/armed/delivered/admitted/dispatched/settled/discarded events with stable IDs; external event logging is not a commit oracle.

Read and merge rules:

- Use one scheduler transition/version for the entire scheduler object, including explicit null clears. Never mix newer phase with older A/B schedule fields.
- Preserve monotonic transitions through CAN. Match instance identity as well as revision.
- `waitingUntil` uses the recorded absolute deadline; legacy fallback requires both `waitStartedAt` and duration. Never use read time plus duration.
- Missing data and failed reads are distinct from committed cancellation. Keep last-known data and mark it stale/unavailable.
- CMS model-turn writeback owns turn telemetry, not scheduler fields. SDK list/detail responses carry scheduler freshness; a lagging projection cannot overwrite a newer one.
- Pending ingress receipts have their own observation version and delivery state. Do not report zero pending globally from an orchestration snapshot that has not consumed them.

Receipt archival is asynchronous and idempotent. Keep terminal receipts in KV until the archive acknowledges the exact transition/hash. Retire completed attempt ranges only after their sealed prefixes have terminal settlements. Duplicate old requests are rejected by persistent retirement watermarks even after receipt compaction. Unsettled requests and currently referenced work/attempts are never pruned by age alone.

## 8. Legacy import and versioned rollout

On first entry to N without `scheduler.state`, normalize legacy schedule, timers, question, retry state, FIFO and pending work. Persist the imported state and capability marker in one transition. Subsequent starts load KV; they do not re-import stale CAN fields. New CAN inputs carry `schedulerSchemaVersion: 1` and ordinary session configuration, omitting scheduler-owned legacy copies. Conflicting legacy fields alongside an existing KV schema are ignored and diagnosed.

Import rules:

- Preserve all user inputs and pending questions with attribution and constraints.
- An answered question's stale grace is demonstrably obsolete; invalidate it with an audit event.
- Legacy queued occurrences without a trustworthy owner cannot be matched by reason/interval alone. Preserve them in durable quarantine evidence, mark `needs_reconciliation`, and prohibit automatic execution/counting.
- A provably consistent active timer can be assigned an imported identity. If its absolute deadline cannot be recovered from recorded data, do not invent one from worker restart time; expose reconciliation.
- Do not infer expiry from natural-language cron reasons. The builder's elapsed observation deadline requires an explicit recovery decision.
- Unknown future schema or invalid canonical state fails closed with visible diagnostics; never silently fall back to legacy schedule fields.

Freeze the deployed handler and all its orchestration helpers before changing control flow. Preserve absent-field serialization for old activity inputs. Do not modify frozen directories or change their behavior through shared helpers. Add golden serialized inputs and genuine replay fixtures, in addition to the existing schedule fingerprint.

Rollout is two phase:

1. **Compatibility release:** migrate CMS tables; register the new activity and N handler; keep default start and legacy upgrade target on the previous version. Make the latest handler's own version independent of the default target. New N CANs must never downgrade. Verify every worker eligible for this queue can execute N and `runTurnSchedulerV1` before activation. A new activity name alone is not worker isolation.
2. **Activation release:** set the explicit start/upgrade target to N; canary named sessions first, then ordinary starts and natural CAN upgrades. New management requests require a fresh protocol-capability snapshot. New handlers require a configured ingress store for durable scheduling and never fall back to volatile success on storage failure.

Do not assume deployment wakes a parked old execution: legacy handlers advance only at supported CAN boundaries. Any targeted recovery uses an explicit audited command after reviewing the session's pending work. No direct SQL rewriting of orchestration KV/history/timers.

Rollback stops new N starts/upgrades but retains N handlers, activity implementations and schema for existing instances. Never downgrade a KV-schema-1 instance to a legacy handler. A bug in N requires a forward version; optional scheduler intake/dispatch pause must itself be explicit and visible, with accepted requests preserved.

## 9. Implementation work packages

| Package | Files / concrete change | Completion evidence |
|---|---|---|
| A. Contracts and fixtures | New scheduler types/store/transition modules; frozen baseline; immutable work payload/receipt schemas | Size, ownership, serialization and replay tests |
| B. Durable ingress | `cms.ts`, `cms-migrations.ts`, next migration; ingress/Pg/outbox modules; lifecycle start/stop integration in worker host | Transaction, duplicate, lease takeover, terminal target tests |
| C. Worker protocol | `managed-session.ts`, `session-proxy.ts`, control bridge; new activity; attempt open/seal/recovery | Scripted tool→error/crash and recovery tests |
| D. Orchestration integration | `state.ts`, `runtime.ts`, `queue.ts`, `turn.ts`, `lifecycle.ts`, `agents.ts`; replace legacy scheduling mutations and blocking retry sleeps | Full race/cutoff/gate tests, incident replay |
| E. Projection/API/UI | `session-status.ts`, `types.ts`, `client.ts`, `management-client.ts`, transports and generated web ops; UI reducer/controller/selectors and renderer | Atomic scheduler merges, stale reads, absolute deadlines, pending receipt tests |
| F. Migration/release | Registry/version modules, capability checks, operational recovery documentation, release metrics | Mixed-version and rollback rehearsal, canary trace review |

Ship A–F together as a complete protocol activation. Intermediate commits may compile behind a disabled start target but must not claim the scheduling guarantee.

Metrics: accepted-to-delivered and delivered-to-settled latency; due-to-admitted latency; stale effects by owner/reason; retries superseded by input; receipt conflicts/recovery-required; KV size/key headroom; projection age; count and oldest age of reconciliation blockers. Include session, schedule revision, occurrence, work/attempt, action, transition and source version in bounded structured diagnostics.

## 10. Approval criteria

The companion test plan defines the release gates. The proposal is implementation-ready only after adversarial findings are resolved in the document; runtime correctness is established later by those tests. No reliance on live Astra success rates, worker restarts as a repair, or raw event logs as proof of applied scheduling.
