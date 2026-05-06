import { describe, it, expect } from "vitest";
import { MatrixRunner } from "../src/matrix.js";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import { CIGate } from "../src/ci-gate.js";
import type { Driver, DriverOptions } from "../src/drivers/types.js";
import type {
  EvalSample,
  EvalTask,
  MatrixConfig,
  ObservedResult,
} from "../src/types.js";

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
      input: { prompt: `Do ${id}`, systemMessage: "original-sys" },
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

function passingDriver(): FakeDriver {
  return new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]);
}

function failingDriver(): FakeDriver {
  return new FakeDriver([{ sampleId: "s1", response: makeObserved(false) }]);
}

const CONFIGS: MatrixConfig[] = [
  { id: "cfg-a", label: "Config A", overrides: {} },
  { id: "cfg-b", label: "Config B", overrides: {} },
];

describe("MatrixRunner", () => {
  it("produces correct number of cells for models × configs", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["gpt-a", "gpt-b"],
      configs: CONFIGS,
      trials: 2,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.cells.length).toBe(4);
    expect(result.summary.totalCells).toBe(4);
  });

  it("each cell has correct model and configId", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1", "m2"],
      configs: CONFIGS,
      trials: 1,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const pairs = result.cells.map((c) => `${c.model}|${c.configId}`).sort();
    expect(pairs).toEqual(
      ["m1|cfg-a", "m1|cfg-b", "m2|cfg-a", "m2|cfg-b"].sort(),
    );
    for (const cell of result.cells) {
      const cfg = CONFIGS.find((c) => c.id === cell.configId)!;
      expect(cell.configLabel).toBe(cfg.label);
    }
  });

  it("applies systemMessage override to samples", async () => {
    const capturedSystemMessages: (string | undefined)[] = [];
    class CaptureDriver implements Driver {
      async run(
        sample: EvalSample,
        _options?: DriverOptions,
      ): Promise<ObservedResult> {
        capturedSystemMessages.push(sample.input.systemMessage);
        return makeObserved(true);
      }
    }
    const configs: MatrixConfig[] = [
      {
        id: "cfg-override",
        label: "Override",
        overrides: { systemMessage: "overridden-sys" },
      },
    ];
    const runner = new MatrixRunner({
      driverFactory: () => new CaptureDriver(),
      models: ["m1"],
      configs,
      trials: 2,
    });
    await runner.runTask(makeTask(["s1"]));
    expect(capturedSystemMessages.length).toBe(2);
    for (const sm of capturedSystemMessages) {
      expect(sm).toBe("overridden-sys");
    }
  });

  it("applies timeoutMs override to samples", async () => {
    const capturedTimeouts: number[] = [];
    class CaptureDriver implements Driver {
      async run(
        sample: EvalSample,
        _options?: DriverOptions,
      ): Promise<ObservedResult> {
        capturedTimeouts.push(sample.timeoutMs);
        return makeObserved(true);
      }
    }
    const configs: MatrixConfig[] = [
      {
        id: "cfg-timeout",
        label: "Timeout",
        overrides: { timeoutMs: 9999 },
      },
    ];
    const runner = new MatrixRunner({
      driverFactory: () => new CaptureDriver(),
      models: ["m1"],
      configs,
      trials: 1,
    });
    await runner.runTask(makeTask(["s1"]));
    expect(capturedTimeouts.length).toBe(1);
    expect(capturedTimeouts[0]).toBe(9999);
  });

  it("does not mutate the original task", async () => {
    const task = makeTask(["s1"]);
    const snapshot = structuredClone(task);
    const configs: MatrixConfig[] = [
      {
        id: "cfg-override",
        label: "Override",
        overrides: { systemMessage: "overridden-sys", timeoutMs: 7777 },
      },
    ];
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1"],
      configs,
      trials: 1,
    });
    await runner.runTask(task);
    expect(task).toEqual(snapshot);
  });

  it("computes bestPassRate and worstPassRate in summary", async () => {
    // Alternating pass/fail drivers; first cell passes, second fails, etc.
    const driverSequence = [
      passingDriver,
      failingDriver,
      passingDriver,
      failingDriver,
    ];
    let cellCallIndex = 0;
    // Each cell has `trials` trials, and each trial creates 1 driver. Rotate
    // per-cell by tracking a cell index via an outer counter.
    let trialsPerCell = 1;
    let callCount = 0;
    const runner = new MatrixRunner({
      driverFactory: () => {
        const cellIndex = Math.floor(callCount / trialsPerCell);
        callCount++;
        return driverSequence[cellIndex % driverSequence.length]!();
      },
      models: ["m1", "m2"],
      configs: CONFIGS,
      trials: trialsPerCell,
    });
    void cellCallIndex;
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.cells.length).toBe(4);

    // Best should be a passing cell (rate 1), worst a failing cell (rate 0)
    expect(result.summary.bestPassRate.passRate).toBe(1);
    expect(result.summary.worstPassRate.passRate).toBe(0);
    // model/configId refer to an actual cell in the matrix
    const bestCell = result.cells.find(
      (c) =>
        c.model === result.summary.bestPassRate.model &&
        c.configId === result.summary.bestPassRate.configId,
    );
    expect(bestCell).toBeDefined();
    expect(bestCell!.result.summary.meanPassRate).toBe(1);
    const worstCell = result.cells.find(
      (c) =>
        c.model === result.summary.worstPassRate.model &&
        c.configId === result.summary.worstPassRate.configId,
    );
    expect(worstCell).toBeDefined();
    expect(worstCell!.result.summary.meanPassRate).toBe(0);
  });

  it("handles single model × single config", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1"],
      configs: [{ id: "cfg-a", label: "A", overrides: {} }],
      trials: 2,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.cells.length).toBe(1);
    expect(result.summary.totalCells).toBe(1);
    expect(result.summary.bestPassRate.model).toBe("m1");
    expect(result.summary.worstPassRate.model).toBe("m1");
  });

  it("throws on empty models array", () => {
    expect(
      () =>
        new MatrixRunner({
          driverFactory: () => passingDriver(),
          models: [],
          configs: CONFIGS,
          trials: 1,
        }),
    ).toThrow();
  });

  it("throws on empty configs array", () => {
    expect(
      () =>
        new MatrixRunner({
          driverFactory: () => passingDriver(),
          models: ["m1"],
          configs: [],
          trials: 1,
        }),
    ).toThrow();
  });

  it("throws on trials < 1", () => {
    expect(
      () =>
        new MatrixRunner({
          driverFactory: () => passingDriver(),
          models: ["m1"],
          configs: CONFIGS,
          trials: 0,
        }),
    ).toThrow();
  });

  it("preserves rawRuns in each cell result", async () => {
    const trials = 3;
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1", "m2"],
      configs: CONFIGS,
      trials,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    for (const cell of result.cells) {
      expect(cell.result.rawRuns.length).toBe(trials);
      expect(cell.result.trials).toBe(trials);
    }
  });

  it("passes model through to driver", async () => {
    const modelsSeen: Array<string | undefined> = [];
    class ModelCaptureDriver implements Driver {
      async run(
        _sample: EvalSample,
        options?: DriverOptions,
      ): Promise<ObservedResult> {
        modelsSeen.push(options?.model);
        return makeObserved(true);
      }
    }
    const runner = new MatrixRunner({
      driverFactory: () => new ModelCaptureDriver(),
      models: ["gpt-a", "gpt-b"],
      configs: [{ id: "cfg-a", label: "A", overrides: {} }],
      trials: 1,
    });
    await runner.runTask(makeTask(["s1"]));
    expect(modelsSeen.sort()).toEqual(["gpt-a", "gpt-b"]);
  });

  it("sets each cell's result.model to the cell's model", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1", "m2"],
      configs: CONFIGS,
      trials: 1,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    for (const cell of result.cells) {
      expect(cell.result.model).toBe(cell.model);
    }
  });

  it("populates top-level MatrixResult metadata", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1"],
      configs: CONFIGS,
      trials: 1,
      gitSha: "abc1234",
    });
    const result = await runner.runTask(makeTask(["s1"]));
    expect(result.schemaVersion).toBe(1);
    expect(result.runId).toBeTruthy();
    expect(result.taskId).toBe("test-task");
    expect(result.taskVersion).toBe("1.0");
    expect(result.gitSha).toBe("abc1234");
    expect(result.models).toEqual(["m1"]);
    expect(result.configs).toEqual(CONFIGS);
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.finishedAt).toBe("string");
  });

  it("throws at run time before driver creation when planned sample cells exceed maxCells", async () => {
    let created = 0;
    const runner = new MatrixRunner({
      driverFactory: () => {
        created++;
        return passingDriver();
      },
      models: ["m1", "m2"],
      configs: CONFIGS,
      trials: 1,
      maxCells: 3,
    });
    await expect(runner.runTask(makeTask(["s1"]))).rejects.toThrow(/maxCells/i);
    expect(created).toBe(0);
  });

  it("dryRun returns the matrix plan without running drivers", async () => {
    let created = 0;
    const runner = new MatrixRunner({
      driverFactory: () => {
        created++;
        return passingDriver();
      },
      models: ["m1", "m2"],
      configs: CONFIGS,
      trials: 3,
      dryRun: true,
    });
    const result = await runner.runTask(makeTask(["s1", "s2"]));
    expect(created).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.cells).toHaveLength(4);
    expect(result.cells[0].result.rawRuns).toEqual([]);
    expect(result.cells[0].result.dryRun).toBe(true);
    expect(result.cells[0].result.summary.meanPassRate).toBeUndefined();
    expect(result.cells[0].result.samples.every((sample) => sample.noQualitySignal)).toBe(true);
  });

  it("dryRun cells fail CI gate with an explicit dry-run reason", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1"],
      configs: [{ id: "cfg-a", label: "A", overrides: {} }],
      trials: 1,
      dryRun: true,
    });
    const matrix = await runner.runTask(makeTask(["s1"]));

    const verdict = new CIGate({ passRateFloor: 0.8 }).evaluate(matrix.cells[0].result);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      "CIGate received a dry-run MultiTrialResult — re-run without dryRun to gate on real quality signal",
    );
  });

  it("non-dry-run cells evaluate normally in CI gate", async () => {
    const runner = new MatrixRunner({
      driverFactory: () => passingDriver(),
      models: ["m1"],
      configs: [{ id: "cfg-a", label: "A", overrides: {} }],
      trials: 1,
    });
    const matrix = await runner.runTask(makeTask(["s1"]));

    const verdict = new CIGate({ passRateFloor: 0.8, failOnNewSamples: false, allowMissingBaselineSamples: true }).evaluate(matrix.cells[0].result);

    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toContain("All gates passed");
  });

  it("dryRun also enforces maxCells cap (F9)", async () => {
    let created = 0;
    const runner = new MatrixRunner({
      driverFactory: () => {
        created++;
        return passingDriver();
      },
      models: ["m1", "m2", "m3", "m4"],
      configs: [
        { id: "c1", label: "C1", overrides: {} },
        { id: "c2", label: "C2", overrides: {} },
        { id: "c3", label: "C3", overrides: {} },
        { id: "c4", label: "C4", overrides: {} },
        { id: "c5", label: "C5", overrides: {} },
      ],
      trials: 5,
      maxCells: 1,
      dryRun: true,
    });

    await expect(runner.runTask(makeTask(["s1"]))).rejects.toThrow(/maxCells/i);
    expect(created).toBe(0);
  });

  it("dryRun within maxCells budget previews cells without creating drivers", async () => {
    let created = 0;
    const runner = new MatrixRunner({
      driverFactory: () => {
        created++;
        return passingDriver();
      },
      models: ["m1", "m2"],
      configs: [
        { id: "c1", label: "C1", overrides: {} },
        { id: "c2", label: "C2", overrides: {} },
      ],
      trials: 1,
      maxCells: 100,
      dryRun: true,
    });

    const result = await runner.runTask(makeTask(["s1"]));
    expect(created).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.cells).toHaveLength(4);
  });
});
