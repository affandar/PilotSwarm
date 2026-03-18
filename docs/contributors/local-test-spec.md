# Local Test Specification

This document describes the current local integration test suite in `packages/sdk/test/local/`.

It is intentionally different from the broader planning document in [docs/contributors/local-integration-test-plan.md](docs/contributors/local-integration-test-plan.md):

- the plan describes the target coverage model
- this spec describes the tests that actually exist today, what they assert, and where the suite can be hardened

## Scope

The inventory below covers all current local test files under:

- `packages/sdk/test/local/*.test.js`
- `packages/sdk/test/local/sub-agents/*.test.js`

It also notes the current test entry points used by the local runner:

- `./scripts/run-tests.sh`
- `packages/sdk/package.json` `test:local:*` scripts

## Current Local Test Files

### `smoke-basic.test.js`

Purpose:

- basic end-to-end SDK behavior on a single worker/session

Tests:

- `Simple Q&A`
  - sends a basic prompt
  - asserts the answer contains the expected fact
  - validates CMS/event persistence at a basic level
- `Tool Calling`
  - registers a simple math tool
  - asserts the response includes the expected result
- `Multi-turn Conversation`
  - sends two turns with memory dependence
  - asserts the second turn recalls information from the first turn
- `Event Persistence`
  - reads persisted events from CMS
  - asserts events exist, expected types exist, and sequence numbers increase
- `Session Resume`
  - resumes a session by ID after a prior turn
  - asserts a follow-up turn can still reference earlier conversation state
- `send() + wait()`
  - exercises the split send/wait path instead of `sendAndWait`
  - asserts a response is still returned

Primary assertions:

- basic response correctness
- event existence and monotonic sequence order
- session resume works for an ordinary warm path

Hardening ideas:

- replace loose substring checks for memory tests with prompts that force an exact single-token answer
- avoid fixed sleeps when waiting for event persistence; prefer polling helpers with explicit failure messages
- assert exact expected event types and minimum counts for each path

### `smoke-api.test.js`

Purpose:

- API-surface coverage for session listing, info, delete, and subscriptions

Tests:

- `Session List`
  - creates multiple sessions
  - asserts both appear in `listSessions()`
- `Session Info`
  - checks `getInfo()` before and after a turn
  - asserts status/iteration fields move as expected
- `Session Delete`
  - deletes a session
  - asserts it disappears from CMS-backed session listing
- `session.on() Events`
  - subscribes to session events
  - asserts events are delivered to the callback
- `Event Type Filter`
  - subscribes to filtered event types
  - asserts only the requested event types are delivered

Primary assertions:

- client-facing APIs return sensible metadata
- delete removes session visibility
- event subscriptions receive the correct scope of events

Hardening ideas:

- replace fixed waits with polling on event counts
- add negative-path tests for invalid session IDs and repeated delete calls
- assert event ordering more explicitly in subscription tests

### `durability.test.js`

Purpose:

- durability behavior for waits, input-required flows, continue-as-new, and repeated turns

Tests:

- `Short Wait (in-process)`
  - uses a short wait below the durable threshold
  - asserts correct final answer and minimum elapsed time
- `Durable Timer (abort + resume)`
  - forces the durable path using a zero wait threshold
  - asserts a wait can complete and return the expected answer
- `Durable Timer CMS States`
  - asserts CMS state passes through `waiting` and then returns to `idle` or `completed`
- `User Input (input_required)`
  - triggers an `ask_user` flow
  - asserts the user-input callback is invoked and the final response uses the supplied answer
- `Continue-as-new After Idle`
  - performs multiple turns and checks recall after idle/continue-as-new behavior
- `Multiple Iterations`
  - performs repeated turns
  - asserts session iteration count rises across turns

Primary assertions:

- durable timer path still returns the correct answer
- `input_required` round-trip is functional
- iteration count continues rising across turns

Hardening ideas:

- tighten memory assertions so a generic mention of a token does not count as success
- assert exact CMS states for each transition instead of allowing broad alternates where possible
- add explicit validation that continue-as-new actually happened, not just that later turns still worked

### `multi-worker.test.js`

Purpose:

- shared-store and shared-session-state behavior across multiple workers
- strict create-vs-resume lifecycle coverage

Tests:

- `Two Workers Observe Same Session`
  - creates a session while two workers are present
  - asserts the session is visible in CMS and answers correctly
