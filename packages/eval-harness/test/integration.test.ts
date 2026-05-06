import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  // V1
  loadEvalTask,
  EvalRunner,
  FakeDriver,
  type EvalTask,
  type ObservedResult,

  // V2
  MultiTrialRunner,

  // V3
  DurabilityFixtureDriver,
  type DurabilityFixtureScenario,
  type DurabilityObservation,

  // V4
  TrajectoryRunner,
  FakeMultiTurnDriver,
  type TrajectoryTask,
  type ObservedTrajectory,

  // V5a
  LLMJudgeGrader,
  FakeJudgeClient,
  InMemoryJudgeCache,
  type Rubric,
  type JudgeResult,

  // V5b
  CIGate,
  RegressionDetector,
  saveBaseline,
  loadBaseline,
  PRCommentReporter,
  type Baseline,
  type MultiTrialResult,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_FIXTURE = resolve(
  __dirname,
  "..",
  "datasets",
  "tool-call-correctness.v1.json",
);

// Build a deterministic ObservedResult for FakeDriver
function makeObserved(
  toolCalls: ObservedResult["toolCalls"],
  finalResponse: string,
): ObservedResult {
  return {
    toolCalls,
    finalResponse,
    sessionId: "fake-session",
    latencyMs: 5,
    cmsState: "idle",
  };
}

// Reproduces all 6 samples from datasets/tool-call-correctness.v1.json so the
// FakeDriver can satisfy every fixture sample. Lets every sample pass.
function makeAllPassingScenarios(): Record<string, ObservedResult> {
  return {
    "single.add.basic": makeObserved(
      [{ name: "test_add", args: { a: 17, b: 25 }, result: { result: 42 }, order: 0 }],
      "42",
    ),
    "single.weather.multi-param": makeObserved(
      [
        {
          name: "test_weather",
          args: { city: "Tokyo" },
          result: { temp: 22 },
          order: 0,
        },
      ],
      "Tokyo weather is fine.",
    ),
    "selection.multiply-not-add": makeObserved(
      [
        {
          name: "test_multiply",
          args: { a: 4, b: 5 },
          result: { result: 20 },
          order: 0,
        },
      ],
      "20",
    ),
    "selection.no-tool-with-tools": makeObserved([], "Hello!"),
    "sequence.add-then-multiply": makeObserved(
      [
        { name: "test_add", args: { a: 2, b: 3 }, result: { result: 5 }, order: 0 },
        {
          name: "test_multiply",
          args: { a: 4, b: 5 },
          result: { result: 20 },
          order: 1,
        },
      ],
      "Result is 20.",
    ),
    "multi.unordered-weather": makeObserved(
      [
        {
          name: "test_weather",
          args: { city: "London" },
          result: { temp: 12 },
          order: 0,
        },
        {
          name: "test_weather",
          args: { city: "Tokyo" },
          result: { temp: 22 },
          order: 1,
        },
      ],
      "London and Tokyo weather summarized.",
    ),
  };
}

// A degraded variant — wrong response on one sample to simulate a regression.
function makeDegradedScenarios(): Record<string, ObservedResult> {
  const all = makeAllPassingScenarios();
  // Force "selection.multiply-not-add" to call the forbidden tool → fails.
  all["selection.multiply-not-add"] = makeObserved(
    [
      { name: "test_add", args: { a: 4, b: 5 }, result: { result: 9 }, order: 0 },
    ],
    "9",
  );
  return all;
}

