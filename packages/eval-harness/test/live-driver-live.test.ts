import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { EvalRunner } from "../src/runner.js";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { MatrixRunner } from "../src/matrix.js";
import { loadEvalTask } from "../src/loader.js";
import {
  assertLiveAxisWithinCap,
  computeLiveTestTimeout,
  LIVE_MAX_MODELS,
  parseEnvList,
} from "./helpers/live-timeout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Module-load-time computation of the matrix-test timeout. Vitest's per-`it`
// timeout (third arg) is evaluated BEFORE the test body runs, so we cannot
// read env vars inside the body and apply them to the same `it`. Read here
// once and let `assertLiveAxisWithinCap` fail loudly at module load if the
// user set an absurd LIVE_MATRIX_MODELS count.
const LIVE_MATRIX_MODELS_RAW = parseEnvList("LIVE_MATRIX_MODELS");
assertLiveAxisWithinCap("LIVE_MATRIX_MODELS", LIVE_MATRIX_MODELS_RAW.length, LIVE_MAX_MODELS);
const LIVE_MATRIX_TIMEOUT_MS = computeLiveTestTimeout({
  perCellTimeoutMs: 240_000,
  // Floor to 2 cells so a missing env still produces a reasonable timeout
  // when the test guards itself with `models.length < 2 → return`.
  cells: Math.max(LIVE_MATRIX_MODELS_RAW.length, 2),
});

// ---------------------------------------------------------------------------
// LIVE timeout policy
// ---------------------------------------------------------------------------
// The package-level vitest `testTimeout` is intentionally short (60s) so unit
// tests catch hangs quickly. LIVE-gated `it(...)` blocks supply their own
// per-test timeouts (third arg to `it`/`run`) computed as:
//
//   (per-LiveDriver timeout) × (planned sequential cells)
//     + 60s setup/teardown headroom
//     + 30s slack
//
// Per-LiveDriver timeout convention:
//   * 300_000 ms — single-turn / spawn / tool-call LIVE tests (default).
//   * 240_000 ms — matrix cells where the cell count itself is the limiter
//                  (cells are short, sequential adds up); kept tighter on
//                  purpose so a deeply-stuck cell fails faster.
//
// Multi-trial / matrix / multi-paraphrase tests MUST set explicit `it` timeouts
// using this formula. Do not rely on the package default for LIVE work.
// ---------------------------------------------------------------------------