- `Session Survives Graceful Restart`
  - worker A creates a memory-bearing session, gracefully dehydrates, worker B resumes
  - asserts the remembered value survives across workers
  - asserts the session archive exists before recovery
- `Multiple Sessions Across Two Workers`
  - creates several sessions and drives independent prompts
  - asserts each session answers correctly and all appear in the session list
- `Worker Handoff After Stop`
  - stops worker A and continues the same session on worker B
  - asserts later turns still succeed and iteration increases
- `Turn 0 Resets Stale Stored Session`
  - pre-seeds stale Copilot session state for a fixed session ID
  - starts a brand-new turn-0 session with that same ID
  - asserts stale state is discarded and a fresh session is created
- `Turn 1+ Fails Without Stored Session`
  - establishes a prior session, deletes all resumable state, then attempts a resumed turn
  - asserts the session fails rather than silently creating a new Copilot session
  - asserts CMS reflects the failure

Primary assertions:

- valid handoff/recovery works
- stale turn-0 state is purged
- missing turn-1+ state is fatal

Hardening ideas:

- add explicit assertions that work is actually distributed across workers instead of merely sharing a store
- add a direct assertion that the resumed path used archive-backed hydration rather than a warm local directory
- add a crash-path equivalent for the strict turn-1+ failure rule, not only graceful-stop plus deletion

### `commands-user.test.js`

Purpose:

- orchestration command and command-response behavior without the TUI

Tests:

- `get_info Command`
  - sends a command and polls for the command response
  - asserts a response exists and is correlated to the command
- `/done Command`
  - sends a completion command
  - asserts command success
- `/done During Idle Window`
  - sends a prompt and then issues `/done` during the post-turn idle window
  - asserts the command still succeeds

Primary assertions:

- command responses are emitted and retrievable
- `/done` can complete a session from user-visible states

Hardening ideas:

- assert exact command response payload contents, not only `ok`
- add tests for duplicate command IDs and already-completed sessions
- replace arbitrary polling sleeps with a reusable command-response wait helper

### `management.test.js`

Purpose:

- management client behavior for session operations

Tests:

- `sendMessage via Management`
  - sends a message through the management path
  - asserts orchestration status version changes and the turn progresses
- `Management Session Operations`
  - lists sessions, renames a session, and verifies the new title
- `Cancel Session`
  - cancels a session and polls for a terminal state

Primary assertions:

- management API can drive sessions and rename them
- cancel changes session state

Hardening ideas:

- tighten cancel assertions to a single expected state where the product contract is precise
- assert rename persistence through both `listSessions()` and `getInfo()` in the same test
- add negative tests for unknown session IDs and double-cancel

### `kv-transport.test.js`

Purpose:

- hybrid KV/customStatus transport coverage

Tests:

- `Response Written to response.latest`
  - asserts completed responses are available through the KV path
- `CustomStatus Available`
  - asserts custom status versions advance
- `Command Response via KV`
  - asserts command responses are written to KV
- `Response Versions Monotonic`
  - asserts response version numbers rise monotonically across turns
- `waitForStatusChange Detects Updates`
  - asserts the status wait path detects orchestration progress

Primary assertions:

- KV response and command transport works
- versioning allows clients to dedupe updates

Hardening ideas:

- validate the full shape of `response.latest` and command payloads, not only a few fields
- add cases for repeated continue-as-new and command-response races
- explicitly test the fallback/compatibility path for older orchestration status payloads

### `cms-events.test.js`

Purpose:

- event persistence and event filtering in CMS

Tests:

- `Events Seq Strictly Increasing`
  - asserts event sequences rise strictly
- `Expected Event Types Persisted`
  - asserts expected persisted event types exist
- `No Transient Events Persisted`
  - asserts delta/transient event types are not written to CMS
- `User Message Event Data`
  - asserts stored user-message payloads contain the expected prompt data

Primary assertions:

- persisted event history is stable and ordered
- transient event types are excluded from CMS

Hardening ideas:

- remove fixed sleeps by polling for expected event count
- strengthen event data assertions to exact payload values where stable
- add coverage for tool events and child/session-management events

### `cms-state.test.js`

Purpose:

- CMS state transitions, title handling, soft delete, and iteration tracking

Tests:

- `Session State Transitions`
  - asserts state evolves from pending into an active/idle state after a turn
- `Title Update via Management`
  - asserts a management rename persists in the database
- `Session Iteration Count`
  - asserts iteration increases across turns
- `Soft Delete Hides Session`
  - asserts deleted sessions disappear from primary reads
