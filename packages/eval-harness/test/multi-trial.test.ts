import { describe, it, expect } from "vitest";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import type { Driver, DriverOptions } from "../src/drivers/types.js";
import {
  SampleTrialResultSchema,
  type EvalSample,
  type EvalTask,
  type ObservedResult,
  type RunResult,
  type SampleTrialResult,
} from "../src/types.js";
import type { Reporter } from "../src/reporters/types.js";

function makeTask(sampleIds: string[]): EvalTask {
  return {
    schemaVersion: 1,
    id: "test-task",
    name: "Test Task",
    description: "test",
    version: "1.0",
    samples: sampleIds.map((id) => ({
      id,
      description: `Sample ${id}`,
      input: { prompt: `Do ${id}` },
      expected: {
        toolCalls: [{ name: "add", args: { a: 1, b: 2 }, match: "subset" }],
        toolSequence: "unordered",
      },
      timeoutMs: 5000,
    })) as EvalSample[],
  };
}

function makeObserved(pass: boolean): ObservedResult {
  return {
    toolCalls: pass ? [{ name: "add", args: { a: 1, b: 2 }, order: 0 }] : [],
    finalResponse: pass ? "result" : "no tools",
    sessionId: "s1",
    latencyMs: 100,
  };
}

/**
 * Driver whose run() cycles through a list of ObservedResults or throws
 * when given an Error. Used to simulate per-trial variation for a single
 * sample across successive trial runs.
 */
class SequentialFakeDriver implements Driver {
  private callIndex = 0;
  constructor(private responses: Array<ObservedResult | Error>) {}
  async run(sample: EvalSample, _options?: DriverOptions): Promise<ObservedResult> {
    const r = this.responses[this.callIndex++ % this.responses.length]!;
    if (r instanceof Error) throw r;
    return structuredClone(r);
  }
}