describe("End-to-end integration (V1-V5)", () => {
  let workDir: string;

  beforeEach(() => {
    const scratch = resolve(__dirname, "..", ".eval-results-test");
    mkdirSync(scratch, { recursive: true });
    workDir = mkdtempSync(join(scratch, "run-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("full pipeline: load → multi-trial → save baseline → detect regression → CI gate", async () => {
    // 1. Load fixture (V1)
    const task = loadEvalTask(REPO_FIXTURE);
    expect(task.id).toBe("tool-call-correctness");
    expect(task.samples.length).toBe(6);

    // 2. + 3. Multi-trial run (V2) with everything passing → 100% baseline.
    const passingScenarios = makeAllPassingScenarios();
    const baselineRunner = new MultiTrialRunner({
      driverFactory: () => FakeDriver.fromMap(passingScenarios),
      trials: 3,
      passAtKValues: [1, 3],
      model: "fake-model",
    });
    const baselineResult: MultiTrialResult = await baselineRunner.runTask(task);

    expect(baselineResult.summary.total).toBe(6);
    expect(baselineResult.summary.trials).toBe(3);
    expect(baselineResult.summary.meanPassRate).toBeCloseTo(1, 5);

    // 4. Save baseline (V5b)
    const baselinePath = join(workDir, "baseline.json");
    saveBaseline(baselineResult, baselinePath);
    const loaded: Baseline = loadBaseline(baselinePath);
    expect(loaded.taskId).toBe("tool-call-correctness");
    expect(loaded.samples.length).toBe(6);
    expect(loaded.samples.every((s) => s.passRate === 1)).toBe(true);

    // 5. Run again with degraded scenarios (one sample now fails consistently)
    const degradedScenarios = makeDegradedScenarios();
    const currentRunner = new MultiTrialRunner({
      driverFactory: () => FakeDriver.fromMap(degradedScenarios),
      trials: 3,
      model: "fake-model",
    });
    const currentResult = await currentRunner.runTask(task);

    expect(currentResult.summary.meanPassRate).toBeLessThan(1);

    // 6. Detect regressions (V5b)
    const detector = new RegressionDetector(0.05);
    const detection = detector.detect(loaded, currentResult);
    expect(detection.regressions.length).toBe(6);
    expect(detection.missingBaselineSamples).toEqual([]);
    const regressed = detection.regressions.find(
      (r) => r.sampleId === "selection.multiply-not-add",
    );
    expect(regressed).toBeDefined();
    expect(regressed!.baselinePassRate).toBe(1);
    expect(regressed!.currentPassRate).toBe(0);
    expect(regressed!.significant).toBe(true);
    expect(regressed!.direction).toBe("regressed");

    // 7. Evaluate CI gate (V5b)
    const gate = new CIGate({
      passRateFloor: 0.95,
      maxRegressions: 0,
      maxCostUsd: 1,
    });
    const gateResult = gate.evaluate(currentResult, detection, 0.05);

    // 8. Verify gate result structure
    expect(gateResult.pass).toBe(false);
    expect(gateResult.passRate).toBeLessThan(0.95);
    expect(gateResult.regressionCount).toBe(1);
    expect(gateResult.totalCostUsd).toBe(0.05);
    expect(gateResult.reasons.length).toBeGreaterThan(0);
    expect(
      gateResult.reasons.some((r) => r.toLowerCase().includes("pass rate")),
    ).toBe(true);
    expect(
      gateResult.reasons.some((r) => r.toLowerCase().includes("regression")),
    ).toBe(true);
    expect(gate.exitCode(gateResult)).toBe(1);

    // PR comment reporter wires the whole thing into a markdown artifact.
    const prPath = join(workDir, "pr.md");
    const reporter = new PRCommentReporter(prPath);
    reporter.onMultiTrialComplete(currentResult);
    reporter.writeGateResult(gateResult, detection.regressions);
  });

  it("trajectory pipeline: build → run → grade (per-turn + cross-turn + holistic)", async () => {
    const task: TrajectoryTask = {
      schemaVersion: 1,
      id: "trajectory-int-test",
      name: "Trajectory Integration",
      description: "Integration trajectory",
      version: "1.0.0",
      samples: [
        {
          id: "remember-color",
          description: "Multi-turn memory retention",
          turns: [
            {
              input: { prompt: "Remember my favorite color is blue." },
              expected: {
                noToolCall: true,
                response: { containsAny: ["blue"] },
              },
            },
            {
              input: { prompt: "What is my favorite color?" },
              expected: {
                noToolCall: true,
                response: { containsAny: ["blue"] },
              },
            },
          ],
          tags: ["memory"],
          timeoutMs: 5000,
          expected: {
            goalCompleted: true,
            maxTotalToolCalls: 0,
            contextRetention: [{ term: "blue", mustAppearAfterTurn: 0 }],
          },
        },
      ],
    };

    const trajectory: ObservedTrajectory = {
      turns: [
        {
          toolCalls: [],
          response: "Got it — your favorite color is blue.",
          latencyMs: 10,
        },
        {
          toolCalls: [],
          response: "Your favorite color is blue.",
          latencyMs: 12,
        },
      ],
      sessionId: "fake-traj-session",
      totalLatencyMs: 22,
    };

    const runner = new TrajectoryRunner({
      driver: new FakeMultiTurnDriver([
        { sampleId: "remember-color", trajectory },
      ]),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result;
    try {
      result = await runner.runTask(task);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("contextRetention matched only via lexical regex"),
      );
    } finally {
      warn.mockRestore();
    }

    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.passRate).toBe(1);

    const caseResult = result.cases[0];
    expect(caseResult.pass).toBe(true);
    expect(caseResult.trajectoryScore.turnScores.length).toBe(2);
    expect(
      caseResult.trajectoryScore.turnScores.every((ts) =>
        ts.every((s) => s.pass),
      ),
    ).toBe(true);
    expect(caseResult.trajectoryScore.crossTurnScores.length).toBe(1);
    expect(caseResult.trajectoryScore.crossTurnScores[0].pass).toBe(true);
    expect(
      caseResult.trajectoryScore.holisticScores.find(
        (s) => s.name === "turn-count",
      )?.pass,
    ).toBe(true);
    expect(
      caseResult.trajectoryScore.holisticScores.find(
        (s) => s.name === "goal-completed",
      )?.pass,
    ).toBe(true);
    expect(
      caseResult.trajectoryScore.holisticScores.find(
        (s) => s.name === "call-budget",
      )?.pass,
    ).toBe(true);
  });

  it("judge pipeline: grade → cache hit → budget enforcement", async () => {
    const rubric: Rubric = {
      id: "rubric-int",
      name: "Integration Rubric",
      version: "1.0.0",
      criteria: [
        {
          id: "helpfulness",
          description: "Is the response helpful?",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
        {
          id: "accuracy",
          description: "Is the response accurate?",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
      ],
    };

    const helpfulness: JudgeResult = {
      criterionId: "helpfulness",
      reasoning: "Response addresses the question directly.",
      rawScore: 4,
      normalizedScore: 0.8,
      pass: true,
    };
    const accuracy: JudgeResult = {
      criterionId: "accuracy",
      reasoning: "Facts check out.",
      rawScore: 5,
      normalizedScore: 1,
      pass: true,
    };

    const client = new FakeJudgeClient([
      {
        criterionId: "helpfulness",
        result: helpfulness,
        cost: {
          inputTokens: 200,
          outputTokens: 80,
          model: "fake-judge",
          estimatedCostUsd: 0.002,
        },
      },
      {
        criterionId: "accuracy",
        result: accuracy,
        cost: {
          inputTokens: 200,
          outputTokens: 80,
          model: "fake-judge",
          estimatedCostUsd: 0.002,
        },
      },
    ]);

    const cache = new InMemoryJudgeCache();
    const grader = new LLMJudgeGrader({
      client,
      rubric,
      cache,
      judgeId: "integration-judge",
      budgetUsd: 1,
    });

    // 1. First call → 2 fresh judge invocations, cache populated.
    const first = await grader.grade("Q: capital of France?", "Paris.");
    expect(first.scores.length).toBe(2);
    expect(first.scores.every((s) => s.pass)).toBe(true);
    expect(client.callCount).toBe(2);
    expect(cache.size).toBe(2);
    expect(first.totalCostUsd).toBeCloseTo(0.004, 6);

    // 2. Same prompt/response → cache hits, no new client calls.
    const second = await grader.grade("Q: capital of France?", "Paris.");
    expect(second.scores.length).toBe(2);
    expect(second.scores.every((s) => s.pass)).toBe(true);
    expect(client.callCount).toBe(2);

    // 3. Budget enforcement on a fresh grader with a tight budget.
    const tightClient = new FakeJudgeClient([
      {
        criterionId: "helpfulness",
        result: helpfulness,
        cost: {
          inputTokens: 200,
          outputTokens: 80,
          model: "fake-judge",
          estimatedCostUsd: 5,
        },
      },
      {
        criterionId: "accuracy",
        result: accuracy,
        cost: {
          inputTokens: 200,
          outputTokens: 80,
          model: "fake-judge",
          estimatedCostUsd: 5,
        },
      },
    ]);
    const tight = new LLMJudgeGrader({
      client: tightClient,
      rubric,
      budgetUsd: 0.01,
    });
    const tightResult = await tight.grade("Q?", "A.");
    // iter19 H4: hard-cap reconcile refunds + denies the first call (actual
    // 5 > cap 0.01). The second call is then pre-checked or also denied.
    // What matters: cumulative spend never exceeds cap, and at least one
    // score surfaces a "Budget exceeded" infraError reason.
    expect(tightClient.callCount).toBeGreaterThanOrEqual(1);
    expect(tight.cumulativeCostUsd).toBeLessThanOrEqual(0.01);
    const budgetSkipped = tightResult.scores.find((s) =>
      s.reason.toLowerCase().includes("budget exceeded"),
    );
    expect(budgetSkipped).toBeDefined();
    expect(budgetSkipped!.infraError).toBe(true);
  });

  it("durability pipeline: scripted crash → grade via runner → durability scores", async () => {
    const scenarios: DurabilityFixtureScenario[] = [
      {
        sampleId: "crash.recovers",
        steps: [
          {
            type: "respond",
            response: makeObserved(
              [
                {
                  name: "test_weather",
                  args: { city: "Tokyo" },
                  result: { temp: 22 },
                  order: 0,
                },
              ],
              "partial",
            ),
          },
          {
            type: "crash",
            faultPoint: "during_tool_call",
            faultMode: "worker_crash",
          },
          {
            type: "recover",
            recoveryResponse: {
              ...makeObserved(
                [
                  {
                    name: "test_weather",
                    args: { city: "Tokyo" },
                    result: { temp: 22 },
                    order: 0,
                  },
                ],
                "Tokyo weather is fine.",
              ),
              cmsState: "idle",
            },
            durability: { dehydrated: true, hydrated: true, workerHandoff: true },
          },
        ],
      },
    ];

    const task: EvalTask = {
      schemaVersion: 1,
      id: "durability-int",
      name: "Durability integration",
      description: "scripted crash + recovery",
      version: "1.0.0",
      samples: [
        {
          id: "crash.recovers",
          description: "scripted crash",
          input: { prompt: "weather Tokyo" },
          expected: {
            toolCalls: [
              {
                name: "test_weather",
                args: { city: "Tokyo" },
                match: "subset",
              },
            ],
            toolSequence: "unordered",
            cms: { stateIn: ["idle", "completed"] },
            durability: {
              mustRecover: true,
              finalStateIn: ["idle", "completed"],
              minToolCallsAfterRecovery: 1,
              requireDehydrated: true,
              requireHydrated: true,
              requireWorkerHandoff: true,
            },
          },
          tools: ["test_weather"],
          timeoutMs: 5000,
        },
      ],
    };

    const runner = new EvalRunner({ driver: new DurabilityFixtureDriver(scenarios) });
    const runResult = await runner.runTask(task);

    expect(runResult.summary.total).toBe(1);
    expect(runResult.summary.passed).toBe(1);

    const scores = runResult.cases[0].scores;
    const observation = runResult.cases[0].observed.durability as
      | DurabilityObservation
      | undefined;
    expect(observation).toBeDefined();
    expect(observation!.recovered).toBe(true);
    expect(observation!.injected).toBe(true);
    expect(observation!.dehydrated).toBe(true);
    expect(observation!.hydrated).toBe(true);
    expect(observation!.workerHandoff).toBe(true);

    const expectedScoreNames = [
      "crash-recovery",
      "post-recovery-state",
      "tool-calls-after-recovery",
      "dehydration",
      "hydration",
      "worker-handoff",
    ];
    for (const name of expectedScoreNames) {
      const s = scores.find((sc) => sc.name === name);
      expect(s, `score "${name}" missing`).toBeDefined();
      expect(s!.pass, `score "${name}" should pass`).toBe(true);
    }
  });
});