- `Rename Visible In List And Info`
  - asserts renamed titles appear in list and info views
- `Rename Persists Across Resume`
  - asserts rename survives resume
- `Rename Truncates Long Title`
  - asserts long titles are truncated to the expected maximum

Primary assertions:

- CMS remains the authoritative read model for state and titles
- rename and delete semantics are consistent across APIs

Hardening ideas:

- replace `>=` iteration assertions with exact expected counts where the turn count is deterministic
- add negative rename tests for empty or invalid titles if the API contract defines them
- explicitly assert `updatedAt` changes on state and title transitions

### `contracts.test.js`

Purpose:

- runtime contract checks for tools, prompts, agents, and worker-loaded assets

Tests:

- `Worker-Registered Tool By Name`
  - asserts a worker-registered tool can be referenced by `toolNames`
- `Registry + Per-Session Tools Combined`
  - asserts worker-level tools and per-session tools are both available
- `Tool Update After Eviction`
  - evicts a session, changes its tool set, and asserts the new tool set is effective on later turns
- `Mode Replace Keeps Base Prompt`
  - asserts replace-mode system messages do not strip core runtime prompt behavior
- `Worker Exposes Loaded Agents`
  - asserts worker exposes loaded system agents
- `Worker Skill Dirs Loaded`
  - asserts worker exposes loaded skill directories

Primary assertions:

- runtime tool resolution and session config updates work
- base prompt behavior is preserved under `mode: "replace"`

Hardening ideas:

- add explicit assertions that tools were actually called rather than guessed by the model
- strengthen loaded-agent checks to assert exact expected agents in test setups
- add schema or name-conflict tests for tool registration

### `chaos.test.js`

Purpose:

- local restart and interruption scenarios without AKS

Tests:

- `Worker Restart During Long Wait`
- `Stop Both Workers Then Restart`
- `Session Delete During Completion`
- `Rapid Worker Stop/Start`
- `Concurrent Sessions Under Worker Restart`

Primary assertions:

- sessions remain visible and usable across abrupt stop/start cycles
- delete during an active or recently-completed path is handled safely

Hardening ideas:

- strengthen result assertions beyond non-null/non-empty responses
- add more explicit state verification during interruptions
- consider child-process workers for more realistic crash semantics

### `session-policy-guards.test.js`

Purpose:

- guardrail enforcement for session-creation policy and system-session deletion

Tests:

- `Agent Namespacing`
- `List Agents Omits System`
- `Client Rejects Generic When Disallowed`
- `Client Allows Named Agent`
- `Client Rejects Unknown Agent`
- `Client Rejects System Agent`
- `Deletion Protects System Sessions`
- `Orch Rejects Generic When Disallowed`

Primary assertions:

- client and orchestration both enforce policy
- system sessions cannot be deleted through normal APIs

Hardening ideas:

- add stronger exact-match error assertions instead of substring-only checks
- add qualified-name and mixed-plugin negative cases to the guard suite itself
- cover more than one system session in delete-protection tests

### `session-policy-behavior.test.js`

Purpose:

- behavioral consequences of policy configuration and plugin composition

Tests:

- `No Policy (Open)`
- `Open Policy Allows Generic`
- `Multiple Plugin Dirs Merge`
- `Last Policy Wins`
- `Named Agent Title Prefix`
- `System Agent Title Not Prefixed`
- `Orch Allows Named Agent`
- `Orch Allows Sub-Agent Spawns`
- `Qualified Name Resolution`
- `App System Agents Coexist`
- `Named Agent Title After Summarization`

Primary assertions:

- policy composition and override behavior are coherent
- agent/session title behavior stays consistent before and after summarization

Hardening ideas:

- replace the hardcoded 65-second summarization wait with a hookable/testable summarize trigger
- make the system-agent lookup path more deterministic so the test does not risk silent environmental dependence
- tighten the qualified-name test to verify actual spawn resolution, not only loaded metadata

### `reliability-crash.test.js`

Purpose:

- single-session crash/restart recovery coverage

Tests:

- `Orchestration Survives Worker Crash`
  - asserts later turns still work after worker replacement
- `CMS Consistency Across Crash`
  - asserts state and iteration continue coherently across a crash
- `Tool Works On Replacement Worker`
  - asserts worker-registered tools still function after worker replacement

Primary assertions:

- ordinary crash recovery works for sessions and tools

Hardening ideas:

- strengthen answer correctness checks so model guessing does not count as tool/path success
- compare pre-crash and post-crash orchestration/CMS state more directly
- add a case where the crash happens mid-turn rather than only between turns

### `reliability-multi-crash.test.js`

Purpose:

- staggered and repeated restart coverage, including local-state deletion with persisted archives

Tests:

- `Staggered Crashes — Multiple Sessions`
  - establishes multiple sessions across repeated worker crashes
  - asserts all remain visible and at least one can resume successfully
- `Deleted Local State Recovered From Store`
  - establishes a session, persists an archive, deletes only local state, resumes on a new worker
  - asserts recovery succeeds from store-backed state
- `Double Crash — Two Consecutive Restarts`
  - drives the same session across three workers
  - asserts later turns still succeed and iteration reaches 3+

Primary assertions:

- stored archives can recover deleted local state
- repeated crash/restart cycles do not break session continuity

Hardening ideas:

- explicitly verify archive-backed restore occurred, not just later-turn success
- tighten iteration checks where exact counts are deterministic
- add the complementary negative case where both local and stored state are deleted and failure is expected

### `model-selection.test.js`

Purpose:

- model recording and per-session model selection behavior

Tests:

- `Create Session With Explicit Model`
- `Model Recorded In CMS After Turn`
- `Different Models On Same Worker`
- `Default Model Recorded`

Primary assertions:

- chosen model names are recorded in CMS and session info

Hardening ideas:

- add normalization and invalid-model rejection cases
- add assertions that child/sub-agent model inheritance and override are preserved in the general suite as well as the specialized sub-agent file

### `system-agents.test.js`

Purpose:

- auto-start lifecycle for built-in management/system agents

Tests:

- `Pilotswarm Root Agent Created`
  - asserts the root system session appears with deterministic metadata and splash
- `Child System Agents Spawned`
  - asserts pilotswarm spawns sweeper and resource manager children
- `Child Agent Titles`
  - asserts expected fixed titles for system children
- `Child Agent Splash Screens`
  - asserts splash banners exist and contain expected content
- `Child Agent CMS Metadata`
  - asserts system child metadata and parent/child linkage in CMS

Primary assertions:

- built-in system agent tree comes up automatically and writes correct metadata

Hardening ideas:

- replace long manual polling loops with reusable wait helpers that surface the last observed state on failure
- add partial-spawn diagnostics so failures identify which child agent is missing and what pilotswarm last emitted
- add deterministic-id restart assertions to prove system children are reused rather than recreated incorrectly

## Sub-Agent Focused Files

The sub-agent suite is split into dedicated files under `packages/sdk/test/local/sub-agents/`.

### `spawn-custom.test.js`

Purpose:

- ad hoc custom sub-agent spawn by task only

Tests:

- `Spawn Custom Sub-Agent`
  - asserts a child session is created for a custom task-only spawn

Hardening ideas:

- assert the child actually completes the requested task, not only that it exists

### `custom-no-skill.test.js`

Purpose:

- custom sub-agent spawn without a preconfigured skill or named agent definition

Tests:

- `Custom Agent Without Skill`
  - asserts a child is created and does not get an `agentId`

Hardening ideas:

- assert the absence of named-agent metadata more comprehensively

### `child-metadata.test.js`

Purpose:

- parent/child metadata and descendant lookup

Tests:

- `Child Session CMS Metadata`
  - asserts `parentSessionId` is set correctly and the child appears in descendant queries

Hardening ideas:

- add multi-child and grandchild descendant assertions

### `check-agents.test.js`

Purpose:

- `check_agents` orchestration behavior

Tests:

- `Check Agents Returns Child Status`
  - spawns a child then calls `check_agents`
  - asserts status reporting works and the parent turn advances

Hardening ideas:

- assert the response includes the child session ID and status text rather than only completing

### `multiple-agents.test.js`

Purpose:

- multiple children under one parent session

Tests:

- `Multiple Sub-Agents`
  - spawns more than one child and asserts multiple CMS children exist

Hardening ideas:

- assert each child corresponds to a distinct task
- assert completion/update handling for both children, not only creation

### `named-agents.test.js`

Purpose:

- named-agent spawning through `agent_name`

Tests:

- `Spawn Named Agents By agent_name`
  - asserts named children resolve to canonical agent metadata, titles, splash, and system flags

Hardening ideas:

- add negative tests for unknown or malformed `agent_name` values
- validate actual tool-call parameters if available in events

### `model-override.test.js`

Purpose:

- child model inheritance/override behavior