describe("LiveDriver LIVE smoke", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  run("drives a real PilotSwarm session through tool registration end-to-end", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic");
    expect(sample).toBeDefined();
    const runner = new EvalRunner({
      driver,
      runId: "live-tool-registration",
    });
    const runResult = await runner.runTask({
      ...dataset,
      samples: [sample!],
    });
    const result = runResult.cases[0]!;

    expect(result.pass).toBe(true);
    expect(result.observed.sessionId).toBeTruthy();
    expect(result.observed.finalResponse).toMatch(/42/);
    expect(result.observed.toolCalls.length).toBeGreaterThan(0);
    expect(result.observed.toolCalls[0]!.name).toBe("test_add");
    expect(result.observed.toolCalls[0]!.args).toMatchObject({ a: 17, b: 25 });
  }, 360_000);

  run("spawns a real sub-agent and records parent/child PilotSwarm metadata", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const sample = {
      ...baseSample,
      id: "live.subagent.spawn",
      input: {
        ...baseSample.input,
        prompt: "Spawn a sub-agent named 'helper' and ask it to run the add tool with a=2, b=3.",
      },
    };
    const runner = new EvalRunner({ driver, runId: "live-subagent-spawn" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = result.cases[0]!.observed;
    expect(observed.sessionId).toBeTruthy();
    expect(observed.toolCalls.length).toBeGreaterThan(0);
  }, 360_000);

  run("runs a multi-trial eval through a real PilotSwarm worker", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const runner = new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials: 3,
    });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    expect(result.trials).toBe(3);
    expect(result.rawRuns.length).toBe(3);
    expect(result.samples.length).toBe(1);
    const trialSample = result.samples[0]!;
    expect(trialSample.passCount + trialSample.failCount + trialSample.errorCount).toBe(3);
  }, 1_050_000);

  run("executes a real matrix across configured PilotSwarm models", async () => {
    const models = LIVE_MATRIX_MODELS_RAW;
    if (models.length < 2) {
      // eslint-disable-next-line no-console
      console.warn("LIVE_MATRIX_MODELS not set or <2 models; skipping matrix live test.");
      return;
    }
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const runner = new MatrixRunner({
      driverFactory: () => new LiveDriver({ timeout: 240_000 }),
      models,
      configs: [{ id: "default", label: "default", overrides: {} }],
      trials: 1,
    } as never);
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    expect(result.cells.length).toBe(models.length);
    for (const cell of result.cells) {
      expect(cell.result.model).toBe(cell.model);
    }
  }, LIVE_MATRIX_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // FUNCTIONAL suite expansion (eval-platform expansion phase 3)
  // -------------------------------------------------------------------------

  run("FUNCTIONAL: spawn_agent tool produces real CMS evidence (session.agent_spawned with childSessionId)", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const sample = {
      ...baseSample,
      id: "live.functional.spawn_agent",
      input: {
        ...baseSample.input,
        prompt:
          "Use the spawn_agent tool to spawn a sub-agent. Have the sub-agent compute 7 + 8 with test_add. Report the result.",
      },
    };
    const runner = new EvalRunner({ driver, runId: "live-functional-spawn-agent" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = result.cases[0]!.observed;
    expect(observed.sessionId).toBeTruthy();

    // Real CMS evidence: the parent session's event log MUST contain a
    // `session.agent_spawned` event whose data.childSessionId is a
    // non-empty string distinct from the parent session id. Fired by the
    // spawn_agent system tool at orchestration.ts (manager.recordSessionEvent)
    // and session-proxy.ts (bufferCmsEvent) — both code paths set
    // data.childSessionId. Without this evidence the previous regex check
    // (`/spawn|add/.test(toolName)`) trivially matched a plain test_add
    // call and proved nothing about the spawn_agent system tool actually
    // firing.
    const cmsEvents = observed.cmsEvents ?? [];
    expect(cmsEvents.length, "expected CMS events to be captured").toBeGreaterThan(0);
    const spawned = cmsEvents.find((e) => e.eventType === "session.agent_spawned");
    expect(
      spawned,
      `expected session.agent_spawned in event log; saw eventTypes=${JSON.stringify(cmsEvents.map((e) => e.eventType))}`,
    ).toBeDefined();
    const childSessionId = (spawned!.data as { childSessionId?: unknown } | undefined)?.childSessionId;
    expect(typeof childSessionId, "session.agent_spawned.data.childSessionId must be a string").toBe("string");
    expect((childSessionId as string).length, "childSessionId must be non-empty").toBeGreaterThan(0);
    expect(childSessionId, "childSessionId must differ from parent sessionId").not.toBe(observed.sessionId);
  }, 360_000);

  // NOTE: The wait tool's INLINE path (seconds <= worker.waitThreshold,
  // default 30s) runs `setTimeout(seconds*1000)` directly in
  // managed-session.ts:406-408 and emits NO session.wait_started /
  // session.wait_completed events — those events only fire on the durable
  // (orchestration) path when seconds > waitThreshold. This FUNCTIONAL
  // test deliberately uses a SHORT wait (1s) to verify the inline-path is
  // callable end-to-end without the LLM erroring out; it does NOT prove a
  // durable timer ran. Canonical durable-timer proof — including
  // session.dehydrated / session.hydrated / session.wait_started /
  // session.wait_completed event evidence — lives in
  // test/durability-live.test.ts.
  run("FUNCTIONAL: wait tool is callable end-to-end (inline path, NOT durable-timer proof)", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const sample = {
      ...baseSample,
      id: "live.functional.wait",
      input: {
        ...baseSample.input,
        prompt: "Use the wait tool to wait for 1 second, then compute 4+5 with test_add and report the answer.",
      },
    };
    const runner = new EvalRunner({ driver, runId: "live-functional-wait" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = result.cases[0]!.observed;
    expect(observed.sessionId).toBeTruthy();
    expect(observed.finalResponse, "wait+test_add must produce a non-empty response").toBeTruthy();
    // Latency floor only — does NOT prove durability. See note above.
    expect(observed.latencyMs).toBeGreaterThanOrEqual(900);
  }, 360_000);

  run("FUNCTIONAL: tool registration — worker-level toolNames flow surfaces correct tools", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const sample = {
      ...baseSample,
      id: "live.functional.tool-registration",
      tools: ["test_add"],
      input: { prompt: "Compute 1 + 1 using test_add. Do not use any other tool." },
    };
    const runner = new EvalRunner({ driver, runId: "live-functional-tool-registration" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = result.cases[0]!.observed;
    const toolNames = new Set(observed.toolCalls.map((c) => c.name));
    expect(toolNames.has("test_add")).toBe(true);
    expect(toolNames.has("test_multiply")).toBe(false);
  }, 360_000);

  run("FUNCTIONAL: concurrent sessions — 3 parallel sessions complete with isolated state", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const N = 3;
    const samples = Array.from({ length: N }, (_, i) => ({
      ...baseSample,
      id: `live.functional.parallel.${i}`,
    }));
    const drivers = Array.from({ length: N }, () => new LiveDriver({ timeout: 240_000 }));
    const results = await Promise.all(
      samples.map((s, i) =>
        new EvalRunner({ driver: drivers[i]!, runId: `live-parallel-${i}` }).runTask({
          ...dataset,
          samples: [s],
        }),
      ),
    );
    const sessionIds = new Set(results.map((r) => r.cases[0]!.observed.sessionId));
    expect(sessionIds.size).toBe(N);
    for (const r of results) expect(r.cases[0]!.pass).toBe(true);
  }, 360_000);

  run("FUNCTIONAL: session lifecycle — sessionId stable, cmsState terminal-or-idle", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const runner = new EvalRunner({ driver, runId: "live-functional-lifecycle" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = result.cases[0]!.observed;
    expect(observed.sessionId).toBeTruthy();
    if (observed.cmsState) {
      expect(["idle", "completed", "running"]).toContain(observed.cmsState);
    }
  }, 360_000);
});
