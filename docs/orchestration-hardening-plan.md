# Orchestration Hardening Plan

This note lays out the next refactor for the durable session orchestration.
It focuses on three goals:

1. make the main loop smaller and easier to reason about
2. reduce status and continue-as-new state churn
3. use Duroxide's newer KV store APIs where they materially simplify the design

The current codebase is on `duroxide` `0.1.16`, which includes:

- core KV APIs added in `0.1.15`
- bulk KV reads, key listing, pruning, and a higher key cap in `0.1.16`

Official references:

- `duroxide-node` changelog: <https://github.com/microsoft/duroxide-node/blob/main/CHANGELOG.md>
- `duroxide-node` README: <https://github.com/microsoft/duroxide-node/blob/main/README.md>

## Current State

The current orchestration lives in `packages/sdk/src/orchestration.ts`.

Rough complexity markers:

- file size: about 1330 lines
- `OrchestrationInput` fields: 21
- `setStatus(...)` call sites: 26
- top-level `switch (result.type)` cases: 17

The orchestration currently overloads `customStatus` with several jobs at once:

- live state for the TUI (`running`, `waiting`, `input_required`, `error`, `idle`)
- result payloads (`turnResult`, `cmdResponse`, `intermediateContent`)
- control-plane data (`iteration`, `waitReason`, `pendingQuestion`)

It also carries a large amount of mutable workflow state through `continueAsNew(...)` input:

- `iteration`
- `needsHydration`
- `retryCount`
- `taskContext`
- `nextSummarizeAt`
- `subAgents`
- `parentSessionId`
- `nestingLevel`
- `prompt`
- plus session config and thresholds

That works, but it creates a few problems:

- too many responsibilities are mixed into one long loop
- `customStatus` blobs are doing double duty as both signal and payload
- transient state and long-lived state are carried the same way
- every continue-as-new has to serialize and reason about a large mutable input object

## Current Orchestration Pseudocode

This is the all-up shape of the orchestration today, simplified:

```text
function orchestration(ctx, input):
  load mutable state from input
    iteration
    affinityKey
    needsHydration
    retryCount
    nextSummarizeAt
    taskContext
    subAgents
    config

  create manager proxy
  create session proxy

  while true:
    if input carried a pending prompt:
      prompt = pending prompt
    else:
      set customStatus idle (+ maybe last turn result)

      loop until prompt acquired:
        msg = dequeueEvent("messages")

        if msg is command:
          mutate config or session state
          set customStatus with cmdResponse
          maybe continueAsNew
          continue outer loop

        if msg is child update:
          mutate subAgents[]
          continue inner loop

        prompt = msg.prompt

    if needsHydration:
      try hydrate with retries
      on repeated failure set customStatus error and go back to waiting

    set customStatus running

    try:
      turnResult = runTurn(prompt)
    catch activity failure:
      increment retryCount
      set customStatus error
      maybe dehydrate
      continueAsNew(prompt + retryCount + hydration state)
      return

    iteration += 1
    maybe summarize title

    switch turnResult.type:
      completed:
        maybe notify parent
        maybe auto-destroy child
        if no blob/idle timeout:
          stash lastTurnResult and continue loop
        else:
          set customStatus idle + turnResult
          race(next message, idle timer)
          if message:
            continueAsNew(prompt=message)
          else:
            dehydrate and continueAsNew(no prompt)
          return

      wait:
        maybe persist taskContext into config.systemMessage
        maybe publish intermediate content in customStatus
        maybe notify parent
        maybe dehydrate before long timer
        set customStatus waiting
        race(timer, interrupt message)
        build resume prompt from timer state
        continueAsNew(prompt=resumePrompt, hydration state)
        return

      input_required:
        set customStatus input_required + question payload
        race(answer, grace timer)
        maybe dehydrate
        continueAsNew(prompt="user was asked ... user answered ...")
        return

      spawn_agent / message_agent / check_agents / wait_for_agents / list_sessions /
      complete_agent / cancel_agent / delete_agent / error:
        mutate subAgents and/or status
        usually continueAsNew(prompt=system follow-up)
        return
```

## Proposed Refactor

The main design change is:

- keep event queues as the input path
- keep `customStatus` as a small change signal only
- move durable response payloads and mutable orchestration bookkeeping into KV

### Proposed State Split

#### Keep in `customStatus`

Only small routing/status fields:

```json
{
  "status": "idle|running|waiting|input_required|error|completed",
  "iteration": 42,
  "responseVersion": 17,
  "questionVersion": 4,
  "commandVersion": 9,
  "waitReason": "timer",
  "waitUntil": 1742080000000,
  "errorCode": "run_turn_failed"
}
```

#### Move to KV

Longer-lived and/or larger payloads:

- `meta.iteration`
- `meta.retryCount`
- `meta.needsHydration`
- `meta.nextSummarizeAt`
- `meta.taskContext`
- `meta.lastCompletedTurn`
- `meta.pendingQuestion`
- `meta.waitState`
- `subagents.snapshot`
- `response.latest`
- `response.completed.<iteration>`
- `command.<cmdId>`

