# Native Copilot subagents: localhost spike

Implemented on `codex/native-copilot-subagents-spike`, 2026-09-08.
Baseline: Copilot SDK 1.0.13 / CLI 1.0.83. Default remains off.

## Behavior

Copilot's native `task` tool can delegate bounded work to another Copilot
context on the same worker. The parent awaits the result inside its existing
PilotSwarm turn. No slash command is needed. Copilot decides when delegation
helps, or the user can explicitly request it.

The spike supplies two custom profiles to the native harness:

| Profile | Intended use |
| --- | --- |
| `swarm-explore` | Workspace investigation; return findings with file references |
| `swarm-task` | Local tests, builds, and commands; return concise results |

These are native Copilot agents, not PilotSwarm child sessions. They have
explicit CLI tool lists. They cannot call PilotSwarm external
tools, inherit deployment agent definitions, use MCP servers, or recursively
invoke `task`. The built-in wildcard agents are excluded because earlier
experiments showed they could inherit the parent's external tools.

This deliberately narrows the original proposal's MCP/application-tool scope.
Compatible application tools can be considered separately after this spike.
Shell access has the worker's existing OS permissions; these profiles are not a
filesystem or process security sandbox. `swarm-explore`'s no-edit instruction is
a behavioral instruction, not an OS-enforced read-only boundary.

Both profiles use the parent's admitted model/provider and inherit its
reasoning/context settings. Caller-supplied model, reasoning, and context-tier
overrides are rejected. A separate `swarm-rubber-duck` profile is deferred and
is neither registered nor mentioned in native delegation guidance.

`spawn_agent` remains the mechanism for independent durable work, timers,
wake-ups, later messages, and child contracts. `/tasks` and `/fleet` UI support,
background native execution, cross-worker delegation, and performance claims
are outside this spike.

## Enablement

```ts
new PilotSwarmWorker({
    // Existing store, credentials, and worker configuration
    nativeSubagents: "sync", // "off" | "sync"
});
```

Alternatively set `PILOTSWARM_NATIVE_SUBAGENTS=sync`. An explicit worker option
wins over the environment. Unknown values fail startup. Configure every worker
in the receiving pool consistently. This is a worker setting, not a durable
per-session field or a public API toggle.

System sessions, the regeneration distiller, and the agent tuner retain the
existing task exclusion. Create and resume share one configuration path;
changing the effective native setting forces a warm-session rebind.

## Execution and event boundaries

- Compose application pre-tool hooks, preserving denials and checking rewritten
  arguments. Omitted task mode becomes `sync`; background mode is rejected.
- Exclude `write_agent` and native scheduling/factory tools. Native child shell
  calls reject async mode and the explicit detach flag.
- Scope native tools and reject child calls to external tools at both the hook
  and actual SDK callback boundary, including tool-name collisions.
- At turn entry and exit, cancel/retire reusable native agents. Successful root
  completion with a still-running native agent is an execution-contract error,
  even if cleanup succeeds. Cleanup failure or a five-second timeout throws
  before the activity's snapshot commit. Late task-RPC responses cannot
  continue cancellation against a subsequent turn.
- Stop and error unwinds run the same cleanup. No new orchestration version or
  frozen orchestration change is needed.
- Preserve `nativeAgentId` and native tool-call correlation. Store child
  transcripts/tools under `native.*`; only root events affect final answers,
  reasoning, streaming callbacks, required-tool checks, and idle completion.
- Keep child `assistant.usage` in the existing accounting path. A scripted
  four-request parent/child exchange produced exactly 80 input and 20 output
  tokens, proving the parent usage event did not already include child usage.
- Render concise native start/completion/failure entries in Activity. Child
  messages remain inspectable as events without becoming parent chat answers.

Native agents are transient. Cold resume retains the parent task result and
can start fresh native work. A machine crash can interrupt local work; this
spike does not make native child execution independently resumable or roll back
filesystem side effects.

## Adversarial review findings

Two manual adversarial review passes examined tool authority and turn/event
lifecycle, followed by targeted regression checks. No independent reviewer was
used.