Tests:

- `Child Inherits Parent Model`
  - asserts a child inherits the parent model when not explicitly overridden

Hardening ideas:

- add explicit override acceptance and explicit invalid-override rejection assertions in this same file

### `nested-spawn.test.js`

Purpose:

- nested sub-agent spawning and max-depth enforcement

Tests:

- `Depth 2 Nesting (Grandchild)`
  - spawns a child which spawns a grandchild
  - asserts the root → child → grandchild parent chain exists in CMS
- `Depth 3 Denied (Max Nesting)`
  - asserts no depth-3 sessions are created when depth 2 is the maximum

Execution check:

- this file executes normally
- the tests are not swallowing failures
- assertions are direct and would fail the file if conditions are not met
- there are no broad catch-and-ignore blocks in the test body

Hardening ideas:

- replace the fixed 5-second post-turn sleep with a wait helper based on child/grandchild CMS appearance
- make the depth-3-denied case more direct by asking for an explicit depth-3 spawn attempt and asserting rejection, not only absence

## High-Value Hardening Ideas Across The Suite

### 1. Replace fixed sleeps with state-based polling helpers

Several files still use fixed waits such as 500ms, 2s, 5s, or 65s. These are the biggest source of avoidable flakiness.

Prefer helpers that poll for:

- expected event count
- expected CMS state
- expected child count
- expected title change
- expected command response version

### 2. Strengthen weak substring assertions

Many tests currently pass if the response merely contains a token like `4`, `56`, `Alice`, or `X123` anywhere.

Prefer prompts that force:

- a single-word answer
- a single-token answer
- an exact JSON or exact quoted response

That reduces false positives from model verbosity.

### 3. Assert actual tool-path execution, not only final text

For tool tests, response correctness alone is not enough because the model can guess.

Where possible, also assert:

- tool execution events were emitted
- expected tool names were called
- child/tool metadata changed as expected

### 4. Separate positive recovery from negative missing-state behavior

After the strict session lifecycle change, tests need to distinguish clearly between:

- recoverable state loss: local files deleted, store archive still exists
- unrecoverable state loss: memory, local files, and store are all gone

Both paths should have explicit tests and should never be conflated.

### 5. Tighten iteration assertions where deterministic

A lot of tests use `>=` for iteration counts.

That is fine for some asynchronous flows, but for deterministic turn counts many should assert exact expected values. Otherwise regressions that double-execute a turn can still pass.

### 6. Add better worker-distribution and recovery-path assertions

The multi-worker and reliability suites prove that behavior still works, but not always that the intended path was used.

Useful additions:

- assert archive existence and disappearance at the right times
- assert local session directory presence/absence during handoff
- assert host/worker identity changes across turns where relevant

### 7. Make summarization tests less time-based

The named-agent summarization test currently waits more than a minute to cross the summarization threshold.

That is expensive and brittle. Better options:

- injectable summarize delay in test mode
- a direct management/command trigger for summarize in tests
- a special worker default override only used in the suite

### 8. Add explicit negative cases for named-agent and model resolution

There is good positive coverage for named agents and model inheritance. The suite should also assert:

- unknown `agent_name` is rejected clearly
- malformed qualified names are rejected clearly
- invalid or unqualified child model overrides are rejected clearly

## Test Runner Notes

Current local runner surfaces are:

- `./scripts/run-tests.sh`
- `npm run test:local` in `packages/sdk`

Current grouped npm scripts are:

- `test:local:smoke`
- `test:local:durability`
- `test:local:multi-worker`
- `test:local:commands`
- `test:local:management`
- `test:local:sub-agents`
- `test:local:kv-transport`
- `test:local:cms`
- `test:local:contracts`
- `test:local:chaos`
- `test:local:system-agents`
- `test:local:session-policy`
- `test:local:reliability`

One improvement here would be to add a dedicated grouped runner for nested-spawn or other especially slow/high-risk sub-agent scenarios when debugging regressions locally.

## Recommended Next Hardening Pass

If we want the biggest reliability payoff quickly, the best next set of improvements is:

1. Replace all fixed sleeps in local tests with polling helpers that report the final observed state.
2. Tighten memory and math response assertions to exact-answer prompts.
3. Add explicit negative tests for unknown named agents and invalid model overrides in the specialized sub-agent files.
4. Add direct assertions that multi-worker handoff used archive-backed recovery where intended.
5. Add a deterministic summarize trigger or shorter test-only summarize interval.