describe("MultiTrialRunner", () => {
  it("runs N trials and aggregates results", async () => {
    const runner = new MultiTrialRunner({
      driverFactory: () => new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
      trials: 3,
    });
    const result = await runner.runTask(makeTask(["s1"]));

    expect(result.trials).toBe(3);
    expect(result.rawRuns.length).toBe(3);
    expect(result.samples.length).toBe(1);
    const s1 = result.samples[0]!;
    expect(s1.sampleId).toBe("s1");
    expect(s1.passCount).toBe(3);
    expect(s1.failCount).toBe(0);
    expect(s1.errorCount).toBe(0);
    expect(s1.passRate).toBe(1);
    expect(s1.passAtK[1]).toBe(1);
    expect(result.summary.meanPassRate).toBe(1);
  });

  it("computes correct passRate excluding infra errors", async () => {
    // 5 trials: 3 pass, 1 fail, 1 error -> passRate = 3/4 = 0.75
    const seq: Array<ObservedResult | Error> = [
      makeObserved(true),
      makeObserved(true),
      makeObserved(true),
      makeObserved(false),
      new Error("infra boom"),
    ];
    let idx = 0;
    const drivers = seq.map((r) => new SequentialFakeDriver([r]));
    const runner = new MultiTrialRunner({
      driverFactory: () => drivers[idx++]!,
      trials: 5,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const s1 = result.samples[0]!;
    expect(s1.passCount).toBe(3);
    expect(s1.failCount).toBe(1);
    expect(s1.errorCount).toBe(1);
    expect(s1.passRate).toBeCloseTo(0.75, 10);
  });

  it("computes passAtK correctly", async () => {
    // 10 trials: 2 pass (first two), 8 fail
    const seq: ObservedResult[] = [
      makeObserved(true),
      makeObserved(true),
      ...Array.from({ length: 8 }, () => makeObserved(false)),
    ];
    let idx = 0;
    const runner = new MultiTrialRunner({
      driverFactory: () => new SequentialFakeDriver([seq[idx++]!]),
      trials: 10,
      passAtKValues: [1, 5, 10, 20], // 20 should be skipped (> trials)
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const s1 = result.samples[0]!;
    expect(s1.passAtK[1]).toBeCloseTo(0.2, 10);
    // passAtK(n=10, c=2, k=5) = 1 - prod_{i=9..10} (1-5/i) = 1 - (4/9)(1/2) = 1 - 2/9 ≈ 0.7778
    expect(s1.passAtK[5]).toBeCloseTo(0.77777777778, 8);
    expect(s1.passAtK[10]).toBeCloseTo(1.0, 10);
    expect(s1.passAtK[20]).toBeUndefined();
  });

  it("aggregates scores per sample", async () => {
    // Two trials, both pass. Scores come from gradeEvalCase (tool-selection + ordering + match-args etc).
    let idx = 0;
    const runner = new MultiTrialRunner({
      driverFactory: () => new SequentialFakeDriver([makeObserved(true)]),
      trials: 3,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const s1 = result.samples[0]!;
    // For each score name seen, mean should be 1 and stddev 0 across 3 trials
    const scoreNames = Object.keys(s1.scores);
    expect(scoreNames.length).toBeGreaterThan(0);
    for (const name of scoreNames) {
      const agg = s1.scores[name]!;
      expect(agg.n).toBe(3);
      expect(agg.values.length).toBe(3);
      expect(agg.mean).toBeCloseTo(1, 10);
      expect(agg.stddev).toBeCloseTo(0, 10);
    }
  });

  it("handles all-error trials for a sample", async () => {
    let idx = 0;
    const runner = new MultiTrialRunner({
      driverFactory: () =>
        new SequentialFakeDriver([new Error(`err-${idx++}`)]),
      trials: 4,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const s1 = result.samples[0]!;
    expect(s1.errorCount).toBe(4);
    expect(s1.passCount).toBe(0);
    expect(s1.passRate).toBeUndefined();
    expect((s1 as { noQualitySignal?: boolean }).noQualitySignal).toBe(true);
    expect(result.summary.meanPassRate).toBeUndefined();
    expect((result.summary as { noQualitySignal?: boolean }).noQualitySignal).toBe(true);
    expect((result.summary as { infraErrorRate?: number }).infraErrorRate).toBe(1);
  });

  it("preserves rawRuns", async () => {
    const runner = new MultiTrialRunner({
      driverFactory: () =>
        new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
      trials: 4,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.rawRuns.length).toBe(4);
    for (const r of result.rawRuns) {
      expect(r.cases.length).toBe(1);
      expect(r.runId).toBeTruthy();
    }
    // All runIds distinct
    const ids = new Set(result.rawRuns.map((r) => r.runId));
    expect(ids.size).toBe(4);
  });

  it("computes task-level summary", async () => {
    // 2 samples: s1 always passes, s2 always fails. meanPassRate across samples = 0.5.
    const runner = new MultiTrialRunner({
      driverFactory: () =>
        new FakeDriver([
          { sampleId: "s1", response: makeObserved(true) },
          { sampleId: "s2", response: makeObserved(false) },
        ]),
      trials: 3,
    });
    const result = await runner.runTask(makeTask(["s1", "s2"]));
    expect(result.summary.total).toBe(2);
    expect(result.summary.trials).toBe(3);
    expect(result.summary.meanPassRate).toBeCloseTo(0.5, 10);
    expect(result.summary.stddevPassRate).toBeGreaterThan(0);
    // Overall passRateCI from 3/6 passes
    expect(result.summary.passRateCI.point).toBeCloseTo(0.5, 10);
    expect(result.summary.passRateCI.lower).toBeGreaterThanOrEqual(0);
    expect(result.summary.passRateCI.upper).toBeLessThanOrEqual(1);
  });

  it("uses driverFactory for fresh driver per trial", async () => {
    let callCount = 0;
    const runner = new MultiTrialRunner({
      driverFactory: () => {
        callCount++;
        return new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]);
      },
      trials: 5,
    });
    await runner.runTask(makeTask(["s1"]));
    expect(callCount).toBe(5);
  });

  it("handles single trial (trials=1)", async () => {
    const runner = new MultiTrialRunner({
      driverFactory: () =>
        new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
      trials: 1,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.trials).toBe(1);
    expect(result.rawRuns.length).toBe(1);
    expect(result.samples[0]!.passCount).toBe(1);
    expect(result.samples[0]!.passRate).toBe(1);
  });

  it("validates trials >= 1", () => {
    expect(
      () =>
        new MultiTrialRunner({
          driverFactory: () => new FakeDriver([]),
          trials: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new MultiTrialRunner({
          driverFactory: () => new FakeDriver([]),
          trials: -1,
        }),
    ).toThrow();
  });

  it("computes wilsonCI on passRate", async () => {
    // 10 trials: 7 pass, 3 fail
    const seq: ObservedResult[] = [
      ...Array.from({ length: 7 }, () => makeObserved(true)),
      ...Array.from({ length: 3 }, () => makeObserved(false)),
    ];
    let idx = 0;
    const runner = new MultiTrialRunner({
      driverFactory: () => new SequentialFakeDriver([seq[idx++]!]),
      trials: 10,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const s1 = result.samples[0]!;
    expect(s1.wilsonCI.point).toBeCloseTo(0.7, 10);
    expect(s1.wilsonCI.lower).toBeGreaterThan(0);
    expect(s1.wilsonCI.lower).toBeLessThan(0.7);
    expect(s1.wilsonCI.upper).toBeLessThan(1);
    expect(s1.wilsonCI.upper).toBeGreaterThan(0.7);
  });

  it("forwards reporters to inner EvalRunner per trial", async () => {
    const starts: string[] = [];
    const completes: string[] = [];
    const reporter: Reporter = {
      onRunStart: (_t, runId) => {
        starts.push(runId);
      },
      onCaseResult: () => {},
      onRunComplete: (r) => {
        completes.push(r.runId);
      },
    };
    const runner = new MultiTrialRunner({
      driverFactory: () =>
        new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
      trials: 3,
      reporters: [reporter],
    });
    await runner.runTask(makeTask(["s1"]));
    expect(starts.length).toBe(3);
    expect(completes.length).toBe(3);
    expect(new Set(starts).size).toBe(3);
  });

  it("supports concurrency > 1", async () => {
    let active = 0;
    let maxActive = 0;
    class SlowDriver implements Driver {
      async run(): Promise<ObservedResult> {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return makeObserved(true);
      }
    }
    const runner = new MultiTrialRunner({
      driverFactory: () => new SlowDriver(),
      trials: 6,
      concurrency: 3,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.rawRuns.length).toBe(6);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

// F14: aggregateSample silently dropped trials whose RunResult had no case for
// the sample, producing passCount + failCount + errorCount < trials and failing
// SampleTrialResultSchema on round-trip. Treat missing case as an infra error.
describe("MultiTrialRunner.aggregateSample — F14 missing per-sample case", () => {
  function makeCaseResult(caseId: string, pass: boolean) {
    return {
      caseId,
      pass,
      scores: [],
      observed: {
        toolCalls: [],
        finalResponse: pass ? "ok" : "no",
        sessionId: "sess",
        latencyMs: 10,
      },
      durationMs: 10,
    };
  }

  function makeRunResult(cases: ReturnType<typeof makeCaseResult>[]): RunResult {
    return {
      schemaVersion: 1,
      runId: `r-${Math.random().toString(36).slice(2)}`,
      taskId: "test-task",
      taskVersion: "1.0",
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: {
        total: cases.length,
        passed: cases.filter((c) => c.pass).length,
        failed: cases.filter((c) => !c.pass).length,
        errored: 0,
      },
      cases,
    } as RunResult;
  }

  function aggregate(runner: MultiTrialRunner, sampleId: string, rawRuns: RunResult[]): SampleTrialResult {
    return (
      runner as unknown as {
        aggregateSample(id: string, runs: RunResult[]): SampleTrialResult;
      }
    ).aggregateSample(sampleId, rawRuns);
  }

  it("counts a trial with no case for the sample as an infra error", () => {
    const runner = new MultiTrialRunner({
      driverFactory: () => new FakeDriver([]),
      trials: 3,
    });
    const rawRuns: RunResult[] = [
      makeRunResult([makeCaseResult("s1", true)]),
      makeRunResult([]), // missing s1 — partial run / driver bug
      makeRunResult([makeCaseResult("s1", true)]),
    ];

    const sample = aggregate(runner, "s1", rawRuns);

    expect(sample.trials).toBe(3);
    expect(sample.passCount).toBe(2);
    expect(sample.failCount).toBe(0);
    expect(sample.errorCount).toBe(1);
    expect(sample.passCount + sample.failCount + sample.errorCount).toBe(sample.trials);
    expect(sample.passRate).toBeCloseTo(1, 10);

    // Round-trip through the schema (would reject if the arithmetic invariant
    // were violated by silent drops).
    expect(() => SampleTrialResultSchema.parse(sample)).not.toThrow();
  });

  it("counts every trial as an infra error when no trial has a case for the sample", () => {
    const runner = new MultiTrialRunner({
      driverFactory: () => new FakeDriver([]),
      trials: 4,
    });
    const rawRuns: RunResult[] = [
      makeRunResult([makeCaseResult("other", true)]),
      makeRunResult([]),
      makeRunResult([makeCaseResult("other", false)]),
      makeRunResult([]),
    ];

    const sample = aggregate(runner, "missing", rawRuns);

    expect(sample.trials).toBe(4);
    expect(sample.passCount).toBe(0);
    expect(sample.failCount).toBe(0);
    expect(sample.errorCount).toBe(4);
    expect(sample.passRate).toBeUndefined();
    expect((sample as { noQualitySignal?: boolean }).noQualitySignal).toBe(true);

    expect(() => SampleTrialResultSchema.parse(sample)).not.toThrow();
  });

  it("mixes missing cases, infra errors, and real pass/fail correctly", () => {
    const runner = new MultiTrialRunner({
      driverFactory: () => new FakeDriver([]),
      trials: 5,
    });
    const failingCase = makeCaseResult("s1", false);
    const infraErrorCase = {
      ...makeCaseResult("s1", false),
      infraError: "boom",
    };
    const rawRuns: RunResult[] = [
      makeRunResult([makeCaseResult("s1", true)]),
      makeRunResult([failingCase]),
      makeRunResult([infraErrorCase]),
      makeRunResult([]), // missing — count as infra error
      makeRunResult([makeCaseResult("s1", true)]),
    ];

    const sample = aggregate(runner, "s1", rawRuns);

    expect(sample.trials).toBe(5);
    expect(sample.passCount).toBe(2);
    expect(sample.failCount).toBe(1);
    expect(sample.errorCount).toBe(2); // 1 explicit infraError + 1 missing
    expect(sample.passCount + sample.failCount + sample.errorCount).toBe(sample.trials);
    // passRate = passCount / (trials - errorCount) = 2 / 3
    expect(sample.passRate).toBeCloseTo(2 / 3, 10);

    expect(() => SampleTrialResultSchema.parse(sample)).not.toThrow();
  });
});