### Proposed Orchestration Pseudocode

```text
function orchestration(ctx, input):
  load only bootstrap/static fields from input
    sessionId
    config
    affinityKey
    thresholds
    parentSessionId
    nestingLevel
    blobEnabled

  load mutable state from KV with defaults
    iteration = kv["meta.iteration"] ?? 0
    retryCount = kv["meta.retryCount"] ?? 0
    needsHydration = kv["meta.needsHydration"] ?? false
    nextSummarizeAt = kv["meta.nextSummarizeAt"] ?? 0
    taskContext = kv["meta.taskContext"] ?? null
    subAgents = kv["subagents.snapshot"] ?? []

  while true:
    msg = dequeueNextWorkItem()

    if msg.kind == "command":
      result = handleCommand(msg, state)
      kv["command.<id>"] = result
      bump commandVersion in customStatus
      if command changed config or durable state:
        write kv/meta
      if command requires loop restart:
        continueAsNew(minimal input)
        return
      continue

    if msg.kind == "child_update":
      update subAgents in KV
      maybe bump responseVersion
      continue

    if msg.kind == "user_prompt":
      if needsHydration:
        hydrate using kv/meta state

      set small customStatus { status: "running", iteration, ... }
      result = runTurn(msg.prompt)

      switch result.type:
        completed:
          kv["response.latest"] = completed payload
          kv["meta.lastCompletedTurn"] = completed payload
          bump responseVersion
          maybe schedule idle/dehydrate
          maybe continueAsNew(minimal input)

        wait:
          kv["meta.waitState"] = timer payload
          maybe kv["response.latest"] = intermediate payload
          bump responseVersion
          set small customStatus waiting
          race(timer, interrupt)
          continueAsNew(minimal input)

        input_required:
          kv["meta.pendingQuestion"] = question payload
          bump questionVersion
          set small customStatus input_required
          race(answer, grace timer)
          clear kv["meta.pendingQuestion"] when answered
          continueAsNew(minimal input)

        sub-agent actions:
          update kv["subagents.snapshot"]
          maybe kv["response.latest"]
          bump responseVersion
          continueAsNew(minimal input)

        error:
          kv["response.latest"] = error payload
          kv["meta.retryCount"] = retryCount + 1
          set small customStatus error
          maybe dehydrate and continueAsNew(minimal input)
```

## What Changes Architecturally

### Before

- `customStatus` is both signal and payload
- `continueAsNew` input is the main mutable state container
- orchestration state is re-threaded by hand through one large `continueInput(...)`
- command responses, questions, and turn results all compete inside one status blob

### After

- `customStatus` becomes a lightweight status index
- KV becomes the durable state and payload store
- `continueAsNew` input becomes mostly bootstrap and routing data
- UI and clients observe a small versioned status vector, then read payloads from KV

## Expected Benefits

These are estimates, but they are grounded in the current code shape.

### 1. Smaller carried orchestration input

Current `OrchestrationInput` has 21 fields.

A realistic post-refactor carry set is closer to 8-10 fields:

- session identity
- config
- affinity key
- hydration/blob toggles
- thresholds
- parent/nesting metadata
- maybe one explicit wake-up reason

Estimated reduction:

- about 50-60 percent fewer carried fields
- less risk of forgetting to thread a new mutable field through `continueInput(...)`

### 2. Smaller and cleaner `customStatus`

Today, `customStatus` can include:

- `turnResult.content`
- `cmdResponse.result`
- `intermediateContent`
- question payloads

Those can easily reach hundreds or thousands of bytes.

With the hybrid model, `customStatus` becomes a small status vector, likely under
150-250 bytes in most cases.

Estimated reduction for many active sessions:

- 70-95 percent smaller status payloads
- less JSON parse churn in TUI polling
- less duplication between CMS events, custom status, and transient UI state

### 3. Simpler session observers and management clients

Today, TUI and clients have to interpret many different shapes inside one status blob.

With versioned KV payloads:

- `responseVersion` means "read response KV"
- `questionVersion` means "read pending question KV"
- `commandVersion` means "read command response KV"

That should materially simplify observer logic and reduce duplicate/dropped render paths.

### 4. Easier pruning and bounded state growth

`0.1.16` added:

- `ctx.getKvAllValues()`
- `ctx.getKvAllKeys()`
- `ctx.getKvLength()`
- `ctx.pruneKvValuesUpdatedBefore(cutoffMs)`
- `client.getKvAllValues(instanceId)`

That makes it practical to:

- keep only the latest command responses
- keep only the latest completed response plus a bounded tail
- prune stale per-command KV keys

This is cleaner than letting `customStatus` repeatedly overwrite a single large blob.

## Evaluation: Event In, KV Out

The idea is:

- requests still arrive via `enqueueEvent(..., "messages", ...)`
- orchestration writes responses to KV instead of embedding them in `customStatus`