| Finding | Resolution and evidence |
| --- | --- |
| Built-in agents inherit external tools | Exclude built-ins, use scoped custom profiles; real CLI fabricated child tool call cannot invoke parent handler |
| Existing base prompt forbids native task | Scope durable instructions and add worker-controlled native guidance |
| Child events overwrite/settle the parent | Isolate child transcript, reasoning, deltas, tools, and idle; interleaving regression test |
| Completed native agents remain idle/reusable | Cancel/remove them before snapshot; real warm/cold runtime checks |
| Tool-name collision could bypass a name allowlist | Guard SDK callbacks at creation and per-turn registration; root calls still work |
| Background/model overrides bypass admission/lifecycle | Runtime hook rejection tests, including app-hook argument rewrites |
| Cancellation might leave an OS process alive | Real child shell stop test checks the process is gone, not just task metadata |
| Cleanup timeout can resume during a later turn | Expiration guard after each RPC; delayed-response regression test |
| Stop arrives after the answer but during cleanup | Classify the turn only after cleanup; stop-race regression test |

## Verification

- 43 new SDK policy/runtime checks pass. The native runtime tests use the real
  pinned CLI and scripted localhost inference, without live credentials.
- 84 focused SDK tests pass in total, including the new tests and existing
  reasoning, stop-turn, inactivity-watchdog, and provider-wire suites.
- All 651 UI core tests pass, including native activity and replay rendering.
- Full build passes (SDK, Horizon store, portal, MCP).
- Broad SDK unit run: 775 pass; one existing test file fails to load because
  `dist/agent-package-fetchers.js` has no corresponding source module in the
  branch baseline (`db0ce955`). This is unrelated to the spike.
- Live GitHub Copilot smoke: `gpt-5.6-terra`, native `swarm-explore` source read,
  parent summary, completed durable turn. Child took about 5 seconds; whole
  turn about 12.6 seconds. This is functional evidence, not a benchmark.

### Guidance delivery correction

A subsequent user session requested background execution and a reasoning
override. The native guidance had been attached as `content` alongside the
`last_instructions` transform callback; the SDK ignores that sibling field.
The guidance now forms part of the callback's returned text, including explicit
instructions to omit model, reasoning-effort, and context-tier arguments.

The regression checks reproduce the missing guidance before the fix and inspect
actual inference requests through the pinned SDK/CLI on create, warm reuse, and
cold resume. They also verify existing prompt overlays survive and disabled or
ineligible sessions do not receive the guidance. All 49 focused tests and the
full build pass after the correction.

A fresh live GitHub Copilot session, asked to delegate without specifying
execution arguments, selected `swarm-explore` with `mode="sync"` and omitted
model/reasoning/context overrides. The native child completed 11 local tool
calls in about 24 seconds, followed by the parent's summary, with no tool
failures. Local session: `7cb2d383-c902-4669-a8bd-423c336cf871`.

## Local instance

### Delegation selection and regression tests

The framework base prompt is now version `1.21.0`. A matching configured,
user-creatable specialist takes priority and is spawned by exact `agent_name`.
Long-lived work and broad scale-out favor durable sessions. User wording such
as “subagent”, “spawn”, and “spin off” is a strong durable hint; explicit native
requests and required access to the current uncommitted checkout still matter.
These are prompt guidelines, not a keyword router. A request for durable agents
that run native tasks preserves that two-level structure.

A synchronous native task shares its immediate parent's filesystem and working
directory, including when that parent is itself a durable child. Separate
durable sessions still cannot assume they share files. No orchestration or data
model change is needed for this selection guidance.

`PILOTSWARM_NATIVE_SUBAGENTS=off` remains the default. Tests exercise disabled
new/warm/cold sessions, durable spawning while disabled, and saved-session
sync-to-OFF revocation. See [the test guide](../models/native-delegation-testing.md)
for the unified suite, live routing evaluation, and repeatable durable/native
filesystem smoke test.

Portal: <http://127.0.0.1:3017>. Bound only to loopback, with local auth disabled.
It uses one standalone worker with native delegation enabled and management
agents disabled. Existing services on ports 3001/3002 are untouched.

Database: `pilotswarm_native_subagents_spike` on the existing local PostgreSQL
server at port 55432. Session/snapshot state, logs, and the launcher are isolated
under `.tmp/native-subagents/` in this worktree. It uses the existing GitHub
credential without printing it or adding it to git.

To try it, open a session and ask:

> Use a native swarm-explore task to inspect this repository's session manager.
> Return three findings about how native agents are configured. Do not edit files.

Look for `[native agent] … started/completed` in Activity. For verbose command
work, request `swarm-task`. No `/tasks` command is exposed in this spike.

Local restart: `node .tmp/native-subagents/serve.mjs` from the worktree. Stop
only this instance with `kill -TERM $(cat .tmp/native-subagents/server.pid)`.
The launcher contains local paths and is intentionally not committed.
