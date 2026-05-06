# Drivers

A `Driver` runs an `EvalSample` (or `TrajectoryTask` turn) and returns observed evidence: tool calls, final response, latency, CMS state, optionally `cmsEvents` and `durability` annotations. Every runner (`EvalRunner`, `MultiTrialRunner`, `MatrixRunner`, `TrajectoryRunner`) takes a Driver — picking the right one is the first design decision in any eval.

## Driver matrix

| driver | source | LLM calls | speed | what it's for |
|--------|--------|-----------|-------|----------------|
| `FakeDriver` | `src/drivers/fake-driver.ts` | no | <1ms/case | unit tests, CI, deterministic harness regression. The whole non-LIVE test suite uses this. |
| `LiveDriver` | `src/drivers/live-driver.ts` | yes | 5-30s/case | real PilotSwarm session against `LiveDriverDeps.modelProviders` (default Copilot). Gated by `LIVE=1`. |
| `DurabilityFixtureDriver` (alias `ScriptedDriver`) | `src/drivers/scripted-driver.ts` | no | <1ms/case | scripted crash/recovery scenarios. Drives `gradeDurability` on fixture data without real worker kills. |
| `FakeMultiTurnDriver` | `src/drivers/fake-multi-turn-driver.ts` | no | <1ms/turn | scripted trajectory traces for `TrajectoryRunner` unit tests. |
| `ChaosDriver` | `src/drivers/chaos-driver.ts` | wraps inner | inner + overlay | wraps any inner Driver and overlays a synthetic `DurabilityObservation`. Real fault injection only via `beforeRunHook` / `afterRunHook`. |

`Driver` interface (single-turn) lives in `src/drivers/types.ts`; `MultiTurnDriver` (trajectory) lives in `src/drivers/multi-turn-types.ts`.

## FakeDriver — the inner-loop workhorse

```ts
import { FakeDriver, EvalRunner } from "pilotswarm-eval-harness";

const driver = new FakeDriver({
  "single.add.basic": {
    toolCalls: [{ name: "test_add", args: { a: 17, b: 25 }, result: { result: 42 }, order: 0 }],
    finalResponse: "17 + 25 = 42.",
    sessionId: "fake-session-1",
    latencyMs: 100,
    cmsState: "idle",
  },
  // ... one entry per sample id you exercise
});

const runner = new EvalRunner({ driver });
await runner.runTask(loadEvalTask("./datasets/tool-call-correctness.v1.json"));
```

Scenario shape is `Record<sampleId, ObservedResult>`. Missing ids → driver returns a sentinel "no scenario" error so you can't accidentally pass against a stub you forgot to write.

## LiveDriver — real PilotSwarm execution

Constructor accepts `LiveDriverDeps`:

```ts
new LiveDriver({
  modelProviders,                   // ModelProviderRegistry from PilotSwarm SDK
  databaseUrl: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
  model: "github-copilot:gpt-5.4",  // optional; default registry resolves
  timeout: 300_000,                 // per-sample wallclock (ms)
  systemMessage: "...",             // optional system-prompt override (matrix experiments)
  workerNodeId: "eval-handoff-a",   // optional; uniqueness enforced per-run
  logLevel: "error",
});
```

What it does per `run(sample)`:

1. Spins up an isolated test environment (fresh CMS schemas, fact store, worker).
2. Sends `sample.input.prompt` through a real `PilotSwarmWorker`.
3. Captures observed tool calls + final response via `EvalToolTracker`.
4. Reads back the persisted CMS event log via `session.getMessages()` and attaches as `observed.cmsEvents` (capped at 1000 events). This is the canonical evidence surface for graders / durability tests.
5. Stops the worker + client, swallowing teardown errors unless `EVAL_VERBOSE_TEARDOWN=1`.

Limitations (current):

- No support for `input.context` (multi-turn priors) — throws.
- Each sample creates fresh DB schemas; cross-sample state carries through `sessionId` only when caller manages it.
- Provider-level call cancellation depends on SDK; in-flight LLM requests may continue billing if AbortSignal fires after dispatch.

## DurabilityFixtureDriver / ScriptedDriver

Drives the `gradeDurability` grader without real worker kills. Scenario steps:

```ts
import { DurabilityFixtureDriver } from "pilotswarm-eval-harness";

const driver = new DurabilityFixtureDriver([
  {
    sampleId: "crash.recovers",
    steps: [
      { type: "respond",  response: /* ObservedResult */ },
      { type: "crash",    faultPoint: "during_tool_call", faultMode: "worker_crash" },
      { type: "recover",
        recoveryResponse: /* ObservedResult with cmsState:"idle" */,
        durability: { dehydrated: true, hydrated: true, workerHandoff: true } },
    ],
  },
]);
```

Fault points: `before_turn | during_tool_call | after_tool_call | after_turn | after_dehydrate | before_hydrate`.
Fault modes: `worker_crash | tool_timeout | tool_throw | network_disconnect`.

This is fixture-only scaffolding — for real product evidence (worker handoff, dehydrate/hydrate, cross-worker resume) see the SDK-direct LIVE tests in `test/durability-live.test.ts`. They bypass ChaosDriver entirely and read CMS event evidence.

## ChaosDriver

Wraps any inner Driver and tags the result with a synthetic `DurabilityObservation` (`{ scenario, faultPoint, faultMode, injected, recovered }`). The base `run()` does NOT crash workers, force dehydration, or perturb the inner driver — it executes the inner normally and overlays the tag for grading wrappers.

To inject real faults:

- `beforeRunHook(sample) => Promise<void>` — kill workers, flip flags, etc. before the inner driver runs.
- `afterRunHook(sample, observed) => Promise<void>` — fire post-run mutations.

Example: wrap `LiveDriver` with `beforeRunHook` that kills worker A and starts worker B between turns to test cross-worker handoff.

## FakeMultiTurnDriver — trajectory unit tests

```ts
new FakeMultiTurnDriver([
  {
    sampleId: "remember-color",
    trajectory: { turns: [/* per-turn ObservedResult[] */] },
  },
]);
```

Drives `TrajectoryRunner.runTask()` over a `TrajectoryTask` for V4 multi-turn evaluation (per-turn / cross-turn / holistic scoring). LIVE multi-turn is not yet shipped — `live-driver.ts` rejects `input.context`. Wire FakeMultiTurnDriver scenarios for grader development; expect the live path to land later.

## Writing a custom driver

Pinning either interface gives you all the runner machinery:

```ts
import type { Driver, ObservedResult } from "pilotswarm-eval-harness";

class RemoteDriver implements Driver {
  async run(sample, options): Promise<ObservedResult> {
    // options.signal — caller's AbortSignal (timeouts + manual cancel)
    return {
      toolCalls: [...],
      finalResponse: "...",
      sessionId: "...",
      latencyMs: 0,
      cmsState: "idle",
      // optionally: cmsEvents, durability
    };
  }
}
```

Contract:

- `options.signal` is the harness wait abort. Honor it — return early or throw. The harness wrap-up will still fire its own teardown.
- Throwing maps to a CaseResult with `errored: true` (infra error, excluded from quality stats by `MultiTrialRunner`).
- Returning is a quality verdict — graders score whatever you report.
- Don't swallow signal aborts as success; the harness tags them as infra errors so timeout cases don't pollute pass rates.

## Driver selection cheat-sheet

| you want to … | use |
|---|---|
| run the harness's own tests | `FakeDriver` (already wired) |
| iterate on a grader without burning tokens | `FakeDriver` + scripted scenarios |
| smoke a real PilotSwarm session | `LiveDriver` + `LIVE=1` |
| test crash-recovery grader logic | `DurabilityFixtureDriver` (fixture) |
| prove real worker handoff | direct SDK in `durability-live.test.ts`, NOT ChaosDriver |
| sweep model × config | `MatrixRunner` → driver factory → `LiveDriver` |
| evaluate a multi-turn trajectory | `TrajectoryRunner` + `FakeMultiTurnDriver` (live multi-turn TBD) |
| inject synthetic durability annotations onto an existing run | `ChaosDriver` with hooks |

## Pointers

- `src/drivers/` — implementations
- `src/drivers/types.ts` — `Driver` + `DriverOptions` interfaces
- `src/drivers/multi-turn-types.ts` — trajectory interfaces
- README sections on V3 (durability) and V4 (trajectory) for grader-side detail
- `docs/SUITES.md` for which test files use which driver