### Is This Viable?

Yes, with an important caveat:

- `KV-only output` is not a great replacement for `customStatus`
- `KV-backed payloads plus minimal customStatus` is a strong fit

### Why KV Helps

KV is a good fit for:

- command responses keyed by command id
- pending question payloads
- latest completed turn result
- sub-agent snapshots
- orchestration bookkeeping that survives continue-as-new

It is especially attractive for command responses because those are naturally keyed:

- `command.<cmdId>` -> `{ id, cmd, result, error, createdAt }`

### Why KV Should Not Fully Replace `customStatus`

The big missing piece is change notification breadth.

Today we have:

- `waitForStatusChange(instanceId, lastSeenVersion, ...)`

That is perfect for "something changed, tell me cheaply".

KV currently gives us:

- `getValue(instanceId, key)`
- `waitForValue(instanceId, key, timeoutMs)`
- `getKvAllValues(instanceId)`

That is useful, but it is not the same as:

- "wait until any of these response channels changed"

If we removed `customStatus` entirely, the UI would need to:

- poll multiple keys
- or wait on one dedicated sentinel key
- or repeatedly fetch all KV values to discover what changed

That is worse than using `customStatus` as the small versioned signal.

### Recommendation

Use a hybrid model:

- event queue for requests
- minimal `customStatus` for live status and version bumps
- KV for response payloads and durable orchestration bookkeeping

In practice:

- keep `waitForStatusChange(...)` as the wake-up signal
- when versions change, fetch KV values only for the affected channel

Example:

```text
customStatus = {
  status: "input_required",
  iteration: 42,
  questionVersion: 7,
  responseVersion: 18,
  commandVersion: 11
}

KV:
  meta.pendingQuestion
  response.latest
  command.ab12cd34
```

This preserves the good part of the current design:

- a single cheap, versioned wake-up path

while moving the bulky part out of status.

## Recommended Refactor Order

### Phase 1: Introduce KV-backed response payloads

Do not rewrite the main loop first.

Instead:

1. keep current orchestration structure
2. add KV writes for:
   - `response.latest`
   - `meta.pendingQuestion`
   - `command.<cmdId>`
3. shrink `customStatus` to pointers and versions
4. update TUI/client readers to follow those pointers

This gives the value of the new model without a full control-flow rewrite.

### Phase 2: Move mutable bookkeeping from input to KV

Migrate:

- `retryCount`
- `nextSummarizeAt`
- `taskContext`
- `subAgents`
- `lastCompletedTurn`
- wait/input state

Keep only truly bootstrap/static values in `OrchestrationInput`.

### Phase 3: Split the orchestration into explicit handlers

Break the current file into smaller helpers:

- `dequeueNextWorkItem`
- `handleCommand`
- `handleCompletedTurn`
- `handleWaitTurn`
- `handleInputRequiredTurn`
- `handleSubAgentAction`
- `persistResponseToKv`
- `publishStatusVector`

The point is not just file size. It is isolating transition logic so it is testable.

### Phase 4: Add client and management abstractions for KV-backed state

Expose or wrap:

- `getValue`
- `waitForValue`
- `getKvAllValues`

Then teach `PilotSwarmClient`, `PilotSwarmManagementClient`, and the TUI to use a
small response-state adapter instead of reaching into raw status blobs.

## Suggested Target State

### Minimal `customStatus`

```json
{
  "status": "waiting",
  "iteration": 42,
  "responseVersion": 18,
  "questionVersion": 7,
  "commandVersion": 11,
  "waitReason": "polling flight status",
  "waitUntil": 1742080000000
}
```

### KV layout

```text
meta.iteration
meta.retryCount
meta.needsHydration
meta.nextSummarizeAt
meta.taskContext
meta.pendingQuestion
meta.waitState
meta.lastCompletedTurn
response.latest
response.completed.<iteration>
command.<cmdId>
subagents.snapshot
```

## Risks And Caveats

### 1. KV schema becomes a product surface

Once the TUI and clients depend on key names, those names become part of the
effective compatibility contract.

Mitigation:

- version the response schema explicitly
- keep key names centralized in one module

### 2. Need pruning discipline

KV makes it easy to accumulate stale command responses.

Mitigation:

- keep `command.<cmdId>` keys bounded by age or count
- prune on turn completion or every N iterations

### 3. Do not move everything at once

A full loop rewrite plus a storage model rewrite at the same time would be risky.

Mitigation:

- do the response-channel split first
- then move bookkeeping state
- then simplify control flow

## Bottom Line

The strongest next move is not a full orchestration rewrite in one shot.

It is:

1. keep event queues for inbound requests
2. keep a tiny versioned `customStatus` as the wake-up signal
3. move response payloads and mutable orchestration bookkeeping into KV
4. then simplify the control flow around that cleaner state model

That should reduce status churn, shrink continue-as-new input, and make both the
runtime and the TUI easier to reason about.
